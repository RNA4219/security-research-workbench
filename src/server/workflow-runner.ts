import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../shared/domain-error.js";
import {
  workflowModelResponse,
  workflowRunCreateInput,
  type WorkflowModelResponse,
  type WorkflowProviderSummary,
  type WorkflowRun,
  type WorkflowRunArtifact,
  type WorkflowRunCreateInput,
  type WorkflowRunComparison,
  type WorkflowRunEvaluation,
  type WorkflowRunSnapshot,
  type WorkflowRunStep,
} from "../shared/workflow-run.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const refs = (items: { id: string; revision: number }[]) =>
  items.map(({ id, revision }) => ({ id, revision }));
const artifact = (
  kind: WorkflowRunArtifact["kind"],
  value: WorkflowRunArtifact["value"],
): WorkflowRunArtifact => ({
  kind,
  value,
  hash: sha256(typeof value === "string" ? value : JSON.stringify(value)),
});

export type WorkflowProviderDefinition = WorkflowProviderSummary & {
  configVersion: string;
  endpoint?: string;
  apiKey?: string;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  maxOutputTokens?: number;
  disableThinking?: boolean;
  jsonMode?: boolean;
};
export type WorkflowProviderResult = {
  response: string;
  actualCostUsd: number | null;
  model: string;
  configVersion: string;
  promptTokens?: number;
  completionTokens?: number;
};
export type WorkflowRunStore = {
  get(projectId: string, runId: string): Promise<WorkflowRun | undefined>;
  list(projectId: string): Promise<WorkflowRun[]>;
  save(run: WorkflowRun, expectedRevision: number | null): Promise<void>;
};
export type WorkflowRunDependencies = {
  store: WorkflowRunStore;
  providers: () => readonly WorkflowProviderDefinition[];
  invokeModel: (
    provider: WorkflowProviderDefinition,
    prompt: string,
    signal: AbortSignal,
    maxOutputTokens: number,
  ) => Promise<WorkflowProviderResult>;
  clock?: () => number;
};
export type WorkflowRunStart = {
  projectId: string;
  input: WorkflowRunCreateInput;
  snapshot: WorkflowRunSnapshot;
  basedOnRunId?: string;
};

