import { z } from "zod";
import { id, text, url } from "./model.js";

export const classification = z.enum([
  "public",
  "local",
  "blocked",
  "unclassified",
]);
export type Classification = z.infer<typeof classification>;
export const providerKind = z.enum(["cloud", "local", "manual"]);
export const workflowMethod = z.enum([
  "static-review",
  "known-issue-match",
  "normal-function-test",
  "regression-test",
  "manual-review",
]);
export const workflowScopeInput = z.strictObject({
  target: text.max(500),
  version: text.max(200),
  purpose: text.max(5000),
  ownership: text.max(5000),
  allowedProviderIds: z.array(id).max(20),
  allowedMethods: z.array(workflowMethod).max(20),
});
export type WorkflowScope = z.infer<typeof workflowScopeInput>;

export const workflowDocumentInput = z.strictObject({
  title: text.max(200),
  body: z.string().min(1).max(1_000_000),
  url: url.optional(),
  classification,
});
export type WorkflowDocumentInput = z.infer<typeof workflowDocumentInput>;
export type WorkflowDocument = WorkflowDocumentInput & {
  id: string;
  revision: number;
  hash: string;
  history: (WorkflowDocumentInput & { revision: number; hash: string })[];
};
export const sourceRefSchema = z.strictObject({
  docId: id,
  revision: z.number().int().positive(),
  excerpt: text.max(2000),
});
export type WorkflowSourceRef = z.infer<typeof sourceRefSchema>;
const sourceRefs = z.array(sourceRefSchema).min(1).max(50);
const revisionRef = z.strictObject({
  id,
  revision: z.number().int().positive(),
});

export const knowledgeStatus = z.enum(["draft", "active", "rejected", "stale"]);
export type KnowledgeStatus = z.infer<typeof knowledgeStatus>;
export type WorkflowKnowledge = {
  id: string;
  revision: number;
  purpose: string;
  content: string;
  sourceRefs: WorkflowSourceRef[];
  supersedes?: { id: string; revision: number };
  status: KnowledgeStatus;
  origin: "manual" | "query" | "decision" | "remediation" | "research";
  actor?: string;
  reason?: string;
};
export type WorkflowRule = {
  id: string;
  revision: number;
  purpose: string;
  content: string;
  applicability: string;
  appliesToVersion: string;
  sourceRefs: WorkflowSourceRef[];
  supersedes?: { id: string; revision: number };
  status: KnowledgeStatus;
  actor?: string;
  reason?: string;
};
export const findingJudgment = z.enum([
  "unconfirmed",
  "needs_action",
  "false_positive",
  "duplicate",
  "accepted_known",
]);
export type FindingJudgment = z.infer<typeof findingJudgment>;
const hashValue = z.string().regex(/^[a-f0-9]{64}$/);
export const findingSuppressionStatus = z.enum([
  "active",
  "expired",
  "invalidated",
  "missing",
  "unknown",
]);
export type FindingSuppressionStatus = z.infer<typeof findingSuppressionStatus>;
export type FindingSuppressionReason =
  | "active"
  | "no_active_suppression"
  | "expired"
  | "target_version_changed"
  | "fingerprint_changed"
  | "latest_decision_changed"
  | "judgment_changed"
  | "rules_changed"
  | "source_changed"
  | "context_changed"
  | "evidence_changed"
  | "legacy_context_unknown";
export type FindingObservation = {
  observation: string;
  observedAt: string;
  targetVersion: string;
  sourceRefs: WorkflowSourceRef[];
  /** Optional hashes added for diagnostic findings; old workflow rows omit them. */
  contextHash?: string;
  evidenceHash?: string;
};
export type WorkflowSuppression = {
  decisionRevision: number;
  sourceRefs: WorkflowSourceRef[];
  actor: string;
  reason: string;
  targetVersion: string;
  fingerprint: string;
  ruleRefs: { id: string; revision: number }[];
  expiresAt: string;
  active: boolean;
  /** These fields are absent in legacy workflow data and then cannot be reused by diagnostics. */
  contextHash?: string;
  evidenceHash?: string;
};
/**
 * Immutable approved context used to bind a diagnostic observation to the
 * product specification and the complete current workflow context.
 */
