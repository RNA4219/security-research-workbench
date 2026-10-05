import { z } from "zod";
import { id, text, url } from "./model.js";
export const classification = z.enum([
    "public",
    "local",
    "blocked",
    "unclassified",
]);
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
export const workflowDocumentInput = z.strictObject({
    title: text.max(200),
    body: z.string().min(1).max(1_000_000),
    url: url.optional(),
    classification,
});
export const sourceRefSchema = z.strictObject({
    docId: id,
    revision: z.number().int().positive(),
    excerpt: text.max(2000),
});
const sourceRefs = z.array(sourceRefSchema).min(1).max(50);
const revisionRef = z.strictObject({
    id,
    revision: z.number().int().positive(),
});
export const knowledgeStatus = z.enum(["draft", "active", "rejected", "stale"]);
export const findingJudgment = z.enum([
    "unconfirmed",
    "needs_action",
    "false_positive",
    "duplicate",
    "accepted_known",
]);
const hashValue = z.string().regex(/^[a-f0-9]{64}$/);
export const findingSuppressionStatus = z.enum([
    "active",
    "expired",
    "invalidated",
    "missing",
    "unknown",
]);
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
//# sourceMappingURL=workflow.js.map