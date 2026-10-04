import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { DiagnosticStore } from "../src/server/diagnostic-store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import { ENGINE_VERSION } from "../src/shared/diagnostic-engine.js";
import {
  diagnosticApiPaths,
  productInputSchema,
  productSettingsSchema,
  runInputSchema,
  type DiagnosticRun,
} from "../src/shared/product-diagnostics.js";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";

const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
let fixture: Awaited<ReturnType<typeof createDiagnosticFixture>>;
let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  fixture = await createDiagnosticFixture();
  app = await createApp({
    dbPath: ":memory:",
    diagnosticsRepositories: { fixture: fixture.directory },
  });
});
afterAll(async () => {
  await app?.close();
});

describe("製品診断の共有契約と中断履歴", () => {
  it("厳格入力でlocal repo IDだけを受け付け、CI requestIdとschedule境界を検証する", () => {
    const product = productInputSchema.parse({
      title: "仕様確認対象",
      repositoryId: "fixture",
      ref: "baseline",
      specification: "社内クライアント",
    });
    expect(product.allowDependencyNetwork).toBe(false);
    expect(product.schedule).toEqual({ enabled: false, intervalMinutes: null });
    expect(() =>
      productInputSchema.parse({
        title: "対象",
        repositoryId: "fixture",
        ref: "main",
        specification: "仕様",
        path: fixture.directory,
      }),
    ).toThrow();
    expect(() =>
      runInputSchema.parse({ trigger: "ci", ref: "baseline" }),
    ).toThrow();
    expect(() =>
      productSettingsSchema.parse({
        revision: 1,
        schedule: { enabled: true, intervalMinutes: null },
      }),
    ).toThrow();
    expect(
      productSettingsSchema.parse({
        revision: 1,
        schedule: { enabled: true, intervalMinutes: 5 },
      }).schedule,
    ).toEqual({ enabled: true, intervalMinutes: 5 });
  });

  it("repository一覧からローカル絶対pathを返さない", async () => {
    const response = await app.inject({
      url: diagnosticApiPaths.repositories,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(fixture.directory);
    expect(response.json()).toEqual([
      expect.objectContaining({ id: "fixture", name: "diagnostic-fixture" }),
    ]);
    expect(response.json()[0].defaultRef).toBeTruthy();
  });

  it("再起動時にactive runをinterruptedへ移し、履歴を残す", () => {
    const store = new Store(":memory:");
    new WorkflowStore(store);
    const diagnostics = new DiagnosticStore(store);
    const product = diagnostics.create(
      {
        title: "中断回復対象",
        repositoryId: "fixture",
        ref: "baseline",
        specification: "固定版を確認する",
      },
      "diagnostic-fixture",
    );
    const timestamp = new Date().toISOString();
    const run: DiagnosticRun = {
      id: "a4d70965-2e72-4f18-ab97-a51c6be0a537",
      productId: product.id,
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
      specificationRevision: product.diagnosticRevision,
      workflowRevision: 1,
      knowledge: [],
      rules: [],
      progress: { phase: "static", message: "解析中", updatedAt: timestamp },
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
    diagnostics.createRun(
      run,
      DiagnosticStore.requestFingerprint({
        trigger: "manual",
        ref: "baseline",
      }),
    );
    const [recovered] = diagnostics.recoverInterrupted();
    expect(recovered?.status).toBe("interrupted");
    expect(recovered?.statusHistory.at(-1)).toMatchObject({
      status: "interrupted",
      reason: "サーバー再起動",
    });
    store.close();
  });
});
