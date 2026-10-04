import { z } from "zod";

export const ENGINE_VERSION = "0.2.0";
export const diagnosticEngineNameSchema = z.enum([
  "static",
  "dependency",
  "model",
]);
export type DiagnosticEngineName = z.infer<typeof diagnosticEngineNameSchema>;

export const diagnosticFindingSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  ruleId: z.string().min(1).max(120),
  engine: diagnosticEngineNameSchema,
  title: z.string().min(1).max(500),
  severity: z.enum(["high", "medium", "low"]),
  path: z.string().min(1).max(1000),
  line: z.number().int().positive(),
  evidence: z.string().min(1).max(4000),
  remediation: z.string().min(1).max(4000),
  advisoryUrl: z.string().url().optional(),
  /**
   * Model-review provenance is optional so old static/dependency findings and
   * old database rows remain readable.  A matched prior judgment never
   * suppresses human confirmation by itself; the UI can show both the matched
   * IDs and the conservative recheck requirement.
   */
  modelReviewEvidence: z
    .strictObject({
      specRefIds: z.array(z.string().min(1).max(200)).max(100),
      pastJudgmentIds: z.array(z.string().min(1).max(200)).max(100),
      requiresHumanConfirmation: z.literal(true),
      recheckPriorDecision: z.boolean(),
    })
    .optional(),
});
export type DiagnosticFinding = z.infer<typeof diagnosticFindingSchema>;

export const diagnosticCoverageSchema = z.strictObject({
  engine: diagnosticEngineNameSchema,
  status: z.enum(["complete", "partial", "unavailable", "unsupported"]),
  assessed: z.number().int().nonnegative(),
  omitted: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1000),
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(500),
  limitations: z.array(z.string().min(1).max(1000)).max(100),
});
export type DiagnosticCoverage = z.infer<typeof diagnosticCoverageSchema>;

export const diagnosticSnapshotSchema = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1000),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        content: z.string().max(262_144),
      }),
    )
    .max(500),
  omitted: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(1000),
        reason: z.string().min(1).max(1000),
      }),
    )
    .max(500),
});
export type DiagnosticSnapshot = z.infer<typeof diagnosticSnapshotSchema>;

export const diagnosticAnalysisSchema = z.strictObject({
  findings: z.array(diagnosticFindingSchema).max(10_000),
  // Old persisted analyses contained the static/dependency pair.  Keep that
  // shape readable while allowing a model review engine to append its own
  // coverage entry.
  coverage: z.array(diagnosticCoverageSchema).min(2).max(3),
});
export type DiagnosticAnalysis = z.infer<typeof diagnosticAnalysisSchema>;

export type DiagnosticAnalysisOptions = {
  allowDependencyNetwork: boolean;
  /** 実行したいstageだけを選ぶ。省略時は全engineを実行する。 */
  engines?: DiagnosticEngineName[];
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};
