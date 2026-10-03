import { z } from "zod";

export const text = z.string().trim().min(1).max(10000);
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const url = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
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
    rationale: z.string().max(10000),
    acceptance: z.array(text).min(1).max(30),
    tasks: z.array(text).min(1).max(30),
  })
  .refine(
    (r) => r.sourceIds.length > 0 || r.rationale.trim().length > 0,
    "出典または利用者判断の理由が必要です",
  );
export const replySchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
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
export type Candidate = CandidateInput & { id: string };
export type Requirement = RequirementInput & {
  status: "draft" | "approved" | "needs_review";
  sourceVersions: Record<string, number>;
};
export type Project = ProjectInput & {
  schemaVersion: "1.0";
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sources: Source[];
  candidates: Candidate[];
  requirements: Requirement[];
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
    type: z.literal("review"),
    requirementId: id,
    status: z.enum(["draft", "approved"]),
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
