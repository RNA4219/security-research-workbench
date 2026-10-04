import { z } from "zod";
import { id, text } from "./model.js";
import type { WorkflowContext } from "./workflow.js";

export const workflowRunBudgets = z.strictObject({
  maxDurationMs: z
    .number()
    .int()
    .min(1_000)
    .max(30 * 60_000),
  maxCostUsd: z.number().finite().min(0).max(10_000),
  maxSteps: z.number().int().min(1).max(10),
  maxConcurrency: z.number().int().min(1).max(4),
  maxRetries: z.number().int().min(0).max(5),
});
export type WorkflowRunBudgets = z.infer<typeof workflowRunBudgets>;

export const workflowRunCreateInput = z.strictObject({
  revision: z.number().int().positive(),
  query: text.min(1).max(10_000),
  queryClassification: z.enum(["public", "local"]),
  providerId: id,
  budgets: workflowRunBudgets,
});
export type WorkflowRunCreateInput = z.infer<typeof workflowRunCreateInput>;

export const workflowModelResponse = z.strictObject({
  answer: z.string().min(1).max(20_000),
  citedKnowledgeIds: z.array(id).max(100),
  findingReferences: z.array(id).max(100),
});
export type WorkflowModelResponse = z.infer<typeof workflowModelResponse>;

export type WorkflowRunStepName = "context" | "provider" | "reconcile";
export type WorkflowRunStepStatus =
  "queued" | "running" | "completed" | "failed" | "stopped" | "skipped";
export type WorkflowRunStatus =
  | "running"
  | "waiting_response"
  | "completed"
  | "partial"
  | "failed"
  | "stopped";
export type WorkflowRunArtifact = {
  kind: "prompt" | "response" | "result";
  value: string | WorkflowModelResponse;
  hash: string;
};
export type WorkflowRunStep = {
  name: WorkflowRunStepName;
  status: WorkflowRunStepStatus;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  artifacts: WorkflowRunArtifact[];
};
export type WorkflowProviderSummary = {
  id: string;
  kind: "manual" | "local" | "cloud";
  label: string;
  model: string;
  available: boolean;
  costKnown: boolean;
};

export type WorkflowRun = {
  id: string;
  projectId: string;
  revision: number;
  status: WorkflowRunStatus;
  query: string;
  queryClassification: "public" | "local";
  providerId: string;
  providerKind: "manual" | "local" | "cloud";
  createdAt: string;
  updatedAt: string;
  inputFingerprint: string;
  contextFingerprint: string;
  contextSnapshotRevision: number;
  target: string;
  targetVersion: string;
  knowledgeRefs: { id: string; revision: number }[];
  ruleRefs: { id: string; revision: number }[];
  model: string;
  configVersion: string;
  ruleVersion: string;
  knowledgeVersion: string;
  snapshot: WorkflowRunSnapshot;
  budgets: WorkflowRunBudgets;
  steps: WorkflowRunStep[];
  artifacts: WorkflowRunArtifact[];
  stopReason?:
    | "operator"
    | "timeout"
    | "budget"
    | "step_limit"
    | "provider_error"
    | "invalid_response"
    | "restart";
  actualCostUsd: number | null;
  elapsedMs: number | null;
  answer?: WorkflowModelResponse;
  basedOnRunId?: string;
  snapshotDifference?: {
    targetChanged: boolean;
    providerConfigChanged: boolean;
    modelChanged: boolean;
    addedKnowledgeIds: string[];
    removedKnowledgeIds: string[];
    changedKnowledgeIds: string[];
    addedRuleIds: string[];
    removedRuleIds: string[];
    changedRuleIds: string[];
  };
};

type ClassifiedKnowledge = WorkflowContext["knowledge"][number] & {
  classifications: ("public" | "local" | "blocked" | "unclassified")[];
};
type ClassifiedRule = WorkflowContext["rules"][number] & {
  classifications: ("public" | "local" | "blocked" | "unclassified")[];
};
export type WorkflowRunSnapshot = Omit<
  WorkflowContext,
  "knowledge" | "rules"
> & {
  knowledge: ClassifiedKnowledge[];
  rules: ClassifiedRule[];
  contextSnapshotRevision: number;
  allowedProviderIds: string[];
  ruleVersion: string;
  knowledgeVersion: string;
};

export type WorkflowRunComparisonMetrics = {
  falseNegatives: number | null;
  falsePositives: number | null;
  duplicateFindings: number | null;
  reviewTimeMs: number | null;
  executionTimeMs: number | null;
  costUsd: number | null;
};
export type WorkflowRunComparison = {
  eligible: boolean;
  reason?: string;
  leftRunId: string;
  rightRunId: string;
  metrics: {
    left: WorkflowRunComparisonMetrics;
    right: WorkflowRunComparisonMetrics;
  };
};
export type WorkflowRunEvaluation = {
  labelSetId: string;
  answerKeyDigest: string;
  target: string;
  targetVersion: string;
  contextFingerprint: string;
  knowledgeRefs: { id: string; revision: number }[];
  ruleRefs: { id: string; revision: number }[];
  expectedFindingReferences: string[];
  reviewTimeMsByRunId: Record<string, number | null>;
};
export const workflowRunEvaluation = z.strictObject({
  labelSetId: text.min(1).max(200),
  answerKeyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  target: text.max(500),
  targetVersion: text.max(200),
  contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  knowledgeRefs: z
    .array(z.strictObject({ id, revision: z.number().int().positive() }))
    .max(100),
  ruleRefs: z
    .array(z.strictObject({ id, revision: z.number().int().positive() }))
    .max(100),
  expectedFindingReferences: z.array(id).max(1000),
  reviewTimeMsByRunId: z.record(id, z.number().int().nonnegative().nullable()),
});
export const workflowRunComparisonInput = z.strictObject({
  leftRunId: id,
  rightRunId: id,
  evaluation: workflowRunEvaluation,
});
