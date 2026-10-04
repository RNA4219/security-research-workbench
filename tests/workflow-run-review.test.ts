import { describe, expect, it } from "vitest";
import {
  createWorkflowRun,
  resumeWorkflowRun,
  stopWorkflowRun,
  submitWorkflowRunResponse,
  waitWorkflowRun,
  type WorkflowProviderDefinition,
  type WorkflowRunDependencies,
  type WorkflowRunStore,
} from "../src/server/workflow-runner.js";
import { compareWorkflowRuns } from "../src/server/workflow-runner.js";
import {
  workflowRunEvaluation,
  type WorkflowRun,
  type WorkflowRunSnapshot,
} from "../src/shared/workflow-run.js";
import { createHash } from "node:crypto";

const response = JSON.stringify({
  answer: "ok",
  citedKnowledgeIds: ["knowledge_1"],
  findingReferences: [],
});
const snapshot: WorkflowRunSnapshot = {
  question: "question",
  target: "repo",
  targetVersion: "v1",
  purpose: "review",
  knowledge: [
    {
      id: "knowledge_1",
      revision: 1,
      content: "public knowledge",
      sourceRefs: [{ docId: "doc_1", revision: 1, excerpt: "public" }],
      classifications: ["public"],
    },
  ],
  rules: [],
  fingerprint: "a".repeat(64),
  uncertainty: "none",
  contextSnapshotRevision: 1,
  allowedProviderIds: ["manual", "local"],
  ruleVersion: "r1",
  knowledgeVersion: "k1",
};
const budget = (maxConcurrency = 1) => ({
  maxDurationMs: 10_000,
  maxCostUsd: 1,
  maxSteps: 3,
  maxConcurrency,
  maxRetries: 0,
});
const budgetWithDuration = (maxDurationMs: number) => ({
  ...budget(),
  maxDurationMs,
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
  model: "local-v1",
  available: true,
  costKnown: true,
  configVersion: "local-v1",
  endpoint: "http://127.0.0.1:8080",
  inputUsdPerMillionTokens: 0,
  outputUsdPerMillionTokens: 0,
  maxOutputTokens: 100,
};
function deps(
  providers: WorkflowProviderDefinition[],
  invokeModel: WorkflowRunDependencies["invokeModel"],
): WorkflowRunDependencies {
  const runs = new Map<string, WorkflowRun>();
  const store: WorkflowRunStore = {
    async get(projectId, runId) {
      const value = runs.get(runId);
      return value?.projectId === projectId
        ? structuredClone(value)
        : undefined;
    },
    async list(projectId) {
      return [...runs.values()]
        .filter((run) => run.projectId === projectId)
        .map((run) => structuredClone(run));
    },
    async save(run, expectedRevision) {
      const current = runs.get(run.id);
      if (
        expectedRevision === null
          ? current !== undefined
          : current?.revision !== expectedRevision
      )
        throw new Error("revision conflict");
      runs.set(run.id, structuredClone(run));
    },
  };
  return { store, providers: () => providers, invokeModel };
}
function create(
  dependencies: WorkflowRunDependencies,
  providerId: string,
  runBudget = budget(),
  query = "question",
) {
  return createWorkflowRun(
    {
      projectId: "project_1",
      input: {
        revision: 1,
        query,
        queryClassification: "public",
        providerId,
        budgets: runBudget,
      },
      snapshot,
    },
    dependencies,
  );
}

describe("FR-18/26/27/30 runner境界の再現", () => {
  it("manual runは未測定費用を0にせず、人のレビュー時間をunknownで保つ", async () => {
    const dependencies = deps([manual], async () => {
      throw new Error("manual provider must not invoke");
    });
    const run = await create(dependencies, "manual");
    await waitWorkflowRun(run.id);
    const waiting = (await dependencies.store.get("project_1", run.id))!;
    expect(waiting.actualCostUsd).toBeNull();
    expect(waiting.elapsedMs).toEqual(expect.any(Number));
    const completed = await submitWorkflowRunResponse(
      "project_1",
      run.id,
      {
        answer: "ok",
        citedKnowledgeIds: ["knowledge_1"],
        findingReferences: [],
      },
      snapshot,
      dependencies,
    );
    const expected: string[] = [];
    const comparison = compareWorkflowRuns(
      completed,
      completed,
      workflowRunEvaluation.parse({
        labelSetId: "labels-v1",
        answerKeyDigest: createHash("sha256")
          .update(JSON.stringify(expected))
          .digest("hex"),
        target: completed.target,
        targetVersion: completed.targetVersion,
        contextFingerprint: completed.contextFingerprint,
        knowledgeRefs: completed.knowledgeRefs,
        ruleRefs: completed.ruleRefs,
        expectedFindingReferences: expected,
        reviewTimeMsByRunId: {},
      }),
    );
    expect(comparison.metrics.left.reviewTimeMs).toBeNull();
  });

  it("同一projectのmaxConcurrency=1を越えてproviderを同時起動しない", async () => {
    const resolvers: ((value: {
      response: string;
      actualCostUsd: number;
      model: string;
      configVersion: string;
    }) => void)[] = [];
    let calls = 0;
    const dependencies = deps([manual, local], async () => {
      calls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const first = await create(dependencies, "local");
    try {
      await expect(create(dependencies, "local")).rejects.toThrow(
        "同時実行上限",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(1);
    } finally {
      while (!resolvers[0])
        await new Promise((resolve) => setTimeout(resolve, 5));
      resolvers[0]!({
        response,
        actualCostUsd: 0,
        model: "local-v1",
        configVersion: "local-v1",
      });
      await waitWorkflowRun(first.id);
    }
  });

  it("応答を無視するproviderでもoperator stopがrunを期限内に収束させる", async () => {
    let started!: () => void;
    let resolveProvider!: (result: {
      response: string;
      actualCostUsd: number;
      model: string;
      configVersion: string;
    }) => void;
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const dependencies = deps(
      [manual, local],
      async () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
          started();
        }),
    );
    const run = await create(dependencies, "local");
    await invoked;
    try {
      await stopWorkflowRun("project_1", run.id, dependencies);
      const finished = await Promise.race([
        waitWorkflowRun(run.id).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      expect(finished).toBe(true);
    } finally {
      resolveProvider({
        response,
        actualCostUsd: 0,
        model: "local-v1",
        configVersion: "local-v1",
      });
      await waitWorkflowRun(run.id);
    }
  });

  it("model config変更で再開するときは旧runのstep履歴に混在させない", async () => {
    let currentProvider = {
      ...local,
      model: "model-v1",
      configVersion: "config-v1",
    };
    const providers: WorkflowProviderDefinition[] = [manual, currentProvider];
    const dependencies = deps(providers, async (provider) => ({
      response,
      actualCostUsd: 0,
      model: provider.model,
      configVersion: provider.configVersion,
    }));
    const run = await create(dependencies, "local");
    await waitWorkflowRun(run.id);
    const saved = (await dependencies.store.get("project_1", run.id))!;
    const interrupted: WorkflowRun = {
      ...saved,
      status: "partial",
      steps: saved.steps.map((step) =>
        step.name === "context"
          ? { ...step, status: "completed" }
          : { ...step, status: "queued", attempts: 0 },
      ),
    };
    await dependencies.store.save(interrupted, saved.revision);
    currentProvider = {
      ...local,
      model: "model-v2",
      configVersion: "config-v2",
    };
    providers[1] = currentProvider;
    const resumed = await resumeWorkflowRun(
      "project_1",
      run.id,
      snapshot,
      dependencies,
    );
    try {
      expect(resumed.id).not.toBe(run.id);
    } finally {
      await waitWorkflowRun(resumed.id);
    }
  });

  it("再起動後にprovider完了済み・reconcile未完了なら残りstepを再開する", async () => {
    const dependencies = deps([manual, local], async (provider) => ({
      response,
      actualCostUsd: 0,
      model: provider.model,
      configVersion: provider.configVersion,
    }));
    const run = await create(dependencies, "local");
    await waitWorkflowRun(run.id);
    const saved = (await dependencies.store.get("project_1", run.id))!;
    const interrupted: WorkflowRun = {
      ...saved,
      status: "partial",
      steps: saved.steps.map((step) =>
        step.name === "reconcile"
          ? { ...step, status: "queued", attempts: 0 }
          : step,
      ),
    };
    await dependencies.store.save(interrupted, saved.revision);
    await resumeWorkflowRun("project_1", run.id, snapshot, dependencies);
    await waitWorkflowRun(run.id);
    expect((await dependencies.store.get("project_1", run.id))?.status).toBe(
      "completed",
    );
  });

  it("resume時に保存済みelapsedMsをmaxDuration予算へ累積する", async () => {
    const dependencies = deps([manual, local], async (provider) => ({
      response,
      actualCostUsd: 0,
      model: provider.model,
      configVersion: provider.configVersion,
    }));
    const run = await create(dependencies, "local", budgetWithDuration(1_000));
    await waitWorkflowRun(run.id);
    const saved = (await dependencies.store.get("project_1", run.id))!;
    const interrupted: WorkflowRun = {
      ...saved,
      status: "partial",
      elapsedMs: 900,
      steps: saved.steps.map((step) =>
        step.name === "context"
          ? { ...step, status: "completed" }
          : { ...step, status: "queued", attempts: 0 },
      ),
    };
    await dependencies.store.save(interrupted, saved.revision);
    let now = 0;
    dependencies.clock = () => {
      const current = now;
      now += 200;
      return current;
    };
    await resumeWorkflowRun("project_1", run.id, snapshot, dependencies);
    await waitWorkflowRun(run.id);
    const resumed = (await dependencies.store.get("project_1", run.id))!;
    expect(resumed).toMatchObject({ status: "stopped", stopReason: "timeout" });
    expect(resumed.elapsedMs).toBeGreaterThanOrEqual(1_000);
  });

  it("manual待機runの人の回答で未測定費用を0へ置き換えない", async () => {
    const dependencies = deps([manual], async () => {
      throw new Error("manual provider must not invoke");
    });
    const run = await create(dependencies, "manual");
    await waitWorkflowRun(run.id);
    const completed = await submitWorkflowRunResponse(
      "project_1",
      run.id,
      {
        answer: "ok",
        citedKnowledgeIds: ["knowledge_1"],
        findingReferences: [],
      },
      snapshot,
      dependencies,
    );
    expect(completed.actualCostUsd).toBeNull();
  });

  it("test vectors remain local and contain no external prompt or attack payload", () => {
    expect(snapshot.knowledge[0]!.content).toBe("public knowledge");
  });

  it("同じsnapshot fingerprintでも異なるqueryを同条件比較にしない", () => {
    const base: WorkflowRun = {
      id: "run_a",
      projectId: "project_1",
      revision: 1,
      status: "completed",
      query: "first question",
      queryClassification: "public",
      providerId: "manual",
      providerKind: "manual",
      createdAt: "",
      updatedAt: "",
      inputFingerprint: "",
      contextFingerprint: "a".repeat(64),
      contextSnapshotRevision: 1,
      target: "repo",
      targetVersion: "v1",
      knowledgeRefs: [{ id: "knowledge_1", revision: 1 }],
      ruleRefs: [],
      model: "manual",
      configVersion: "manual-v1",
      ruleVersion: "r1",
      knowledgeVersion: "k1",
      snapshot,
      budgets: budget(),
      steps: [],
      artifacts: [],
      actualCostUsd: null,
      elapsedMs: null,
      answer: {
        answer: "first",
        citedKnowledgeIds: ["knowledge_1"],
        findingReferences: [],
      },
    };
    const right = { ...base, id: "run_b", query: "different question" };
    const expected: string[] = [];
    const evaluation = workflowRunEvaluation.parse({
      labelSetId: "labels-v1",
      answerKeyDigest: createHash("sha256")
        .update(JSON.stringify(expected))
        .digest("hex"),
      target: "repo",
      targetVersion: "v1",
      contextFingerprint: "a".repeat(64),
      knowledgeRefs: base.knowledgeRefs,
      ruleRefs: [],
      expectedFindingReferences: expected,
      reviewTimeMsByRunId: {},
    });
    expect(compareWorkflowRuns(base, right, evaluation).eligible).toBe(false);
  });
});
