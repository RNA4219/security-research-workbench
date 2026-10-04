import { z } from "zod";

export const text = z.string().trim().min(1).max(10000);
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const url = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) && !u.username && !u.password
    );
  }, "http/httpsの認証情報を含まないURLを指定してください");
export const date = z.iso.datetime();
export const projectInput = z.strictObject({
  title: text.max(200),
  objective: text,
  audience: text,
  constraints: z.string().max(10000),
  scope: z.string().max(10000).optional(),
  outOfScope: z.string().max(10000).optional(),
});
export const sourceInput = z.strictObject({
  title: text.max(200),
  url,
  retrievedAt: date,
  version: text.max(100),
  body: z.string().min(1).max(1_000_000),
});
export const candidateInput = z.strictObject({
  name: text.max(200),
  url,
  features: text,
  license: text.max(200),
  maintenance: text,
  decision: z.enum(["consider", "adopt", "reject"]),
  rationale: text,
  sourceIds: z.array(id).max(100),
});
export const requirementInput = z
  .strictObject({
    id,
    title: text.max(200),
    description: text,
    priority: z.enum(["low", "medium", "high", "critical"]),
    sourceIds: z.array(id).max(100),
    claimIds: z.array(id).max(100).optional(),
    rationale: z.string().max(10000),
    acceptance: z.array(text).min(1).max(30),
    tasks: z.array(text).min(1).max(30),
  })
  .refine(
    (r) =>
      r.sourceIds.length > 0 ||
      (r.claimIds?.length ?? 0) > 0 ||
      r.rationale.trim().length > 0,
    "出典または利用者判断の理由が必要です",
  );
export const replySchema = z.strictObject({
  schemaVersion: z.enum(["1.0", "2.0"]),
  requirements: z.array(requirementInput).min(1).max(100),
});
export const sourceBundleSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  sources: z.array(sourceInput).min(1).max(100),
});
export const replyJsonSchema = z.toJSONSchema(replySchema);

export type ProjectInput = z.infer<typeof projectInput>;
export type SourceInput = z.infer<typeof sourceInput>;
export type CandidateInput = z.infer<typeof candidateInput>;
export type RequirementInput = z.infer<typeof requirementInput>;
export type Source = SourceInput & {
  id: string;
  hash: string;
  revision: number;
  history: (SourceInput & { hash: string; revision: number })[];
};
export const reviewStatus = z.enum([
  "draft",
  "approved",
  "needs_review",
  "needs_evidence",
  "needs_revision",
  "rejected",
]);
export const verificationStatus = z.enum([
  "unverified",
  "verified",
  "disputed",
]);
export const claimFields = [
  "category",
  "purpose",
  "features",
  "license",
  "release",
  "commit",
  "archived",
  "issueActivity",
  "integration",
  "inputOutput",
  "deployment",
  "maintenance",
  "requirement_basis",
] as const;
export const fieldLabels: Record<(typeof claimFields)[number], string> = {
  category: "カテゴリ",
  purpose: "用途",
  features: "機能",
  license: "ライセンス",
  release: "リリース",
  commit: "コミット",
  archived: "アーカイブ状態",
  issueActivity: "Issue・PR活動",
  integration: "統合方式",
  inputOutput: "入力・出力",
  deployment: "運用形態",
  maintenance: "保守状況",
  requirement_basis: "要件の根拠",
};
export const evidenceInput = z.strictObject({
  sourceId: id,
  sourceType: z.enum(["official", "report", "other"]),
  excerpt: text,
  verificationStatus,
});
export const claimInput = z
  .strictObject({
    candidateId: id.optional(),
    field: z.enum(claimFields),
    valueState: z.enum(["known", "unknown", "empty"]),
    value: z.string().trim().max(10000),
    evidenceIds: z.array(id).max(100),
    verificationStatus,
  })
  .refine(
    (c) => (c.valueState === "known" ? c.value.length > 0 : c.value === ""),
    "既知の値を入力するか、未確認・値なしでは値を空にしてください",
  );
