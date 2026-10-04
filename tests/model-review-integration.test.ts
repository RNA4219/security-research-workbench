import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { WorkflowProviderDefinition } from "../src/server/workflow-runner.js";
import type {
  DiagnosticRun,
  Product,
} from "../src/shared/product-diagnostics.js";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";

const headers = {
  host: "127.0.0.1:4317",
  "x-workbench": "1",
  "content-type": "application/json",
};
type App = Awaited<ReturnType<typeof createApp>>;

const provider: WorkflowProviderDefinition = {
  id: "local",
  kind: "local",
  label: "テスト用ローカルモデル",
  model: "fixture-model",
  available: true,
  costKnown: true,
  configVersion: "fixture-local-v1",
  // The integration test injects the workflow adapter.  Keeping an endpoint
  // out of this definition also proves that the provider API does not need to
  // expose one for embedded local execution.
  maxOutputTokens: 2048,
};

let fixture: Awaited<ReturnType<typeof createDiagnosticFixture>>;
let app: App;
const prompts: string[] = [];

function payloadFromPrompt(prompt: string) {
  const start = "BEGIN_REFERENCE_DATA_JSON\n";
  const end = "\nEND_REFERENCE_DATA_JSON";
  const from = prompt.indexOf(start);
  const to = prompt.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error("model review payload is missing");
  return JSON.parse(prompt.slice(from + start.length, to)) as {
    approvedKnowledge: {
      id: string;
      content?: string;
      sourceRefs?: {
        id: string;
        version: string;
        hash: string;
        excerpt: string;
      }[];
    }[];
    matchingPastJudgments: {
      id: string;
      sourceRefs?: {
        id: string;
        version: string;
        hash: string;
        excerpt: string;
      }[];
    }[];
    pinnedSnapshot: {
      files: { path: string; lines: { line: number; text: string }[] }[];
    };
  };
}

function responseFor(prompt: string, includeFinding = true) {
  const payload = payloadFromPrompt(prompt);
  const file = payload.pinnedSnapshot.files.find(
    (entry) => entry.path === "src/client.ts",
  );
  const line = file?.lines.find((entry) =>
    entry.text.includes("rejectUnauthorized: false"),
  );
  return JSON.stringify({
    schemaVersion: "1",
    findings:
      includeFinding && file && line
        ? [
            {
              id: "model-static-observation",
              category: "trust-boundary",
              severity: "medium",
              title: "通信設定の仕様照合候補",
              rationale:
                "固定snapshotの通信設定と製品仕様を担当者が照合する必要があります。",
              path: file.path,
              line: line.line,
              originalText: line.text,
              specRefIds: ["product-specification"],
              relatedFixedFindingIds: [],
              pastJudgmentIds: [],
              remediation: {
                guidance: "担当者が用途・仕様と通信設定を確認する。",
                humanReviewRequired: true,
              },
              falsePositiveCandidate: false,
              uncertainty: {
                level: "medium",
                reasons: ["モデル出力は候補であり安全性の証明ではありません。"],
              },
            },
          ]
        : [],
    omitted: [],
    limitations: [],
  });
}

