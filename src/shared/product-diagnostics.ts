import { z } from "zod";
import {
  diagnosticCoverageSchema,
  diagnosticFindingSchema,
} from "./diagnostic-engine.js";

export const diagnosticTrigger = z.enum(["manual", "ci", "schedule"]);
export type DiagnosticTrigger = z.infer<typeof diagnosticTrigger>;

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
  }),
  progress: diagnosticProgressSchema,
  incompleteCoverage: z.boolean(),
});
export type ProductRunSummary = z.infer<typeof productRunSummarySchema>;

export const productSchema = z.strictObject({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  repositoryId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  ref: z.string().min(1).max(200),
  specification: z.string().min(1).max(20_000),
  allowDependencyNetwork: z.boolean(),
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
});
export type DiagnosticRunFinding = z.infer<typeof diagnosticRunFindingSchema>;

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
  coverage: z.array(diagnosticCoverageSchema).length(2),
  findings: z.array(diagnosticRunFindingSchema).max(10_000),
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
} as const;
