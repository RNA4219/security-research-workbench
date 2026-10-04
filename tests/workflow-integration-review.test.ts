import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import {
  waitWorkflowRun,
  type WorkflowProviderDefinition,
} from "../src/server/workflow-runner.js";
import type { WorkflowState } from "../src/shared/workflow.js";
import { exampleProject } from "../src/shared/example.js";
import { scope } from "./workflow-fixtures.js";

const handles: { close(): unknown }[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
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
const providers: WorkflowProviderDefinition[] = [
  {
    id: "manual",
    kind: "manual",
    label: "Manual",
    model: "manual",
    available: true,
    costKnown: true,
    configVersion: "manual-v1",
  },
  {
    id: "local",
    kind: "local",
    label: "Local",
    model: "local-v1",
    available: true,
    costKnown: true,
    configVersion: "local-v1",
    endpoint: "http://127.0.0.1:8080",
    inputUsdPerMillionTokens: 0,
    outputUsdPerMillionTokens: 0,
    maxOutputTokens: 100,
  },
];
async function prepare(app: App) {
  const project = (await call(app, "/api/projects", exampleProject)).json();
  const base = `/api/projects/${project.id}/workflow`;
  let state = (await call(app, base)).json<WorkflowState>();
  const command = async (value: unknown) => {
    const response = await call(app, `${base}/commands`, {
      revision: state.revision,
      command: value,
    });
    expect(response.statusCode, response.body).toBe(200);
    state = response.json();
  };
  await command({
    type: "scope",
    value: { ...scope, allowedProviderIds: ["manual", "local"] },
  });
  await command({
    type: "document",
    value: {
      title: "Public spec",
      body: "Current statement",
      classification: "public",
    },
  });
  const doc = state.documents[0]!;
  await command({
    type: "knowledge-draft",
    purpose: scope.purpose,
    content: "Current statement",
    sourceRefs: [{ docId: doc.id, revision: 1, excerpt: "Current statement" }],
  });
  await command({
    type: "knowledge-review",
    knowledgeId: state.knowledge[0]!.id,
    decision: "active",
    actor: "reviewer",
    reason: "source checked",
  });
  return {
    project,
    base,
    get state() {
      return state;
    },
  };
}
const runInput = (revision: number) => ({
  revision,
  query: "Current statement?",
  queryClassification: "public",
  providerId: "local",
  budgets: {
    maxDurationMs: 60_000,
    maxCostUsd: 1,
    maxSteps: 3,
    maxConcurrency: 1,
    maxRetries: 0,
  },
});

describe("workflow persistence and shutdown integration review", () => {
  it("workflow scope change stops an in-flight provider before returning", async () => {
    let started!: () => void;
    let aborted = false;
    const invocationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await createApp({
      dbPath: ":memory:",
      workflowProviders: providers,
      workflowInvokeModel: async (_provider, _prompt, signal) =>
        new Promise((_resolve, _reject) => {
          started();
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    });
    handles.push(app);
    const p = await prepare(app);
    const created = await call(
      app,
      `${p.base}/runs`,
      runInput(p.state.revision),
    );
    const run = created.json<{ id: string }>();
    await invocationStarted;
    const changed = await call(app, `${p.base}/commands`, {
      revision: p.state.revision,
      command: {
        type: "scope",
        value: { ...p.state.scope, version: "def5678" },
      },
    });
    expect(changed.statusCode).toBe(200);
    await waitWorkflowRun(run.id);
    expect(aborted).toBe(true);
    expect((await call(app, `${p.base}/runs/${run.id}`)).json()).toMatchObject({
      status: "stopped",
      stopReason: "operator",
    });
  });

  it("onCloseはSQLite closeより先にactive providerを停止・checkpointする", async () => {
    const path = resolve(".cache", `workflow-close-review-${randomUUID()}.db`);
    let started!: () => void;
    let aborted = false;
    const invocationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await createApp({
      dbPath: path,
      workflowProviders: providers,
      workflowInvokeModel: async (_provider, _prompt, signal) =>
        new Promise((_resolve, _reject) => {
          started();
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
            },
            { once: true },
          );
        }),
    });
    const p = await prepare(app);
    const run = (
      await call(app, `${p.base}/runs`, runInput(p.state.revision))
    ).json<{ id: string }>();
    await invocationStarted;
    await app.close();
    expect(aborted).toBe(true);
    const direct = new Store(path);
    try {
      const recovered = new WorkflowStore(direct).getRun(p.project.id, run.id);
      expect(recovered).toMatchObject({
        status: "stopped",
        stopReason: "restart",
      });
    } finally {
      direct.close();
    }
  });
});