const STEP_NAMES = ["context", "provider", "reconcile"] as const;
function newSteps(): WorkflowRunStep[] {
  return STEP_NAMES.map((name) => ({
    name,
    status: "queued",
    attempts: 0,
    artifacts: [],
  }));
}
function promptFor(query: string, context: WorkflowRunSnapshot) {
  return JSON.stringify({
    task: "Use only the approved context below. Return a JSON object with answer, citedKnowledgeIds, and findingReferences. Do not make a human decision or mark anything resolved.",
    query,
    target: context.target,
    targetVersion: context.targetVersion,
    purpose: context.purpose,
    uncertainty: context.uncertainty,
    knowledge: context.knowledge.map(
      ({ id, revision, content, sourceRefs }) => ({
        id,
        revision,
        content,
        sourceRefs,
      }),
    ),
    rules: context.rules.map(({ id, revision, content }) => ({
      id,
      revision,
      content,
    })),
  });
}
function validateSnapshot(
  provider: WorkflowProviderDefinition,
  snapshot: WorkflowRunSnapshot,
  queryClassification: "public" | "local",
) {
  if (!snapshot.allowedProviderIds.includes(provider.id))
    throw new DomainError("案件で許可されていないproviderです");
  const kinds = provider.kind === "cloud" ? ["public"] : ["public", "local"];
  if (!kinds.includes(queryClassification))
    throw new DomainError("queryの分類がproviderへの送信条件を満たしません");
  const entries = [...snapshot.knowledge, ...snapshot.rules];
  if (!entries.length)
    throw new DomainError("承認済みの知識または基準がありません");
  for (const item of entries) {
    const sourceRefs = (item as { sourceRefs?: unknown }).sourceRefs;
    const sourceCount = Array.isArray(sourceRefs)
      ? sourceRefs.length
      : undefined;
    if (
      item.classifications.length === 0 ||
      (sourceCount !== undefined && item.classifications.length !== sourceCount)
    )
      throw new DomainError("出典分類がない知識は実行に使えません");
    if (
      item.classifications.some(
        (classification) => !kinds.includes(classification),
      )
    )
      throw new DomainError(
        provider.kind === "cloud"
          ? "外部providerへは公開資料だけを送信できます"
          : "providerへ送信できない資料分類を含んでいます",
      );
  }
  if (provider.kind !== "manual" && (!provider.available || !provider.endpoint))
    throw new DomainError("設定済みmodel providerが利用できません");
}
function inputFingerprint(
  projectId: string,
  input: WorkflowRunCreateInput,
  snapshot: WorkflowRunSnapshot,
) {
  return sha256(
    JSON.stringify({
      projectId,
      revision: input.revision,
      query: input.query,
      providerId: input.providerId,
      budgets: input.budgets,
      contextFingerprint: snapshot.fingerprint,
      contextSnapshotRevision: snapshot.contextSnapshotRevision,
      ruleVersion: snapshot.ruleVersion,
      knowledgeVersion: snapshot.knowledgeVersion,
    }),
  );
}
function snapshotDifference(
  before: WorkflowRun,
  after: WorkflowRunSnapshot,
  provider: WorkflowProviderDefinition,
) {
  const diff = (
    oldItems: { id: string; revision: number }[],
    newItems: { id: string; revision: number }[],
  ) => {
    const oldMap = new Map(oldItems.map((item) => [item.id, item.revision]));
    const newMap = new Map(newItems.map((item) => [item.id, item.revision]));
    return {
      added: [...newMap.keys()].filter((id) => !oldMap.has(id)).sort(),
      removed: [...oldMap.keys()].filter((id) => !newMap.has(id)).sort(),
      changed: [...newMap.keys()]
        .filter((id) => oldMap.has(id) && oldMap.get(id) !== newMap.get(id))
        .sort(),
    };
  };
  const knowledge = diff(before.knowledgeRefs, refs(after.knowledge));
  const rules = diff(before.ruleRefs, refs(after.rules));
  return {
    targetChanged:
      before.target !== after.target ||
      before.targetVersion !== after.targetVersion,
    providerConfigChanged: before.configVersion !== provider.configVersion,
    modelChanged: before.model !== provider.model,
    addedKnowledgeIds: knowledge.added,
    removedKnowledgeIds: knowledge.removed,
    changedKnowledgeIds: knowledge.changed,
    addedRuleIds: rules.added,
    removedRuleIds: rules.removed,
    changedRuleIds: rules.changed,
  };
}
function estimatedCost(prompt: string, provider: WorkflowProviderDefinition) {
  if (
    provider.inputUsdPerMillionTokens === undefined ||
    provider.outputUsdPerMillionTokens === undefined ||
    provider.maxOutputTokens === undefined
  )
    return null;
  const inputTokens = Buffer.byteLength(prompt, "utf8");
  return (
    (inputTokens * provider.inputUsdPerMillionTokens +
      provider.maxOutputTokens * provider.outputUsdPerMillionTokens) /
    1_000_000
  );
}
function ensureTime(
  run: WorkflowRun,
  startedAt: number,
  clock: () => number,
  elapsedBefore = 0,
) {
  if (elapsedBefore + clock() - startedAt >= run.budgets.maxDurationMs) {
    run.stopReason = "timeout";
    run.status = "stopped";
    throw new DomainError("runの時間上限に達しました");
  }
}
function addCost(run: WorkflowRun, cost: number | null) {
  if (cost === null) return;
  const next = (run.actualCostUsd ?? 0) + cost;
  run.actualCostUsd = next;
  if (next > run.budgets.maxCostUsd) {
    run.stopReason = "budget";
    run.status = "stopped";
    throw new DomainError("runの費用上限を超えました");
  }
}
function setStep(step: WorkflowRunStep, status: WorkflowRunStep["status"]) {
  step.status = status;
  if (status === "running") {
    step.startedAt ??= now();
    step.attempts += 1;
  }
  if (["completed", "failed", "stopped", "skipped"].includes(status))
    step.finishedAt = now();
}
async function checkpoint(
  deps: WorkflowRunDependencies,
  run: WorkflowRun,
  expectedRevision: number | null,
) {
  run.revision = (expectedRevision ?? 0) + 1;
  run.updatedAt = now();
  await deps.store.save(structuredClone(run), expectedRevision);
}
function throwIfStopped(run: WorkflowRun, signal: AbortSignal) {
  if (signal.aborted || run.status === "stopped")
    throw new DomainError("runが停止されました");
}
function isRunStopped(run: WorkflowRun, signal?: AbortSignal) {
  return signal?.aborted === true || (run as WorkflowRun).status === "stopped";
}
function invokeUntilAbort(
  deps: WorkflowRunDependencies,
  provider: WorkflowProviderDefinition,
  prompt: string,
  signal: AbortSignal,
  maxOutputTokens: number,
) {
  return new Promise<WorkflowProviderResult>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DomainError("runが停止されました"),
      );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    void deps.invokeModel(provider, prompt, signal, maxOutputTokens).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const activeControllers = new Map<
  string,
  {
    controller: AbortController;
    run: WorkflowRun;
    deps: WorkflowRunDependencies;
  }
