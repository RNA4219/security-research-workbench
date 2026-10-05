import { z } from "zod";
import {
  diagnosticCoverageSchema,
  diagnosticFindingSchema,
} from "./diagnostic-engine.js";
import {
  modelReviewBudgetSchema,
  modelReviewCoverageSchema as providerModelReviewCoverageSchema,
  modelReviewReportSchema,
} from "./model-review.js";
import {
  findingJudgment,
  findingSuppressionStatus,
  suppressionMatchPolicy,
} from "./workflow.js";

export const diagnosticTrigger = z.enum(["manual", "ci", "schedule"]);
export type DiagnosticTrigger = z.infer<typeof diagnosticTrigger>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const modelReviewProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const modelReviewProviderKindSchema = z.enum(["local", "cloud"]);
export type ModelReviewProviderKind = z.infer<
  typeof modelReviewProviderKindSchema
>;

/** 製品設定で選ぶモデル診断provider。省略時は無効・local選択にする。 */
export const productModelReviewSchema = z.strictObject({
  enabled: z.boolean().default(false),
  providerId: modelReviewProviderIdSchema.default("local"),
  /** 外部送信を行うための明示同意。localでは常にfalseのままにする。 */
  cloudConsent: z.boolean().default(false),
});
export type ProductModelReview = z.infer<typeof productModelReviewSchema>;

export const modelReviewStatusSchema = z.enum([
  "disabled",
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "stopped",
  "interrupted",
  "unavailable",
]);
export type ModelReviewStatus = z.infer<typeof modelReviewStatusSchema>;

export const modelReviewCoverageSchema = providerModelReviewCoverageSchema;
export type ModelReviewCoverage = z.infer<typeof modelReviewCoverageSchema>;

/** モデルの生応答を保存せず、検証済み結果の監査可能な要約だけを残す。 */
export const modelReviewRecordSchema = z.strictObject({
  status: modelReviewStatusSchema,
  outputHash: sha256Schema.nullable(),
  findingFingerprints: z.array(sha256Schema).max(10_000),
  evidenceChecked: z.number().int().nonnegative(),
  evidenceRejected: z.number().int().nonnegative(),
  limitations: z.array(z.string().min(1).max(1000)).max(100),
  failure: z.string().max(1000).nullable(),
});
export type ModelReviewRecord = z.infer<typeof modelReviewRecordSchema>;

/** run開始時に固定するprovider/contextと、保存済みcheckpointの要約。 */
export const diagnosticModelReviewSchema = z.strictObject({
  enabled: z.boolean(),
  providerId: modelReviewProviderIdSchema.nullable(),
  providerKind: modelReviewProviderKindSchema.nullable(),
  model: z.string().min(1).max(200).nullable(),
  configVersion: z.string().min(1).max(200).nullable(),
  inputHash: sha256Schema.nullable(),
  contextHash: sha256Schema.nullable(),
  /** Effective budget is persisted so an interrupted checkpoint can reject a changed resume. */
  budget: modelReviewBudgetSchema.optional(),
  coverage: modelReviewCoverageSchema,
  record: modelReviewReportSchema.nullable(),
  failure: z.string().max(1000).nullable().optional(),
});
export type DiagnosticModelReview = z.infer<typeof diagnosticModelReviewSchema>;


export const diagnosticRunStatus = z.enum([
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "stopped",
  "interrupted",
]);
export type DiagnosticRunStatus = z.infer<typeof diagnosticRunStatus>;

export const diagnosticDeltaStatus = z.enum([
  "new",
  "continuing",
  "needs_review",
  "not_observed",
]);
export type DiagnosticDeltaStatus = z.infer<typeof diagnosticDeltaStatus>;
export const diagnosticReviewDisposition = z.enum([
  "confirmation_required",
  "suppressed_human",
]);
export type DiagnosticReviewDisposition = z.infer<
  typeof diagnosticReviewDisposition
>;
export const diagnosticSuppressionSchema = z.strictObject({
  status: findingSuppressionStatus,
  reason: z.string().min(1).max(100),
  decisionRevision: z.number().int().positive().nullable(),
  judgment: findingJudgment.nullable(),
  expiresAt: z.string().datetime().nullable(),
  reused: z.boolean(),
  /** Legacy API rows omit this and therefore remain strict by default. */
  matchPolicy: suppressionMatchPolicy.optional(),
});
export type DiagnosticSuppression = z.infer<
  typeof diagnosticSuppressionSchema
>;

