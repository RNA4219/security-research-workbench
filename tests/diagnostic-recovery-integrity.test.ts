import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { ProductDiagnosticsService } from "../src/server/diagnostic-service.js";
import { Store } from "../src/server/store.js";
import type { DiagnosticRun } from "../src/shared/product-diagnostics.js";
import type { WorkflowProviderDefinition } from "../src/server/workflow-runner.js";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";

const exec = promisify(execFile);

const terminalStatuses = new Set([
  "completed",
  "partial",
  "failed",
  "stopped",
  "interrupted",
]);

let fixture: Awaited<ReturnType<typeof createDiagnosticFixture>>;

beforeAll(async () => {
  fixture = await createDiagnosticFixture();
});

const provider = (
  overrides: Partial<WorkflowProviderDefinition> = {},
): WorkflowProviderDefinition => ({
  id: "local",
  kind: "local",
  label: "recovery test local provider",
  model: "recovery-test-model",
  available: true,
  costKnown: true,
  configVersion: "recovery-v1",
  ...overrides,
});

const serviceOptions = (
  extra: Partial<
    ConstructorParameters<typeof ProductDiagnosticsService>[1]
  > = {},
) => ({
  repositories: { fixture: fixture.directory },
  scheduleIntervalMs: 0,
  ...extra,
});

async function waitForTerminal(
  service: ProductDiagnosticsService,
  productId: string,
  runId: string,
) {
  let current = service.getRun(productId, runId);
  for (let attempt = 0; attempt < 500; attempt++) {
    if (terminalStatuses.has(current.status)) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = service.getRun(productId, runId);
  }
  return current;
}

function createProduct(
  service: ProductDiagnosticsService,
  title: string,
  modelReview = false,
  repositoryId = "fixture",
) {
  return service.createProduct({
    title,
    repositoryId,
    ref: "baseline",
    specification: `${title} の固定版防御レビュー要件`,
    ...(modelReview
      ? {
          modelReview: {
            enabled: true,
            providerId: "local",
            cloudConsent: false,
          },
        }
      : {}),
  });
}

function modelFindingResponse() {
  return JSON.stringify({
    schemaVersion: "1",
    findings: [
      {
        id: "checkpoint-recovery-model-finding",
        category: "trust-boundary",
        severity: "medium",
        title: "通信設定の仕様照合候補",
        rationale:
          "固定snapshotの通信設定を担当者が仕様と照合する必要があります。",
        path: "src/client.ts",
        line: 2,
        originalText:
          "export const client = new https.Agent({ rejectUnauthorized: false });",
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
    ],
    omitted: [],
    limitations: [],
  });
}

function markPartial(store: Store, run: DiagnosticRun) {
  const at = new Date().toISOString();
  const value: DiagnosticRun = {
    ...run,
    status: "partial",
    updatedAt: at,
    finishedAt: run.finishedAt ?? at,
    failure: null,
    statusHistory: [
      ...run.statusHistory,
      { status: "partial" as const, at, reason: "recovery fixture" },
    ].slice(-100),
  };
  store.db
    .prepare("UPDATE diagnostic_runs SET status=?,data=? WHERE id=?")
    .run(value.status, JSON.stringify(value), value.id);
  return value;
}

async function removeDatabase(pathname: string) {
  for (const suffix of ["", "-wal", "-shm"])
    await rm(`${pathname}${suffix}`, { force: true });
}

/**
 * READMEやpackage.json等の診断対象外ファイルを含めず、両engineの全範囲を
 * 完了できる固定snapshotを用意する。生成したソースは実行せず、git操作は
 * snapshotの固定にだけ使う。
 */
async function createMinimalDiagnosticRepository() {
  const root = await mkdtemp(join(resolve(".cache"), "diagnostic-minimal-"));
  await mkdir(join(root, "src"), { recursive: true });
  const git = async (...args: string[]) => {
    const result = await exec(
      "git",
      ["-c", "core.hooksPath=", "-C", root, ...args],
      {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return String(result.stdout).trim();
  };
  await git("init", "--quiet");
  await git("config", "user.name", "Workbench Minimal Diagnostic Fixture");
  await git("config", "user.email", "minimal-fixture@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(root, "src", "index.js"), "export const value = 1;\n");
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "minimal-diagnostic-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "minimal-diagnostic-fixture", version: "1.0.0" },
      },
    }),
  );
  await git("add", "--", ".");
  await git("commit", "--quiet", "-m", "minimal diagnostic fixture");
  const commit = await git("rev-parse", "HEAD");
  await git("branch", "baseline", commit);
  return { directory: root, commit };
}

