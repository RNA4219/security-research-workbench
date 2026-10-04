import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import { waitWorkflowRun } from "../src/server/workflow-runner.js";
import type { WorkflowState, WorkflowCommand } from "../src/shared/workflow.js";
import type { WorkflowRun } from "../src/shared/workflow-run.js";
import { exampleProject } from "../src/shared/example.js";
import { researchFetcher } from "./research-fixtures.js";
import { report, scope } from "./workflow-fixtures.js";

const handles: { close(): unknown }[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  vi.restoreAllMocks();
});
const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
type App = Awaited<ReturnType<typeof createApp>>;
const call = (app: App, url: string, payload?: unknown) =>
  app.inject({
    method: payload === undefined ? "GET" : "POST",
    url,
    headers: {
      ...headers,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
async function prepare(app: App) {
  const project = (await call(app, "/api/projects", exampleProject)).json();
  const base = `/api/projects/${project.id}/workflow`;
  let state = (await call(app, base)).json<WorkflowState>();
  const command = async (value: WorkflowCommand) => {
    const response = await call(app, `${base}/commands`, {
      revision: state.revision,
      command: value,
    });
    expect(response.statusCode, response.body).toBe(200);
    state = response.json();
    return state;
  };
  await command({ type: "scope", value: scope });
  await command({
    type: "document",
    value: {
      title: "権限仕様",
      body: "ログを30日保存する。",
      classification: "public",
    },
  });
  const doc = state.documents[0]!;
  await command({
    type: "knowledge-draft",
    purpose: scope.purpose,
    content: "ログを30日保存する",
    sourceRefs: [{ docId: doc.id, revision: 1, excerpt: "ログを30日保存する" }],
    origin: "manual",
  });
  await command({
    type: "knowledge-review",
    knowledgeId: state.knowledge[0]!.id,
    decision: "active",
    actor: "担当者",
    reason: "原文を確認した",
  });
  return {
    project,
    base,
    get state() {
      return state;
    },
    command,
  };
}
const input = (revision: number) => ({
  revision,
  query: "ログの保存条件",
  queryClassification: "public",
  providerId: "manual",
  budgets: {
    maxDurationMs: 60000,
    maxCostUsd: 0,
    maxSteps: 3,
    maxConcurrency: 1,
    maxRetries: 0,
  },
});

describe("案件APIと永続化", () => {
  it("版の競合、不正入力、案件越境を拒否し、原文と承認済みの版を履歴に残す", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      staticRoot: ".cache/absent-static",
    });
    handles.push(app);
    const p = await prepare(app);
    const original = p.state;
    const stale = await call(app, `${p.base}/commands`, {
      revision: 1,
      command: { type: "scope", value: scope },
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (
        await call(app, `${p.base}/commands`, {
          revision: original.revision,
          command: {
            type: "document",
            value: {
              title: "不正",
              body: "x",
              classification: "public",
              injected: true,
            },
          },
        })
      ).statusCode,
    ).toBe(400);
    for (const url of ["", "not a URL"]) {
      const invalidUrl = await call(app, `${p.base}/commands`, {
        revision: original.revision,
        command: {
          type: "document",
          value: {
            title: "不正なURL",
            body: "原文",
            classification: "public",
            url,
          },
        },
      });
      expect(invalidUrl.statusCode).toBe(400);
      expect(invalidUrl.json().issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "command.value.url" }),
        ]),
      );
    }
    expect((await call(app, p.base)).json().revision).toBe(original.revision);
    const context = await call(app, `${p.base}/context`, {
      question: "ログ",
      providerKind: "manual",
    });
    expect(context.json().knowledge[0].id).toBe(original.knowledge[0]!.id);
    const other = (await call(app, "/api/projects", exampleProject)).json();
    const otherBase = `/api/projects/${other.id}/workflow`;
    expect(
      (
        await call(app, `${otherBase}/commands`, {
          revision: 1,
          command: {
            type: "knowledge-draft",
            purpose: scope.purpose,
            content: "越境",
            sourceRefs: [
              {
                docId: original.documents[0]!.id,
                revision: 1,
                excerpt: "ログ",
              },
            ],
          },
        })
      ).statusCode,
    ).toBe(404);
    await p.command({
      type: "document",
      documentId: original.documents[0]!.id,
      value: {
        title: "権限仕様",
        body: "ログを7日保存する。",
        classification: "public",
      },
    });
    expect(p.state.knowledge[0]!.status).toBe("stale");
    expect(
      (
        await call(app, `${p.base}/context`, {
          question: "ログ",
          providerKind: "manual",
        })
      ).json().knowledge,
    ).toEqual([]);
    expect(
      (await call(app, `${p.base}/history/${original.revision}`)).json(),
    ).toEqual(original);
    expect((await call(app, `${p.base}/history`)).json()).toHaveLength(
      p.state.revision,
    );
    expect((await call(app, `${p.base}/history/999`)).statusCode).toBe(404);
    expect((await call(app, "/api/projects/missing/workflow")).statusCode).toBe(
      404,
    );
    expect((await call(app, p.base)).json()).toEqual(p.state);
  });
  it("URL調査から一度だけ案件を作成し、import失敗で案件を壊さない", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      researchFetch: researchFetcher(),
    });
    handles.push(app);
    const research = (
      await call(app, "/api/research", {
        repoUrl: "https://github.com/example/research-fixture",
      })
    ).json();
    const adopted = await call(app, `/api/research/${research.id}/adopt`, {});
    expect(adopted.statusCode).toBe(201);
    const project = adopted.json();
    expect(
      (await call(app, `/api/research/${research.id}/adopt`, {})).json().id,
    ).toBe(project.id);
    const base = `/api/projects/${project.id}/workflow`;
    const state = (await call(app, base)).json<WorkflowState>();
    expect(state.documents[0]!.body).toBe(JSON.stringify(research));
    expect(state.findings[0]!.judgment).toBe("unconfirmed");
    expect(
      (
        await call(app, `${base}/import-research`, {
          revision: state.revision,
          researchId: research.id,
        })
      ).json(),
    ).toEqual(state);
    const p = await prepare(app);
    expect(
      (
        await call(app, `${p.base}/import-research`, {
          revision: p.state.revision,
          researchId: research.id,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(app, `${base}/import-research`, {
          revision: state.revision,
          researchId: randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
  });
  it("手動runを保存・停止・再開し、比較の欠測を0にせず、別案件では読めない", async () => {
    const app = await createApp({ dbPath: ":memory:" });
    handles.push(app);
    const p = await prepare(app);
    const providers = (await call(app, `${p.base}/runs`)).json();
    expect(providers.providers[0]).toMatchObject({
      id: "manual",
      available: true,
    });
    expect(JSON.stringify(providers)).not.toContain("apiKey");
    expect((await call(app, `${p.base}/runs`, input(1))).statusCode).toBe(409);
    expect(
      (
        await call(app, `${p.base}/runs`, {
          ...input(p.state.revision),
          providerId: "unknown",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(app, `${p.base}/runs`, {
          ...input(p.state.revision),
          providerId: "cloud",
        })
      ).statusCode,
    ).toBe(400);
    const firstResponse = await call(
      app,
      `${p.base}/runs`,
      input(p.state.revision),
    );
    expect(firstResponse.statusCode, firstResponse.body).toBe(201);
    const first = firstResponse.json<WorkflowRun>();
    await waitWorkflowRun(first.id);
    expect((await call(app, `${p.base}/runs/${first.id}`)).json().status).toBe(
      "waiting_response",
    );
    const stopped = await call(app, `${p.base}/runs/${first.id}/stop`, {});
    expect(stopped.json().status).toBe("stopped");
    const resumed = await call(app, `${p.base}/runs/${first.id}/resume`, {});
    expect(resumed.statusCode, resumed.body).toBe(200);
    await waitWorkflowRun(first.id);
    const response = {
      answer: "原文では30日保存。運用条件の確認が必要。",
      citedKnowledgeIds: [p.state.knowledge[0]!.id],
      findingReferences: ["expected-1"],
    };
    const answered = await call(app, `${p.base}/runs/${first.id}/response`, {
      response,
    });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.json().status).toBe("completed");
    const second = (
      await call(app, `${p.base}/runs`, input(p.state.revision))
    ).json<WorkflowRun>();
    await waitWorkflowRun(second.id);
    expect(
      (
        await call(app, `${p.base}/runs/${second.id}/response`, {
          response: { ...response, findingReferences: [] },
        })
      ).statusCode,
    ).toBe(200);
    const comparison = await call(app, `${p.base}/compare`, {
      leftRunId: first.id,
      rightRunId: second.id,
      labelSetId: "reviewed-cases-v1",
      expectedFindingReferences: ["expected-1"],
      reviewTimeMsByRunId: { [first.id]: 1500, [second.id]: null },
    });
    expect(comparison.statusCode, comparison.body).toBe(200);
    expect(comparison.json()).toMatchObject({
      eligible: true,
      metrics: {
        left: { falseNegatives: 0, reviewTimeMs: 1500 },
        right: { falseNegatives: 1, reviewTimeMs: null },
      },
    });
    const artifacts = (
      await call(app, `/api/projects/${p.project.id}/artifacts`)
    ).json();
    const recorded = JSON.parse(
      artifacts.find((a: { kind: string }) => a.kind === "workflow-comparison")
        .body,
    );
    expect(
      (
        await call(app, `${p.base}/runs/compare`, {
          leftRunId: first.id,
          rightRunId: second.id,
          evaluation: recorded.evaluation,
        })
      ).json().eligible,
    ).toBe(true);
    const other = (await call(app, "/api/projects", exampleProject)).json();
    expect(
      (await call(app, `/api/projects/${other.id}/workflow/runs/${first.id}`))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(app, `${p.base}/runs/missing/stop`, {})).statusCode,
    ).toBe(404);
    expect(
      (await call(app, `${p.base}/runs/${first.id}/stop`, { injected: true }))
        .statusCode,
    ).toBe(400);
    expect((await call(app, p.base)).json()).toEqual(p.state);
  });
  it("プロセスを閉じても手動引渡しの原文と進行状況を保持する", async () => {
    const path = resolve(".cache", `workflow-${randomUUID()}.db`);
    const app = await createApp({ dbPath: path });
    const p = await prepare(app);
    const run = (
      await call(app, `${p.base}/runs`, input(p.state.revision))
    ).json<WorkflowRun>();
    await waitWorkflowRun(run.id);
    const before = (await call(app, `${p.base}/runs/${run.id}`)).json();
    await app.close();
    const next = await createApp({ dbPath: path });
    handles.push(next);
    expect((await call(next, `${p.base}/runs/${run.id}`)).json()).toEqual(
      before,
    );
    expect(
      (
        await call(next, `${p.base}/runs/${run.id}/response`, {
          response: {
            answer: "確認済み",
            citedKnowledgeIds: [p.state.knowledge[0]!.id],
            findingReferences: [],
          },
        })
      ).json().status,
    ).toBe("completed");
  });
  it("案件の情報区分・許可範囲の変更で旧条件の実行を停止する", async () => {
    const app = await createApp({ dbPath: ":memory:" });
    handles.push(app);
    const p = await prepare(app);
    const run = (
      await call(app, `${p.base}/runs`, input(p.state.revision))
    ).json<WorkflowRun>();
    await waitWorkflowRun(run.id);
    await p.command({
      type: "document",
      documentId: p.state.documents[0]!.id,
      value: {
        title: "権限仕様",
        body: "ログを30日保存する。",
        classification: "blocked",
      },
    });
    expect((await call(app, `${p.base}/runs/${run.id}`)).json().status).toBe(
      "stopped",
    );
    expect(
      (
        await call(app, `${p.base}/runs/${run.id}/response`, {
          response: {
            answer: "古い条件",
            citedKnowledgeIds: [],
            findingReferences: [],
          },
        })
      ).statusCode,
    ).toBe(400);
    await p.command({ type: "scope", value: { ...scope, allowedMethods: [] } });
    const forbidden = await call(
      app,
      `${p.base}/runs`,
      input(p.state.revision),
    );
    expect(forbidden.statusCode).toBe(400);
    expect(forbidden.json().error).toContain("確認方法");
  });
  it("SQLite失敗で途中保存せず、revision競合と異案件への書換を拒否する", () => {
    const store = new Store(":memory:");
    handles.push(store);
    const workflows = new WorkflowStore(store);
    const project = store.create(exampleProject);
    const state = workflows.get(project.id);
    expect(
      workflows.command(project.id, state.revision, {
        type: "scope",
        value: state.scope,
      }),
    ).toEqual(state);
    expect(() =>
      workflows.update(project.id, 1, (s) => ({ ...s, projectId: "another" })),
    ).toThrow("一致");
    store.db.exec(
      "CREATE TRIGGER fail_workflow_snapshot BEFORE INSERT ON workflow_history BEGIN SELECT RAISE(FAIL,'snapshot failure'); END;",
    );
    expect(() =>
      workflows.command(project.id, 1, { type: "scope", value: scope }),
    ).toThrow("snapshot failure");
    expect(workflows.get(project.id)).toEqual(state);
    const second = store.create(exampleProject);
    expect(() => workflows.get(second.id)).toThrow("snapshot failure");
    store.saveResearch(report(randomUUID(), null));
    const researchId = store.listResearch()[0]!.id;
    expect(() => workflows.adopt(researchId)).toThrow("snapshot failure");
    expect(store.list()).toHaveLength(2);
    store.db.exec("DROP TRIGGER fail_workflow_snapshot");
    expect(workflows.get(second.id).revision).toBe(1);
    const adopted = workflows.adopt(researchId);
    expect(workflows.get(adopted.id).scope.version).toBe("unknown");
  });
  it("実行途中で失われたプロセスのcheckpointを検出し、二重保存や案件横断更新を拒否する", async () => {
    const path = resolve(".cache", `workflow-recovery-${randomUUID()}.db`);
    const app = await createApp({ dbPath: path });
    const p = await prepare(app);
    const run = (
      await call(app, `${p.base}/runs`, input(p.state.revision))
    ).json<WorkflowRun>();
    await waitWorkflowRun(run.id);
    await app.close();
    const direct = new Store(path);
    const repository = new WorkflowStore(direct);
    const saved = repository.getRun(p.project.id, run.id);
    expect(() => repository.saveRun(saved, 0)).toThrow("版");
    expect(() => repository.saveRun({ ...saved, revision: 1 }, 0)).toThrow(
      "既に存在",
    );
    expect(() =>
      repository.saveRun(
        { ...saved, revision: saved.revision },
        saved.revision - 1,
      ),
    ).toThrow("別の操作");
    const secondProject = direct.create(exampleProject);
    expect(() =>
      repository.saveRun(
        { ...saved, projectId: secondProject.id, revision: saved.revision + 1 },
        saved.revision,
      ),
    ).toThrow("別の操作");
    saved.status = "running";
    saved.steps[1]!.status = "running";
    saved.revision++;
    repository.saveRun(saved, saved.revision - 1);
    direct.close();
    const next = await createApp({ dbPath: path });
    handles.push(next);
    const recovered = (
      await call(next, `${p.base}/runs/${run.id}`)
    ).json<WorkflowRun>();
    expect(recovered.status).toBe("partial");
    expect(recovered.stopReason).toBe("restart");
    expect(recovered.steps[0]!.status).toBe("completed");
    expect(recovered.steps[1]!.status).toBe("failed");
    const resumed = await call(next, `${p.base}/runs/${run.id}/resume`, {});
    expect(resumed.statusCode, resumed.body).toBe(200);
    await waitWorkflowRun(run.id);
    expect(
      (await call(next, `${p.base}/runs/${run.id}`)).json().steps[0].attempts,
    ).toBe(recovered.steps[0]!.attempts);
  });
});
