import { z } from "zod";
import { id, text } from "./model.js";

/**
 * The model-review contract deliberately lives beside, but independently
 * from, the fixed diagnostic engine contract.  A model finding is an
 * observation to be reviewed by a person; it is never a proof of safety or
 * an instruction to modify the repository.
 */
export const MODEL_REVIEW_SCHEMA_VERSION = "1" as const;

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const modelReviewSourceRefSchema = z.strictObject({
  id,
  version: text.max(200),
  hash: sha256Schema,
  excerpt: text.max(4000),
});
export type ModelReviewSourceRef = z.infer<typeof modelReviewSourceRefSchema>;

/** An approved, immutable product-knowledge item supplied to one review. */
export const modelReviewKnowledgeSchema = z.strictObject({
  id,
  revision: z.number().int().positive().optional(),
  version: text.max(200),
  hash: sha256Schema,
  content: z.string().trim().min(1).max(50_000),
  sourceRefs: z.array(modelReviewSourceRefSchema).min(1).max(50),
  status: z.literal("active"),
});
export type ModelReviewKnowledge = z.infer<typeof modelReviewKnowledgeSchema>;

export const modelReviewJudgmentSchema = z.enum([
  "unconfirmed",
  "needs_action",
  "false_positive",
  "duplicate",
  "accepted_known",
]);
export type ModelReviewJudgment = z.infer<typeof modelReviewJudgmentSchema>;

/** A prior human judgment which may be used only when its conditions match. */
export const modelReviewPastJudgmentSchema = z.strictObject({
  id,
  revision: z.number().int().positive(),
  targetVersion: text.max(200),
  conditionHash: sha256Schema.optional(),
  judgment: modelReviewJudgmentSchema,
  reason: text.max(5000),
  sourceRefs: z.array(modelReviewSourceRefSchema).min(1).max(50),
});
export type ModelReviewPastJudgment = z.infer<
  typeof modelReviewPastJudgmentSchema
>;

/** Fixed-rule output is context only; the model must inspect the source independently. */
export const modelReviewFixedFindingSchema = z.strictObject({
  id,
  ruleId: id,
  path: text.max(1000),
  line: z.number().int().positive(),
  evidence: text.max(4000),
  title: text.max(500),
});
export type ModelReviewFixedFinding = z.infer<
  typeof modelReviewFixedFindingSchema
>;

export const modelReviewInputSchema = z.strictObject({
  target: text.max(500),
  targetVersion: text.max(200),
  purpose: text.max(5000),
  conditionHash: sha256Schema.optional(),
  // A code-only evaluation is valid; the service records the absence of
  // approved knowledge as a limitation instead of inventing a specification.
  approvedKnowledge: z.array(modelReviewKnowledgeSchema).max(200).default([]),
  pastJudgments: z.array(modelReviewPastJudgmentSchema).max(500).default([]),
  fixedFindings: z.array(modelReviewFixedFindingSchema).max(10_000).default([]),
  /** Additional approved specification IDs that findings may cite. */
  specificationRefs: z.array(modelReviewSourceRefSchema).max(200).default([]),
});
export type ModelReviewInput = z.infer<typeof modelReviewInputSchema>;

export const modelReviewProviderKindSchema = z.enum([
  "local",
  "cloud",
  "manual",
  "injected",
]);
export type ModelReviewProviderKind = z.infer<
  typeof modelReviewProviderKindSchema
>;

/** Provider identity is safe to record and intentionally excludes endpoint/API keys. */
export const modelReviewProviderSchema = z.strictObject({
  id,
  kind: modelReviewProviderKindSchema,
  model: text.max(200),
  configVersion: text.max(200),
  maxOutputTokens: z.number().int().positive().max(32_768),
  inputUsdPerMillionTokens: z.number().finite().nonnegative().optional(),
  outputUsdPerMillionTokens: z.number().finite().nonnegative().optional(),
});
export type ModelReviewProvider = z.infer<typeof modelReviewProviderSchema>;

export const modelReviewUncertaintyLevelSchema = z.enum([
  "low",
  "medium",
  "high",
]);
export type ModelReviewUncertaintyLevel = z.infer<
  typeof modelReviewUncertaintyLevelSchema
>;

export const modelReviewFindingSchema = z.strictObject({
  /** Model-local IDs are namespaced by the service with the batch index on acceptance. */
  id,
  category: text.max(200),
  severity: z.enum(["high", "medium", "low", "info"]),
  title: text.max(500),
  /** Independent reasoning is required so fixed-rule results are not paraphrased. */
  rationale: text.max(5000),
  path: text.max(1000),
  line: z.number().int().positive(),
  /** Exact source line copied from the pinned snapshot. */
  // Do not trim: indentation and trailing spaces are part of the exact source citation.
  originalText: z.string().min(1).max(4000),
  specRefIds: z.array(id).max(100),
  relatedFixedFindingIds: z.array(id).max(100),
  pastJudgmentIds: z.array(id).max(100),
  remediation: z.strictObject({
    guidance: text.max(4000),
    humanReviewRequired: z.literal(true),
  }),
  falsePositiveCandidate: z.boolean(),
  uncertainty: z.strictObject({
    level: modelReviewUncertaintyLevelSchema,
    reasons: z.array(text.max(1000)).max(20),
  }),
});
export type ModelReviewFinding = z.infer<typeof modelReviewFindingSchema>;

export const modelReviewOmissionSchema = z.strictObject({
  path: text.max(1000),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  reason: text.max(1000),
});
export type ModelReviewOmission = z.infer<typeof modelReviewOmissionSchema>;

