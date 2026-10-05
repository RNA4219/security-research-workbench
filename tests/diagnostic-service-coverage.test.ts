import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ProductDiagnosticsService } from "../src/server/diagnostic-service.js";
import { Store } from "../src/server/store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import type { DiagnosticCoverage, DiagnosticSnapshot } from "../src/shared/diagnostic-engine.js";
import type {
  ModelReviewBudget,
  ModelReviewCheckpoint,
  ModelReviewCoverage,
  ModelReviewFinding,
} from "../src/shared/model-review.js";
import type { Product } from "../src/shared/product-diagnostics.js";
import type { WorkflowProviderDefinition } from "../src/server/workflow-runner.js";
import { plannedModelReviewBatchCount } from "../src/server/model-review.js";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";

const hash = "a".repeat(64);

const provider = (
  overrides: Partial<WorkflowProviderDefinition> = {},
): WorkflowProviderDefinition => ({
  id: "local",
  kind: "local",
  label: "local test provider",
  model: "local-test",
  available: true,
  costKnown: true,
  configVersion: "local-v1",
  ...overrides,
});

const coverage = (
  status: ModelReviewCoverage["status"],
  overrides: Partial<ModelReviewCoverage> = {},
): ModelReviewCoverage => ({
  status,
  batchCount: 1,
  completedBatchCount: status === "complete" ? 1 : 0,
  assessedFiles: 1,
  assessedLines: 2,
  omitted: [],
  limitations: [],
  isSafetyProof: false,
  ...overrides,
});

const finding = (
  overrides: Partial<ModelReviewFinding> = {},
): ModelReviewFinding => ({
  id: "model-finding",
  category: "configuration",
  severity: "low",
  title: "設定確認が必要です",
  rationale: "固定snapshotの設定を確認してください。",
  path: "src\\client.ts",
  line: 4,
  originalText: "  const configured = true;  ",
  specRefIds: [],
  relatedFixedFindingIds: [],
  pastJudgmentIds: [],
  remediation: {
    guidance: "担当者が根拠を確認してください。",
    humanReviewRequired: true,
  },
  falsePositiveCandidate: false,
  uncertainty: { level: "low", reasons: [] },
  ...overrides,
});

type DiagnosticServiceInternals = {
  modelReviewCoverageToDiagnostic(
    value: ModelReviewCoverage,
  ): DiagnosticCoverage;
  modelReviewCheckpointCoverage(
    checkpoint: ModelReviewCheckpoint,
    snapshot: DiagnosticSnapshot,
    plannedBatchCount?: number,
  ): ModelReviewCoverage;
  modelFindingToDiagnostic(
    value: ModelReviewFinding,
    occurrence?: number,
  ): { fingerprint: string; severity: string; evidence: string; path: string };
  unavailableModelReview(
    product: Product,
    provider: WorkflowProviderDefinition | null,
    reason: string,
    pending?: boolean,
  ): {
    enabled: boolean;
    providerId: string | null;
    providerKind: string | null;
    model: string | null;
    configVersion: string | null;
    coverage: ModelReviewCoverage;
    failure: string | null;
  };
};