>();
const backgroundRuns = new Map<
  string,
  { promise: Promise<void>; deps: WorkflowRunDependencies }
>();
const projectRunSlots = new WeakMap<
  WorkflowRunDependencies,
  Map<string, Map<string, number>>
>();
const scheduledRuns = new Map<
  string,
  { run: WorkflowRun; deps: WorkflowRunDependencies }
>();
function reserveRunSlot(
  deps: WorkflowRunDependencies,
  projectId: string,
  runId: string,
  requestedLimit: number,
) {
  const projects =
    projectRunSlots.get(deps) ?? new Map<string, Map<string, number>>();
  const slots = projects.get(projectId) ?? new Map<string, number>();
  const effectiveLimit = Math.min(4, requestedLimit, ...slots.values());
  if (slots.size >= effectiveLimit)
    throw new DomainError("案件の同時実行上限に達しています", 409);
  slots.set(runId, requestedLimit);
  projects.set(projectId, slots);
  projectRunSlots.set(deps, projects);
  return () => {
    slots.delete(runId);
    if (!slots.size) projects.delete(projectId);
  };
}
async function executeWithRunSlot(
  run: WorkflowRun,
  snapshot: WorkflowRunSnapshot,
  provider: WorkflowProviderDefinition,
  deps: WorkflowRunDependencies,
  release: () => void,
) {
  scheduledRuns.set(run.id, { run, deps });
  try {
    if (run.status === "stopped") return;
    await execute(run, snapshot, provider, deps);
  } finally {
    release();
    scheduledRuns.delete(run.id);
  }
}

