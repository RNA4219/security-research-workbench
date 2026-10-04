import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticStore } from "../src/server/diagnostic-store.js";
import { Store } from "../src/server/store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import { ENGINE_VERSION } from "../src/shared/diagnostic-engine.js";
import type {
  DiagnosticCoverage,
  DiagnosticFinding,
  DiagnosticSnapshot,
} from "../src/shared/diagnostic-engine.js";
import type { DiagnosticRun } from "../src/shared/product-diagnostics.js";

const directories: string[] = [];
const now = () => new Date().toISOString();
const input = (title: string) => ({
  title,
  repositoryId: "fixture",
  ref: "baseline",
  specification: `${title} の仕様`,
});

function makeRun(
  productId: string,
  id: string,
  status: DiagnosticRun["status"] = "queued",
  timestamp = now(),
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
      phase: status === "queued" ? "queued" : "static",
      message: "test",
      updatedAt: timestamp,
    },
    statusHistory: [{ status, at: timestamp, reason: null }],
    coverage: ["static", "dependency"].map((engine) => ({
      engine,
      status: "unavailable",
      assessed: 0,
      omitted: [],
      limitations: ["fixture"],
    })) as DiagnosticRun["coverage"],
    findings: [],
    startedAt: status === "queued" ? null : timestamp,
    updatedAt: timestamp,
    finishedAt: [
      "completed",
      "partial",
      "failed",
      "stopped",
      "interrupted",
    ].includes(status)
      ? timestamp
      : null,
    failure: null,
  };
}

function runStore(pathname = ":memory:") {
  const store = new Store(pathname);
  new WorkflowStore(store);
  return { store, diagnostics: new DiagnosticStore(store) };
}

function makeSnapshot(): DiagnosticSnapshot {
  const content = "export const reviewed = true;\n";
  const fileHash = createHash("sha256").update(content).digest("hex");
  const files = [{ path: "src/client.ts", hash: fileHash, content }];
  const omitted: DiagnosticSnapshot["omitted"] = [];
  const manifestHash = createHash("sha256")
    .update(JSON.stringify({ files: [[files[0]!.path, fileHash]], omitted }))
    .digest("hex");
  return { commit: "a".repeat(40), manifestHash, files, omitted };
}

function makeFinding(engine: DiagnosticFinding["engine"]): DiagnosticFinding {
  return {
    fingerprint: "d".repeat(64),
    ruleId: engine === "static" ? "tls.example" : "dependency.example",
    engine,
    title: "test finding",
    severity: "medium",
    path: engine === "static" ? "src/client.ts" : "package-lock.json",
    line: 1,
    evidence: "fixed test evidence",
    remediation: "review manually",
  };
}