export type FindingReviewContext = {
  targetVersion: string;
  purpose: string;
  specificationRevision: number;
  specificationHash: string;
  /**
   * Stable analysis-method metadata used to bind a human suppression to the
   * exact diagnostic method that produced the observation.  This is optional
   * for legacy callers and persisted workflow data; new diagnostics provide
   * the hash while the workflow domain includes it in contextHash.
   */
  metadata?: {
    diagnosticMethodologyHash: string;
  };
  knowledge: {
    id: string;
    revision: number;
    contentHash: string;
    sourceRefs: WorkflowSourceRef[];
  }[];
  rules: {
    id: string;
    revision: number;
    contentHash: string;
    appliesToVersion: string;
    sourceRefs: WorkflowSourceRef[];
  }[];
  /**
   * Current human judgments that are eligible to be supplied as model
   * context.  The diagnostic service omits the finding currently being
   * linked, because its own decision revision is checked separately by the
   * suppression evaluator.
   */
  pastJudgments?: {
    findingId: string;
    revision: number;
    targetVersion: string;
    judgment: Exclude<FindingJudgment, "unconfirmed">;
    reason: string;
    sourceRefs: WorkflowSourceRef[];
  }[];
};
export type FindingSuppressionEvaluation = {
  reusable: boolean;
  status: FindingSuppressionStatus;
  reason: FindingSuppressionReason;
  decisionRevision: number | null;
  judgment: Exclude<FindingJudgment, "unconfirmed"> | null;
  expiresAt: string | null;
};
export type WorkflowFinding = {
  id: string;
  revision: number;
  fingerprint: string;
  targetVersion: string;
  observation: string;
  observedAt: string;
  sourceRefs: WorkflowSourceRef[];
  observationHistory: FindingObservation[];
  judgment: FindingJudgment;
  decisions: {
    revision: number;
    judgment: Exclude<FindingJudgment, "unconfirmed">;
    actor: string;
    reason: string;
    targetVersion: string;
    sourceRefs: WorkflowSourceRef[];
    ruleRefs: { id: string; revision: number }[];
    at: string;
  }[];
  suppressions: WorkflowSuppression[];
  remediation?: WorkflowRemediation;
};
export type WorkflowRemediation = {
  status: "awaiting" | "in_progress" | "verification_pending" | "completed";
  assignee: string;
  taskRef: string;
  plan: string;
  fixCommit?: string;
  targetVersion: string;
  verifications: WorkflowVerification[];
  /** A changed observation invalidates verifications recorded at or before this time. */
  reverificationRequiredAfter?: string;
  completion?: {
    actor: string;
    reason: string;
    at: string;
    targetVersion: string;
  };
};
export type WorkflowVerification = {
  method: z.infer<typeof workflowMethod>;
  rationale: string;
  scope: string;
  status: "not_run" | "passed" | "failed" | "unable";
  actor: string;
  at: string;
  targetVersion: string;
  fixCommit: string;
  evidence: WorkflowSourceRef[];
};
export type WorkflowQuery = {
  id: string;
  question: string;
  target: string;
  targetVersion: string;
  purpose: string;
  providerKind: z.infer<typeof providerKind>;
  knowledge: { id: string; revision: number }[];
  rules: { id: string; revision: number }[];
  answer?: string;
  uncertainty: "none" | "insufficient" | "conflict";
  at: string;
};
export type WorkflowEvent = {
  type: string;
  entityId?: string;
  actor?: string;
  reason?: string;
  at: string;
  detail?: string;
};
export type WorkflowImport = {
  reportId: string;
  repositoryUrl: string;
  repositoryName: string;
  commit: string | null;
  collectedAt: string;
  sourceRefs: string[];
  hash: string;
};
export type WorkflowState = {
  projectId: string;
  revision: number;
  scope: WorkflowScope;
  documents: WorkflowDocument[];
  knowledge: WorkflowKnowledge[];
  rules: WorkflowRule[];
  findings: WorkflowFinding[];
  queries: WorkflowQuery[];
  events: WorkflowEvent[];
  imports: WorkflowImport[];
};

const person = text.max(200);
const knowledgeBody = text.max(20_000);
const ruleRefsSchema = z
  .array(z.strictObject({ id, revision: z.number().int().positive() }))
  .max(50);