describe("診断保存データの再開整合性", () => {
  it("checkpoint identityが壊れているrunを再開せず、partialのまま保持する", async () => {
    const dbPath = join(
      ".cache",
      `diagnostic-recovery-identity-${randomUUID()}.sqlite`,
    );
    let store: Store | undefined = new Store(dbPath);
    let service: ProductDiagnosticsService | undefined =
      new ProductDiagnosticsService(store, serviceOptions());
    let productId = "";
    let runId = "";
    try {
      const product = createProduct(service, "壊れたcheckpoint identity");
      productId = product.id;
      const started = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      runId = started.id;
      const completed = await waitForTerminal(service, product.id, started.id);
      expect(["completed", "partial"]).toContain(completed.status);
      const partial = markPartial(store, completed);
      store.db
        .prepare("UPDATE diagnostic_checkpoints SET identity=? WHERE run_id=?")
        .run("tampered-checkpoint-identity", started.id);

      await service.close();
      service = undefined;
      store.close();
      store = undefined;
      store = new Store(dbPath);
      service = new ProductDiagnosticsService(store, serviceOptions());

      await expect(service.resume(productId, runId)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("固定入力"),
      });
      const unchanged = service.getRun(productId, runId);
      expect(unchanged.status).toBe("partial");
      expect(unchanged.revision).toBe(partial.revision);
      expect(unchanged.statusHistory.at(-1)?.status).toBe("partial");
    } finally {
      await service?.close();
      store?.close();
      await removeDatabase(dbPath);
    }
  });

  it("固定snapshotのcommitが壊れている再開はfailedになり、completed扱いにしない", async () => {
    const dbPath = join(
      ".cache",
      `diagnostic-recovery-snapshot-${randomUUID()}.sqlite`,
    );
    let store: Store | undefined = new Store(dbPath);
    let service: ProductDiagnosticsService | undefined =
      new ProductDiagnosticsService(store, serviceOptions());
    try {
      const product = createProduct(service, "壊れたsnapshot commit");
      const started = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const completed = await waitForTerminal(service, product.id, started.id);
      expect(["completed", "partial"]).toContain(completed.status);
      markPartial(store, completed);
      const checkpoint = service.products.getCheckpoint(started.id)!;
      expect(checkpoint.snapshot).not.toBeNull();
      store.db
        .prepare("UPDATE diagnostic_checkpoints SET snapshot=? WHERE run_id=?")
        .run(
          JSON.stringify({
            ...checkpoint.snapshot,
            commit: "c".repeat(40),
          }),
          started.id,
        );

      await service.close();
      service = undefined;
      store.close();
      store = undefined;
      store = new Store(dbPath);
      service = new ProductDiagnosticsService(store, serviceOptions());

      const queued = await service.resume(product.id, started.id);
      expect(queued.status).toBe("queued");
      const failed = await waitForTerminal(service, product.id, started.id);
      expect(failed.status).toBe("failed");
      expect(failed.failure).toBe("固定commitの診断に失敗しました");
      expect(failed.status).not.toBe("completed");
      expect(service.products.getCheckpoint(started.id)?.snapshot?.commit).toBe(
        "c".repeat(40),
      );
    } finally {
      await service?.close();
      store?.close();
      await removeDatabase(dbPath);
    }
  });

  it("保存snapshotのJSONが壊れている再開はcheckpointを修復せず拒否する", async () => {
    const dbPath = join(
      ".cache",
      `diagnostic-recovery-json-${randomUUID()}.sqlite`,
    );
    let store: Store | undefined = new Store(dbPath);
    let service: ProductDiagnosticsService | undefined =
      new ProductDiagnosticsService(store, serviceOptions());
    try {
      const product = createProduct(service, "壊れたsnapshot JSON");
      const started = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const completed = await waitForTerminal(service, product.id, started.id);
      expect(["completed", "partial"]).toContain(completed.status);
      const partial = markPartial(store, completed);
      store.db
        .prepare("UPDATE diagnostic_checkpoints SET snapshot=? WHERE run_id=?")
        .run("{broken-json", started.id);

      await service.close();
      service = undefined;
      store.close();
      store = undefined;
      store = new Store(dbPath);
      service = new ProductDiagnosticsService(store, serviceOptions());

      await expect(service.resume(product.id, started.id)).rejects.toThrow();
      expect(service.getRun(product.id, started.id)).toMatchObject({
        status: "partial",
        revision: partial.revision,
      });
      expect(
        store.db
          .prepare("SELECT snapshot FROM diagnostic_checkpoints WHERE run_id=?")
          .get(started.id),
      ).toEqual({ snapshot: "{broken-json" });
    } finally {
      await service?.close();
      store?.close();
      await removeDatabase(dbPath);
    }
  });

  it("checkpoint行がない旧形式のrunは保存済み結果を捏造せず、再計算してから終了する", async () => {
    const dbPath = join(
      ".cache",
      `diagnostic-recovery-old-${randomUUID()}.sqlite`,
    );
    let store: Store | undefined = new Store(dbPath);
    let service: ProductDiagnosticsService | undefined =
      new ProductDiagnosticsService(store, serviceOptions());
    try {
      const product = createProduct(service, "旧形式checkpoint");
      const started = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const completed = await waitForTerminal(service, product.id, started.id);
      expect(["completed", "partial"]).toContain(completed.status);
      markPartial(store, completed);
      store.db
        .prepare("DELETE FROM diagnostic_checkpoints WHERE run_id=?")
        .run(started.id);

      await service.close();
      service = undefined;
      store.close();
      store = undefined;
      store = new Store(dbPath);
      service = new ProductDiagnosticsService(store, serviceOptions());

      const queued = await service.resume(product.id, started.id);
      expect(queued.status).toBe("queued");
      const resumed = await waitForTerminal(service, product.id, started.id);
      expect(["completed", "partial"]).toContain(resumed.status);
      expect(resumed.status).not.toBe("failed");
      const checkpoint = service.products.getCheckpoint(started.id);
      expect(checkpoint?.snapshot?.commit).toBe(resumed.commit);
      expect(checkpoint?.identity).toEqual(expect.any(String));
    } finally {
      await service?.close();
      store?.close();
      await removeDatabase(dbPath);
    }
  });

  it("旧runでmodelReviewとmodel checkpointが欠けていても再開失敗を完了扱いにしない", async () => {
    const dbPath = join(
      ".cache",
      `diagnostic-recovery-model-legacy-${randomUUID()}.sqlite`,
    );
    let calls = 0;
    const modelOptions = serviceOptions({
      workflowProviders: [provider()],
      workflowInvokeModel: async () => {
        calls++;
        throw new Error("legacy model provider unavailable");
      },
    });
    let store: Store | undefined = new Store(dbPath);
    let service: ProductDiagnosticsService | undefined =
      new ProductDiagnosticsService(store, modelOptions);
    try {
      const product = createProduct(service, "旧model review記録", true);
      const started = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const partial = await waitForTerminal(service, product.id, started.id);
      expect(partial.status).toBe("partial");
      expect(partial.modelReview?.record).toBeNull();
      expect(calls).toBeGreaterThan(0);
      const legacyRun = { ...partial } as Record<string, unknown>;
      delete legacyRun.modelReview;
      store.db
        .prepare("UPDATE diagnostic_runs SET data=? WHERE id=?")
        .run(JSON.stringify(legacyRun), started.id);
      store.db
        .prepare(
          "UPDATE diagnostic_checkpoints SET model_review=NULL WHERE run_id=?",
        )
        .run(started.id);

      await service.close();
      service = undefined;
      store.close();
      store = undefined;
      store = new Store(dbPath);
      service = new ProductDiagnosticsService(store, modelOptions);

      const queued = await service.resume(product.id, started.id);
      expect(queued.status).toBe("queued");
      const resumed = await waitForTerminal(service, product.id, started.id);
      expect(resumed.status).toBe("partial");
      expect(resumed.modelReview?.record).toBeNull();
      expect(resumed.modelReview?.failure).toContain(
        "legacy model provider unavailable",
      );
      expect(resumed.status).not.toBe("completed");
      expect(calls).toBeGreaterThan(1);
    } finally {
      await service?.close();
      store?.close();
      await removeDatabase(dbPath);
    }
  });

  it("model checkpoint不一致時は旧complete coverageを無効化し、旧候補を修正済みにしない", async () => {
    const dbPath = join(
      ".cache",
      `diagnostic-recovery-model-checkpoint-${randomUUID()}.sqlite`,
    );
    let calls = 0;
    const modelOptions = serviceOptions({
      workflowProviders: [provider()],
      workflowInvokeModel: async (selected) => {
        calls++;
        return {
          response: modelFindingResponse(),
          model: selected.model,
          configVersion: selected.configVersion,
          actualCostUsd: 0,
        };
      },
    });
    let store: Store | undefined = new Store(dbPath);
    let service: ProductDiagnosticsService | undefined =
      new ProductDiagnosticsService(store, modelOptions);
    try {
      const product = createProduct(service, "model checkpoint不一致", true);
      const first = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const completedFirst = await waitForTerminal(
        service,
        product.id,
        first.id,
      );
      expect(completedFirst.status).toBe("partial");
      expect(completedFirst.modelReview?.coverage.status).toBe("complete");
      const previousFinding = completedFirst.findings.find(
        (finding) => finding.engine === "model" && finding.presentInAnalysis,
      );
      expect(previousFinding).toBeDefined();

      const second = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const completedSecond = await waitForTerminal(
        service,
        product.id,
        second.id,
      );
      expect(completedSecond.status).toBe("partial");
      expect(completedSecond.modelReview?.coverage.status).toBe("complete");
      const checkpoint = service.products.getCheckpoint(second.id);
      expect(checkpoint?.modelReview).toBeDefined();
      const tamperedModelReview = {
        ...checkpoint!.modelReview!,
        identity: {
          ...checkpoint!.modelReview!.identity,
          input: "0".repeat(64),
        },
      };
      store.db
        .prepare(
          "UPDATE diagnostic_checkpoints SET model_review=? WHERE run_id=?",
        )
        .run(JSON.stringify(tamperedModelReview), second.id);

      const queued = await service.resume(product.id, second.id);
      expect(queued.status).toBe("queued");
      const resumed = await waitForTerminal(service, product.id, second.id);
      expect(resumed.status).toBe("partial");
      expect(resumed.status).not.toBe("completed");
      expect(resumed.modelReview).toMatchObject({
        coverage: {
          status: "unavailable",
          completedBatchCount: 0,
        },
        record: null,
      });
      expect(resumed.modelReview?.failure).toContain("checkpoint identity");
      const oldCandidate = resumed.findings.find(
        (finding) => finding.fingerprint === previousFinding!.fingerprint,
      );
      expect(oldCandidate).toMatchObject({
        presentInAnalysis: false,
        delta: "needs_review",
        reviewDisposition: "confirmation_required",
      });
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      await service?.close();
      store?.close();
      await removeDatabase(dbPath);
    }
  });

  it("再起動時にrunningレコードが壊れていれば自動修復せず起動を拒否する", async () => {
    const dbPath = join(
      ".cache",
      `diagnostic-recovery-startup-${randomUUID()}.sqlite`,
    );
    let store: Store | undefined = new Store(dbPath);
    let service: ProductDiagnosticsService | undefined =
      new ProductDiagnosticsService(store, serviceOptions());
    try {
      const product = createProduct(service, "壊れたrunningレコード");
      const started = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const completed = await waitForTerminal(service, product.id, started.id);
      expect(["completed", "partial"]).toContain(completed.status);
      const corrupted = { ...completed, findings: "not-an-array" };
      store.db
        .prepare("UPDATE diagnostic_runs SET status=?,data=? WHERE id=?")
        .run("running", JSON.stringify(corrupted), started.id);
      await service.close();
      service = undefined;
      store.close();
      store = undefined;

      const reopened = new Store(dbPath);
      try {
        expect(
          () => new ProductDiagnosticsService(reopened, serviceOptions()),
        ).toThrow();
        expect(
          reopened.db
            .prepare("SELECT status FROM diagnostic_runs WHERE id=?")
            .get(started.id),
        ).toEqual({ status: "running" });
      } finally {
        reopened.close();
      }
    } finally {
      await service?.close();
      store?.close();
      await removeDatabase(dbPath);
    }
  });

  it("最小固定snapshotでは全engineを完了し、completed runを再開できない", async () => {
    const minimal = await createMinimalDiagnosticRepository();
    const store = new Store(":memory:");
    let service: ProductDiagnosticsService | undefined =
      new ProductDiagnosticsService(
        store,
        serviceOptions({ repositories: { minimal: minimal.directory } }),
      );
    try {
      const product = createProduct(service, "全engine完了", false, "minimal");
      const started = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const completed = await waitForTerminal(service, product.id, started.id);

      expect(completed.status).toBe("completed");
      expect(completed.progress).toMatchObject({
        phase: "finished",
        message: "診断完了",
      });
      expect(completed.coverage).toEqual([
        expect.objectContaining({ engine: "static", status: "complete" }),
        expect.objectContaining({ engine: "dependency", status: "complete" }),
      ]);

      await expect(
        service.resume(product.id, started.id),
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(
          "中断または部分診断のrunだけ再開できます",
        ),
      });
      expect(service.getRun(product.id, started.id).status).toBe("completed");

      const closing = service.close();
      await expect(
        service.resume(product.id, started.id),
      ).rejects.toMatchObject({
        status: 409,
        message: "診断serviceを終了しています",
      });
      await closing;
      await service.close();
    } finally {
      await service?.close();
      store.close();
      await rm(minimal.directory, { recursive: true, force: true });
    }
  });
});