async function call(
  url: string,
  body?: unknown,
  method: "GET" | "POST" = body === undefined ? "GET" : "POST",
) {
  return app.inject({
    url,
    method,
    headers,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function createProduct(title: string) {
  const response = await call("/api/products", {
    title,
    repositoryId: "fixture",
    ref: "baseline",
    specification: "TLS接続の証明書検証を必須とする製品。",
    allowDependencyNetwork: false,
    modelReview: {
      enabled: true,
      providerId: "local",
      cloudConsent: false,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Product>();
}

async function waitForRun(productId: string, runId: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const response = await call(`/api/products/${productId}/runs/${runId}`);
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<DiagnosticRun>();
    if (
      ["completed", "partial", "failed", "stopped", "interrupted"].includes(
        run.status,
      )
    )
      return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("diagnostic run did not finish in time");
}

beforeAll(async () => {
  fixture = await createDiagnosticFixture();
  app = await createApp({
    dbPath: ":memory:",
    diagnosticsRepositories: { fixture: fixture.directory },
    diagnosticsFetch: async () => {
      throw new Error("外部依存照会はこの試験では許可しません");
    },
    workflowProviders: [provider],
    workflowInvokeModel: async (_provider, prompt) => {
      prompts.push(prompt);
      return {
        response: responseFor(prompt),
        model: provider.model,
        configVersion: provider.configVersion,
        actualCostUsd: 0,
        promptTokens: 11,
        completionTokens: 7,
      };
    },
  });
});

afterAll(async () => {
  await app?.close();
});

describe("diagnostic serviceとlocal model reviewの統合", () => {
  it("provider契約を守り、固定snapshotの検証済みモデルfindingをrunへ接続する", async () => {
    const providers = await call("/api/model-review/providers");
    expect(providers.statusCode, providers.body).toBe(200);
    const local = providers
      .json()
      .find((item: { id: string }) => item.id === "local");
    expect(local).toMatchObject({
      id: "local",
      kind: "local",
      available: true,
      model: provider.model,
      configVersion: provider.configVersion,
    });
    expect(JSON.stringify(local)).not.toContain("endpoint");
    expect(JSON.stringify(local)).not.toContain("apiKey");

    prompts.length = 0;
    const product = await createProduct("モデル統合の固定snapshot");
    const started = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(started.statusCode, started.body).toBe(202);
    const startedRun = started.json<DiagnosticRun>();
    expect(startedRun.modelReview?.failure).toBeNull();
    const run = await waitForRun(product.id, startedRun.id);

    // The deterministic analyzer intentionally reports unsupported fixture
    // files as an incomplete range; model coverage can still be complete.
    expect(run.status).toBe("partial");
    expect(run.modelReview).toMatchObject({
      enabled: true,
      providerId: "local",
      providerKind: "local",
      model: provider.model,
      configVersion: provider.configVersion,
      coverage: {
        status: "complete",
        isSafetyProof: false,
      },
      record: {
        status: "completed",
        used: { promptTokens: 11, completionTokens: 7 },
      },
    });
    expect(run.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ engine: "model", status: "complete" }),
      ]),
    );
    expect(run.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          engine: "model",
          path: "src/client.ts",
          line: 2,
          modelReviewEvidence: {
            specRefIds: ["product-specification"],
            pastJudgmentIds: [],
            requiresHumanConfirmation: true,
            recheckPriorDecision: true,
          },
        }),
      ]),
    );
    expect(run.findings.some((finding) => finding.engine === "model")).toBe(
      true,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("MODEL_REVIEW_CONTRACT v1");
    expect(prompts[0]).not.toContain("127.0.0.1");

    // The fixture's updated commit shifts the exact source line.  The
    // finding identity remains tied to path/category/normalized source text,
    // so comparison can still relate the observation across the move.
    const changed = await call(`/api/products/${product.id}/settings`, {
      revision: product.revision,
      ref: "updated",
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const nextStarted = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "updated",
    });
    expect(nextStarted.statusCode, nextStarted.body).toBe(202);
    const nextRun = await waitForRun(
      product.id,
      nextStarted.json<DiagnosticRun>().id,
    );
    const previousModel = run.findings.find(
      (finding) => finding.engine === "model",
    );
    const nextModel = nextRun.findings.find(
      (finding) => finding.engine === "model",
    );
    expect(previousModel).toBeTruthy();
    expect(nextModel).toMatchObject({
      fingerprint: previousModel!.fingerprint,
      line: 3,
      delta: "needs_review",
    });
  });

  it("承認されていない/失効した案件知識と条件不一致の過去判断をモデル入力へ渡さない", async () => {
    prompts.length = 0;
    const product = await createProduct("モデル入力の承認境界");
    const workflowUrl = `/api/projects/${product.linkedProjectId}/workflow`;
    const initial = await call(workflowUrl);
    expect(initial.statusCode).toBe(200);
    let state = initial.json<{
      revision: number;
      scope: Record<string, unknown>;
      documents: { id: string; revision: number; body: string }[];
      knowledge: { id: string; status?: string }[];
      findings: { id: string }[];
    }>();
    const command = async (value: unknown) => {
      const response = await call(`${workflowUrl}/commands`, {
        revision: state.revision,
        command: value,
      });
      expect(response.statusCode, response.body).toBe(200);
      state = response.json();
    };
    const specification = state.documents.find((document) =>
      document.body.includes("TLS接続"),
    )!;
    await command({
      type: "knowledge-draft",
      purpose: state.scope.purpose,
      content: "失効した旧仕様: すべての入力を公開扱いにする。",
      sourceRefs: [
        {
          docId: specification.id,
          revision: specification.revision,
          excerpt: "TLS接続",
        },
      ],
    });
    const draftId = state.knowledge[0]!.id;
    await command({
      type: "knowledge-review",
      knowledgeId: draftId,
      decision: "active",
      actor: "reviewer",
      reason: "一時的な試験用知識",
    });
    // Create a judgment while the source is still current, then change the
    // source document.  The old judgment must become incompatible with the
    // current source revision before the diagnostic starts.
    await command({
      type: "scope",
      value: { ...state.scope, version: fixture.commits.baseline },
    });
    await command({
      type: "knowledge-draft",
      purpose: state.scope.purpose,
      content: "現行承認知識: TLS証明書検証の例外は許可しない。",
      sourceRefs: [
        {
          docId: specification.id,
          revision: specification.revision,
          excerpt: "TLS接続",
        },
      ],
    });
    const currentDraftId = state.knowledge.at(-1)!.id;
    await command({
      type: "knowledge-review",
      knowledgeId: currentDraftId,
      decision: "active",
      actor: "reviewer",
      reason: "現行版で承認",
    });
    const oldFindingId = "old-model-judgment";
    await command({
      type: "finding-observation",
      findingId: oldFindingId,
      fingerprint: "old-model-fingerprint",
      targetVersion: fixture.commits.baseline,
      observation: "旧仕様を前提にした過去観測",
      sourceRefs: [
        {
          docId: specification.id,
          revision: 1,
          excerpt: "TLS接続",
        },
      ],
    });
    await command({
      type: "finding-decision",
      findingId: oldFindingId,
      judgment: "accepted_known",
      actor: "reviewer",
      reason: "旧仕様下では既知",
      targetVersion: fixture.commits.baseline,
      sourceRefs: [
        {
          docId: specification.id,
          revision: 1,
          excerpt: "TLS接続",
        },
      ],
      ruleRefs: [],
    });
    const activeStarted = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(activeStarted.statusCode, activeStarted.body).toBe(202);
    await waitForRun(product.id, activeStarted.json<DiagnosticRun>().id);
    expect(prompts).toHaveLength(1);
    const activePayload = payloadFromPrompt(prompts[0]!);
    expect(activePayload.approvedKnowledge).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: currentDraftId })]),
    );
    expect(activePayload.matchingPastJudgments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `${oldFindingId}-decision-2` }),
      ]),
    );
    prompts.length = 0;
    state = (await call(workflowUrl)).json();
    // Updating the source document stales the previous knowledge and its
    // source revision.  The model input must therefore use only the product
    // specification fallback, never the old content.
    await command({
      type: "document",
      documentId: specification.id,
      value: {
        title: "製品仕様",
        body: "現行仕様: テナント境界を分離し、TLS証明書検証を必須とする。",
        classification: "local",
      },
    });
    expect(state.knowledge[0]?.status).toBe("stale");

    const started = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = await waitForRun(product.id, started.json<DiagnosticRun>().id);
    expect(run.modelReview?.coverage.status).toBe("complete");
    const payloads = prompts.map(payloadFromPrompt);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.approvedKnowledge).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ id: draftId }),
        expect.objectContaining({ id: currentDraftId }),
      ]),
    );
    expect(payloads[0]!.matchingPastJudgments).toEqual([]);
    expect(prompts[0]).not.toContain("失効した旧仕様");
    expect(prompts[0]).not.toContain(oldFindingId);
  });

  it("過去判断は監査履歴全件ではなく現行findingの最新判断だけを入力する", async () => {
    prompts.length = 0;
    const product = await createProduct("モデル入力の最新判断");
    const workflowUrl = `/api/projects/${product.linkedProjectId}/workflow`;
    const initial = await call(workflowUrl);
    let state = initial.json<{
      revision: number;
      scope: Record<string, unknown>;
      documents: { id: string; revision: number; body: string }[];
      findings: { id: string }[];
    }>();
    const command = async (value: unknown) => {
      const response = await call(`${workflowUrl}/commands`, {
        revision: state.revision,
        command: value,
      });
      expect(response.statusCode, response.body).toBe(200);
      state = response.json();
    };
    const specification = state.documents.find((document) =>
      document.body.includes("TLS接続"),
    )!;
    await command({
      type: "scope",
      value: { ...state.scope, version: fixture.commits.baseline },
    });
    const sourceRef = {
      docId: specification.id,
      revision: specification.revision,
      excerpt: "TLS接続",
    };
    const findingId = "latest-model-judgment";
    await command({
      type: "finding-observation",
      findingId,
      fingerprint: "latest-model-fingerprint",
      targetVersion: fixture.commits.baseline,
      observation: "同条件の過去観測",
      sourceRefs: [sourceRef],
    });
    await command({
      type: "finding-decision",
      findingId,
      judgment: "accepted_known",
      actor: "reviewer",
      reason: "初回判断",
      targetVersion: fixture.commits.baseline,
      sourceRefs: [sourceRef],
      ruleRefs: [],
    });
    await command({
      type: "finding-decision",
      findingId,
      judgment: "needs_action",
      actor: "reviewer",
      reason: "最新判断で再確認が必要",
      targetVersion: fixture.commits.baseline,
      sourceRefs: [sourceRef],
      ruleRefs: [],
    });

    const started = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = await waitForRun(product.id, started.json<DiagnosticRun>().id);
    expect(run.modelReview?.coverage.status).toBe("complete");
    const payload = payloadFromPrompt(prompts[0]!);
    expect(payload.matchingPastJudgments).toEqual([
      expect.objectContaining({
        id: `${findingId}-decision-3`,
      }),
    ]);
    expect(payload.matchingPastJudgments).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `${findingId}-decision-2` }),
      ]),
    );
  });

  it("複数sourceRefsの承認知識を順序どおり固定し、rule更新後は根拠付き過去判断を除外する", async () => {
    prompts.length = 0;
    const product = await createProduct("モデル入力の複数根拠と基準境界");
    const workflowUrl = `/api/projects/${product.linkedProjectId}/workflow`;
    const initial = await call(workflowUrl);
    expect(initial.statusCode, initial.body).toBe(200);
    let state = initial.json<{
      revision: number;
      scope: { purpose: string; version: string; [key: string]: unknown };
      documents: { id: string; revision: number; body: string }[];
      knowledge: { id: string; revision: number; status?: string }[];
      rules: { id: string; revision: number; status?: string }[];
    }>();
    const command = async (value: unknown) => {
      const response = await call(`${workflowUrl}/commands`, {
        revision: state.revision,
        command: value,
      });
      expect(response.statusCode, response.body).toBe(200);
      state = response.json();
    };
    const specification = state.documents.find((document) =>
      document.body.includes("TLS接続"),
    )!;
    expect(specification.body).toContain("証明書検証");
    await command({
      type: "document",
      value: {
        title: "ローカルレビュー補助資料",
        body: "補助資料: ローカルレビューでは証明書検証を必須にする。",
        classification: "local",
      },
    });
    const supplemental = state.documents.at(-1)!;
    const sourceRefs = [
      {
        docId: supplemental.id,
        revision: supplemental.revision,
        excerpt: "補助資料: ローカルレビューでは証明書検証を必須にする。",
      },
      {
        docId: specification.id,
        revision: specification.revision,
        excerpt: "証明書検証",
      },
      {
        docId: specification.id,
        revision: specification.revision,
        excerpt: "TLS接続",
      },
    ];
    const judgmentSourceRefs = [sourceRefs[1]!, sourceRefs[0]!, sourceRefs[2]!];
    await command({
      type: "scope",
      value: { ...state.scope, version: fixture.commits.baseline },
    });
    await command({
      type: "knowledge-draft",
      purpose: state.scope.purpose,
      content: "複数資料で確認した証明書検証の承認済み運用知識。",
      sourceRefs: [sourceRefs[2]!, sourceRefs[0]!, sourceRefs[1]!],
    });
    const knowledgeId = state.knowledge.at(-1)!.id;
    await command({
      type: "knowledge-review",
      knowledgeId,
      decision: "active",
      actor: "reviewer",
      reason: "複数資料の原文を照合して承認",
    });
    await command({
      type: "rule-draft",
      purpose: state.scope.purpose,
      content: "通信設定は証明書検証を満たすこと。",
      applicability: "固定版の通信設定レビュー",
      appliesToVersion: fixture.commits.baseline,
      sourceRefs: [sourceRefs[1]!, sourceRefs[0]!],
    });
    const ruleId = state.rules.at(-1)!.id;
    await command({
      type: "rule-review",
      ruleId,
      decision: "active",
      actor: "reviewer",
      reason: "レビュー基準の原文を確認して承認",
    });
    const findingId = "rule-backed-model-judgment";
    await command({
      type: "finding-observation",
      findingId,
      fingerprint: "rule-backed-model-fingerprint",
      targetVersion: fixture.commits.baseline,
      observation: "基準に照らして確認した過去観測",
      sourceRefs: [sourceRefs[2]!, sourceRefs[0]!],
    });
    await command({
      type: "finding-decision",
      findingId,
      judgment: "accepted_known",
      actor: "reviewer",
      reason: "承認済みレビュー基準により既知と判断",
      targetVersion: fixture.commits.baseline,
      sourceRefs: judgmentSourceRefs,
      ruleRefs: [{ id: ruleId, revision: 1 }],
    });

    const firstStarted = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(firstStarted.statusCode, firstStarted.body).toBe(202);
    const first = await waitForRun(
      product.id,
      firstStarted.json<DiagnosticRun>().id,
    );
    expect(first.modelReview?.coverage.status).toBe("complete");
    expect(prompts).toHaveLength(1);
    const firstPayload = payloadFromPrompt(prompts[0]!);
    const inputKnowledge = firstPayload.approvedKnowledge.find(
      (item) => item.id === knowledgeId,
    );
    expect(inputKnowledge?.content).toBe(
      "複数資料で確認した証明書検証の承認済み運用知識。",
    );
    expect(
      inputKnowledge?.sourceRefs?.map(({ id, version, excerpt }) => ({
        id,
        version,
        excerpt,
      })),
    ).toEqual([
      {
        id: sourceRefs[2]!.docId,
        version: String(sourceRefs[2]!.revision),
        excerpt: sourceRefs[2]!.excerpt,
      },
      {
        id: sourceRefs[0]!.docId,
        version: String(sourceRefs[0]!.revision),
        excerpt: sourceRefs[0]!.excerpt,
      },
      {
        id: sourceRefs[1]!.docId,
        version: String(sourceRefs[1]!.revision),
        excerpt: sourceRefs[1]!.excerpt,
      },
    ]);
    expect(
      inputKnowledge?.sourceRefs?.every(({ hash }) =>
        /^[a-f0-9]{64}$/.test(hash),
      ),
    ).toBe(true);
    expect(firstPayload.matchingPastJudgments).toEqual([
      expect.objectContaining({
        id: `${findingId}-decision-2`,
        sourceRefs: judgmentSourceRefs.map((source) =>
          expect.objectContaining({
            id: source.docId,
            version: String(source.revision),
            excerpt: source.excerpt,
          }),
        ),
      }),
    ]);

    state = (await call(workflowUrl)).json();
    await command({
      type: "rule-draft",
      supersedes: { id: ruleId, revision: 1 },
      purpose: state.scope.purpose,
      content: "更新後の通信設定基準は別の証明書運用を要求する。",
      applicability: "更新後固定版の通信設定レビュー",
      appliesToVersion: fixture.commits.baseline,
      sourceRefs: [sourceRefs[0]!, sourceRefs[1]!],
    });
    await command({
      type: "rule-review",
      ruleId,
      decision: "active",
      actor: "reviewer",
      reason: "更新後のレビュー基準を承認",
    });
    expect(
      state.rules.find((rule) => rule.id === ruleId && rule.revision === 1)
        ?.status,
    ).toBe("stale");
    expect(
      state.rules.find((rule) => rule.id === ruleId && rule.revision === 2)
        ?.status,
    ).toBe("active");

    prompts.length = 0;
    const secondStarted = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(secondStarted.statusCode, secondStarted.body).toBe(202);
    const second = await waitForRun(
      product.id,
      secondStarted.json<DiagnosticRun>().id,
    );
    expect(second.modelReview?.coverage.status).toBe("complete");
    expect(prompts).toHaveLength(1);
    const secondPayload = payloadFromPrompt(prompts[0]!);
    expect(secondPayload.matchingPastJudgments).toEqual([]);
    expect(secondPayload.approvedKnowledge).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: knowledgeId })]),
    );
  });

  it("別findingの現行判断変更はモデル比較contextを変え、再確認を要求する", async () => {
    prompts.length = 0;
    const product = await createProduct("モデル比較contextの判断境界");
    const firstStarted = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(firstStarted.statusCode, firstStarted.body).toBe(202);
    const first = await waitForRun(
      product.id,
      firstStarted.json<DiagnosticRun>().id,
    );
    const firstModel = first.findings.find(
      (finding) => finding.engine === "model",
    );
    expect(firstModel).toBeTruthy();
    const firstContextHash = first.modelReview?.contextHash;
    const firstInputHash = first.modelReview?.inputHash;
    expect(firstContextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(firstInputHash).toMatch(/^[a-f0-9]{64}$/);

    const workflowUrl = `/api/projects/${product.linkedProjectId}/workflow`;
    const initial = await call(workflowUrl);
    let state = initial.json<{
      revision: number;
      scope: Record<string, unknown>;
      documents: { id: string; revision: number; body: string }[];
    }>();
    const command = async (value: unknown) => {
      const response = await call(`${workflowUrl}/commands`, {
        revision: state.revision,
        command: value,
      });
      expect(response.statusCode, response.body).toBe(200);
      state = response.json();
    };
    const specification = state.documents.find((document) =>
      document.body.includes("TLS接続"),
    )!;
    const sourceRef = {
      docId: specification.id,
      revision: specification.revision,
      excerpt: "TLS接続",
    };
    await command({
      type: "scope",
      value: { ...state.scope, version: fixture.commits.baseline },
    });
    await command({
      type: "finding-observation",
      findingId: "other-current-judgment",
      fingerprint: "other-current-fingerprint",
      targetVersion: fixture.commits.baseline,
      observation: "別findingの現行観測",
      sourceRefs: [sourceRef],
    });
    await command({
      type: "finding-decision",
      findingId: "other-current-judgment",
      judgment: "accepted_known",
      actor: "reviewer",
      reason: "別findingの現行判断",
      targetVersion: fixture.commits.baseline,
      sourceRefs: [sourceRef],
      ruleRefs: [],
    });

    const secondStarted = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(secondStarted.statusCode, secondStarted.body).toBe(202);
    const second = await waitForRun(
      product.id,
      secondStarted.json<DiagnosticRun>().id,
    );
    expect(second.modelReview?.contextHash).not.toBe(firstContextHash);
    expect(second.modelReview?.inputHash).not.toBe(firstInputHash);
    expect(
      second.findings.find(
        (finding) => finding.engine === "model" && finding.presentInAnalysis,
      ),
    ).toMatchObject({
      fingerprint: firstModel!.fingerprint,
      delta: "needs_review",
    });
  });

  it("blockedまたは未分類sourceの過去判断をlocal modelへ送らない", async () => {
    prompts.length = 0;
    const product = await createProduct("モデル入力の情報区分境界");
    const workflowUrl = `/api/projects/${product.linkedProjectId}/workflow`;
    const initial = await call(workflowUrl);
    let state = initial.json<{
      revision: number;
      scope: Record<string, unknown>;
      documents: { id: string; revision: number }[];
    }>();
    const command = async (value: unknown) => {
      const response = await call(`${workflowUrl}/commands`, {
        revision: state.revision,
        command: value,
      });
      expect(response.statusCode, response.body).toBe(200);
      state = response.json();
    };
    await command({
      type: "document",
      value: {
        title: "送信不可資料",
        body: "送信してはいけない過去判断の根拠",
        url: "https://example.test/blocked-model-source",
        classification: "blocked",
      },
    });
    const blocked = state.documents.at(-1)!;
    await command({
      type: "scope",
      value: { ...state.scope, version: fixture.commits.baseline },
    });
    const findingId = "blocked-source-judgment";
    await command({
      type: "finding-observation",
      findingId,
      fingerprint: "blocked-source-fingerprint",
      targetVersion: fixture.commits.baseline,
      observation: "送信不可資料を根拠にした過去観測",
      sourceRefs: [
        {
          docId: blocked.id,
          revision: blocked.revision,
          excerpt: "送信してはいけない過去判断の根拠",
        },
      ],
    });
    await command({
      type: "finding-decision",
      findingId,
      judgment: "accepted_known",
      actor: "reviewer",
      reason: "過去判断",
      targetVersion: fixture.commits.baseline,
      sourceRefs: [
        {
          docId: blocked.id,
          revision: blocked.revision,
          excerpt: "送信してはいけない過去判断の根拠",
        },
      ],
      ruleRefs: [],
    });
    const started = await call(`/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = await waitForRun(product.id, started.json<DiagnosticRun>().id);
    expect(run.modelReview?.coverage.status).toBe("complete");
    const payload = payloadFromPrompt(prompts[0]!);
    expect(payload.matchingPastJudgments).toEqual([]);
    expect(prompts[0]).not.toContain("送信してはいけない過去判断の根拠");
  });

  it("モデル停止時は保存済みbatchのpartial coverageをrunへ残す", async () => {
    let invocation = 0;
    const stoppedApp = await createApp({
      dbPath: ":memory:",
      diagnosticsRepositories: { fixture: fixture.directory },
      diagnosticsFetch: async () => {
        throw new Error("外部依存照会はこの試験では許可しません");
      },
      workflowProviders: [provider],
      modelReviewBatchSize: 1,
      workflowInvokeModel: async (_provider, prompt) => {
        invocation++;
        if (invocation > 1) throw new Error("テスト用モデル停止");
        return {
          response: responseFor(prompt, false),
          model: provider.model,
          configVersion: provider.configVersion,
          actualCostUsd: 0,
        };
      },
    });
    try {
      const created = await stoppedApp.inject({
        url: "/api/products",
        method: "POST",
        headers,
        payload: JSON.stringify({
          title: "モデル停止coverage",
          repositoryId: "fixture",
          ref: "baseline",
          specification: "TLS接続の証明書検証を必須とする製品。",
          modelReview: {
            enabled: true,
            providerId: "local",
            cloudConsent: false,
          },
        }),
      });
      expect(created.statusCode, created.body).toBe(201);
      const product = created.json<Product>();
      const started = await stoppedApp.inject({
        url: `/api/products/${product.id}/runs`,
        method: "POST",
        headers,
        payload: JSON.stringify({ trigger: "manual", ref: "baseline" }),
      });
      expect(started.statusCode, started.body).toBe(202);
      const startedRun = started.json<DiagnosticRun>();
      let run = startedRun;
      for (let attempt = 0; attempt < 500; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const response = await stoppedApp.inject({
          url: `/api/products/${product.id}/runs/${startedRun.id}`,
          headers,
        });
        run = response.json<DiagnosticRun>();
        if (!["queued", "running"].includes(run.status)) break;
      }
      expect(run.modelReview?.coverage).toMatchObject({
        status: "partial",
        completedBatchCount: 1,
        assessedFiles: 1,
        isSafetyProof: false,
      });
      expect(run.modelReview?.failure).toContain("テスト用モデル停止");
    } finally {
      await stoppedApp.close();
    }
  });
});