export const workflowCommand = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("scope"), value: workflowScopeInput }),
  z.strictObject({
    type: z.literal("document"),
    documentId: id.optional(),
    value: workflowDocumentInput,
  }),
  z.strictObject({
    type: z.literal("knowledge-draft"),
    knowledgeId: id.optional(),
    supersedes: revisionRef.optional(),
    purpose: text.max(5000),
    content: knowledgeBody,
    sourceRefs,
    origin: z
      .enum(["manual", "query", "decision", "remediation", "research"])
      .default("manual"),
  }),
  z.strictObject({
    type: z.literal("knowledge-review"),
    knowledgeId: id,
    decision: z.enum(["active", "rejected"]),
    actor: person,
    reason: text.max(5000),
  }),
  z.strictObject({
    type: z.literal("rule-draft"),
    ruleId: id.optional(),
    supersedes: revisionRef.optional(),
    purpose: text.max(5000),
    content: knowledgeBody,
    applicability: text.max(5000),
    appliesToVersion: text.max(200).optional(),
    sourceRefs,
  }),
  z.strictObject({
    type: z.literal("rule-review"),
    ruleId: id,
    decision: z.enum(["active", "rejected"]),
    actor: person,
    reason: text.max(5000),
  }),
  z.strictObject({
    type: z.literal("query"),
    queryId: id.optional(),
    question: text.max(10000),
    providerKind,
    knowledge: z
      .array(z.strictObject({ id, revision: z.number().int().positive() }))
      .max(100),
    rules: ruleRefsSchema.default([]),
    answer: z.string().max(20000).optional(),
    uncertainty: z.enum(["none", "insufficient", "conflict"]).default("none"),
  }),
  z.strictObject({
    type: z.literal("finding-observation"),
    findingId: id.optional(),
    fingerprint: id,
    targetVersion: text.max(200),
    observation: knowledgeBody,
    sourceRefs: z.array(sourceRefSchema).max(50).default([]),
    contextHash: hashValue.optional(),
    evidenceHash: hashValue.optional(),
  }),
  z.strictObject({
    type: z.literal("finding-decision"),
    findingId: id,
    judgment: findingJudgment.exclude(["unconfirmed"]),
    actor: person,
    reason: text.max(5000),
    targetVersion: text.max(200),
    sourceRefs,
    ruleRefs: ruleRefsSchema.default([]),
  }),
  z.strictObject({
    type: z.literal("suppression"),
    findingId: id,
    actor: person,
    reason: text.max(5000),
    targetVersion: text.max(200),
    fingerprint: id,
    ruleRefs: ruleRefsSchema,
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({
    type: z.literal("remediation-start"),
    findingId: id,
    assignee: person,
    taskRef: text.max(1000),
    plan: text.min(1).max(5000),
    targetVersion: text.max(200),
  }),
  z.strictObject({
    type: z.literal("remediation-progress"),
    findingId: id,
    status: z.enum(["in_progress", "verification_pending"]),
    actor: person,
    reason: text.max(5000),
    fixCommit: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i)
      .optional(),
    targetVersion: text.max(200),
  }),
  z.strictObject({
    type: z.literal("verification"),
    findingId: id,
    method: workflowMethod,
    rationale: text.max(5000),
    scope: text.max(5000),
    status: z.enum(["not_run", "passed", "failed", "unable"]),
    actor: person,
    targetVersion: text.max(200),
    evidence: z.array(sourceRefSchema).max(50).default([]),
  }),
  z.strictObject({
    type: z.literal("remediation-complete"),
    findingId: id,
    actor: person,
    reason: text.max(5000),
    targetVersion: text.max(200),
  }),
]);
export type WorkflowCommand = z.infer<typeof workflowCommand>;

export type WorkflowContext = {
  question: string;
  target: string;
  targetVersion: string;
  purpose: string;
  knowledge: {
    id: string;
    revision: number;
    content: string;
    sourceRefs: WorkflowSourceRef[];
    classifications: Classification[];
  }[];
  rules: {
    id: string;
    revision: number;
    content: string;
    appliesToVersion: string;
    classifications: Classification[];
  }[];
  fingerprint: string;
  uncertainty: "none" | "insufficient" | "conflict";
};
