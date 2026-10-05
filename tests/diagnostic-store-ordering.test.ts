import { describe, expect, it } from "vitest";
import { DiagnosticStore } from "../src/server/diagnostic-store.js";
import { Store } from "../src/server/store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import { ENGINE_VERSION } from "../src/shared/diagnostic-engine.js";
import type { DiagnosticRun } from "../src/shared/product-diagnostics.js";

const input = (title: string) => ({
  title,
  repositoryId: "fixture",
  ref: "baseline",
  specification: `${title} の仕様`,
});

function makeRun(
  productId: string,
  id: string,
  status: DiagnosticRun["status"],
  timestamp: string,
): DiagnosticRun {
  return {
    id,
    productId,
    revision: 1,
    status,
    trigger: "manual",
    requestId: null,
    ref: "baseline",
    commit: "a".repeat(40),
    previousRunId: null,
    manifestHash: "b".repeat(64),
    snapshotFiles: [{ path: "src/client.ts", hash: "c".repeat(64) }],
    snapshotOmitted: [],
    engineVersion: ENGINE_VERSION,
    allowDependencyNetwork: false,
    specificationRevision: 1,
    workflowRevision: 1,
    knowledge: [],
    rules: [],
    progress: {
      phase: status === "queued" ? "queued" : "finished",
      message: "test",
      updatedAt: timestamp,
    },
    statusHistory: [{ status, at: timestamp, reason: null }],
    coverage: ["static", "dependency"].map((engine) => ({
      engine,
      status: "complete",
      assessed: 1,
      omitted: [],
      limitations: [],
    })) as DiagnosticRun["coverage"],
    findings: [],
    startedAt: status === "queued" ? null : timestamp,
    updatedAt: timestamp,
    finishedAt:
      status === "completed" ||
      status === "partial" ||
      status === "failed" ||
      status === "stopped" ||
      status === "interrupted"
        ? timestamp
        : null,
    failure: null,
  };
}

describe("DiagnosticStore run ordering", () => {
  it("puts a resumed older run before a newer inserted run for latest/previous selection", () => {
    const store = new Store(":memory:");
    new WorkflowStore(store);
    const diagnostics = new DiagnosticStore(store);
    try {
      const product = diagnostics.create(input("resume ordering"), "fixture");
      const older = makeRun(
        product.id,
        "70000000-0000-4000-8000-000000000001",
        "partial",
        "2026-10-05T01:00:00.000Z",
      );
      const newer = makeRun(
        product.id,
        "70000000-0000-4000-8000-000000000002",
        "completed",
        "2026-10-05T02:00:00.000Z",
      );
      diagnostics.createRun(older, "ordering-older");
      diagnostics.createRun(newer, "ordering-newer");

      const resumed = {
        ...older,
        revision: 2,
        startedAt: "2026-10-05T03:00:00.000Z",
        updatedAt: "2026-10-05T03:00:00.000Z",
        finishedAt: "2026-10-05T03:00:00.000Z",
      };
      diagnostics.saveRun(resumed, 1);

      expect(diagnostics.listRuns(product.id).map((run) => run.id)).toEqual([
        older.id,
        newer.id,
      ]);
      expect(diagnostics.get(product.id).latestRun?.id).toBe(older.id);
      expect(
        diagnostics
          .listRuns(product.id)
          .find((run) => ["completed", "partial"].includes(run.status))?.id,
      ).toBe(older.id);
    } finally {
      store.close();
    }
  });
});