async function execute(
  run: WorkflowRun,
  snapshot: WorkflowRunSnapshot,
  provider: WorkflowProviderDefinition,
  deps: WorkflowRunDependencies,
) {
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();
  const elapsedBefore = run.elapsedMs ?? 0;
  const signalController = new AbortController();
  activeControllers.set(run.id, { controller: signalController, run, deps });
  const timer = setTimeout(
    () => {
      if (run.status === "running") {
        run.stopReason = "timeout";
        run.status = "stopped";
      }
      signalController.abort(new Error("timeout"));
    },
    Math.max(0, run.budgets.maxDurationMs - elapsedBefore),
  );
  const prompt = promptFor(run.query, snapshot);
  try {
    ensureTime(run, startedAt, clock, elapsedBefore);
    const mayStartStep = () =>
      run.steps.filter((step) => step.attempts > 0).length <
      run.budgets.maxSteps;
    if (!mayStartStep() && run.steps[0]!.status !== "completed") {
      run.status = "stopped";
      run.stopReason = "step_limit";
      return;
    }
    const contextStep = run.steps[0]!;
    if (contextStep.status !== "completed") {
      setStep(contextStep, "running");
      await checkpoint(deps, run, run.revision);
      throwIfStopped(run, signalController.signal);
      ensureTime(run, startedAt, clock, elapsedBefore);
      contextStep.artifacts.push(
        artifact(
          "result",
          JSON.stringify({
            fingerprint: snapshot.fingerprint,
            contextSnapshotRevision: snapshot.contextSnapshotRevision,
          }),
        ),
      );
      setStep(contextStep, "completed");
      await checkpoint(deps, run, run.revision);
      throwIfStopped(run, signalController.signal);
    }
    ensureTime(run, startedAt, clock, elapsedBefore);
    const providerStep = run.steps[1]!;
    if (provider.kind === "manual") {
      if (providerStep.status !== "completed") {
        if (!mayStartStep()) {
          run.status = "stopped";
          run.stopReason = "step_limit";
          return;
        }
        setStep(providerStep, "running");
        await checkpoint(deps, run, run.revision);
        throwIfStopped(run, signalController.signal);
        providerStep.artifacts.push(artifact("prompt", prompt));
        run.artifacts.push(providerStep.artifacts.at(-1)!);
        setStep(providerStep, "completed");
      }
      run.status = "waiting_response";
      await checkpoint(deps, run, run.revision);
      return;
    }
    if (providerStep.status !== "completed") {
      if (run.budgets.maxSteps < 3) {
        run.status = "stopped";
        run.stopReason = "step_limit";
        return;
      }
      if (!mayStartStep()) {
        run.status = "stopped";
        run.stopReason = "step_limit";
        return;
      }
      const maximumCost = estimatedCost(prompt, provider);
      if (maximumCost === null)
        throw new DomainError(
          "費用見積りを設定できないmodel providerは実行できません",
        );
      const remainingRetryCalls = Math.max(
        1,
        run.budgets.maxRetries + 1 - providerStep.attempts,
      );
      const reservedCost = maximumCost * remainingRetryCalls;
      if ((run.actualCostUsd ?? 0) + reservedCost > run.budgets.maxCostUsd) {
        run.status = "stopped";
        run.stopReason = "budget";
        throw new DomainError("providerの費用見積りが設定予算を超えます");
      }
      if (
        providerStep.status === "failed" &&
        providerStep.attempts >= run.budgets.maxRetries + 1
      ) {
        run.status = "partial";
        run.stopReason = "provider_error";
        return;
      }
      let providerResult: WorkflowProviderResult | undefined;
      setStep(providerStep, "running");
      await checkpoint(deps, run, run.revision);
      throwIfStopped(run, signalController.signal);
      while (!providerResult) {
        throwIfStopped(run, signalController.signal);
        ensureTime(run, startedAt, clock, elapsedBefore);
        try {
          providerResult = await invokeUntilAbort(
            deps,
            provider,
            prompt,
            signalController.signal,
            provider.maxOutputTokens!,
          );
        } catch (error) {
          if (provider.kind === "cloud") run.actualCostUsd = null;
          if (
            signalController.signal.aborted ||
            run.status === "stopped" ||
            providerStep.attempts >= run.budgets.maxRetries + 1
          )
            throw error;
          providerStep.error =
            error instanceof Error
              ? error.message.slice(0, 500)
              : "provider error";
          providerStep.attempts += 1;
          await checkpoint(deps, run, run.revision);
        }
      }
      if (!providerResult)
        throw new DomainError("providerから応答を取得できませんでした");
      run.model = providerResult.model;
      run.configVersion = providerResult.configVersion;
      providerStep.artifacts.push(
        artifact("response", providerResult.response),
      );
      run.artifacts.push(providerStep.artifacts.at(-1)!);
      if (providerResult.actualCostUsd === null) {
        run.actualCostUsd = null;
      } else if (run.actualCostUsd !== null) {
        addCost(run, providerResult.actualCostUsd);
      }
      setStep(providerStep, "completed");
      try {
        run.answer = parseResponse(providerResult.response, snapshot);
      } catch (error) {
        run.stopReason = "invalid_response";
        throw error;
      }
      await checkpoint(deps, run, run.revision);
      throwIfStopped(run, signalController.signal);
    }
    if (providerStep.status === "completed" && !run.answer) {
      const response = providerStep.artifacts.findLast(
        (item) => item.kind === "response",
      )?.value;
      if (typeof response !== "string")
        throw new DomainError(
          "完了済みprovider stepにresponse artifactがありません",
        );
      try {
        run.answer = parseResponse(response, snapshot);
      } catch (error) {
        run.stopReason = "invalid_response";
        throw error;
      }
      await checkpoint(deps, run, run.revision);
    }
    if (run.answer && run.steps[2]!.status !== "completed")
      await reconcile(run, run.answer, deps, signalController.signal);
  } catch (error) {
    const active = run.steps.find((step) => step.status === "running");
    if (active) {
      active.error =
        error instanceof Error ? error.message.slice(0, 500) : "run error";
      setStep(
        active,
        run.status === "stopped" || signalController.signal.aborted
          ? "stopped"
          : "failed",
      );
    }
    if (run.status !== "stopped") {
      run.status = "failed";
      run.stopReason ??= "provider_error";
    }
    await checkpoint(deps, run, run.revision);
  } finally {
    clearTimeout(timer);
    activeControllers.delete(run.id);
    run.elapsedMs = Math.max(0, elapsedBefore + clock() - startedAt);
    await checkpoint(deps, run, run.revision);
  }
}
function parseResponse(
  raw: string,
  snapshot: WorkflowRunSnapshot,
): WorkflowModelResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError("provider responseはJSONではありません");
  }
  const answer = workflowModelResponse.parse(parsed);
  const knowledgeIds = new Set(snapshot.knowledge.map((item) => item.id));
  if (answer.citedKnowledgeIds.some((id) => !knowledgeIds.has(id)))
    throw new DomainError("responseに今回の知識snapshotにない引用があります");
  return answer;
}
async function reconcile(
  run: WorkflowRun,
  answer: WorkflowModelResponse,
  deps: WorkflowRunDependencies,
  signal?: AbortSignal,
) {
  const step = run.steps[2]!;
  if (isRunStopped(run, signal)) return;
  if (
    run.steps.filter((item) => item.attempts > 0).length >= run.budgets.maxSteps
  ) {
    run.status = "stopped";
    run.stopReason = "step_limit";
    return;
  }
  setStep(step, "running");
  await checkpoint(deps, run, run.revision);
  if (isRunStopped(run, signal)) return;
  step.artifacts.push(artifact("result", answer));
  run.artifacts.push(step.artifacts.at(-1)!);
  setStep(step, "completed");
  run.status = "completed";
  await checkpoint(deps, run, run.revision);
}

