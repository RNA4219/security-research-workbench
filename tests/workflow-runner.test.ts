import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  compareWorkflowRuns,
  createWorkflowRun,
  recoverInterruptedWorkflowRun,
  resumeWorkflowRun,
  stopWorkflowRun,
  submitWorkflowRunResponse,
  waitWorkflowRun,
  listWorkflowProviders,
  abortActiveWorkflowRuns,
  type WorkflowProviderDefinition,
  type WorkflowRunDependencies,
  type WorkflowRunStore,
} from "../src/server/workflow-runner.js";
import {
  invokeOpenAICompatible,
  workflowProvidersFromEnvironment,
} from "../src/server/workflow-providers.js";
import type {
  WorkflowRun,
  WorkflowRunSnapshot,
} from "../src/shared/workflow-run.js";

const knowledgeId = "knowledge_1";
const findingId = "finding_1";
const snapshot = (
  overrides: Partial<WorkflowRunSnapshot> = {},
): WorkflowRunSnapshot => ({
  question: "Can this be adopted?",
  target: "https://github.com/example/widget",
  targetVersion: "v1",
  purpose: "adoption review",
  knowledge: [
    {
      id: knowledgeId,
      revision: 1,
      content: "The package is maintained.",
      sourceRefs: [{ docId: "doc_1", revision: 1, excerpt: "maintained" }],
      classifications: ["public"],
    },
  ],
  rules: [],
  fingerprint: "a".repeat(64),
  uncertainty: "none",
  contextSnapshotRevision: 1,
  allowedProviderIds: ["manual", "local", "cloud"],
  ruleVersion: "rules-v1",
  knowledgeVersion: "knowledge-v1",
  ...overrides,
});
const budgets = (overrides: Partial<WorkflowRun["budgets"]> = {}) => ({
  maxDurationMs: 60_000,
  maxCostUsd: 2,
  maxSteps: 3,
  maxConcurrency: 1,
  maxRetries: 0,
  ...overrides,
});
const input = (
  providerId = "manual",
  changes: Record<string, unknown> = {},
) => ({
  revision: 1,
  query: "Can we adopt this?",
  queryClassification: "public" as const,
  providerId,
  budgets: budgets(),
  ...changes,
});
const manual: WorkflowProviderDefinition = {
  id: "manual",
  kind: "manual",
  label: "Manual",
  model: "manual",
  available: true,
  costKnown: true,
  configVersion: "manual-v1",
};
const local: WorkflowProviderDefinition = {
  id: "local",
  kind: "local",
  label: "Local",
  model: "local-model",
  available: true,
  costKnown: true,
  configVersion: "local-v1",
  endpoint: "http://127.0.0.1:8080/v1",
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  maxOutputTokens: 100,
};
const cloud: WorkflowProviderDefinition = {
  id: "cloud",
  kind: "cloud",
  label: "Cloud",
  model: "cloud-model",
  available: true,
  costKnown: true,
  configVersion: "cloud-v1",
  endpoint: "https://api.example.test/v1",
  inputUsdPerMillionTokens: 1,
  outputUsdPerMillionTokens: 1,
  maxOutputTokens: 100,
};
function harness(
  providers = [manual, local, cloud],
  invokeModel: WorkflowRunDependencies["invokeModel"] = async () => ({
    response: JSON.stringify({
      answer: "Use is reasonable.",
      citedKnowledgeIds: [knowledgeId],
      findingReferences: [findingId],
    }),
    actualCostUsd: 0.001,
    model: "fixture-model",
    configVersion: "fixture-v1",
  }),
) {
  let providerCatalog = [...providers];
  const saved = new Map<string, WorkflowRun>();
  const store: WorkflowRunStore = {
    async get(projectId, runId) {
      const run = saved.get(runId);
      return run?.projectId === projectId ? structuredClone(run) : undefined;
    },
    async list(projectId) {
      return [...saved.values()]
        .filter((run) => run.projectId === projectId)
        .map((run) => structuredClone(run));
    },
    async save(run, expectedRevision) {
      const existing = saved.get(run.id);
      if (
        expectedRevision === null
          ? existing !== undefined
          : existing?.revision !== expectedRevision
      )
        throw new Error("revision conflict");
      saved.set(run.id, structuredClone(run));
    },
  };
  const deps: WorkflowRunDependencies = {
    store,
    providers: () => providerCatalog,
    invokeModel,
  };
  return {
    deps,
    saved,
    setProviders: (next: WorkflowProviderDefinition[]) => {
      providerCatalog = next;
    },
  };
}
const create = (
  deps: WorkflowRunDependencies,
  runInput = input(),
  runSnapshot = snapshot(),
) =>
  createWorkflowRun(
    { projectId: "project_1", input: runInput, snapshot: runSnapshot },
    deps,
  );