/** The only JSON shape accepted from a model batch response. */
export const modelReviewResponseSchema = z.strictObject({
  schemaVersion: z
    .literal(MODEL_REVIEW_SCHEMA_VERSION)
    .default(MODEL_REVIEW_SCHEMA_VERSION),
  findings: z.array(modelReviewFindingSchema).max(500),
  omitted: z.array(modelReviewOmissionSchema).max(500).default([]),
  limitations: z.array(text.max(1000)).max(100).default([]),
});
export type ModelReviewResponse = z.infer<typeof modelReviewResponseSchema>;

export const modelReviewCoverageStatusSchema = z.enum([
  "complete",
  "partial",
  "stopped",
  "unavailable",
]);
export type ModelReviewCoverageStatus = z.infer<
  typeof modelReviewCoverageStatusSchema
>;

export const modelReviewCoverageSchema = z.strictObject({
  status: modelReviewCoverageStatusSchema,
  batchCount: z.number().int().nonnegative(),
  completedBatchCount: z.number().int().nonnegative(),
  assessedFiles: z.number().int().nonnegative(),
  assessedLines: z.number().int().nonnegative(),
  omitted: z.array(modelReviewOmissionSchema).max(1000),
  limitations: z.array(text.max(1000)).max(200),
  /** Coverage is an accounting aid and must never be interpreted as safety proof. */
  isSafetyProof: z.literal(false),
});
export type ModelReviewCoverage = z.infer<typeof modelReviewCoverageSchema>;

export const modelReviewBudgetSchema = z.strictObject({
  maxBatches: z.number().int().positive().max(1000),
  maxFiles: z.number().int().positive().max(500),
  maxInputChars: z.number().int().positive().max(100_000_000),
  maxBatchChars: z.number().int().positive().max(10_000_000),
  /** Includes source, approved knowledge, and the output schema in one prompt. */
  maxPromptChars: z.number().int().positive().max(10_000_000),
  maxOutputTokens: z.number().int().positive().max(32_768),
  maxCostUsd: z.number().finite().nonnegative().optional(),
});
export type ModelReviewBudget = z.infer<typeof modelReviewBudgetSchema>;

export const modelReviewHashesSchema = z.strictObject({
  snapshot: sha256Schema,
  input: sha256Schema,
  knowledge: sha256Schema,
  provider: sha256Schema,
  model: sha256Schema,
  config: sha256Schema,
  plan: sha256Schema,
  prompt: sha256Schema,
  response: sha256Schema,
});
export type ModelReviewHashes = z.infer<typeof modelReviewHashesSchema>;

export const modelReviewCheckpointBatchSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  filePaths: z.array(text.max(1000)).min(1).max(500),
  fileHashes: z.array(sha256Schema).min(1).max(500),
  promptHash: sha256Schema,
  responseHash: sha256Schema,
  findings: z.array(modelReviewFindingSchema).max(500),
  omitted: z.array(modelReviewOmissionSchema).max(500),
  limitations: z.array(text.max(1000)).max(100),
  elapsedMs: z.number().finite().nonnegative(),
  model: text.max(200).optional(),
  configVersion: text.max(200).optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  actualCostUsd: z.number().finite().nonnegative().nullable(),
});
export type ModelReviewCheckpointBatch = z.infer<
  typeof modelReviewCheckpointBatchSchema
>;

export const modelReviewCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(MODEL_REVIEW_SCHEMA_VERSION),
  identity: z.strictObject({
    snapshot: sha256Schema,
    input: sha256Schema,
    knowledge: sha256Schema,
    provider: sha256Schema,
    model: sha256Schema,
    config: sha256Schema,
    plan: sha256Schema,
  }),
  batches: z.array(modelReviewCheckpointBatchSchema).max(1000),
  updatedAt: z.string().min(1).max(100),
});
export type ModelReviewCheckpoint = z.infer<typeof modelReviewCheckpointSchema>;

export const modelReviewReportSchema = z.strictObject({
  status: z.enum(["completed", "partial", "stopped"]),
  providerId: id,
  model: text.max(200),
  configVersion: text.max(200),
  hashes: modelReviewHashesSchema,
  startedAt: z.string().min(1).max(100),
  finishedAt: z.string().min(1).max(100),
  elapsedMs: z.number().finite().nonnegative(),
  budget: modelReviewBudgetSchema,
  used: z.strictObject({
    batches: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    inputChars: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    actualCostUsd: z.number().finite().nonnegative().nullable(),
  }),
  stopReason: z
    .enum(["none", "max_budgets", "aborted", "no_source"])
    .optional(),
  checkpoint: z.strictObject({
    reused: z.boolean(),
    savedBatchCount: z.number().int().nonnegative(),
  }),
});
export type ModelReviewReport = z.infer<typeof modelReviewReportSchema>;

export type ModelReviewResult = {
  findings: ModelReviewFinding[];
  coverage: ModelReviewCoverage;
  report: ModelReviewReport;
};

export type ModelReviewInvocation = {
  response: string;
  model?: string;
  configVersion?: string;
  promptTokens?: number;
  completionTokens?: number;
  actualCostUsd?: number | null;
};

export type ModelReviewBatch = {
  index: number;
  filePaths: string[];
  fileHashes: string[];
};

export type ModelReviewInvoke = (
  prompt: string,
  signal: AbortSignal,
  maxOutputTokens: number,
  batch: ModelReviewBatch,
) => Promise<ModelReviewInvocation>;

export type ModelReviewOptions = {
  invoke: ModelReviewInvoke;
  provider?: ModelReviewProvider;
  signal?: AbortSignal;
  checkpoint?: ModelReviewCheckpoint;
  onCheckpoint?: (checkpoint: ModelReviewCheckpoint) => void | Promise<void>;
  maxBudget?: Partial<ModelReviewBudget>;
  /** Number of files to put in one request before the character limit applies. */
  batchSize?: number;
  now?: () => Date;
};