export const productScheduleSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    intervalMinutes: z
      .number()
      .int()
      .min(5)
      .max(43_200)
      .nullable()
      .default(null),
  })
  .refine(
    (value) =>
      value.enabled
        ? value.intervalMinutes !== null
        : value.intervalMinutes === null,
    {
      message: "schedule.enabledとintervalMinutesの組み合わせが不正です",
    },
  );
export type ProductSchedule = z.infer<typeof productScheduleSchema>;

export const productInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  repositoryId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  ref: z.string().trim().min(1).max(200),
  specification: z.string().trim().min(1).max(20_000),
  allowDependencyNetwork: z.boolean().default(false),
  // Existing database rows may predate model review.  The store normalizes
  // newly created rows, while this optional field keeps old callers typed.
  modelReview: productModelReviewSchema.optional(),
  schedule: productScheduleSchema.default({
    enabled: false,
    intervalMinutes: null,
  }),
});
export type ProductInput = z.input<typeof productInputSchema>;

export const productSettingsSchema = z
  .strictObject({
    revision: z.number().int().positive(),
    ref: z.string().trim().min(1).max(200).optional(),
    specification: z.string().trim().min(1).max(20_000).optional(),
    allowDependencyNetwork: z.boolean().optional(),
    modelReview: productModelReviewSchema.optional(),
    schedule: productScheduleSchema.optional(),
  })
  .refine((value) => Object.keys(value).some((key) => key !== "revision"), {
    message: "変更する設定を指定してください",
  });
export type ProductSettingsInput = z.infer<typeof productSettingsSchema>;

export const runInputSchema = z.discriminatedUnion("trigger", [
  z.strictObject({
    trigger: z.literal("manual"),
    ref: z.string().trim().min(1).max(200).optional(),
    requestId: z.string().trim().min(1).max(200).optional(),
  }),
  z.strictObject({
    trigger: z.literal("ci"),
    ref: z.string().trim().min(1).max(200).optional(),
    requestId: z.string().trim().min(1).max(200),
  }),
  z.strictObject({
    trigger: z.literal("schedule"),
    ref: z.string().trim().min(1).max(200).optional(),
    requestId: z.string().trim().min(1).max(200),
  }),
]);
export type RunInput = z.infer<typeof runInputSchema>;

export const diagnosticRepositorySchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().min(1).max(200),
  defaultRef: z.string().min(1).max(250).nullable(),
});
export type DiagnosticRepository = z.infer<typeof diagnosticRepositorySchema>;

export const diagnosticProgressSchema = z.strictObject({
  phase: z.enum([
    "queued",
    "snapshot",
    "static",
    "dependency",
    "model_review",
    "linking",
    "saving",
    "finished",
  ]),
  message: z.string().max(500),
  updatedAt: z.string().datetime(),
});
export type DiagnosticProgress = z.infer<typeof diagnosticProgressSchema>;
export const diagnosticStatusHistorySchema = z
  .array(
    z.strictObject({
      status: diagnosticRunStatus,
      at: z.string().datetime(),
      reason: z.string().max(500).nullable(),
    }),
  )
  .max(100);

export const productRunSummarySchema = z.strictObject({
  id: z.string().uuid(),
  status: diagnosticRunStatus,
  trigger: diagnosticTrigger,
  commit: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  findingCounts: z.strictObject({
    new: z.number().int().nonnegative(),
    continuing: z.number().int().nonnegative(),
    needsReview: z.number().int().nonnegative(),
    notObserved: z.number().int().nonnegative(),
    /** Added when at least one finding reused an explicit human suppression. */
    suppressed: z.number().int().nonnegative().optional(),
  }),
  progress: diagnosticProgressSchema,
  incompleteCoverage: z.boolean(),
  modelReview: z
    .strictObject({
      enabled: z.boolean(),
      providerId: modelReviewProviderIdSchema.nullable(),
      status: modelReviewStatusSchema,
      coverage: modelReviewCoverageSchema,
    })
    .optional(),
});
export type ProductRunSummary = z.infer<typeof productRunSummarySchema>;

export const productSchema = z.strictObject({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  repositoryId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  ref: z.string().min(1).max(200),
  specification: z.string().min(1).max(20_000),
  allowDependencyNetwork: z.boolean(),
  modelReview: productModelReviewSchema.optional(),
  schedule: productScheduleSchema,
  revision: z.number().int().positive(),
  diagnosticRevision: z.number().int().positive(),
  linkedProjectId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  latestRun: productRunSummarySchema.nullable(),
});
export type Product = z.infer<typeof productSchema>;