describe("診断serviceの境界変換", () => {
  it("provider一覧は安全な識別情報だけを返し、local/cloud/manualの利用可能性を区別する", async () => {
    const fixture = await createDiagnosticFixture();
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
      workflowProviders: [
        provider({ id: "local-with-endpoint", endpoint: "http://local.invalid" }),
        provider({
          id: "local-unavailable",
          available: false,
          endpoint: "http://secret.invalid",
          apiKey: "should-not-be-returned",
        }),
        provider({
          id: "cloud-with-endpoint",
          kind: "cloud",
          endpoint: "https://cloud.invalid",
          apiKey: "cloud-secret",
          maxOutputTokens: 1024,
        }),
        provider({ id: "manual-provider", kind: "manual" }),
      ],
    });
    try {
      const listed = service.listModelReviewProviders();
      expect(listed.map((item) => item.id)).toEqual([
        "local-with-endpoint",
        "local-unavailable",
        "cloud-with-endpoint",
      ]);
      expect(listed).toEqual([
        expect.objectContaining({
          id: "local-with-endpoint",
          kind: "local",
          available: true,
          maxOutputTokens: 2048,
        }),
        expect.objectContaining({
          id: "local-unavailable",
          available: false,
          maxOutputTokens: 2048,
        }),
        expect.objectContaining({
          id: "cloud-with-endpoint",
          kind: "cloud",
          available: true,
          maxOutputTokens: 1024,
        }),
      ]);
      expect(JSON.stringify(listed)).not.toContain("secret.invalid");
      expect(JSON.stringify(listed)).not.toContain("cloud-secret");
    } finally {
      await service.close();
      store.close();
    }
  });

  it("製品登録時の対象refを初回runで再固定しても承認済みknowledgeを失効させない", async () => {
    const fixture = await createDiagnosticFixture();
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const product = service.createProduct({
        title: "初回knowledge保持",
        repositoryId: "fixture",
        ref: "baseline",
        specification: "TLS接続の証明書検証を必須とする。",
      });
      const workflows = new WorkflowStore(store);
      let state = workflows.get(product.linkedProjectId);
      const specification = state.documents.find(
        (document) => document.title === "製品仕様",
      )!;
      state = workflows.command(product.linkedProjectId, state.revision, {
        type: "knowledge-draft",
        purpose: state.scope.purpose,
        content: "証明書検証を必須とする承認済み運用知識。",
        sourceRefs: [
          {
            docId: specification.id,
            revision: specification.revision,
            excerpt: "証明書検証を必須",
          },
        ],
        origin: "manual",
      });
      const knowledgeId = state.knowledge.at(-1)!.id;
      state = workflows.command(product.linkedProjectId, state.revision, {
        type: "knowledge-review",
        knowledgeId,
        decision: "active",
        actor: "reviewer",
        reason: "製品仕様の原文と照合済み",
      });
      expect(state.scope.version).toBe("baseline");
      expect(state.knowledge[0]?.status).toBe("active");

      const started = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      let run = service.getRun(product.id, started.id);
      for (
        let index = 0;
        index < 300 && ["queued", "running"].includes(run.status);
        index++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        run = service.getRun(product.id, started.id);
      }
      expect(run.knowledge).toHaveLength(1);
      expect(run.knowledge[0]?.id).toBe(knowledgeId);
      expect(
        new WorkflowStore(store).get(product.linkedProjectId).knowledge[0]?.status,
      ).toBe("active");
    } finally {
      await service.close();
      store.close();
    }
  });

  it("有効化したmodel providerの案件境界を拒否理由ごとに区別する", async () => {
    const fixture = await createDiagnosticFixture();
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
      workflowProviders: [
        provider({ id: "local", endpoint: "http://local.invalid" }),
        provider({ id: "cloud", kind: "cloud", endpoint: "https://cloud.invalid" }),
        provider({ id: "manual", kind: "manual", endpoint: "http://manual.invalid" }),
        provider({ id: "offline", available: false, endpoint: "http://offline.invalid" }),
      ],
    });
    const allowMethodsAndProvider = (projectId: string, allowedProviderIds: string[]) => {
      const workflows = new WorkflowStore(store);
      const state = workflows.get(projectId);
      return workflows.command(projectId, state.revision, {
        type: "scope",
        value: {
          ...state.scope,
          allowedMethods: ["static-review", "known-issue-match"],
          allowedProviderIds,
        },
      });
    };
    const product = (id: string, providerId: string, cloudConsent = false) =>
      service.createProduct({
        title: id,
        repositoryId: "fixture",
        ref: "baseline",
        specification: "固定版の防御的レビュー",
        modelReview: { enabled: true, providerId, cloudConsent },
      });
    try {
      const cloud = product("cloud consent", "cloud");
      allowMethodsAndProvider(cloud.linkedProjectId, ["cloud"]);
      await expect(
        service.startRun(cloud.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("明示同意") });

      const consentedCloud = product("cloud unsupported", "cloud", true);
      allowMethodsAndProvider(consentedCloud.linkedProjectId, ["cloud"]);
      await expect(
        service.startRun(consentedCloud.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("外部送信") });

      const manual = product("manual provider", "manual");
      allowMethodsAndProvider(manual.linkedProjectId, ["manual"]);
      await expect(
        service.startRun(manual.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("local provider") });

      const offline = product("offline provider", "offline");
      allowMethodsAndProvider(offline.linkedProjectId, ["offline"]);
      await expect(
        service.startRun(offline.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("利用できません") });

      const disallowed = product("disallowed provider", "local");
      allowMethodsAndProvider(disallowed.linkedProjectId, ["manual"]);
      await expect(
        service.startRun(disallowed.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("許可されていない") });

      const missing = product("missing provider", "missing");
      allowMethodsAndProvider(missing.linkedProjectId, ["missing"]);
      await expect(
        service.startRun(missing.id, { trigger: "manual", ref: "baseline" }),
      ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("providerがありません") });
    } finally {
      await service.close();
      store.close();
    }
  });

  it("model findingとcoverageの変換はseverity・不確実性・停止状態を保持する", async () => {
    const fixture = await createDiagnosticFixture();
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const internals = service as unknown as DiagnosticServiceInternals;
      const high = internals.modelFindingToDiagnostic(
        finding({ severity: "high", uncertainty: { level: "high", reasons: ["要確認"] } }),
      );
      const medium = internals.modelFindingToDiagnostic(
        finding({ severity: "medium", originalText: "const configured = true;" }),
        2,
      );
      const info = internals.modelFindingToDiagnostic(
        finding({ severity: "info" }),
      );
      expect(high.severity).toBe("high");
      expect(medium.severity).toBe("medium");
      expect(info.severity).toBe("low");
      expect(high.evidence).toContain("不確実性: 要確認");
      expect(info.evidence).not.toContain("不確実性:");
      expect(high.path).toBe("src\\client.ts");
      expect(high.fingerprint).not.toBe(medium.fingerprint);

      const mapped = (status: ModelReviewCoverage["status"]) =>
        internals.modelReviewCoverageToDiagnostic(
          coverage(status, { omitted: [{ path: "src/missing.ts", reason: "除外" }] }),
        );
      expect(mapped("complete").status).toBe("complete");
      expect(mapped("unavailable").status).toBe("unavailable");
      expect(mapped("stopped").status).toBe("partial");
      expect(mapped("partial").status).toBe("partial");
      expect(mapped("complete").omitted).toEqual([
        { path: "src/missing.ts", reason: "除外" },
      ]);
    } finally {
      await service.close();
      store.close();
    }
  });

  it("停止済みmodel checkpointのcoverageは重複omissionと未収録pathを安全に集計する", async () => {
    const fixture = await createDiagnosticFixture();
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const internals = service as unknown as DiagnosticServiceInternals;
      const batch = {
        index: 0,
        filePaths: ["src/client.ts", "src/missing.ts"],
        fileHashes: [hash],
        promptHash: hash,
        responseHash: hash,
        findings: [],
        omitted: [
          { path: "src/omitted.ts", startLine: 1, endLine: 2, reason: "budget" },
          { path: "src/omitted.ts", startLine: 1, endLine: 2, reason: "budget" },
          { path: "src/other.ts", reason: "binary" },
        ],
        limitations: ["モデル停止", "モデル停止"],
        elapsedMs: 10,
        actualCostUsd: null,
      };
      const checkpoint = {
        schemaVersion: "1",
        identity: {
          snapshot: hash,
          input: hash,
          knowledge: hash,
          provider: hash,
          model: hash,
          config: hash,
          plan: hash,
        },
        batches: [batch],
        updatedAt: new Date().toISOString(),
      } as ModelReviewCheckpoint;
      const snapshot: DiagnosticSnapshot = {
        commit: "b".repeat(40),
        manifestHash: hash,
        files: [
          { path: "src/client.ts", hash, content: "one\ntwo\n" },
        ],
        omitted: [],
      };
      const partial = internals.modelReviewCheckpointCoverage(checkpoint, snapshot);
      expect(partial).toMatchObject({
        status: "partial",
        batchCount: 1,
        completedBatchCount: 1,
        assessedFiles: 2,
        assessedLines: 3,
        isSafetyProof: false,
      });
      expect(partial.omitted).toHaveLength(2);
      expect(partial.limitations).toEqual([
        "モデル診断は中断され、完了batchのcoverageだけを保存しています。",
        "モデル停止",
      ]);
      expect(
        internals.modelReviewCheckpointCoverage(checkpoint, snapshot, 3),
      ).toMatchObject({ batchCount: 3, completedBatchCount: 1 });
      const unavailable = internals.modelReviewCheckpointCoverage(
        { ...checkpoint, batches: [] },
        snapshot,
      );
      expect(unavailable).toMatchObject({
        status: "unavailable",
        batchCount: 0,
        assessedFiles: 0,
        assessedLines: 0,
      });
    } finally {
      await service.close();
      store.close();
    }
  });

  it("record未生成の中断checkpointでもbudget変更のresumeを409で拒否する", async () => {
    const fixture = await createDiagnosticFixture();
    const dbPath = `.cache/diagnostic-budget-${randomUUID()}.sqlite`;
    const invoke = async (
      _provider: WorkflowProviderDefinition,
      _prompt: string,
      _signal: AbortSignal,
    ) => ({
      response: JSON.stringify({
        schemaVersion: "1",
        findings: [],
        omitted: [],
        limitations: [],
      }),
      model: "budget-test",
      configVersion: "budget-v1",
      actualCostUsd: 0,
    });
    let invocation = 0;
    let store: Store | undefined = new Store(dbPath);
    let service: ProductDiagnosticsService | undefined = new ProductDiagnosticsService(
      store,
      {
        repositories: { fixture: fixture.directory },
        scheduleIntervalMs: 0,
        modelReviewBatchSize: 1,
        modelReviewBudget: { maxBatches: 2 },
        workflowProviders: [provider({ model: "budget-test", configVersion: "budget-v1" })],
        workflowInvokeModel: async (selected, prompt, signal) => {
          invocation++;
          const result = await invoke(selected, prompt, signal);
          // The first batch is checkpointed; the second batch fails before a
          // report is produced, leaving record=null by design.
          if (invocation === 1) return result;
          throw new Error("budget checkpoint stop");
        },
      },
    );
    try {
      const product = service.createProduct({
        title: "budget checkpoint resume",
        repositoryId: "fixture",
        ref: "baseline",
        specification: "固定版の防御的レビュー",
        modelReview: { enabled: true, providerId: "local", cloudConsent: false },
      });
      const started = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      let run = service.getRun(product.id, started.id);
      for (
        let index = 0;
        index < 500 && ["queued", "running"].includes(run.status);
        index++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        run = service.getRun(product.id, started.id);
      }
      expect(run.status).toBe("partial");
      expect(run.modelReview).toMatchObject({
        budget: { maxBatches: 2 },
        coverage: { batchCount: 2, completedBatchCount: 1 },
        record: null,
      });

      await service.close();
      service = undefined;
      store?.close();
      store = undefined;

      store = new Store(dbPath);
      service = new ProductDiagnosticsService(store, {
        repositories: { fixture: fixture.directory },
        scheduleIntervalMs: 0,
        modelReviewBatchSize: 1,
        modelReviewBudget: { maxBatches: 3 },
        workflowProviders: [provider({ model: "budget-test", configVersion: "budget-v1" })],
        workflowInvokeModel: async () => {
          throw new Error("resume must be rejected before model invocation");
        },
      });
      await expect(service.resume(product.id, started.id)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("予算設定がcheckpoint作成時から変わっています"),
      });
    } finally {
      await service?.close();
      store?.close();
      for (const suffix of ["", "-wal", "-shm"])
        await rm(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("予定batch数は本番plannerのsource・batch・budget境界を反映する", () => {
    const snapshot: DiagnosticSnapshot = {
      commit: "b".repeat(40),
      manifestHash: hash,
      files: [
        { path: "z.ts", hash, content: "z".repeat(4) },
        { path: "a.ts", hash, content: "a".repeat(4) },
        { path: "too-large.ts", hash, content: "x".repeat(12) },
        { path: "max-input.ts", hash, content: "i".repeat(4) },
      ],
      omitted: [],
    };
    const budget: ModelReviewBudget = {
      maxBatches: 2,
      maxFiles: 2,
      maxInputChars: 8,
      maxBatchChars: 8,
      maxPromptChars: 20,
      maxOutputTokens: 10,
    };
    expect(plannedModelReviewBatchCount(snapshot, budget, 1)).toBe(2);
    expect(plannedModelReviewBatchCount(snapshot, budget, 2)).toBe(1);
    expect(
      plannedModelReviewBatchCount(snapshot, { ...budget, maxBatches: 1 }, 1),
    ).toBe(1);
    expect(
      plannedModelReviewBatchCount(snapshot, { ...budget, maxFiles: 1 }, 1),
    ).toBe(1);
    expect(
      plannedModelReviewBatchCount(snapshot, { ...budget, maxInputChars: 4 }, 1),
    ).toBe(1);
    expect(
      plannedModelReviewBatchCount(snapshot, { ...budget, maxBatchChars: 3 }, 1),
    ).toBe(0);
    expect(() => plannedModelReviewBatchCount(snapshot, budget, 0)).toThrow(
      "batchSizeが不正です",
    );
  });

  it("未実行model reviewの記録は旧製品設定とprovider種別を後方互換で表現する", async () => {
    const fixture = await createDiagnosticFixture();
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const internals = service as unknown as DiagnosticServiceInternals;
      const product = service.createProduct({
        title: "legacy model setting",
        repositoryId: "fixture",
        ref: "baseline",
        specification: "既存製品の仕様",
      });
      const manual = provider({ id: "manual", kind: "manual" });
      const legacy = internals.unavailableModelReview(product, null, "disabled", true);
      expect(legacy).toMatchObject({
        enabled: false,
        providerId: "local",
        providerKind: null,
        failure: null,
      });
      const unavailable = internals.unavailableModelReview(
        product,
        manual,
        "provider unavailable",
      );
      expect(unavailable).toMatchObject({
        enabled: false,
        providerId: "manual",
        providerKind: null,
        model: "local-test",
        configVersion: "local-v1",
        failure: "provider unavailable",
      });
      expect(unavailable.coverage.status).toBe("unavailable");
      expect(unavailable.coverage.isSafetyProof).toBe(false);
    } finally {
      await service.close();
      store.close();
    }
  });
});