describe("workflow runner", () => {
  it("manual prompt is checkpointed and only a valid response with current citations is accepted", async () => {
    const { deps } = harness();
    const run = await create(deps);
    await waitWorkflowRun(run.id);
    const waiting = (await deps.store.get("project_1", run.id))!;
    expect(waiting.status).toBe("waiting_response");
    expect(waiting.steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "queued",
    ]);
    expect(
      waiting.artifacts.some(
        (item) => item.kind === "prompt" && typeof item.value === "string",
      ),
    ).toBe(true);
    await expect(
      submitWorkflowRunResponse(
        "project_1",
        run.id,
        {
          answer: "stale",
          citedKnowledgeIds: [knowledgeId],
          findingReferences: [],
        },
        snapshot({ fingerprint: "b".repeat(64) }),
        deps,
      ),
    ).rejects.toThrow("snapshotが変わりました");
    await expect(
      submitWorkflowRunResponse(
        "project_1",
        run.id,
        {
          answer: "ok",
          citedKnowledgeIds: ["other"],
          findingReferences: [],
        },
        snapshot(),
        deps,
      ),
    ).rejects.toThrow();
    await expect(
      submitWorkflowRunResponse(
        "project_1",
        run.id,
        {
          answer: "ok",
          citedKnowledgeIds: [knowledgeId],
          findingReferences: [],
          extra: true,
        },
        snapshot(),
        deps,
      ),
    ).rejects.toThrow();
    const completed = await submitWorkflowRunResponse(
      "project_1",
      run.id,
      {
        answer: "ok",
        citedKnowledgeIds: [knowledgeId],
        findingReferences: [findingId],
      },
      snapshot(),
      deps,
    );
    expect(completed.status).toBe("completed");
  });

  it("restart recovery keeps completed steps and creates a separate run when the snapshot changed", async () => {
    let ticks = 0;
    const { deps, saved } = harness();
    deps.clock = () => (ticks += 2_000);
    const timed = await create(
      deps,
      input("manual", { budgets: budgets({ maxDurationMs: 1_000 }) }),
    );
    await waitWorkflowRun(timed.id);
    expect((await deps.store.get("project_1", timed.id))?.stopReason).toBe(
      "timeout",
    );
    deps.clock = () => Date.now();
    const run = await create(
      deps,
      input("local", { budgets: budgets({ maxRetries: 1 }) }),
    );
    await waitWorkflowRun(run.id);
    const interrupted = (await deps.store.get("project_1", run.id))!;
    interrupted.status = "running";
    interrupted.steps[0]!.status = "completed";
    interrupted.steps[1]!.status = "running";
    interrupted.steps[1]!.attempts = 1;
    interrupted.revision += 1;
    saved.set(run.id, structuredClone(interrupted));
    const recovered = await recoverInterruptedWorkflowRun(interrupted, deps);
    expect(recovered.status).toBe("partial");
    const next = await resumeWorkflowRun(
      "project_1",
      run.id,
      snapshot({ fingerprint: "b".repeat(64), contextSnapshotRevision: 2 }),
      deps,
    );
    await waitWorkflowRun(next.id);
    expect(next.id).not.toBe(run.id);
    expect(next.basedOnRunId).toBe(run.id);
  });

  it("stop aborts the active model call, and budgets and classifications block excess or disallowed work", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const invoke = vi.fn(
      (_provider, _prompt, _signal) =>
        new Promise<never>(() => {
          requestStarted();
        }),
    );
    const { deps } = harness([manual, local, cloud], invoke);
    const run = await create(deps, input("local"));
    await started;
    await stopWorkflowRun("project_1", run.id, deps);
    await waitWorkflowRun(run.id);
    expect((await deps.store.get("project_1", run.id))?.stopReason).toBe(
      "operator",
    );
    const limited = await create(
      deps,
      input("manual", { budgets: budgets({ maxSteps: 1 }) }),
    );
    await waitWorkflowRun(limited.id);
    expect((await deps.store.get("project_1", limited.id))?.stopReason).toBe(
      "step_limit",
    );
    const freeOnly = input("cloud", { budgets: budgets({ maxCostUsd: 0 }) });
    const cost = await create(deps, freeOnly);
    await waitWorkflowRun(cost.id);
    expect((await deps.store.get("project_1", cost.id))?.stopReason).toBe(
      "budget",
    );
    await expect(
      create(deps, input("cloud", { queryClassification: "local" })),
    ).rejects.toThrow("query");
    await expect(
      create(
        deps,
        input("cloud"),
        snapshot({
          knowledge: [
            {
              id: knowledgeId,
              revision: 1,
              content: "local",
              sourceRefs: [{ docId: "doc_1", revision: 1, excerpt: "local" }],
              classifications: ["local"],
            },
          ],
        }),
      ),
    ).rejects.toThrow("公開資料だけ");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("caps retries, rejects model JSON and unknown citations, and refuses missing provider cost bounds", async () => {
    const failedInvoke = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const { deps } = harness([manual, local, cloud], failedInvoke);
    const failed = await create(
      deps,
      input("local", { budgets: budgets({ maxRetries: 1 }) }),
    );
    await waitWorkflowRun(failed.id);
    expect(failedInvoke).toHaveBeenCalledTimes(2);
    expect(
      (await deps.store.get("project_1", failed.id))?.steps[1]?.attempts,
    ).toBe(2);
    await waitWorkflowRun(failed.id);
    await resumeWorkflowRun("project_1", failed.id, snapshot(), deps);
    await waitWorkflowRun(failed.id);
    expect(failedInvoke).toHaveBeenCalledTimes(2);

    const badJson = harness([manual, local, cloud], async () => ({
      response: "not json",
      actualCostUsd: 0,
      model: "m",
      configVersion: "v",
    }));
    const bad = await create(badJson.deps, input("local"));
    await waitWorkflowRun(bad.id);
    expect(
      (await badJson.deps.store.get("project_1", bad.id))?.stopReason,
    ).toBe("invalid_response");

    const badCitation = harness([manual, local, cloud], async () => ({
      response: JSON.stringify({
        answer: "claim",
        citedKnowledgeIds: ["foreign"],
        findingReferences: [],
      }),
      actualCostUsd: 0,
      model: "m",
      configVersion: "v",
    }));
    const cited = await create(badCitation.deps, input("local"));
    await waitWorkflowRun(cited.id);
    expect(
      (await badCitation.deps.store.get("project_1", cited.id))?.status,
    ).toBe("failed");

    const missingPrices = {
      ...cloud,
      inputUsdPerMillionTokens: undefined,
      outputUsdPerMillionTokens: undefined,
      costKnown: false,
    };
    const unpriced = harness([manual, local, missingPrices], async () => {
      throw new Error("must not call");
    });
    const rejected = await create(unpriced.deps, input("cloud"));
    await waitWorkflowRun(rejected.id);
    expect(
      (await unpriced.deps.store.get("project_1", rejected.id))?.status,
    ).toBe("failed");
  });

  it("validates every classification and lifecycle edge before accepting a run transition", async () => {
    const { deps } = harness();
    await expect(
      create(
        deps,
        input("cloud"),
        snapshot({ allowedProviderIds: ["manual"] }),
      ),
    ).rejects.toThrow("許可されていない");
    await expect(
      create(deps, input("manual"), snapshot({ knowledge: [] })),
    ).rejects.toThrow("承認済み");
    await expect(
      create(
        deps,
        input("manual"),
        snapshot({
          knowledge: [{ ...snapshot().knowledge[0]!, classifications: [] }],
        }),
      ),
    ).rejects.toThrow("分類");
    await expect(
      create(
        deps,
        input("manual"),
        snapshot({
          knowledge: [
            {
              ...snapshot().knowledge[0]!,
              classifications: ["public", "local"],
            },
          ],
        }),
      ),
    ).rejects.toThrow("分類");
    await expect(
      create(
        deps,
        input("local"),
        snapshot({
          knowledge: [
            {
              ...snapshot().knowledge[0]!,
              classifications: ["blocked"],
            },
          ],
        }),
      ),
    ).rejects.toThrow("分類");
    const ruleDeps = harness([manual, local, cloud], async () => ({
      response: JSON.stringify({
        answer: "rule result",
        citedKnowledgeIds: [],
        findingReferences: [],
      }),
      actualCostUsd: 0,
      model: "model",
      configVersion: "v1",
    })).deps;
    const ruleOnly = await create(
      ruleDeps,
      input("local"),
      snapshot({
        knowledge: [],
        rules: [
          {
            id: "rule_1",
            revision: 1,
            content: "rule",
            appliesToVersion: "v1",
            classifications: ["public"],
          },
        ],
      }),
    );
    await waitWorkflowRun(ruleOnly.id);
    expect((await ruleDeps.store.get("project_1", ruleOnly.id))?.status).toBe(
      "completed",
    );

    const noEndpoint = harness([
      manual,
      { ...local, endpoint: undefined },
      cloud,
    ]);
    await expect(create(noEndpoint.deps, input("local"))).rejects.toThrow(
      "providerが利用できません",
    );
    const neverInvoke = harness(
      [manual, local, cloud],
      vi.fn(async () => {
        throw new Error("should not be called");
      }),
    );
    const tooFewSteps = await create(
      neverInvoke.deps,
      input("local", { budgets: budgets({ maxSteps: 2 }) }),
    );
    await waitWorkflowRun(tooFewSteps.id);
    expect(
      (await neverInvoke.deps.store.get("project_1", tooFewSteps.id))
        ?.stopReason,
    ).toBe("step_limit");
    expect(
      (await neverInvoke.deps.store.get("project_1", tooFewSteps.id))?.steps[1]
        ?.attempts,
    ).toBe(0);

    const run = await create(deps);
    await waitWorkflowRun(run.id);
    await expect(
      submitWorkflowRunResponse(
        "project_1",
        run.id,
        {
          answer: "ok",
          citedKnowledgeIds: [knowledgeId],
          findingReferences: [],
        },
        snapshot(),
        { ...deps, providers: () => [local] },
      ),
    ).rejects.toThrow("manual provider");
    await expect(
      resumeWorkflowRun("project_1", "missing", snapshot(), deps),
    ).rejects.toThrow("ありません");
    await expect(
      resumeWorkflowRun("project_1", run.id, snapshot(), deps),
    ).rejects.toThrow("再開できる");
    await expect(
      submitWorkflowRunResponse("project_1", run.id, {}, snapshot(), deps),
    ).rejects.toThrow();
    await expect(stopWorkflowRun("project_1", "missing", deps)).rejects.toThrow(
      "ありません",
    );
    expect((await stopWorkflowRun("project_1", run.id, deps)).status).toBe(
      "stopped",
    );
    expect(listWorkflowProviders(deps)).toEqual([
      {
        id: "manual",
        kind: "manual",
        label: "Manual",
        model: "manual",
        available: true,
        costKnown: true,
      },
      {
        id: "local",
        kind: "local",
        label: "Local",
        model: "local-model",
        available: true,
        costKnown: true,
      },
      {
        id: "cloud",
        kind: "cloud",
        label: "Cloud",
        model: "cloud-model",
        available: true,
        costKnown: true,
      },
    ]);
    await expect(
      createWorkflowRun(
        {
          projectId: "project_1",
          input: input(),
          snapshot: snapshot(),
          basedOnRunId: "missing",
        },
        deps,
      ),
    ).rejects.toThrow("比較元");
    expect((await recoverInterruptedWorkflowRun(run, deps)).status).toBe(
      "waiting_response",
    );
    await abortActiveWorkflowRuns(deps);
  });

  it("uses timeout and provider ownership safely across independent runner instances", async () => {
    let startedA!: () => void;
    let startedB!: () => void;
    const a = new Promise<void>((resolve) => {
      startedA = resolve;
    });
    const b = new Promise<void>((resolve) => {
      startedB = resolve;
    });
    const invokeA = vi.fn(
      (_provider, _prompt, signal) =>
        new Promise<never>((_resolve, reject) => {
          startedA();
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const invokeB = vi.fn(
      (_provider, _prompt, signal) =>
        new Promise<never>((_resolve, reject) => {
          startedB();
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const one = harness([manual, local, cloud], invokeA);
    const two = harness([manual, local, cloud], invokeB);
    const first = await create(one.deps, input("local"));
    const second = await create(two.deps, input("local"));
    await Promise.all([a, b]);
    await (
      await import("../src/server/workflow-runner.js")
    ).abortActiveWorkflowRuns(one.deps);
    await waitWorkflowRun(first.id);
    expect((await one.deps.store.get("project_1", first.id))?.stopReason).toBe(
      "restart",
    );
    await stopWorkflowRun("project_1", second.id, two.deps);
    await waitWorkflowRun(second.id);
    expect((await two.deps.store.get("project_1", second.id))?.stopReason).toBe(
      "operator",
    );
  });

  it("retains actual provider cost on overrun and forks when model configuration changes", async () => {
    const expensive = harness(
      [
        manual,
        {
          ...local,
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 1,
          maxOutputTokens: 100,
        },
        cloud,
      ],
      async () => ({
        response: JSON.stringify({
          answer: "answer",
          citedKnowledgeIds: [knowledgeId],
          findingReferences: [],
        }),
        actualCostUsd: 4,
        model: "model-v1",
        configVersion: "config-v1",
      }),
    );
    const over = await create(
      expensive.deps,
      input("local", { budgets: budgets({ maxCostUsd: 1 }) }),
    );
    await waitWorkflowRun(over.id);
    const overSaved = (await expensive.deps.store.get("project_1", over.id))!;
    expect(overSaved).toMatchObject({
      status: "stopped",
      stopReason: "budget",
      actualCostUsd: 4,
    });
    expect(
      overSaved.steps[1]?.artifacts.some((item) => item.kind === "response"),
    ).toBe(true);

    const mutable = harness([manual, local, cloud]);
    const original = await create(mutable.deps, input("local"));
    await waitWorkflowRun(original.id);
    mutable.setProviders([
      manual,
      { ...local, model: "local-model-v2", configVersion: "local-v2" },
      cloud,
    ]);
    const recreated = await resumeWorkflowRun(
      "project_1",
      original.id,
      snapshot(),
      mutable.deps,
    );
    await waitWorkflowRun(recreated.id);
    expect(recreated.id).not.toBe(original.id);
    expect(recreated.snapshotDifference).toMatchObject({
      modelChanged: true,
      providerConfigChanged: true,
    });
  });

  it("honors a per-project maxConcurrency=1 across runs", async () => {
    let calls = 0;
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const started = new Promise<void>((resolve) => {
      startedFirst = resolve;
    });
    const invoke = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        startedFirst();
        return new Promise<{
          response: string;
          actualCostUsd: number;
          model: string;
          configVersion: string;
        }>((resolve) => {
          releaseFirst = () =>
            resolve({
              response: JSON.stringify({
                answer: "first",
                citedKnowledgeIds: [knowledgeId],
                findingReferences: [],
              }),
              actualCostUsd: 0,
              model: "m",
              configVersion: "v",
            });
        });
      }
      return {
        response: JSON.stringify({
          answer: "next",
          citedKnowledgeIds: [knowledgeId],
          findingReferences: [],
        }),
        actualCostUsd: 0,
        model: "m",
        configVersion: "v",
      };
    });
    const { deps } = harness([manual, local, cloud], invoke);
    const first = await create(
      deps,
      input("local", { budgets: budgets({ maxConcurrency: 1 }) }),
    );
    await started;
    await expect(
      create(deps, input("local", { budgets: budgets({ maxConcurrency: 1 }) })),
    ).rejects.toThrow("同時実行上限");
    expect(calls).toBe(1);
    releaseFirst();
    await waitWorkflowRun(first.id);
    const second = await create(
      deps,
      input("local", { budgets: budgets({ maxConcurrency: 1 }) }),
    );
    await waitWorkflowRun(second.id);
    expect(calls).toBe(2);
  });

  it("releases a reserved project slot when initial or resume checkpoint persistence fails", async () => {
    const { deps } = harness([manual, local, cloud], async () => {
      throw new Error("provider unavailable");
    });
    const save = deps.store.save.bind(deps.store);
    deps.store.save = async () => {
      throw new Error("disk unavailable");
    };
    await expect(create(deps, input("manual"))).rejects.toThrow(
      "disk unavailable",
    );
    deps.store.save = save;

    const failed = await create(deps, input("local"));
    await waitWorkflowRun(failed.id);
    deps.store.save = async () => {
      throw new Error("disk unavailable");
    };
    await expect(
      resumeWorkflowRun("project_1", failed.id, snapshot(), deps),
    ).rejects.toThrow("disk unavailable");
    deps.store.save = save;
    const resumed = await resumeWorkflowRun(
      "project_1",
      failed.id,
      snapshot(),
      deps,
    );
    await waitWorkflowRun(resumed.id);
    expect(resumed.id).toBe(failed.id);
  });

  it("does not start reconciliation when the manual response reaches the step limit", async () => {
    const { deps } = harness();
    const run = await create(
      deps,
      input("manual", { budgets: budgets({ maxSteps: 2 }) }),
    );
    await waitWorkflowRun(run.id);
    const result = await submitWorkflowRunResponse(
      "project_1",
      run.id,
      {
        answer: "ok",
        citedKnowledgeIds: [knowledgeId],
        findingReferences: [],
      },
      snapshot(),
      deps,
    );
    expect(result).toMatchObject({
      status: "stopped",
      stopReason: "step_limit",
    });
    expect(result.steps[2]?.attempts).toBe(0);
  });

  it("reuses a completed provider response after restart without invoking it again", async () => {
    const invoke = vi.fn(async () => ({
      response: JSON.stringify({
        answer: "restored",
        citedKnowledgeIds: [knowledgeId],
        findingReferences: [],
      }),
      actualCostUsd: 0.001,
      model: local.model,
      configVersion: local.configVersion,
    }));
    const { deps, saved } = harness([manual, local, cloud], invoke);
    const run = await create(deps, input("local"));
    await waitWorkflowRun(run.id);
    const interrupted = structuredClone(saved.get(run.id)!);
    interrupted.status = "partial";
    interrupted.answer = undefined;
    interrupted.steps[2]!.status = "queued";
    interrupted.steps[2]!.attempts = 0;
    interrupted.revision += 1;
    saved.set(run.id, interrupted);

    const resumed = await resumeWorkflowRun(
      "project_1",
      run.id,
      snapshot(),
      deps,
    );
    await waitWorkflowRun(resumed.id);
    expect((await deps.store.get("project_1", run.id))?.status).toBe(
      "completed",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("compares only identical labeled conditions and leaves unavailable metrics null", () => {
    const base: WorkflowRun = {
      id: "run_a",
      projectId: "project_1",
      revision: 1,
      status: "completed",
      query: "q",
      queryClassification: "public",
      providerId: "manual",
      providerKind: "manual",
      createdAt: "",
      updatedAt: "",
      inputFingerprint: "",
      contextFingerprint: "a".repeat(64),
      contextSnapshotRevision: 1,
      target: "target",
      targetVersion: "v1",
      knowledgeRefs: [{ id: knowledgeId, revision: 1 }],
      ruleRefs: [],
      model: "manual",
      configVersion: "v1",
      ruleVersion: "r1",
      knowledgeVersion: "k1",
      snapshot: snapshot(),
      budgets: budgets(),
      steps: [],
      artifacts: [],
      actualCostUsd: null,
      elapsedMs: 5,
      answer: {
        answer: "a",
        citedKnowledgeIds: [knowledgeId],
        findingReferences: [findingId, findingId],
      },
    };
    const right = {
      ...base,
      id: "run_b",
      answer: {
        answer: "b",
        citedKnowledgeIds: [knowledgeId],
        findingReferences: [],
      },
    };
    const expectedFindingReferences = [findingId];
    const evaluation = {
      labelSetId: "labels-v1",
      answerKeyDigest: createHash("sha256")
        .update(JSON.stringify(expectedFindingReferences))
        .digest("hex"),
      target: base.target,
      targetVersion: base.targetVersion,
      contextFingerprint: base.contextFingerprint,
      knowledgeRefs: base.knowledgeRefs,
      ruleRefs: base.ruleRefs,
      expectedFindingReferences,
      reviewTimeMsByRunId: { run_a: null, run_b: 10 },
    };
    const result = compareWorkflowRuns(base, right, evaluation);
    expect(result.eligible).toBe(true);
    expect(result.metrics.left).toMatchObject({
      falseNegatives: 0,
      duplicateFindings: 1,
      reviewTimeMs: null,
      costUsd: null,
    });
    expect(result.metrics.right).toMatchObject({
      falseNegatives: 1,
      reviewTimeMs: 10,
    });
    expect(
      compareWorkflowRuns(base, { ...right, targetVersion: "v2" }, evaluation)
        .eligible,
    ).toBe(false);
    expect(
      compareWorkflowRuns(
        base,
        { ...right, query: "a different question" },
        evaluation,
      ).eligible,
    ).toBe(false);
    expect(
      compareWorkflowRuns(
        base,
        { ...right, status: "running", answer: undefined },
        evaluation,
      ),
    ).toMatchObject({
      eligible: false,
      metrics: { left: { executionTimeMs: null }, right: { costUsd: null } },
    });
  });
});

describe("operator-configured provider adapters", () => {
  it("applies explicit local JSON/thinking settings, preserves usage, and leaves other providers unchanged", async () => {
    const configured = workflowProvidersFromEnvironment({
      WORKFLOW_LOCAL_URL: "http://127.0.0.1:8081",
      WORKFLOW_LOCAL_DISABLE_THINKING: "true",
      WORKFLOW_LOCAL_JSON_MODE: "true",
    }).find((provider) => provider.id === "local")!;
    expect(configured.configVersion).toMatch(
      /^local-v1:no-thinking:json:endpoint-[a-f0-9]{64}$/,
    );
    const bodies: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 0, completion_tokens: 2 },
      });
    };
    const result = await invokeOpenAICompatible(
      configured,
      "{}",
      new AbortController().signal,
      20,
      fetcher,
    );
    expect(result).toMatchObject({ promptTokens: 0, completionTokens: 2 });
    expect(bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0]?.response_format).toEqual({ type: "json_object" });
    await invokeOpenAICompatible(
      { ...cloud, disableThinking: true, jsonMode: true },
      "{}",
      new AbortController().signal,
      20,
      fetcher,
    );
    expect(bodies[1]).not.toHaveProperty("chat_template_kwargs");
    expect(bodies[1]).not.toHaveProperty("response_format");
    const defaultLocal = workflowProvidersFromEnvironment({
      WORKFLOW_LOCAL_URL: "http://127.0.0.1:8081",
    }).find((provider) => provider.id === "local")!;
    expect(defaultLocal.configVersion).toMatch(
      /^local-v1:endpoint-[a-f0-9]{64}$/,
    );
    await invokeOpenAICompatible(
      defaultLocal,
      "{}",
      new AbortController().signal,
      20,
      fetcher,
    );
    expect(bodies[2]).not.toHaveProperty("chat_template_kwargs");
    expect(bodies[2]).not.toHaveProperty("response_format");
  });

  it("accepts loopback local and allowlisted HTTPS cloud endpoints only", () => {
    const providers = workflowProvidersFromEnvironment({
      WORKFLOW_LOCAL_URL: "http://127.0.0.1:8080/v1",
      WORKFLOW_CLOUD_URL: "https://api.allowed.test/v1",
      WORKFLOW_CLOUD_ALLOWED_HOSTS: "api.allowed.test",
      WORKFLOW_CLOUD_API_KEY: "secret",
      WORKFLOW_CLOUD_INPUT_USD_PER_MILLION_TOKENS: "1",
      WORKFLOW_CLOUD_OUTPUT_USD_PER_MILLION_TOKENS: "2",
    });
    expect(
      providers.find((provider) => provider.id === "local")?.available,
    ).toBe(true);
    expect(
      providers.find((provider) => provider.id === "cloud")?.available,
    ).toBe(true);
    expect(
      JSON.stringify(
        providers.map(({ apiKey: _secret, endpoint: _url, ...info }) => info),
      ),
    ).not.toContain("secret");
    expect(
      workflowProvidersFromEnvironment({
        WORKFLOW_LOCAL_URL: "http://192.168.1.5:80",
      }).find((provider) => provider.id === "local")?.available,
    ).toBe(false);
    expect(
      workflowProvidersFromEnvironment({
        WORKFLOW_LOCAL_URL: "not a url",
      }).find((provider) => provider.id === "local")?.available,
    ).toBe(false);
    expect(
      workflowProvidersFromEnvironment({
        WORKFLOW_CLOUD_URL: "https://api.other.test",
        WORKFLOW_CLOUD_ALLOWED_HOSTS: "api.allowed.test",
        WORKFLOW_CLOUD_API_KEY: "key",
      }).find((provider) => provider.id === "cloud")?.available,
    ).toBe(false);
  });

  it("binds environment provider identity to a canonical endpoint without exposing secrets", () => {
    const localFor = (url?: string) =>
      workflowProvidersFromEnvironment({
        ...(url === undefined ? {} : { WORKFLOW_LOCAL_URL: url }),
      }).find((provider) => provider.id === "local")!;
    const localBase = localFor("http://127.0.0.1:8081");
    const localV1 = localFor("http://127.0.0.1:8081/v1");
    const localV1Trailing = localFor("http://127.0.0.1:8081/v1/");
    expect(localBase.endpoint).toBe("http://127.0.0.1:8081");
    expect(localV1.endpoint).toBe(localBase.endpoint);
    expect(localV1Trailing.endpoint).toBe(localBase.endpoint);
    expect(localV1.configVersion).toBe(localBase.configVersion);
    expect(localV1Trailing.configVersion).toBe(localBase.configVersion);

    const localChanged = localFor("http://127.0.0.1:8082");
    expect(localChanged.configVersion).not.toBe(localBase.configVersion);
    expect(localChanged.configVersion).not.toContain(
      "http://127.0.0.1:8082",
    );

    const localMissing = localFor();
    const localInvalid = localFor("not a url");
    expect(localMissing.available).toBe(false);
    expect(localInvalid.available).toBe(false);
    expect(localInvalid.configVersion).toBe(localMissing.configVersion);
    expect(localMissing.configVersion).not.toBe(localBase.configVersion);
    expect(localInvalid.configVersion).not.toContain("not a url");

    const cloudFor = (url: string, apiKey: string) =>
      workflowProvidersFromEnvironment({
        WORKFLOW_CLOUD_URL: url,
        WORKFLOW_CLOUD_ALLOWED_HOSTS: "api.allowed.test,api.other.test",
        WORKFLOW_CLOUD_API_KEY: apiKey,
      }).find((provider) => provider.id === "cloud")!;
    const cloud = cloudFor("https://api.allowed.test/v1", "cloud-secret-a");
    const cloudEquivalent = cloudFor(
      "https://api.allowed.test/v1/",
      "cloud-secret-b",
    );
    const cloudChanged = cloudFor(
      "https://api.other.test/v1",
      "cloud-secret-a",
    );
    expect(cloudEquivalent.endpoint).toBe(cloud.endpoint);
    expect(cloudEquivalent.configVersion).toBe(cloud.configVersion);
    expect(cloudChanged.configVersion).not.toBe(cloud.configVersion);
    expect(cloud.configVersion).not.toContain("https://api.allowed.test/v1");
    expect(cloud.configVersion).not.toContain("cloud-secret-a");
  });

  it("creates a new run when only the environment endpoint changes", async () => {
    const providersFor = (url: string) =>
      workflowProvidersFromEnvironment({ WORKFLOW_LOCAL_URL: url });
    const firstProviders = providersFor("http://127.0.0.1:8081");
    const mutable = harness(firstProviders, async (provider) => ({
      response: JSON.stringify({
        answer: "answer",
        citedKnowledgeIds: [knowledgeId],
        findingReferences: [],
      }),
      actualCostUsd: 0,
      model: provider.model,
      configVersion: provider.configVersion,
    }));
    const original = await create(mutable.deps, input("local"));
    await waitWorkflowRun(original.id);

    mutable.setProviders(providersFor("http://127.0.0.1:8082"));
    const recreated = await resumeWorkflowRun(
      "project_1",
      original.id,
      snapshot(),
      mutable.deps,
    );
    await waitWorkflowRun(recreated.id);
    expect(recreated.id).not.toBe(original.id);
    expect(recreated.basedOnRunId).toBe(original.id);
    expect(recreated.snapshotDifference).toMatchObject({
      providerConfigChanged: true,
      modelChanged: false,
    });
  });

  it("rejects oversized provider responses", async () => {
    const fetcher = vi.fn(
      async () => new Response(new Uint8Array(1_048_577), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      invokeOpenAICompatible(
        cloud,
        "{}",
        new AbortController().signal,
        100,
        fetcher,
      ),
    ).rejects.toThrow("1 MiB");
    await expect(
      invokeOpenAICompatible(manual, "{}", new AbortController().signal, 100),
    ).rejects.toThrow("endpoint");
    await expect(
      invokeOpenAICompatible(
        { ...local, endpoint: undefined },
        "{}",
        new AbortController().signal,
        100,
      ),
    ).rejects.toThrow("endpoint");
    const invalidUsage = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: -1, completion_tokens: 0 },
      }),
    ) as unknown as typeof fetch;
    await expect(
      invokeOpenAICompatible(
        cloud,
        "{}",
        new AbortController().signal,
        100,
        invalidUsage,
      ),
    ).rejects.toThrow("usage");
  });

  it("sends a bounded OpenAI-compatible request and calculates cost only from valid usage", async () => {
    const fetcher = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer secret",
        );
        return Response.json({
          model: "served-model",
          choices: [
            {
              message: {
                content:
                  '{\\"answer\\":\\"ok\\",\\"citedKnowledgeIds\\":[],\\"findingReferences\\":[]}',
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        });
      },
    ) as unknown as typeof fetch;
    const result = await invokeOpenAICompatible(
      { ...cloud, apiKey: "secret" },
      "{}",
      new AbortController().signal,
      20,
      fetcher,
    );
    expect(result.model).toBe("served-model");
    expect(result.actualCostUsd).toBe(0.000005);
    expect(result.response).toContain("citedKnowledgeIds");
  });
});
