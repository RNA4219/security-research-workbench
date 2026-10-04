import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { DiagnosticStore } from "../src/server/diagnostic-store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import { ProductDiagnosticsService } from "../src/server/diagnostic-service.js";
import * as diagnosticEngine from "../src/server/diagnostic-engine.js";
import { ENGINE_VERSION } from "../src/shared/diagnostic-engine.js";
import { diagnosticApiPaths, type DiagnosticRun } from "../src/shared/product-diagnostics.js";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";

const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
const diagnosticEngines = ["static", "dependency"] as const;
const payload = (title: string) => ({
  title,
  repositoryId: "fixture",
  ref: "baseline",
  specification: `${title} の要件`,
});
let fixture: Awaited<ReturnType<typeof createDiagnosticFixture>>;
let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  fixture = await createDiagnosticFixture();
  app = await createApp({
    dbPath: ":memory:",
    diagnosticsRepositories: { fixture: fixture.directory },
    diagnosticsScheduleIntervalMs: 0,
  });
});
afterAll(async () => {
  await app?.close();
});

describe("製品診断のAPI境界", () => {
  it("不正ID・未知製品・未知repo・schedule直起動を拒否する", async () => {
    for (const path of [
      diagnosticApiPaths.product("nope"),
      diagnosticApiPaths.settings("nope"),
      diagnosticApiPaths.runs("nope"),
      diagnosticApiPaths.run("nope", "nope"),
      diagnosticApiPaths.stop("nope", "nope"),
      diagnosticApiPaths.resume("nope", "nope"),
    ]) {
      const response = await app.inject({
        url: path,
        method:
          path.endsWith("/settings") ||
          path.endsWith("/stop") ||
          path.endsWith("/resume")
            ? "POST"
            : "GET",
        headers,
        payload: {},
      });
      expect(response.statusCode, path).toBe(400);
    }
    const missing = "89a7c43e-675c-4e41-b879-5b0ac54cdeea";
    expect(
      (await app.inject({ url: diagnosticApiPaths.product(missing), headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: diagnosticApiPaths.products,
          method: "POST",
          headers,
          payload: { ...payload("unknown"), repositoryId: "not-registered" },
        })
      ).statusCode,
    ).toBe(404);
    const p = (
      await app.inject({
        url: diagnosticApiPaths.products,
        method: "POST",
        headers,
        payload: payload("route boundaries"),
      })
    ).json();
    expect(
      (await app.inject({ url: diagnosticApiPaths.product(p.id), headers })).statusCode,
    ).toBe(200);
    const settings = await app.inject({
      url: diagnosticApiPaths.settings(p.id),
      method: "POST",
      headers,
      payload: { revision: p.revision, schedule: { enabled: false, intervalMinutes: null } },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    expect(
      (
        await app.inject({
          url: diagnosticApiPaths.runs(p.id),
          method: "POST",
          headers,
          payload: { trigger: "schedule", requestId: "timer-1" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: diagnosticApiPaths.run(p.id, "not-a-uuid"),
          headers,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: diagnosticApiPaths.run(p.id, "89a7c43e-675c-4e41-b879-5b0ac54cdeea"),
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("終端runは停止・再開されず、partial runは最新workflow版から明示再開できる", async () => {
    const p = (
      await app.inject({
        url: diagnosticApiPaths.products,
        method: "POST",
        headers,
        payload: payload("terminal controls"),
      })
    ).json();
    const start = await app.inject({
      url: diagnosticApiPaths.runs(p.id),
      method: "POST",
      headers,
      payload: { trigger: "manual", ref: "baseline" },
    });
    expect(start.statusCode).toBe(202);
    let run = start.json();
    for (
      let i = 0;
      i < 100 && ["queued", "running"].includes(run.status);
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      run = (
        await app.inject({
          url: diagnosticApiPaths.run(p.id, run.id),
          headers,
        })
      ).json();
    }
    expect(["partial", "completed"], run.failure ?? run.status).toContain(
      run.status,
    );
    expect(
      (
        await app.inject({
          url: diagnosticApiPaths.stop(p.id, run.id),
          method: "POST",
          headers,
        })
      ).json().status,
    ).toBe(run.status);
    if (run.status === "partial") {
      const workflowUrl = `/api/projects/${p.linkedProjectId}/workflow`;
      let workflow = (await app.inject({ url: workflowUrl, headers })).json();
      const originalMethods = workflow.scope.allowedMethods;
      const updateScope = async (allowedMethods: string[]) => {
        const changed = await app.inject({
          url: `/api/projects/${p.linkedProjectId}/workflow/commands`,
          method: "POST",
          headers,
          payload: {
            revision: workflow.revision,
            command: {
              type: "scope",
              value: { ...workflow.scope, allowedMethods },
            },
          },
        });
        expect(changed.statusCode, changed.body).toBe(200);
        workflow = changed.json();
      };
      await updateScope([]);
      expect(
        (
          await app.inject({
            url: diagnosticApiPaths.resume(p.id, run.id),
            method: "POST",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
      await updateScope(originalMethods);
      const allowedResume = await app.inject({
        url: diagnosticApiPaths.resume(p.id, run.id),
        method: "POST",
        headers,
        payload: {},
      });
      expect(allowedResume.statusCode, allowedResume.body).toBe(202);
      let resumed = allowedResume.json();
      for (
        let i = 0;
        i < 100 && ["queued", "running"].includes(resumed.status);
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        resumed = (
          await app.inject({
            url: diagnosticApiPaths.run(p.id, run.id),
            headers,
          })
        ).json();
      }
      expect(
        ["partial", "completed"],
        resumed.failure ?? resumed.status,
      ).toContain(resumed.status);
    } else {
      expect(
        (
          await app.inject({
            url: diagnosticApiPaths.resume(p.id, run.id),
            method: "POST",
            headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
    }
    expect(
      (
        await app.inject({
          url: diagnosticApiPaths.stop(p.id, run.id),
          method: "POST",
          headers,
          payload: { extra: true },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("診断serviceの停止・schedule lifecycle", () => {
  it("active runを停止し、設定更新が旧診断を中断して新しい診断版を保存する", async () => {
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const p = service.createProduct(payload("stop and update"));
      const run = await service.startRun(p.id, {
        trigger: "manual",
        ref: "baseline",
      });
      await expect(
        service.startRun(p.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409 });
      const stopped = await service.stop(p.id, run.id);
      expect(stopped.status).toBe("stopped");
      expect((await service.stop(p.id, run.id)).status).toBe("stopped");
      await service.resume(p.id, run.id);
      let resumed = service.getRun(p.id, run.id);
      for (
        let i = 0;
        i < 200 && ["queued", "running"].includes(resumed.status);
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        resumed = service.getRun(p.id, run.id);
      }
      expect(
        ["partial", "completed"],
        resumed.failure ?? resumed.status,
      ).toContain(resumed.status);

      const active = await service.startRun(p.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const change = service.updateProduct(p.id, p.revision, {
        specification: "修正された仕様",
      });
      await expect(
        service.startRun(p.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409 });
      const updated = await change;
      expect(updated.diagnosticRevision).toBe(p.diagnosticRevision + 1);
      expect(service.getRun(p.id, active.id).status).toBe("interrupted");
      await expect(service.resume(p.id, active.id)).rejects.toMatchObject({
        status: 409,
      });
      await expect(
        service.updateProduct(p.id, p.revision, { ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.updateProduct(p.id, updated.revision, {
          schedule: { enabled: false, intervalMinutes: null },
        }),
      ).resolves.toMatchObject({ revision: updated.revision + 1 });

      const racing = service.createProduct(payload("concurrent starts"));
      const starts = await Promise.allSettled([
        service.startRun(racing.id, { trigger: "manual", ref: "baseline" }),
        service.startRun(racing.id, { trigger: "manual", ref: "baseline" }),
      ]);
      expect(starts.filter((item) => item.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(starts.filter((item) => item.status === "rejected")).toHaveLength(
        1,
      );
      expect(
        (
          starts.find(
            (item) => item.status === "rejected",
          ) as PromiseRejectedResult
        ).reason,
      ).toMatchObject({ status: 409 });
      const winning = (
        starts.find(
          (item) => item.status === "fulfilled",
        ) as PromiseFulfilledResult<DiagnosticRun>
      ).value;
      await service.stop(racing.id, winning.id);
    } finally {
      await service.close();
      store.close();
    }
  });

  it("明示scheduleだけを経過後に1回開始し、同じinterval要求を重複作成しない", async () => {
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    const runScheduler = service as unknown as {
      scheduleTick: () => Promise<void>;
    };
    try {
      const disabled = service.createProduct(payload("schedule disabled"));
      await runScheduler.scheduleTick();
      expect(service.listRuns(disabled.id)).toHaveLength(0);

      const p = service.createProduct(payload("schedule enabled"));
      const configured = await service.updateProduct(p.id, p.revision, {
        schedule: { enabled: true, intervalMinutes: 5 },
      });
      await runScheduler.scheduleTick();
      expect(service.listRuns(p.id)).toHaveLength(0);
      const row = store.db
        .prepare("SELECT data FROM diagnostic_products WHERE id=?")
        .get(p.id) as { data: string };
      const stale = {
        ...JSON.parse(row.data),
        updatedAt: "2000-01-01T00:00:00.000Z",
      };
      store.db
        .prepare("UPDATE diagnostic_products SET data=? WHERE id=?")
        .run(JSON.stringify(stale), p.id);
      const manual = await service.startRun(p.id, {
        trigger: "manual",
        ref: "baseline",
      });
      await runScheduler.scheduleTick();
      expect(service.listRuns(p.id)).toHaveLength(1);
      await service.stop(p.id, manual.id);
      const oldManual = {
        ...JSON.parse(
          (
            store.db
              .prepare("SELECT data FROM diagnostic_runs WHERE id=?")
              .get(manual.id) as { data: string }
          ).data,
        ),
        startedAt: "2000-01-01T00:00:00.000Z",
      };
      store.db
        .prepare("UPDATE diagnostic_runs SET data=? WHERE id=?")
        .run(JSON.stringify(oldManual), manual.id);
      await runScheduler.scheduleTick();
      for (
        let i = 0;
        i < 200 &&
        service
          .listRuns(p.id)
          .some((item) => ["queued", "running"].includes(item.status));
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const scheduled = service.listRuns(p.id);
      expect(scheduled).toHaveLength(2);
      const scheduledRun = scheduled.find(
        (item) => item.trigger === "schedule",
      )!;
      expect(scheduledRun).toBeDefined();
      const data = JSON.parse(
        (
          store.db
            .prepare("SELECT data FROM diagnostic_runs WHERE id=?")
            .get(scheduledRun.id) as { data: string }
        ).data,
      );
      data.startedAt = "2000-01-01T00:00:00.000Z";
      store.db
        .prepare("UPDATE diagnostic_runs SET data=? WHERE id=?")
        .run(JSON.stringify(data), scheduledRun.id);
      await runScheduler.scheduleTick();
      expect(service.listRuns(p.id)).toHaveLength(2);
      expect(configured.schedule.enabled).toBe(true);
    } finally {
      await service.close();
      store.close();
    }
  });

  it("Git ref解決中のcloseはschedule tickを待ち、後続runや解析を開始しない", async () => {
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 5,
      fetcher: async () => {
        throw new Error("shutdown後の外部通信は禁止");
      },
    });
    let releaseResolve!: (commit: string) => void;
    const pendingResolve = new Promise<string>((resolve) => {
      releaseResolve = resolve;
    });
    const resolveCommit = vi
      .spyOn(diagnosticEngine, "resolveRepositoryCommit")
      .mockReturnValue(pendingResolve);
    const analyze = vi.spyOn(diagnosticEngine, "analyzeSnapshot");
    try {
      const products = ["shutdown first", "shutdown second"].map((title) =>
        service.createProduct(payload(title)),
      );
      for (const product of products) {
        await service.updateProduct(product.id, product.revision, {
          schedule: { enabled: true, intervalMinutes: 5 },
        });
        const row = store.db
          .prepare("SELECT data FROM diagnostic_products WHERE id=?")
          .get(product.id) as { data: string };
        store.db
          .prepare("UPDATE diagnostic_products SET data=? WHERE id=?")
          .run(
            JSON.stringify({
              ...JSON.parse(row.data),
              updatedAt: "2000-01-01T00:00:00.000Z",
            }),
            product.id,
          );
      }

      for (let i = 0; i < 100 && resolveCommit.mock.calls.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 2));
      expect(resolveCommit).toHaveBeenCalledTimes(1);

      const closing = service.close();
      releaseResolve("a".repeat(40));
      await closing;

      expect(resolveCommit).toHaveBeenCalledTimes(1);
      expect(products.flatMap((product) => service.listRuns(product.id))).toEqual(
        [],
      );
      expect(analyze).not.toHaveBeenCalled();
      await expect(
        service.startRun(products[0]!.id, {
          trigger: "manual",
          ref: "baseline",
        }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      resolveCommit.mockRestore();
      analyze.mockRestore();
      await service.close();
      store.close();
    }
  });

  it("実行中に案件revisionが変わった診断をinterruptedとして具体理由付きで保存する", async () => {
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const p = service.createProduct(payload("workflow race"));
      const run = await service.startRun(p.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const workflows = new WorkflowStore(store);
      const state = workflows.get(p.linkedProjectId);
      workflows.command(p.linkedProjectId, state.revision, {
        type: "scope",
        value: {
          ...state.scope,
          purpose: `${state.scope.purpose} 運用者が更新`,
        },
      });
      let current = service.getRun(p.id, run.id);
      for (
        let i = 0;
        i < 200 && ["queued", "running"].includes(current.status);
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        current = service.getRun(p.id, run.id);
      }
      expect(current.status).toBe("interrupted");
      expect(current.failure).toMatch(/製品設定または案件知識が変更/);
      await expect(service.resume(p.id, run.id)).rejects.toMatchObject({
        status: 409,
      });
    } finally {
      await service.close();
      store.close();
    }
  });

  it("承認済み知識のhashをrunへ固定し、context追加後のpartial resumeを拒否する", async () => {
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const p = service.createProduct(payload("pinned knowledge"));
      const workflows = new WorkflowStore(store);
      let state = workflows.get(p.linkedProjectId);
      state = workflows.command(p.linkedProjectId, state.revision, {
        type: "scope",
        value: { ...state.scope, version: fixture.commits.baseline },
      });
      const specification = state.documents.find(
        (document) => document.title === "製品仕様",
      )!;
      const addKnowledge = (content: string) => {
        state = workflows.command(p.linkedProjectId, state.revision, {
          type: "knowledge-draft",
          purpose: state.scope.purpose,
          content,
          sourceRefs: [
            {
              docId: specification.id,
              revision: specification.revision,
              excerpt: "pinned knowledge の要件",
            },
          ],
          origin: "manual",
        });
        const knowledgeId = state.knowledge.at(-1)!.id;
        state = workflows.command(p.linkedProjectId, state.revision, {
          type: "knowledge-review",
          knowledgeId,
          decision: "active",
          actor: "担当者",
          reason: "製品仕様との対応を確認",
        });
      };
      addKnowledge("TLS 設定は管理者の方針に従う");
      state = workflows.command(p.linkedProjectId, state.revision, {
        type: "rule-draft",
        purpose: state.scope.purpose,
        content: "TLS 設定を製品仕様と照合する",
        applicability: "この固定commitに適用",
        appliesToVersion: fixture.commits.baseline,
        sourceRefs: [
          {
            docId: specification.id,
            revision: specification.revision,
            excerpt: "pinned knowledge の要件",
          },
        ],
      });
      const ruleId = state.rules.at(-1)!.id;
      state = workflows.command(p.linkedProjectId, state.revision, {
        type: "rule-review",
        ruleId,
        decision: "active",
        actor: "担当者",
        reason: "この版の基準を確認",
      });
      const run = await service.startRun(p.id, {
        trigger: "manual",
        ref: "baseline",
      });
      let completed = service.getRun(p.id, run.id);
      for (
        let i = 0;
        i < 200 && ["queued", "running"].includes(completed.status);
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed = service.getRun(p.id, run.id);
      }
      expect(completed.knowledge).toHaveLength(1);
      expect(completed.rules).toHaveLength(1);
      expect(completed.knowledge[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(completed.rules[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(service.detail(p.id).runs[0]?.commit).toBe(
        fixture.commits.baseline,
      );
      if (completed.status === "partial") {
        state = workflows.get(p.linkedProjectId);
        addKnowledge("別途承認された追加要件");
        await expect(service.resume(p.id, run.id)).rejects.toMatchObject({
          status: 409,
        });
      }
    } finally {
      await service.close();
      store.close();
    }
  });

  it("restart resumeはsnapshotを再利用し、complete engine stageを再実行しない", async () => {
    const dbPath = join(
      ".cache",
      `diagnostic-checkpoint-${randomUUID()}.sqlite`,
    );
    let store = new Store(dbPath);
    let service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    const analyze = vi.spyOn(diagnosticEngine, "analyzeSnapshot");
    try {
      const p = service.createProduct(payload("checkpoint reuse"));
      const run = await service.startRun(p.id, {
        trigger: "manual",
        ref: "baseline",
      });
      let current = service.getRun(p.id, run.id);
      for (
        let i = 0;
        i < 200 && ["queued", "running"].includes(current.status);
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        current = service.getRun(p.id, run.id);
      }
      expect(
        ["partial", "completed"],
        current.failure ?? current.status,
      ).toContain(current.status);
      const before = service.products.getCheckpoint(run.id)!;
      expect(
        before.snapshot?.files.some((file) =>
          file.content.includes("rejectUnauthorized"),
        ),
      ).toBe(true);
      const publicRun = JSON.stringify(current);
      expect(publicRun).not.toContain("# ローカル静的診断の評価資料");
      expect(publicRun).not.toContain("export const client =");
      const completeEngines = diagnosticEngines.filter((engine) => {
        const stage =
          engine === "static"
            ? before.staticAnalysis
            : before.dependencyAnalysis;
        return stage?.coverage.status === "complete";
      });
      expect(completeEngines.length).toBeGreaterThan(0);
      if (current.status === "partial") {
        const callOffset = analyze.mock.calls.length;
        await service.close();
        store.close();
        store = new Store(dbPath);
        service = new ProductDiagnosticsService(store, {
          repositories: { fixture: fixture.directory },
          scheduleIntervalMs: 0,
        });
        await service.resume(p.id, run.id);
        current = service.getRun(p.id, run.id);
        for (
          let i = 0;
          i < 200 && ["queued", "running"].includes(current.status);
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          current = service.getRun(p.id, run.id);
        }
        expect(
          ["partial", "completed"],
          current.failure ?? current.status,
        ).toContain(current.status);
        const resumedEngines = analyze.mock.calls
          .slice(callOffset)
          .map((call) => call[1]?.engines?.[0]);
        for (const engine of completeEngines)
          expect(resumedEngines).not.toContain(engine);
        const after = service.products.getCheckpoint(run.id)!;
        expect(after.snapshot).toEqual(before.snapshot);
        for (const engine of completeEngines) {
          const stage =
            engine === "static"
              ? after.staticAnalysis
              : after.dependencyAnalysis;
          const prior =
            engine === "static"
              ? before.staticAnalysis
              : before.dependencyAnalysis;
          expect(stage).toEqual(prior);
        }
      }
    } finally {
      analyze.mockRestore();
      await service.close();
      store.close();
      for (const suffix of ["", "-wal", "-shm"])
        await unlink(`${dbPath}${suffix}`).catch(() => {});
    }
  });

  it("消失確認済み指摘が再出現したらneeds_reviewに戻し、詳細履歴のdelta件数を分ける", async () => {
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const p = service.createProduct(payload("finding history"));
      const runs: DiagnosticRun[] = [];
      for (const ref of ["baseline", "updated", "fixed", "baseline"]) {
        const started = await service.startRun(p.id, {
          trigger: "manual",
          ref,
        });
        let run = service.getRun(p.id, started.id);
        for (
          let i = 0;
          i < 200 && ["queued", "running"].includes(run.status);
          i++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          run = service.getRun(p.id, started.id);
        }
        expect(["partial", "completed"], run.failure ?? run.status).toContain(
          run.status,
        );
        runs.push(run);
      }
      const fingerprint = runs[0]!.findings.find(
        (finding) => finding.ruleId === "tls.reject-unauthorized-disabled",
      )!.fingerprint;
      expect(
        runs[1]!.findings.find((finding) => finding.fingerprint === fingerprint)
          ?.delta,
      ).toBe("continuing");
      expect(
        runs[2]!.findings.find((finding) => finding.fingerprint === fingerprint)
          ?.delta,
      ).toBe("not_observed");
      expect(
        runs[3]!.findings.find((finding) => finding.fingerprint === fingerprint)
          ?.delta,
      ).toBe("needs_review");
      const history = service.detail(p.id).runs;
      expect(
        history.some((entry) => entry.findingCounts.continuing === 1),
      ).toBe(true);
      expect(
        history.some((entry) => entry.findingCounts.notObserved === 1),
      ).toBe(true);
      expect(
        history.some((entry) => entry.findingCounts.needsReview === 1),
      ).toBe(true);
    } finally {
      await service.close();
      store.close();
    }
  });
});

function makeRunningRun(
  productId: string,
  id: string,
  timestamp: string,
): DiagnosticRun {
  return {
    id,
    productId,
    revision: 1,
    status: "running",
    trigger: "manual",
    requestId: null,
    ref: "baseline",
    commit: "a".repeat(40),
    previousRunId: null,
    manifestHash: null,
    snapshotFiles: [],
    snapshotOmitted: [],
    engineVersion: ENGINE_VERSION,
    allowDependencyNetwork: false,
    specificationRevision: 1,
    workflowRevision: 1,
    knowledge: [],
    rules: [],
    progress: { phase: "static", message: "test", updatedAt: timestamp },
    statusHistory: [
      { status: "queued", at: timestamp, reason: null },
      { status: "running", at: timestamp, reason: null },
    ],
    coverage: ["static", "dependency"].map((engine) => ({
      engine,
      status: "unavailable",
      assessed: 0,
      omitted: [],
      limitations: [],
    })) as DiagnosticRun["coverage"],
    findings: [],
    startedAt: timestamp,
    updatedAt: timestamp,
    finishedAt: null,
    failure: null,
  };
}

describe("診断storeのCAS・履歴・隔離", () => {
  it("製品更新のrevisionとworklow historyを一体で進め、scheduleのみでは診断版を変えない", () => {
    const store = new Store(":memory:");
    try {
      new WorkflowStore(store);
      const diagnostics = new DiagnosticStore(store);
      const p = diagnostics.create(payload("CAS"), "diagnostic-fixture");
      const scheduled = diagnostics.update(p.id, 1, {
        schedule: { enabled: true, intervalMinutes: 5 },
      });
      expect(scheduled.revision).toBe(2);
      expect(scheduled.diagnosticRevision).toBe(1);
      expect(() => diagnostics.update(p.id, 1, { ref: "updated" })).toThrow(
        /更新されました/,
      );
      const historyBefore = (
        store.db
          .prepare(
            "SELECT count(*) AS n FROM workflow_history WHERE project_id=?",
          )
          .get(p.linkedProjectId) as { n: number }
      ).n;
      const refChanged = diagnostics.update(p.id, 2, { ref: "updated" });
      expect(refChanged.diagnosticRevision).toBe(2);
      const specChanged = diagnostics.update(p.id, 3, {
        specification: "新仕様",
      });
      expect(specChanged.diagnosticRevision).toBe(3);
      const configured = diagnostics.update(p.id, 4, {
        allowDependencyNetwork: true,
      });
      expect(configured.revision).toBe(5);
      expect(configured.diagnosticRevision).toBe(4);
      const workflow = new WorkflowStore(store).get(p.linkedProjectId);
      expect(workflow.scope.version).toBe("updated");
      expect(
        workflow.documents.find((doc) => doc.title === "製品仕様")?.body,
      ).toBe("新仕様");
      expect(
        (
          store.db
            .prepare(
              "SELECT count(*) AS n FROM workflow_history WHERE project_id=?",
            )
            .get(p.linkedProjectId) as { n: number }
        ).n,
      ).toBeGreaterThan(historyBefore);
      expect(() =>
        diagnostics.get("89a7c43e-675c-4e41-b879-5b0ac54cdeea"),
      ).toThrow(/製品がありません/);
      expect(diagnostics.list()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("runのrequestId冪等性を製品内に限定し、異なるpayloadと古いCASを拒否する", () => {
    const store = new Store(":memory:");
    try {
      new WorkflowStore(store);
      const diagnostics = new DiagnosticStore(store);
      const first = diagnostics.create(payload("first"), "fixture");
      const second = diagnostics.create(payload("second"), "fixture");
      const timestamp = new Date().toISOString();
      const a = makeRunningRun(
        first.id,
        "9e9017d6-0cf3-41b5-9baa-63e2f797548a",
        timestamp,
      );
      a.requestId = "ci-1";
      const fingerprint = DiagnosticStore.requestFingerprint({
        trigger: "ci",
        ref: "baseline",
      });
      expect(diagnostics.createRun(a, fingerprint).created).toBe(true);
      const repeated = { ...a, id: "add182cb-7418-4d0a-a822-9a19fb7949c7" };
      expect(diagnostics.createRun(repeated, fingerprint)).toMatchObject({
        run: { id: a.id },
        created: false,
      });
      expect(() =>
        diagnostics.createRun(
          repeated,
          DiagnosticStore.requestFingerprint({ trigger: "ci", ref: "other" }),
        ),
      ).toThrow(/異なる入力/);
      const b = {
        ...a,
        id: "445d1feb-5079-4fc3-9793-e9a2cc8c3eba",
        productId: second.id,
      };
      expect(diagnostics.createRun(b, fingerprint).created).toBe(true);
      expect(diagnostics.findRequest(first.id, "absent")).toBeUndefined();
      expect(diagnostics.listRuns(first.id)).toHaveLength(1);
      expect(() =>
        diagnostics.listRuns("89a7c43e-675c-4e41-b879-5b0ac54cdeea"),
      ).toThrow(/製品がありません/);
      expect(() => diagnostics.getRun(second.id, a.id)).toThrow(
        /診断記録がありません/,
      );
      expect(() => diagnostics.saveRun({ ...a, revision: 3 }, 1)).toThrow(
        /版が不正/,
      );
      const updated = { ...a, revision: 2, status: "interrupted" as const };
      expect(diagnostics.saveRun(updated, 1).status).toBe("interrupted");
      expect(() => diagnostics.saveRun(updated, 1)).toThrow(/別の操作/);
      const counts = diagnostics.get(first.id).latestRun;
      expect(counts?.findingCounts).toEqual({
        new: 0,
        continuing: 0,
        needsReview: 0,
        notObserved: 0,
      });
    } finally {
      store.close();
    }
  });
});

describe("診断serviceの設定境界", () => {
  it("repo registryは不正ID、非Git path、禁止path、非root pathを拒否し、run開始条件を確認する", async () => {
    const invalidRegistries: Record<string, string>[] = [
      { "bad id": fixture.directory },
      { fixture: "Z:/definitely/missing/path" },
      { RSI: fixture.directory },
      { nested: `${fixture.directory}/src` },
      { file: join(fixture.directory, "README.md") },
    ];
    for (const repositories of invalidRegistries) {
      const store = new Store(":memory:");
      try {
        expect(
          () =>
            new ProductDiagnosticsService(store, {
              repositories,
              scheduleIntervalMs: 0,
            }),
        ).toThrow();
      } finally {
        store.close();
      }
    }
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const p = service.createProduct(payload("method restrictions"));
      await expect(
        service.startRun(p.id, { trigger: "manual", ref: "unknown-ref" }),
      ).rejects.toMatchObject({ status: 400 });
      const workflowStore = new WorkflowStore(store);
      const state = workflowStore.get(p.linkedProjectId);
      workflowStore.command(p.linkedProjectId, state.revision, {
        type: "scope",
        value: { ...state.scope, allowedMethods: [] },
      });
      await expect(
        service.startRun(p.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.resumeRun(p.id, "89a7c43e-675c-4e41-b879-5b0ac54cdeea"),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.updateProduct(p.id, 99, { ref: "updated" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.updateProduct("89a7c43e-675c-4e41-b879-5b0ac54cdeea", 1, {
          ref: "updated",
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.startRun(p.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await service.close();
      store.close();
    }
    const ordinaryStore = new Store(":memory:");
    const ordinaryService = new ProductDiagnosticsService(ordinaryStore, {
      repositories: { version: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      expect(ordinaryService.listRepositories()).toEqual([
        expect.objectContaining({ id: "version" }),
      ]);
    } finally {
      await ordinaryService.close();
      ordinaryStore.close();
    }
  });

  it("既定workbench登録、registry上限、package fallback、detached HEADを扱う", async () => {
    const defaultStore = new Store(":memory:");
    const defaultService = new ProductDiagnosticsService(defaultStore, {
      scheduleIntervalMs: 0,
    });
    try {
      expect(defaultService.listRepositories()).toEqual([
        expect.objectContaining({
          id: "workbench",
          name: "security-research-workbench",
        }),
      ]);
      expect(defaultService.listProducts()).toEqual([]);
    } finally {
      await defaultService.close();
      defaultStore.close();
    }

    const tooMany = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `repo-${index}`,
        fixture.directory,
      ]),
    );
    const limitStore = new Store(":memory:");
    try {
      expect(
        () =>
          new ProductDiagnosticsService(limitStore, {
            repositories: tooMany,
            scheduleIntervalMs: 0,
          }),
      ).toThrow(/上限/);
    } finally {
      limitStore.close();
    }

    const detachedFixture = await createDiagnosticFixture();
    await unlink(join(detachedFixture.directory, "package.json"));
    execFileSync(
      "git",
      [
        "-C",
        detachedFixture.directory,
        "checkout",
        "--detach",
        detachedFixture.commits.baseline,
      ],
      { stdio: "ignore" },
    );
    const detachedStore = new Store(":memory:");
    const detachedService = new ProductDiagnosticsService(detachedStore, {
      repositories: { fixture: detachedFixture.directory },
    });
    try {
      expect(detachedService.listRepositories()).toEqual([
        {
          id: "fixture",
          name: basename(detachedFixture.directory),
          defaultRef: null,
        },
      ]);
      expect(() =>
        detachedService.detail("89a7c43e-675c-4e41-b879-5b0ac54cdeea"),
      ).toThrow(/製品がありません/);
    } finally {
      await detachedService.close();
      detachedStore.close();
    }
  });
});
