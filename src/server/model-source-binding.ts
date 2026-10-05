import { createHash } from "node:crypto";
import {
  diagnosticSnapshotSchema,
  type DiagnosticSnapshot,
} from "../shared/diagnostic-engine.js";
import {
  modelReviewFindingSchema,
  type ModelReviewFinding,
} from "../shared/model-review.js";
import {
  MODEL_SOURCE_BINDING_VERSION,
  modelSourceBindingSchema,
  type ModelSourceBinding,
} from "../shared/model-source-binding.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const sortStrings = (values: readonly string[]) =>
  [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

const normalizedPath = (value: string) => value.replaceAll("\\", "/");

/** A binding cannot be made from an unverified source citation. */
export class ModelSourceBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSourceBindingError";
  }
}

function snapshotManifestHash(snapshot: DiagnosticSnapshot) {
  return sha256(
    JSON.stringify({
      files: snapshot.files.map(({ path, hash }) => [path, hash]),
      omitted: snapshot.omitted,
    }),
  );
}

function sourceLine(content: string, line: number) {
  return content.split(/\r\n|\n/)[line - 1];
}

function assertSnapshotIntegrity(snapshot: DiagnosticSnapshot) {
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (paths.has(file.path))
      throw new ModelSourceBindingError(
        `snapshotのpathが重複しています: ${file.path}`,
      );
    paths.add(file.path);
    if (sha256(file.content) !== file.hash)
      throw new ModelSourceBindingError(
        `snapshot file hashがcontentと一致しません: ${file.path}`,
      );
  }
  if (snapshotManifestHash(snapshot) !== snapshot.manifestHash)
    throw new ModelSourceBindingError(
      "snapshot manifest hashが内容と一致しません",
    );
}

/**
 * Return the canonical field order and normalization used for a binding hash.
 * Spec references are a set-like ordered list for this purpose; wording fields
 * are intentionally absent.
 */
export function canonicalModelSourceBinding(
  rawBinding: ModelSourceBinding,
): ModelSourceBinding {
  const binding = modelSourceBindingSchema.parse(rawBinding);
  return {
    version: MODEL_SOURCE_BINDING_VERSION,
    targetVersion: binding.targetVersion,
    snapshotManifestHash: binding.snapshotManifestHash,
    path: normalizedPath(binding.path),
    line: binding.line,
    originalTextHash: binding.originalTextHash,
    category: binding.category,
    severity: binding.severity,
    specRefIds: sortStrings(binding.specRefIds),
    falsePositiveCandidate: binding.falsePositiveCandidate,
    uncertaintyLevel: binding.uncertaintyLevel,
  };
}

/** Hash only the explicit source/range binding, never model wording. */
export function hashModelSourceBinding(rawBinding: ModelSourceBinding) {
  return sha256(JSON.stringify(canonicalModelSourceBinding(rawBinding)));
}

/**
 * Validate a model finding against the pinned snapshot and create a binding
 * that a caller may attach to an explicit human-selected suppression range.
 * Missing or legacy binding data cannot be manufactured by this helper.
 */
export function createModelSourceBinding(
  rawFinding: unknown,
  rawSnapshot: unknown,
): ModelSourceBinding {
  const finding = modelReviewFindingSchema.parse(rawFinding);
  const snapshot = diagnosticSnapshotSchema.parse(rawSnapshot);
  assertSnapshotIntegrity(snapshot);

  const file = snapshot.files.find(
    (candidate) => candidate.path === finding.path,
  );
  if (!file)
    throw new ModelSourceBindingError(
      `model findingのpathがsnapshotにありません: ${finding.path}`,
    );
  const actualLine = sourceLine(file.content, finding.line);
  if (actualLine === undefined || actualLine !== finding.originalText)
    throw new ModelSourceBindingError(
      `model findingのpath/line/originalTextがsnapshotと一致しません: ${finding.path}:${finding.line}`,
    );

  return modelSourceBindingSchema.parse({
    version: MODEL_SOURCE_BINDING_VERSION,
    targetVersion: snapshot.commit,
    snapshotManifestHash: snapshot.manifestHash,
    path: file.path,
    line: finding.line,
    originalTextHash: sha256(actualLine),
    category: finding.category,
    severity: finding.severity,
    specRefIds: sortStrings(finding.specRefIds),
    falsePositiveCandidate: finding.falsePositiveCandidate,
    uncertaintyLevel: finding.uncertainty.level,
  });
}

/** Check that a later validated finding still belongs to the exact binding. */
export function matchesModelSourceBinding(
  rawBinding: ModelSourceBinding,
  rawFinding: unknown,
  rawSnapshot: unknown,
) {
  try {
    return (
      hashModelSourceBinding(rawBinding) ===
      hashModelSourceBinding(createModelSourceBinding(rawFinding, rawSnapshot))
    );
  } catch {
    return false;
  }
}