export function listWorkflowProviders(
  deps: WorkflowRunDependencies,
): WorkflowProviderSummary[] {
  return deps
    .providers()
    .map(({ id, kind, label, model, available, costKnown }) => ({
      id,
      kind,
      label,
      model,
      available,
      costKnown,
    }));
}
export async function createWorkflowRun(
  start: WorkflowRunStart,
  deps: WorkflowRunDependencies,
): Promise<WorkflowRun> {
  const input = workflowRunCreateInput.parse(start.input);
  const provider = deps
    .providers()
    .find((item) => item.id === input.providerId);
  if (!provider) throw new DomainError("providerが見つかりません", 404);
  validateSnapshot(provider, start.snapshot, input.queryClassification);
  const basedOn = start.basedOnRunId
    ? await deps.store.get(start.projectId, start.basedOnRunId)
    : undefined;
  if (start.basedOnRunId && !basedOn)
    throw new DomainError("比較元runがありません", 404);
  const runId = randomUUID();
  const releaseRunSlot = reserveRunSlot(
    deps,
    start.projectId,
    runId,
    input.budgets.maxConcurrency,
  );
  const run: WorkflowRun = {
    id: runId,
    projectId: start.projectId,
    revision: 0,
    status: "running",
    query: input.query,
    queryClassification: input.queryClassification,
    providerId: provider.id,
    providerKind: provider.kind,
    createdAt: now(),
    updatedAt: now(),
    inputFingerprint: inputFingerprint(start.projectId, input, start.snapshot),
    contextFingerprint: start.snapshot.fingerprint,
    contextSnapshotRevision: start.snapshot.contextSnapshotRevision,
    target: start.snapshot.target,
    targetVersion: start.snapshot.targetVersion,
    knowledgeRefs: refs(start.snapshot.knowledge),
    ruleRefs: refs(start.snapshot.rules),
    model: provider.model,
    configVersion: provider.configVersion,
    ruleVersion: start.snapshot.ruleVersion,
    knowledgeVersion: start.snapshot.knowledgeVersion,
    snapshot: structuredClone(start.snapshot),
    budgets: input.budgets,
    steps: newSteps(),
    artifacts: [],
    actualCostUsd: provider.kind === "manual" ? null : 0,
    elapsedMs: null,
    basedOnRunId: basedOn?.id,
    snapshotDifference: basedOn
      ? snapshotDifference(basedOn, start.snapshot, provider)
      : undefined,
  };
  try {
    await checkpoint(deps, run, null);
  } catch (error) {
    releaseRunSlot();
    throw error;
  }
  const task = executeWithRunSlot(
    run,
    start.snapshot,
    provider,
    deps,
    releaseRunSlot,
  );
  backgroundRuns.set(run.id, { promise: task, deps });
  void task.finally(() => backgroundRuns.delete(run.id)).catch(() => undefined);
  return run;
}
export async function resumeWorkflowRun(
  projectId: string,
  runId: string,
  snapshot: WorkflowRunSnapshot,
  deps: WorkflowRunDependencies,
) {
  const previous = await deps.store.get(projectId, runId);
  if (!previous) throw new DomainError("runがありません", 404);
  const configuredProvider = deps
    .providers()
    .find((item) => item.id === previous.providerId);
  if (!configuredProvider)
    throw new DomainError("providerが見つかりません", 404);
  if (
    previous.contextFingerprint !== snapshot.fingerprint ||
    previous.contextSnapshotRevision !== snapshot.contextSnapshotRevision ||
    previous.configVersion !== configuredProvider.configVersion ||
    previous.model !== configuredProvider.model
  )
    return createWorkflowRun(
      {
        projectId,
        input: {
          revision: snapshot.contextSnapshotRevision,
          query: previous.query,
          queryClassification: previous.queryClassification,
          providerId: previous.providerId,
          budgets: previous.budgets,
        },
        snapshot,
        basedOnRunId: previous.id,
      },
      deps,
    );
  if (
    previous.status === "completed" ||
    previous.status === "waiting_response" ||
    previous.status === "running"
  )
    throw new DomainError("このrunは再開できる状態ではありません");
  const provider = configuredProvider;
  validateSnapshot(provider, snapshot, previous.queryClassification);
  const run = structuredClone(previous);
  run.status = "running";
  run.stopReason = undefined;
  const releaseRunSlot = reserveRunSlot(
    deps,
    projectId,
    run.id,
    run.budgets.maxConcurrency,
  );
  try {
    await checkpoint(deps, run, previous.revision);
  } catch (error) {
    releaseRunSlot();
    throw error;
  }
  const task = executeWithRunSlot(
    run,
    snapshot,
    provider,
    deps,
    releaseRunSlot,
  );
  backgroundRuns.set(run.id, { promise: task, deps });
  void task.finally(() => backgroundRuns.delete(run.id)).catch(() => undefined);
  return run;
}
export async function stopWorkflowRun(
  projectId: string,
  runId: string,
  deps: WorkflowRunDependencies,
) {
  const stored = await deps.store.get(projectId, runId);
  if (!stored) throw new DomainError("runがありません", 404);
  const candidate = activeControllers.get(runId);
  const live = candidate?.deps === deps ? candidate : undefined;
  const scheduled = scheduledRuns.get(runId);
  const run = live?.run ?? (scheduled?.deps === deps ? scheduled.run : stored);
  if (["completed", "failed", "stopped"].includes(run.status)) return run;
  live?.controller.abort(new Error("operator stop"));
  run.status = "stopped";
  run.stopReason = "operator";
  const active = run.steps.find((step) => step.status === "running");
  if (active) setStep(active, "stopped");
  await checkpoint(deps, run, run.revision);
  return run;
}
export async function submitWorkflowRunResponse(
  projectId: string,
  runId: string,
  raw: unknown,
  snapshot: WorkflowRunSnapshot,
  deps: WorkflowRunDependencies,
) {
  const previous = await deps.store.get(projectId, runId);
  if (!previous) throw new DomainError("runがありません", 404);
  if (previous.status !== "waiting_response")
    throw new DomainError("手動回答の待機中ではありません");
  if (
    previous.contextFingerprint !== snapshot.fingerprint ||
    previous.contextSnapshotRevision !== snapshot.contextSnapshotRevision
  )
    throw new DomainError(
      "知識snapshotが変わりました。旧runへの回答は受け付けません",
    );
  const answer = workflowModelResponse.parse(raw);
  const cited = new Set(snapshot.knowledge.map((item) => item.id));
  if (answer.citedKnowledgeIds.some((id) => !cited.has(id)))
    throw new DomainError("回答に今回の知識snapshotにない引用があります");
  const provider = deps
    .providers()
    .find((item) => item.id === previous.providerId);
  if (!provider || provider.kind !== "manual")
    throw new DomainError("manual providerのrunではありません");
  const run = structuredClone(previous);
  run.answer = answer;
  run.artifacts.push(artifact("response", answer));
  run.steps[2]!.status = "queued";
  await checkpoint(deps, run, previous.revision);
  await reconcile(run, answer, deps);
  return run;
}

