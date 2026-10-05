import { z } from "zod";
import {
  modelReviewUncertaintyLevelSchema,
  sha256Schema,
} from "./model-review.js";
import { id, text } from "./model.js";

/** Versioned identity for a user-selected model-review source range. */
export const MODEL_SOURCE_BINDING_VERSION = 1 as const;

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const severitySchema = z.enum(["high", "medium", "low", "info"]);

/**
 * A binding describes only the source and review dimensions selected by a
 * person.  It intentionally contains no model wording, rationale, or
 * remediation text, so a wording change cannot broaden this explicit range.
 */
export const modelSourceBindingSchema = z.strictObject({
  version: z.literal(MODEL_SOURCE_BINDING_VERSION),
  targetVersion: commitSchema,
  snapshotManifestHash: sha256Schema,
  path: text.max(1000),
  line: z.number().int().positive(),
  originalTextHash: sha256Schema,
  category: text.max(200),
  severity: severitySchema,
  specRefIds: z.array(id).max(100),
  falsePositiveCandidate: z.boolean(),
  uncertaintyLevel: modelReviewUncertaintyLevelSchema,
});

export type ModelSourceBinding = z.infer<typeof modelSourceBindingSchema>;