function makeCoverage(
  engine: DiagnosticCoverage["engine"],
): DiagnosticCoverage {
  return {
    engine,
    status: "complete",
    assessed: 1,
    omitted: [],
    limitations: ["test coverage"],
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DiagnosticStore persistence and boundaries", () => {
  it("enforces one queued/running run per product while allowing terminal and cross-product runs", () => {
    const { store, diagnostics } = runStore();
    try {
      const first = diagnostics.create(input("first"), "fixture");
      const second = diagnostics.create(input("second"), "fixture");
      expect(diagnostics.list()).toHaveLength(2);
      expect(diagnostics.listRuns(first.id)).toEqual([]);
      const active = makeRun(first.id, "10000000-0000-4000-8000-000000000001");
      expect(diagnostics.createRun(active, "fp-a").created).toBe(true);
      expect(() =>
        diagnostics.createRun(
          makeRun(first.id, "10000000-0000-4000-8000-000000000002"),
          "fp-b",
        ),
      ).toThrow();
      expect(diagnostics.listRuns(first.id)).toHaveLength(1);
      expect(
        diagnostics.createRun(
          makeRun(second.id, "10000000-0000-4000-8000-000000000003"),
          "fp-c",
        ).created,
      ).toBe(true);

      const completed = {
        ...active,
        revision: 2,
        status: "completed" as const,
        finishedAt: now(),
      };
      diagnostics.saveRun(completed, 1);
      expect(
        diagnostics.createRun(
          makeRun(first.id, "10000000-0000-4000-8000-000000000004"),
          "fp-d",
        ).created,
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("keeps request IDs idempotent per product and rejects changed fingerprints", () => {
    const { store, diagnostics } = runStore();
    try {
      const product = diagnostics.create(input("idempotency"), "fixture");
      const first = makeRun(product.id, "20000000-0000-4000-8000-000000000001");
      first.requestId = "ci-42";
      const fingerprint = DiagnosticStore.requestFingerprint({
        trigger: "ci",
        ref: "baseline",
      });
      expect(
        DiagnosticStore.requestFingerprint({ trigger: "ci", ref: "baseline" }),
      ).toBe(fingerprint);
      expect(diagnostics.createRun(first, fingerprint)).toEqual({
        run: first,
        created: true,
      });

      const retry = { ...first, id: "20000000-0000-4000-8000-000000000002" };
      expect(diagnostics.createRun(retry, fingerprint)).toEqual({
        run: first,
        created: false,
      });
      expect(() => diagnostics.createRun(retry, "different-input")).toThrow(
        /異なる入力/,
      );
      expect(diagnostics.findRequest(product.id, "ci-42")).toMatchObject({
        run: { id: first.id },
        fingerprint,
      });
      expect(diagnostics.findRequest(product.id, "missing")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("uses compare-and-swap revisions and reports absent or cross-product runs", () => {
    const { store, diagnostics } = runStore();
    try {
      const product = diagnostics.create(input("cas"), "fixture");
      const other = diagnostics.create(input("other"), "fixture");
      const run = makeRun(product.id, "30000000-0000-4000-8000-000000000001");
      diagnostics.createRun(run, "fp");
      expect(() => diagnostics.saveRun({ ...run, revision: 3 }, 1)).toThrow(
        /版が不正/,
      );
      const next = { ...run, revision: 2, status: "running" as const };
      expect(diagnostics.saveRun(next, 1)).toEqual(next);
      expect(() => diagnostics.saveRun(next, 1)).toThrow(/別の操作/);
      expect(() =>
        diagnostics.saveRun(
          { ...next, id: "30000000-0000-4000-8000-000000000099" },
          1,
        ),
      ).toThrow(/別の操作/);
      expect(() =>
        diagnostics.get("89a7c43e-675c-4e41-b879-5b0ac54cdeea"),
      ).toThrow(/製品がありません/);
      expect(() => diagnostics.getRun(other.id, run.id)).toThrow(
        /診断記録がありません/,
      );
      expect(() =>
        diagnostics.listRuns("89a7c43e-675c-4e41-b879-5b0ac54cdeea"),
      ).toThrow(/製品がありません/);
      expect(() =>
        diagnostics.createRun(
          makeRun(
            "89a7c43e-675c-4e41-b879-5b0ac54cdeea",
            "30000000-0000-4000-8000-000000000002",
          ),
          "fp",
        ),
      ).toThrow(/製品がありません/);
    } finally {
      store.close();
    }
  });

  it("summarizes every finding delta and latest incomplete coverage without changing persisted run data", () => {
    const { store, diagnostics } = runStore();
    try {
      const product = diagnostics.create(input("summary"), "fixture");
      const run = makeRun(
        product.id,
        "40000000-0000-4000-8000-000000000001",
        "completed",
      );
      run.findings = (
        ["new", "continuing", "needs_review", "not_observed"] as const
      ).map((delta, index) => ({
        fingerprint: String(index + 1).repeat(64),
        ruleId: `rule-${index}`,
        engine: "static" as const,
        title: `finding ${index}`,
        severity: "medium" as const,
        path: `src/file-${index}.ts`,
        line: index + 1,
        evidence: "candidate evidence",
        remediation: "review manually",
        delta,
        presentInAnalysis: delta !== "not_observed",
        comparedToRunId: null,
        workflowFindingId: null,
        workflowUrl: null,
        workflowQuestion: "この候補を確認してください",
        workflowQuestionClassification: "local" as const,
      }));
      diagnostics.createRun(run, "fp-summary");
      expect(diagnostics.get(product.id).latestRun).toMatchObject({
        id: run.id,
        status: "completed",
        findingCounts: {
          new: 1,
          continuing: 1,
          needsReview: 1,
          notObserved: 1,
        },
        incompleteCoverage: true,
      });
      expect(diagnostics.getRun(product.id, run.id).findings).toHaveLength(4);
      expect(() =>
        diagnostics.getRun(product.id, "40000000-0000-4000-8000-000000000002"),
      ).toThrow(/診断記録がありません/);
    } finally {
      store.close();
    }
  });

  it("persists pinned snapshots across reopen and recovers each active state exactly once", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "diagnostic-store-"),
    );
    directories.push(directory);
    const database = path.join(directory, "diagnostics.sqlite");
    const initial = runStore(database);
    const product = initial.diagnostics.create(input("restart"), "fixture");
    const queued = makeRun(
      product.id,
      "50000000-0000-4000-8000-000000000001",
      "queued",
    );
    const running = makeRun(
      product.id,
      "50000000-0000-4000-8000-000000000002",
      "running",
    );
    initial.diagnostics.createRun(queued, "fp-q");
    const runningQueued = {
      ...queued,
      revision: 2,
      status: "stopped" as const,
    };
    initial.diagnostics.saveRun(runningQueued, 1);
    initial.diagnostics.createRun(running, "fp-r");
    initial.store.close();

    const reopened = runStore(database);
    try {
      expect(reopened.diagnostics.get(product.id)).toMatchObject({
        id: product.id,
        linkedProjectId: product.linkedProjectId,
      });
      expect(reopened.diagnostics.getRun(product.id, running.id)).toMatchObject(
        {
          status: "running",
          commit: running.commit,
          snapshotFiles: running.snapshotFiles,
          manifestHash: running.manifestHash,
        },
      );
      const recovered = reopened.diagnostics.recoverInterrupted();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        id: running.id,
        status: "interrupted",
        commit: running.commit,
        snapshotFiles: running.snapshotFiles,
        failure: expect.stringContaining("再起動"),
        progress: { phase: "finished", message: "再起動により中断" },
      });
      expect(recovered[0]?.statusHistory.at(-1)).toMatchObject({
        status: "interrupted",
        reason: "サーバー再起動",
      });
      expect(reopened.diagnostics.recoverInterrupted()).toEqual([]);
      expect(reopened.diagnostics.getRun(product.id, running.id).revision).toBe(
        2,
      );
    } finally {
      reopened.store.close();
    }
  });

  it("updates product configuration and linked workflow atomically with pinned revisions", () => {
    const { store, diagnostics } = runStore();
    try {
      const product = diagnostics.create(input("linked settings"), "fixture");
      const updated = diagnostics.update(product.id, 1, {
        ref: "updated",
        specification: "更新後仕様",
        allowDependencyNetwork: true,
      });
      expect(updated).toMatchObject({
        revision: 2,
        diagnosticRevision: 2,
        ref: "updated",
      });
      const workflow = new WorkflowStore(store).get(product.linkedProjectId);
      expect(workflow.scope.version).toBe("updated");
      expect(
        workflow.documents.find(({ title }) => title === "製品仕様")?.body,
      ).toBe("更新後仕様");
      expect(workflow.revision).toBeGreaterThan(1);

      store.db
        .prepare("DELETE FROM workflows WHERE project_id=?")
        .run(product.linkedProjectId);
      expect(() =>
        diagnostics.update(updated.id, updated.revision, { ref: "another" }),
      ).toThrow(/診断案件がありません/);
      expect(diagnostics.get(updated.id)).toMatchObject({
        revision: updated.revision,
        diagnosticRevision: updated.diagnosticRevision,
        ref: "updated",
      });
    } finally {
      store.close();
    }
  });

  it("advances only the product revision for schedule and no-op edits, then synchronizes dependency permission both ways", () => {
    const { store, diagnostics } = runStore();
    try {
      const product = diagnostics.create(input("schedule"), "fixture");
      const workflowStore = new WorkflowStore(store);
      const originalWorkflow = workflowStore.get(product.linkedProjectId);
      const scheduled = diagnostics.update(product.id, 1, {
        schedule: { enabled: true, intervalMinutes: 15 },
      });
      expect(scheduled).toMatchObject({ revision: 2, diagnosticRevision: 1 });
      expect(workflowStore.get(product.linkedProjectId).revision).toBe(
        originalWorkflow.revision,
      );
      const noOp = diagnostics.update(product.id, 2, { ref: product.ref });
      expect(noOp).toMatchObject({ revision: 3, diagnosticRevision: 1 });
      expect(workflowStore.get(product.linkedProjectId).revision).toBe(
        originalWorkflow.revision,
      );
      expect(() => diagnostics.update(product.id, 1, { ref: "stale" })).toThrow(
        /更新されました/,
      );
      expect(() =>
        diagnostics.update("89a7c43e-675c-4e41-b879-5b0ac54cdeea", 1, {
          ref: "missing",
        }),
      ).toThrow(/製品がありません/);

      const enabled = diagnostics.update(product.id, 3, {
        allowDependencyNetwork: true,
      });
      expect(enabled).toMatchObject({
        revision: 4,
        diagnosticRevision: 2,
        allowDependencyNetwork: true,
      });
      expect(
        workflowStore.get(product.linkedProjectId).scope.purpose,
      ).toContain("許可: 有効");
      const disabled = diagnostics.update(product.id, 4, {
        allowDependencyNetwork: false,
      });
      expect(disabled).toMatchObject({
        revision: 5,
        diagnosticRevision: 3,
        allowDependencyNetwork: false,
      });
      expect(
        workflowStore.get(product.linkedProjectId).scope.purpose,
      ).toContain("許可: 無効");
    } finally {
      store.close();
    }
  });

  it("rolls back product and workflow creation as one transaction on a database failure", () => {
    const { store, diagnostics } = runStore();
    try {
      store.db
        .exec(`CREATE TRIGGER fail_product_insert BEFORE INSERT ON diagnostic_products
        BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
      expect(() => diagnostics.create(input("rollback"), "fixture")).toThrow(
        /fixture failure/,
      );
      expect(
        (
          store.db.prepare("SELECT count(*) AS n FROM projects").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect(
        (
          store.db.prepare("SELECT count(*) AS n FROM workflows").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
      expect(diagnostics.list()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back settings if the linked workflow CAS fails", () => {
    const { store, diagnostics } = runStore();
    try {
      const product = diagnostics.create(input("workflow CAS"), "fixture");
      store.db
        .exec(`CREATE TRIGGER ignore_workflow_update BEFORE UPDATE ON workflows
        BEGIN SELECT RAISE(IGNORE); END;`);
      expect(() =>
        diagnostics.update(product.id, 1, { ref: "updated" }),
      ).toThrow(/同時に更新されました/);
      expect(diagnostics.get(product.id)).toMatchObject({
        revision: 1,
        diagnosticRevision: 1,
        ref: "baseline",
      });
      expect(
        new WorkflowStore(store).get(product.linkedProjectId).scope.version,
      ).toBe("baseline");
    } finally {
      store.close();
    }
  });

  it("rejects checkpoint access when the run is missing or the pinned identity differs", () => {
    const { store, diagnostics } = runStore();
    try {
      expect(
        diagnostics.getCheckpoint("89a7c43e-675c-4e41-b879-5b0ac54cdeea"),
      ).toBeUndefined();
      expect(() =>
        diagnostics.ensureCheckpoint(
          "89a7c43e-675c-4e41-b879-5b0ac54cdeea",
          "identity-a",
        ),
      ).toThrow();
      expect(() =>
        diagnostics.saveSnapshotCheckpoint(
          "89a7c43e-675c-4e41-b879-5b0ac54cdeea",
          "identity-a",
          makeSnapshot(),
        ),
      ).toThrow(/identity/);
      expect(() =>
        diagnostics.saveEngineCheckpoint(
          "89a7c43e-675c-4e41-b879-5b0ac54cdeea",
          "identity-a",
          "static",
          [],
          makeCoverage("static"),
        ),
      ).toThrow(/identity/);

      const product = diagnostics.create(
        input("checkpoint identity"),
        "fixture",
      );
      const run = makeRun(product.id, "60000000-0000-4000-8000-000000000001");
      diagnostics.createRun(run, "fp");
      expect(diagnostics.ensureCheckpoint(run.id, "identity-a")).toMatchObject({
        identity: "identity-a",
        snapshot: null,
        staticAnalysis: null,
        dependencyAnalysis: null,
      });
      expect(() => diagnostics.ensureCheckpoint(run.id, "identity-b")).toThrow(
        /identity/,
      );
      expect(() =>
        diagnostics.saveSnapshotCheckpoint(
          run.id,
          "identity-b",
          makeSnapshot(),
        ),
      ).toThrow(/identity/);
      expect(() =>
        diagnostics.saveEngineCheckpoint(
          run.id,
          "identity-b",
          "static",
          [],
          makeCoverage("static"),
        ),
      ).toThrow(/identity/);
    } finally {
      store.close();
    }
  });

  it("validates snapshot schema and binds each persisted engine stage to its matching coverage/findings", () => {
    const { store, diagnostics } = runStore();
    try {
      const product = diagnostics.create(input("checkpoint schema"), "fixture");
      const run = makeRun(product.id, "70000000-0000-4000-8000-000000000001");
      diagnostics.createRun(run, "fp", "identity-a");
      const snapshot = makeSnapshot();
      expect(() =>
        diagnostics.saveSnapshotCheckpoint(run.id, "identity-a", {
          ...snapshot,
          commit: "not-a-commit",
        }),
      ).toThrow();
      diagnostics.saveSnapshotCheckpoint(run.id, "identity-a", snapshot);
      expect(diagnostics.getCheckpoint(run.id)?.snapshot).toEqual(snapshot);

      expect(() =>
        diagnostics.saveEngineCheckpoint(
          run.id,
          "identity-a",
          "static",
          [makeFinding("dependency")],
          makeCoverage("static"),
        ),
      ).toThrow(/範囲が一致/);
      expect(() =>
        diagnostics.saveEngineCheckpoint(
          run.id,
          "identity-a",
          "dependency",
          [makeFinding("dependency")],
          makeCoverage("static"),
        ),
      ).toThrow(/範囲が一致/);
      expect(() =>
        diagnostics.saveEngineCheckpoint(
          run.id,
          "identity-a",
          "static",
          [{ ...makeFinding("static"), line: 0 }],
          makeCoverage("static"),
        ),
      ).toThrow();

      const staticFinding = makeFinding("static");
      diagnostics.saveEngineCheckpoint(
        run.id,
        "identity-a",
        "static",
        [staticFinding],
        makeCoverage("static"),
      );
      expect(diagnostics.getCheckpoint(run.id)?.staticAnalysis).toEqual({
        findings: [staticFinding],
        coverage: makeCoverage("static"),
      });
      expect(diagnostics.getCheckpoint(run.id)?.dependencyAnalysis).toBeNull();
    } finally {
      store.close();
    }
  });

  it("persists the fixed snapshot and separate engine results across store reopen", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "diagnostic-checkpoint-store-"),
    );
    directories.push(directory);
    const database = path.join(directory, "checkpoint.sqlite");
    const initial = runStore(database);
    const product = initial.diagnostics.create(
      input("checkpoint restart"),
      "fixture",
    );
    const run = makeRun(product.id, "80000000-0000-4000-8000-000000000001");
    const identity = "sha256:fixed-commit-manifest-engine-config-context";
    initial.diagnostics.createRun(run, "fp", identity);
    const snapshot = makeSnapshot();
    const staticFinding = makeFinding("static");
    const dependencyFinding = makeFinding("dependency");
    initial.diagnostics.saveSnapshotCheckpoint(run.id, identity, snapshot);
    initial.diagnostics.saveEngineCheckpoint(
      run.id,
      identity,
      "static",
      [staticFinding],
      makeCoverage("static"),
    );
    initial.diagnostics.saveEngineCheckpoint(
      run.id,
      identity,
      "dependency",
      [dependencyFinding],
      makeCoverage("dependency"),
    );
    initial.store.close();

    const reopened = runStore(database);
    try {
      expect(reopened.diagnostics.getCheckpoint(run.id)).toEqual({
        identity,
        snapshot,
        staticAnalysis: {
          findings: [staticFinding],
          coverage: makeCoverage("static"),
        },
        dependencyAnalysis: {
          findings: [dependencyFinding],
          coverage: makeCoverage("dependency"),
        },
      });
      expect(() =>
        reopened.diagnostics.ensureCheckpoint(run.id, "changed-identity"),
      ).toThrow(/identity/);
    } finally {
      reopened.store.close();
    }
  });

  it("rejects checkpoint rows corrupted outside the validated store API", () => {
    const { store, diagnostics } = runStore();
    try {
      const product = diagnostics.create(
        input("corrupt checkpoint"),
        "fixture",
      );
      const run = makeRun(product.id, "90000000-0000-4000-8000-000000000001");
      diagnostics.createRun(run, "fp", "identity-a");
      store.db
        .prepare(
          "UPDATE diagnostic_checkpoints SET static_analysis=? WHERE run_id=?",
        )
        .run(
          JSON.stringify({
            findings: "not-an-array",
            coverage: makeCoverage("static"),
          }),
          run.id,
        );
      expect(() => diagnostics.getCheckpoint(run.id)).toThrow(/checkpoint/);
      store.db
        .prepare(
          "UPDATE diagnostic_checkpoints SET static_analysis=? WHERE run_id=?",
        )
        .run(
          JSON.stringify({ findings: [], coverage: { engine: "static" } }),
          run.id,
        );
      expect(() => diagnostics.getCheckpoint(run.id)).toThrow();
    } finally {
      store.close();
    }
  });
});
