import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/server/app.js";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";
import type {
  DiagnosticRun,
  Product,
} from "../src/shared/product-diagnostics.js";
import type { WorkflowState } from "../src/shared/workflow.js";

const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
let fixture: Awaited<ReturnType<typeof createDiagnosticFixture>>;
let app: Awaited<ReturnType<typeof createApp>>;
const api = (url: string, payload?: unknown) =>
  app.inject({
    url,
    headers,
    method: payload === undefined ? "GET" : "POST",
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
async function product(title: string) {
  const response = await api("/api/products", {
    title,
    repositoryId: "fixture",
    ref: "baseline",
    specification: `${title}は社内の検証用クライアント。外部へのコード送信は不要。`,
    allowDependencyNetwork: false,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Product>();
}
async function run(productId: string, ref: string, requestId?: string) {
  const response = await api(`/api/products/${productId}/runs`, {
    ref,
    trigger: requestId ? "ci" : "manual",
    ...(requestId ? { requestId } : {}),
  });
  expect(response.statusCode, response.body).toBe(202);
  let current = response.json<DiagnosticRun>();
  for (
    let i = 0;
    i < 600 && ["queued", "running"].includes(current.status);
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await api(`/api/products/${productId}/runs/${current.id}`);
    expect(updated.statusCode, updated.body).toBe(200);
    current = updated.json<DiagnosticRun>();
  }
  expect(["completed", "partial"], current.failure ?? current.status).toContain(
    current.status,
  );
  return current;
}

beforeAll(async () => {
  fixture = await createDiagnosticFixture();
  app = await createApp({
    dbPath: ":memory:",
    diagnosticsRepositories: { fixture: fixture.directory },
    diagnosticsFetch: async () => {
      throw new Error("未許可の外部通信が発生しました");
    },
  });
});
afterAll(async () => {
  await app?.close();
});

describe("製品の実解析と既存案件の独立レビュー", () => {
  it("実解析を根拠に判定し、修正版の再解析と通常機能試験を確認して人が完了する", async () => {
    const p = await product("修正確認を通す製品");
    const first = await run(p.id, "baseline");
    const found = first.findings.find(
      (f) => f.ruleId === "tls.reject-unauthorized-disabled",
    )!;
    let state = (
      await api(`/api/projects/${p.linkedProjectId}/workflow`)
    ).json<WorkflowState>();
    const command = async (value: unknown) => {
      const response = await api(
        `/api/projects/${p.linkedProjectId}/workflow/commands`,
        {
          revision: state.revision,
          command: value,
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      state = response.json<WorkflowState>();
    };
    const finding = state.findings.find(
      (f) => f.id === found.workflowFindingId,
    )!;
    expect(finding).toBeDefined();
    await command({
      type: "finding-decision",
      findingId: finding.id,
      judgment: "needs_action",
      actor: "検証担当",
      reason: "製品のTLS設定方針に沿って確認する",
      targetVersion: fixture.commits.baseline,
      sourceRefs: finding.sourceRefs,
    });
    await command({
      type: "remediation-start",
      findingId: finding.id,
      assignee: "検証担当",
      taskRef: "local:fixture-change",
      plan: "TLS検証を有効化し修正版を再評価する",
      targetVersion: fixture.commits.baseline,
    });
    await command({
      type: "remediation-progress",
      findingId: finding.id,
      status: "in_progress",
      actor: "検証担当",
      reason: "修正作業を開始",
      targetVersion: fixture.commits.baseline,
    });
    const fixed = await run(p.id, "fixed");
    expect(
      fixed.findings.find((f) => f.fingerprint === found.fingerprint)?.delta,
    ).toBe("not_observed");
    state = (
      await api(`/api/projects/${p.linkedProjectId}/workflow`)
    ).json<WorkflowState>();
    await command({
      type: "remediation-progress",
      findingId: finding.id,
      status: "verification_pending",
      actor: "検証担当",
      reason: "修正版で静的再評価を実施",
      targetVersion: fixture.commits.fixed,
      fixCommit: fixture.commits.fixed,
    });
    const beforeEvidence = await api(
      `/api/projects/${p.linkedProjectId}/workflow/commands`,
      {
        revision: state.revision,
        command: {
          type: "remediation-complete",
          findingId: finding.id,
          actor: "検証担当",
          reason: "証拠なしの完了は不可",
          targetVersion: fixture.commits.fixed,
        },
      },
    );
    expect(beforeEvidence.statusCode).toBe(400);
    const report = state.documents.find((d) =>
      d.body.includes(`Commit: ${fixture.commits.fixed}`),
    )!;
    expect(report).toBeDefined();
    await command({
      type: "verification",
      findingId: finding.id,
      method: "static-review",
      rationale: "修正版の実解析結果とコード位置を確認",
      scope: "src/client.tsのTLS設定",
      status: "passed",
      actor: "検証担当",
      targetVersion: fixture.commits.fixed,
      evidence: [
        {
          docId: report.id,
          revision: report.revision,
          excerpt: `Commit: ${fixture.commits.fixed}`,
        },
      ],
    });
    // 実行するのは無害な通常機能だけ。TLS設定の評価用コードは実行しない。
    const arithmetic = await import(
      pathToFileURL(join(fixture.directory, "src", "arithmetic.mjs")).href
    );
    expect(arithmetic.sum(2, 3)).toBe(5);
    const regressionBody = `Commit: ${fixture.commits.fixed}\n通常機能: sum(2,3) = 5。期待値と一致。`;
    await command({
      type: "document",
      value: {
        title: "修正版の通常機能確認",
        body: regressionBody,
        classification: "local",
      },
    });
    const regression = state.documents.find((d) => d.body === regressionBody)!;
    await command({
      type: "verification",
      findingId: finding.id,
      method: "regression-test",
      rationale: "固定修正版の通常機能を実行して確認",
      scope: "arithmetic.sum",
      status: "passed",
      actor: "検証担当",
      targetVersion: fixture.commits.fixed,
      evidence: [
        {
          docId: regression.id,
          revision: regression.revision,
          excerpt: regressionBody,
        },
      ],
    });
    await command({
      type: "remediation-complete",
      findingId: finding.id,
      actor: "検証担当",
      reason: "修正版の静的再評価と通常機能の証跡を確認",
      targetVersion: fixture.commits.fixed,
    });
    expect(
      state.findings.find((f) => f.id === finding.id)?.remediation?.status,
    ).toBe("completed");
    await command({
      type: "knowledge-draft",
      purpose: state.scope.purpose,
      content:
        "修正確認では固定コミットの静的再評価と通常機能の回帰結果を照合した。",
      sourceRefs: [
        {
          docId: regression.id,
          revision: regression.revision,
          excerpt: regressionBody,
        },
      ],
      origin: "remediation",
    });
    const learned = state.knowledge.at(-1)!;
    const beforeApproval = await run(p.id, "fixed");
    expect(
      beforeApproval.knowledge.some((item) => item.id === learned.id),
    ).toBe(false);
    state = (
      await api(`/api/projects/${p.linkedProjectId}/workflow`)
    ).json<WorkflowState>();
    await command({
      type: "knowledge-review",
      knowledgeId: learned.id,
      decision: "active",
      actor: "検証担当",
      reason: "修正版の確認結果と引用元を確認",
    });
    const afterApproval = await run(p.id, "fixed");
    expect(afterApproval.knowledge).toContainEqual({
      id: learned.id,
      revision: state.knowledge.find((item) => item.id === learned.id)!
        .revision,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(beforeApproval.knowledge).toEqual([]);
  }, 30_000);

  it("初回・行移動・修正版を解析し、履歴と対象版を保持する", async () => {
    const p = await product("三つの版を追跡する製品");
    const first = await run(p.id, "baseline");
    const original = first.findings.find(
      (f) => f.ruleId === "tls.reject-unauthorized-disabled",
    );
    expect(original).toMatchObject({
      delta: "new",
      path: "src/client.ts",
      engine: "static",
    });
    expect(first.commit).toBe(fixture.commits.baseline);
    expect(original!.workflowFindingId).toBeTruthy();

    const second = await run(p.id, "updated");
    const repeated = second.findings.find(
      (f) => f.fingerprint === original!.fingerprint,
    );
    expect(repeated).toBeDefined();
    expect(repeated!.delta).not.toBe("new");
    expect(repeated!.line).toBeGreaterThan(original!.line);
    expect(second.commit).toBe(fixture.commits.updated);

    const repaired = await run(p.id, "fixed");
    expect(repaired.commit).toBe(fixture.commits.fixed);
    expect(
      repaired.findings.find((f) => f.fingerprint === original!.fingerprint)
        ?.delta,
    ).toBe("not_observed");
    const old = await api(`/api/products/${p.id}/runs/${first.id}`);
    expect(old.json().commit).toBe(fixture.commits.baseline);
    expect(old.json().findings).toEqual(first.findings);

    const linked = await api(`/api/projects/${p.linkedProjectId}/workflow`);
    expect(linked.statusCode, linked.body).toBe(200);
    const workflow = linked.json<WorkflowState>();
    expect(
      workflow.documents.some((d) => d.body.includes(p.specification)),
    ).toBe(true);
    expect(
      workflow.documents.some((d) => d.body.includes(fixture.commits.fixed)),
    ).toBe(true);
    expect(
      workflow.findings.some((f) => f.remediation?.status === "completed"),
    ).toBe(false);
    expect(
      workflow.findings.every(
        (f) => f.judgment === undefined || f.judgment === "unconfirmed",
      ),
    ).toBe(true);
  }, 30_000);

  it("同じCI要求を再解析せず、別内容での使い回しを拒否する", async () => {
    const p = await product("CI対象");
    const first = await run(p.id, "baseline", "build-1");
    const again = await api(`/api/products/${p.id}/runs`, {
      trigger: "ci",
      requestId: "build-1",
      ref: "baseline",
    });
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json().id).toBe(first.id);
    const changed = await api(`/api/products/${p.id}/runs`, {
      trigger: "ci",
      requestId: "build-1",
      ref: "fixed",
    });
    expect(changed.statusCode).toBe(409);
    const detail = await api(`/api/products/${p.id}`);
    expect(detail.json().runs).toHaveLength(1);
  });

  it("製品を越えた結果の取得と古い設定による上書きを拒否する", async () => {
    const left = await product("左の製品");
    const right = await product("右の製品");
    expect(left.linkedProjectId).not.toBe(right.linkedProjectId);
    const leftRun = await run(left.id, "baseline");
    expect(
      (await api(`/api/products/${right.id}/runs/${leftRun.id}`)).statusCode,
    ).toBe(404);
    const setting = await api(`/api/products/${right.id}/settings`, {
      revision: right.revision,
      ref: "fixed",
    });
    expect(setting.statusCode, setting.body).toBe(200);
    expect(
      (
        await api(`/api/products/${right.id}/settings`, {
          revision: right.revision,
          ref: "updated",
        })
      ).statusCode,
    ).toBe(409);
    expect((await api(`/api/products/${right.id}`)).json().product.ref).toBe(
      "fixed",
    );
  });
});