export async function waitWorkflowRun(runId: string) {
  await backgroundRuns.get(runId)?.promise;
}

const normalizedRefs = (items: { id: string; revision: number }[]) =>
  JSON.stringify(
    refs(items).sort(
      (left, right) =>
        left.id.localeCompare(right.id) || left.revision - right.revision,
    ),
  );
export function compareWorkflowRuns(
  left: WorkflowRun,
  right: WorkflowRun,
  evaluation: WorkflowRunEvaluation,
): WorkflowRunComparison {
  const none: WorkflowRunComparison["metrics"]["left"] = {
    falseNegatives: null,
    falsePositives: null,
    duplicateFindings: null,
    reviewTimeMs: null,
    executionTimeMs: null,
    costUsd: null,
  };
  const sameConditions =
    left.target === right.target &&
    left.targetVersion === right.targetVersion &&
    left.query === right.query &&
    left.queryClassification === right.queryClassification &&
    left.contextFingerprint === right.contextFingerprint &&
    left.ruleVersion === right.ruleVersion &&
    left.knowledgeVersion === right.knowledgeVersion &&
    normalizedRefs(left.knowledgeRefs) ===
      normalizedRefs(right.knowledgeRefs) &&
    normalizedRefs(left.ruleRefs) === normalizedRefs(right.ruleRefs) &&
    left.target === evaluation.target &&
    left.targetVersion === evaluation.targetVersion &&
    left.contextFingerprint === evaluation.contextFingerprint &&
    normalizedRefs(left.knowledgeRefs) ===
      normalizedRefs(evaluation.knowledgeRefs) &&
    normalizedRefs(left.ruleRefs) === normalizedRefs(evaluation.ruleRefs) &&
    Boolean(evaluation.labelSetId.trim()) &&
    Boolean(evaluation.answerKeyDigest.trim()) &&
    sha256(JSON.stringify([...evaluation.expectedFindingReferences].sort())) ===
      evaluation.answerKeyDigest;
  if (!sameConditions)
    return {
      eligible: false,
      reason: "対象・知識・ルール・正解集合が同一ではありません",
      leftRunId: left.id,
      rightRunId: right.id,
      metrics: { left: none, right: none },
    };
  if (
    left.status !== "completed" ||
    right.status !== "completed" ||
    !left.answer ||
    !right.answer
  )
    return {
      eligible: false,
      reason: "両runの回答が完了していません",
      leftRunId: left.id,
      rightRunId: right.id,
      metrics: { left: none, right: none },
    };
  const expected = new Set(evaluation.expectedFindingReferences);
  const calculate = (run: WorkflowRun) => {
    const findings = run.answer!.findingReferences;
    const predicted = new Set(findings);
    return {
      falseNegatives: [...expected].filter((id) => !predicted.has(id)).length,
      falsePositives: [...predicted].filter((id) => !expected.has(id)).length,
      duplicateFindings: findings.length - predicted.size,
      reviewTimeMs: evaluation.reviewTimeMsByRunId[run.id] ?? null,
      executionTimeMs: run.elapsedMs,
      costUsd: run.actualCostUsd,
    };
  };
  return {
    eligible: true,
    leftRunId: left.id,
    rightRunId: right.id,
    metrics: { left: calculate(left), right: calculate(right) },
  };
}