export type EvidenceInput = z.infer<typeof evidenceInput>;
export type ClaimInput = z.infer<typeof claimInput>;
export type Evidence = EvidenceInput & {
  id: string;
  revision: number;
  sourceRevision: number;
};
export type Claim = ClaimInput & { id: string; revision: number };
export type ReviewStatus = z.infer<typeof reviewStatus>;
export type ReviewEvent = {
  entity: "candidate" | "requirement";
  entityId: string;
  status: ReviewStatus;
  note: string;
  at: string;
  revision: number;
};
export type Candidate = CandidateInput & { id: string; status: ReviewStatus };
export type Requirement = RequirementInput & {
  claimIds: string[];
  status: ReviewStatus;
  sourceVersions: Record<string, number>;
};
export type Project = ProjectInput & {
  schemaVersion: "2.0";
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sources: Source[];
  candidates: Candidate[];
  requirements: Requirement[];
  evidence: Evidence[];
  claims: Claim[];
  reviews: ReviewEvent[];
};
export const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("project"), value: projectInput }),
  z.strictObject({
    type: z.literal("source"),
    sourceId: id.optional(),
    value: sourceInput,
  }),
  z.strictObject({ type: z.literal("sources"), value: sourceBundleSchema }),
  z.strictObject({
    type: z.literal("candidate"),
    candidateId: id.optional(),
    value: candidateInput,
  }),
  z.strictObject({
    type: z.literal("reply"),
    raw: z.string().min(1).max(1_000_000),
  }),
  z.strictObject({ type: z.literal("requirement"), value: requirementInput }),
  z.strictObject({
    type: z.literal("evidence"),
    evidenceId: id.optional(),
    value: evidenceInput,
  }),
  z.strictObject({
    type: z.literal("claim"),
    claimId: id.optional(),
    value: claimInput,
  }),
  z.strictObject({
    type: z.literal("candidate-review"),
    candidateId: id,
    status: reviewStatus,
    note: z.string().max(10000).optional(),
  }),
  z.strictObject({
    type: z.literal("review"),
    requirementId: id,
    status: reviewStatus,
    note: z.string().max(10000).optional(),
  }),
]);
export type Command = z.infer<typeof commandSchema>;
export const mutationSchema = z.strictObject({
  revision: z.number().int().positive(),
  command: commandSchema,
});
export type ApiError = {
  error: string;
  issues?: { path: string; message: string }[];
};

export const internalTaskContractSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  kind: z.literal("WorkbenchTaskContract"),
  projectId: id,
  projectRevision: z.number().int().positive(),
  objective: text,
  scope: z.string(),
  outOfScope: z.string(),
  requirements: z
    .array(
      z.strictObject({
        id,
        title: text,
        description: text,
        priority: z.enum(["low", "medium", "high", "critical"]),
        acceptanceCriteria: z.array(text).min(1),
        tasks: z.array(text).min(1),
        rationale: z.string(),
        claimIds: z.array(id),
        sourceRefs: z.array(id),
      }),
    )
    .min(1),
  acceptanceCriteria: z.array(text).min(1),
  candidates: z.array(z.strictObject({ id, name: text, url })),
  sourceRefs: z.array(
    z.strictObject({
      id,
      url,
      title: text,
      retrievedAt: date,
      version: text,
      revision: z.number().int().positive(),
      hash: z.string(),
    }),
  ),
  claims: z.array(
    claimInput.safeExtend({ id, revision: z.number().int().positive() }),
  ),
  evidence: z.array(
    evidenceInput.extend({
      id,
      revision: z.number().int().positive(),
      sourceRevision: z.number().int().positive(),
    }),
  ),
});
export const internalTaskContractJsonSchema = z.toJSONSchema(
  internalTaskContractSchema,
);