export const diagnosticRunFindingSchema = diagnosticFindingSchema.extend({
  delta: diagnosticDeltaStatus,
  presentInAnalysis: z.boolean(),
  comparedToRunId: z.string().uuid().nullable(),
  workflowFindingId: z.string().nullable(),
  workflowUrl: z.string().nullable(),
  workflowQuestion: z.string().min(1).max(10_000),
  workflowQuestionClassification: z.literal("local"),
  reviewDisposition: diagnosticReviewDisposition.optional(),
  suppression: diagnosticSuppressionSchema.optional(),
});
export type DiagnosticRunFinding = z.infer<typeof diagnosticRunFindingSchema>;

/**
 * A finding is hidden from the confirmation count only when the API record
 * proves that the current analysis reused an active human suppression.  The
 * complete predicate keeps legacy or inconsistent rows visible for review.
 */
export function isDiagnosticFindingSuppressed(
  finding: DiagnosticRunFinding,
) {
  return (
    finding.presentInAnalysis === true &&
    finding.reviewDisposition === "suppressed_human" &&
    finding.suppression?.status === "active" &&
    finding.suppression.reused === true
  );
}

/**
 * Summarize raw finding deltas while keeping human-suppressed candidates in
 * their own optional bucket.  Omitting a zero bucket preserves old API rows.
 */
export function diagnosticFindingCounts(findings: readonly DiagnosticRunFinding[]) {
  const counts = {
    new: 0,
    continuing: 0,
    needsReview: 0,
    notObserved: 0,
    suppressed: 0,
  };
  for (const finding of findings) {
    if (isDiagnosticFindingSuppressed(finding)) {
      counts.suppressed++;
      continue;
    }
    if (finding.delta === "new") counts.new++;
    else if (finding.delta === "continuing") counts.continuing++;
    else if (finding.delta === "needs_review") counts.needsReview++;
    else counts.notObserved++;
  }
  if (!counts.suppressed) {
    const { suppressed: _suppressed, ...legacy } = counts;
    return legacy;
  }
  return counts;
}

export const diagnosticRunSchema = z.strictObject({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  revision: z.number().int().positive(),
  status: diagnosticRunStatus,
  trigger: diagnosticTrigger,
  requestId: z.string().nullable(),
  ref: z.string().min(1).max(200),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
  previousRunId: z.string().uuid().nullable(),
  manifestHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  snapshotFiles: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1000),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(500),
  snapshotOmitted: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1000),
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(500),
  engineVersion: z.string().min(1).max(100),
  allowDependencyNetwork: z.boolean(),
  specificationRevision: z.number().int().positive(),
  workflowRevision: z.number().int().positive(),
  knowledge: z
    .array(
      z.strictObject({
        id: z.string(),
        revision: z.number().int().positive(),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(500),
  rules: z
    .array(
      z.strictObject({
        id: z.string(),
        revision: z.number().int().positive(),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(500),
  progress: diagnosticProgressSchema,
  statusHistory: diagnosticStatusHistorySchema,
  // Old runs contain only static/dependency coverage.  New runs may append
  // the model engine entry; both forms remain readable after restart.
  coverage: z.array(diagnosticCoverageSchema).min(2).max(3),
  findings: z.array(diagnosticRunFindingSchema).max(10_000),
  modelReview: diagnosticModelReviewSchema.optional(),
  startedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  failure: z.string().max(1000).nullable(),
});
export type DiagnosticRun = z.infer<typeof diagnosticRunSchema>;

export const createProductResponseSchema = productSchema;
export const listProductsResponseSchema = z.array(productSchema).max(10_000);
export const repositoriesResponseSchema = z
  .array(diagnosticRepositorySchema)
  .max(100);
export const productDetailResponseSchema = z.strictObject({
  product: productSchema,
  runs: z.array(productRunSummarySchema).max(500),
});

export const diagnosticApiPaths = {
  repositories: "/api/diagnostics/repositories",
  products: "/api/products",
  product: (id: string) => `/api/products/${encodeURIComponent(id)}`,
  runs: (id: string) => `/api/products/${encodeURIComponent(id)}/runs`,
  run: (id: string, runId: string) =>
    `/api/products/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
  stop: (id: string, runId: string) =>
    `/api/products/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/stop`,
  resume: (id: string, runId: string) =>
    `/api/products/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/resume`,
  settings: (id: string) => `/api/products/${encodeURIComponent(id)}/settings`,
  // diagnosticRequest already prefixes API paths with `/api`.
  modelReviewProviders: "/model-review/providers",
} as const;