export async function recoverInterruptedWorkflowRun(
  run: WorkflowRun,
  deps: WorkflowRunDependencies,
) {
  if (run.status !== "running") return run;
  const recovered = structuredClone(run);
  recovered.status = "partial";
  recovered.stopReason = "restart";
  for (const step of recovered.steps) {
    if (step.status === "running") {
      step.status = "failed";
      step.finishedAt = now();
      step.error = "process restart interrupted this step";
    }
  }
  await checkpoint(deps, recovered, run.revision);
  return recovered;
}

export async function abortActiveWorkflowRuns(deps: WorkflowRunDependencies) {
  const activeRuns = [...activeControllers.entries()].filter(
    ([, active]) => active.deps === deps,
  );
  for (const [, active] of activeRuns) {
    active.run.status = "stopped";
    active.run.stopReason = "restart";
    active.controller.abort(new Error("server shutdown"));
  }
  for (const [runId, scheduled] of scheduledRuns) {
    if (scheduled.deps !== deps || activeControllers.has(runId)) continue;
    scheduled.run.status = "stopped";
    scheduled.run.stopReason = "restart";
    await checkpoint(deps, scheduled.run, scheduled.run.revision);
  }
  await Promise.all(
    [...backgroundRuns.values()]
      .filter((item) => item.deps === deps)
      .map((item) => item.promise),
  );
}
