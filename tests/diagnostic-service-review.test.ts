import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { Store } from "../src/server/store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import { ProductDiagnosticsService } from "../src/server/diagnostic-service.js";
import { createApp } from "../src/server/app.js";
import { ENGINE_VERSION } from "../src/shared/diagnostic-engine.js";
import type {
  DiagnosticRun,
  Product,
} from "../src/shared/product-diagnostics.js";
import type { WorkflowState } from "../src/shared/workflow.js";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";

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

async function createProduct(title: string) {
  const response = await api("/api/products", {
    title,
    repositoryId: "fixture",
    ref: "baseline",
    specification: "社内の固定版クライアントとして扱う。",
    allowDependencyNetwork: false,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Product>();
}

beforeAll(async () => {
  fixture = await createDiagnosticFixture();
  app = await createApp({
    dbPath: ":memory:",
    diagnosticsRepositories: { fixture: fixture.directory },
    diagnosticsFetch: async () => {
      throw new Error("外部通信は許可していません");
    },
  });
});

afterAll(async () => {
  await app?.close();
});

describe("診断serviceの境界と状態整合", () => {
  it("案件で静的診断と既知依存照合が許可されていなければrunを拒否する", async () => {
    const product = await createProduct("許可method確認");
    const workflowResponse = await api(
      "/api/projects/" + product.linkedProjectId + "/workflow",
    );
    expect(workflowResponse.statusCode).toBe(200);
    const workflow = workflowResponse.json<WorkflowState>();
    const changed = await api(
      "/api/projects/" + product.linkedProjectId + "/workflow/commands",
      {
        revision: workflow.revision,
        command: {
          type: "scope",
          value: { ...workflow.scope, allowedMethods: [] },
        },
      },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    const response = await api("/api/products/" + product.id + "/runs", {
      trigger: "manual",
      ref: "baseline",
    });
    expect(response.statusCode).toBe(409);
    expect(
      (await api("/api/products/" + product.id + "/runs")).json(),
    ).toHaveLength(0);
  });

  it("設定がrun開始後に更新された場合、古い設定のrunをcompletedにしない", async () => {
    const product = await createProduct("設定更新競合");
    const started = await api("/api/products/" + product.id + "/runs", {
      trigger: "manual",
      ref: "baseline",
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = started.json<DiagnosticRun>();
    const changed = await api("/api/products/" + product.id + "/settings", {
      revision: product.revision,
      ref: "fixed",
      specification: "更新後の仕様。別runで評価する。",
    });
    if (changed.statusCode === 409) return;
    expect(changed.statusCode, changed.body).toBe(200);
    const workflowAfterSetting = await api(
      "/api/projects/" + product.linkedProjectId + "/workflow",
    );
    expect(workflowAfterSetting.statusCode).toBe(200);
    expect(workflowAfterSetting.json<WorkflowState>().scope.version).not.toBe(
      fixture.commits.baseline,
    );
    let current = run;
    for (
      let index = 0;
      index < 500 && ["queued", "running"].includes(current.status);
      index++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const response = await api(
        "/api/products/" + product.id + "/runs/" + run.id,
      );
      expect(response.statusCode).toBe(200);
      current = response.json<DiagnosticRun>();
    }
    expect(["failed", "interrupted", "stopped", "partial"]).toContain(
      current.status,
    );
  }, 15_000);

  it("依存照合を無効化する更新中はinterrupted runを再開せず、外部照会を送らない", async () => {
    const dependencyFixture = await createDiagnosticFixture();
    const store = new Store(":memory:");
    let fetchCount = 0;
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: dependencyFixture.directory },
      scheduleIntervalMs: 0,
      fetcher: async () => {
        fetchCount++;
        return new Response(JSON.stringify({ results: [{ vulns: [] }] }));
      },
    });
    try {
      const lockPath = `${dependencyFixture.directory}/package-lock.json`;
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      lock.packages["node_modules/example"] = {
        name: "example",
        version: "1.2.3",
      };
      await writeFile(lockPath, JSON.stringify(lock));
      execFileSync("git", [
        "-c",
        "core.hooksPath=",
        "-C",
        dependencyFixture.directory,
        "add",
        "package-lock.json",
      ]);
      execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=",
          "-C",
          dependencyFixture.directory,
          "commit",
          "-m",
          "fixture dependency",
        ],
        {
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          },
          stdio: "ignore",
        },
      );
      const commit = execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=",
          "-C",
          dependencyFixture.directory,
          "rev-parse",
          "HEAD",
        ],
        { encoding: "utf8" },
      ).trim();
      execFileSync("git", [
        "-c",
        "core.hooksPath=",
        "-C",
        dependencyFixture.directory,
        "branch",
        "with-dependency",
        commit,
      ]);

      const product = service.createProduct({
        title: "依存照会競合",
        repositoryId: "fixture",
        ref: "with-dependency",
        specification: "管理下の固定版を確認する。",
        allowDependencyNetwork: true,
      });
      const workflows = new WorkflowStore(store);
      const workflow = workflows.get(product.linkedProjectId);
      const pinned = workflows.command(
        product.linkedProjectId,
        workflow.revision,
        {
          type: "scope",
          value: { ...workflow.scope, version: commit },
        },
      );
      const timestamp = new Date().toISOString();
      const run: DiagnosticRun = {
        id: "6aafd758-370a-4b62-8bdc-b8c8897e2e0e",
        productId: product.id,
        revision: 1,
        status: "partial",
        trigger: "manual",
        requestId: null,
        ref: "with-dependency",
        commit,
        previousRunId: null,
        manifestHash: null,
        snapshotFiles: [],
        snapshotOmitted: [],
        engineVersion: ENGINE_VERSION,
        allowDependencyNetwork: true,
        specificationRevision: product.diagnosticRevision,
        workflowRevision: pinned.revision,
        knowledge: [],
        rules: [],
        progress: {
          phase: "finished",
          message: "中断済み",
          updatedAt: timestamp,
        },
        statusHistory: [{ status: "partial", at: timestamp, reason: null }],
        coverage: ["static", "dependency"].map((engine) => ({
          engine,
          status: "partial",
          assessed: 0,
          omitted: [],
          limitations: ["再開競合fixture"],
        })) as DiagnosticRun["coverage"],
        findings: [],
        startedAt: timestamp,
        updatedAt: timestamp,
        finishedAt: timestamp,
        failure: null,
      };
      service.products.createRun(run, "resume-race-fixture");

      // updateProduct sets its in-flight guard before yielding at Promise.all([]).
      const update = service.updateProduct(product.id, product.revision, {
        allowDependencyNetwork: false,
      });
      await expect(service.resumeRun(product.id, run.id)).rejects.toMatchObject(
        {
          status: 409,
        },
      );
      await update;
      expect(fetchCount).toBe(0);
      expect(service.getRun(product.id, run.id).status).toBe("partial");
    } finally {
      await service.close();
      store.close();
      await rm(dependencyFixture.directory, { recursive: true, force: true });
    }
  });

  it("保存済みengineVersionと現行engineが異なるrunを再開しない", async () => {
    const store = new Store(":memory:");
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    try {
      const product = service.createProduct({
        title: "engine version pin",
        repositoryId: "fixture",
        ref: "baseline",
        specification: "固定版の診断",
      });
      const workflow = new WorkflowStore(store).get(product.linkedProjectId);
      const timestamp = new Date().toISOString();
      const run: DiagnosticRun = {
        id: "e74336a3-4a6e-437a-9e8f-f5a9e670f8c3",
        productId: product.id,
        revision: 1,
        status: "partial",
        trigger: "manual",
        requestId: null,
        ref: "baseline",
        commit: fixture.commits.baseline,
        previousRunId: null,
        manifestHash: null,
        snapshotFiles: [],
        snapshotOmitted: [],
        engineVersion: "0.0.0-old",
        allowDependencyNetwork: false,
        specificationRevision: product.diagnosticRevision,
        workflowRevision: workflow.revision,
        knowledge: [],
        rules: [],
        progress: {
          phase: "finished",
          message: "中断済み",
          updatedAt: timestamp,
        },
        statusHistory: [{ status: "partial", at: timestamp, reason: null }],
        coverage: ["static", "dependency"].map((engine) => ({
          engine,
          status: "partial",
          assessed: 0,
          omitted: [],
          limitations: ["version pin fixture"],
        })) as DiagnosticRun["coverage"],
        findings: [],
        startedAt: timestamp,
        updatedAt: timestamp,
        finishedAt: timestamp,
        failure: null,
      };
      service.products.createRun(run, "old-engine-fixture");
      await expect(service.resumeRun(product.id, run.id)).rejects.toMatchObject(
        {
          status: 409,
        },
      );
      expect(service.getRun(product.id, run.id)).toMatchObject({
        status: "partial",
        engineVersion: "0.0.0-old",
        revision: 1,
      });
    } finally {
      await service.close();
      store.close();
    }
  });
});
