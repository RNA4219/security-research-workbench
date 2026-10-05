import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DiagnosticSnapshot } from "../src/shared/diagnostic-engine.js";
import type { ModelReviewFinding } from "../src/shared/model-review.js";
import { modelSourceBindingSchema } from "../src/shared/model-source-binding.js";
import {
  createModelSourceBinding,
  hashModelSourceBinding,
  matchesModelSourceBinding,
} from "../src/server/model-source-binding.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function makeSnapshot(
  content = "const before = 0;\r\n  const value = 1;  \r\n  const value = 1;  \r\n",
  filePath = "src/a.ts",
  commit = "a".repeat(40),
): DiagnosticSnapshot {
  const files = [{ path: filePath, hash: sha256(content), content }];
  const omitted: DiagnosticSnapshot["omitted"] = [];
  const manifestHash = sha256(
    JSON.stringify({
      files: files.map(({ path, hash }) => [path, hash]),
      omitted,
    }),
  );
  return { commit, manifestHash, files, omitted };
}

function finding(
  overrides: Partial<ModelReviewFinding> = {},
): ModelReviewFinding {
  return {
    id: "finding-1",
    category: "cryptography",
    severity: "high",
    title: "証明書検証の確認",
    rationale: "固定snapshotの設定を仕様と照合する。",
    path: "src/a.ts",
    line: 2,
    originalText: "  const value = 1;  ",
    specRefIds: ["spec-b", "spec-a"],
    relatedFixedFindingIds: [],
    pastJudgmentIds: [],
    remediation: {
      guidance: "人が適用条件を確認する。",
      humanReviewRequired: true,
    },
    falsePositiveCandidate: false,
    uncertainty: { level: "medium", reasons: ["呼び出し元の確認が必要"] },
    ...overrides,
  };
}

describe("model source binding", () => {
  it("validates the exact pinned line and normalizes specification references", () => {
    const snapshot = makeSnapshot();
    const binding = createModelSourceBinding(finding(), snapshot);

    expect(binding).toMatchObject({
      version: 1,
      targetVersion: snapshot.commit,
      snapshotManifestHash: snapshot.manifestHash,
      path: "src/a.ts",
      line: 2,
      originalTextHash: sha256("  const value = 1;  "),
      category: "cryptography",
      severity: "high",
      specRefIds: ["spec-a", "spec-b"],
      falsePositiveCandidate: false,
      uncertaintyLevel: "medium",
    });
    expect(hashModelSourceBinding(binding)).toMatch(/^[a-f0-9]{64}$/);
    expect(matchesModelSourceBinding(binding, finding(), snapshot)).toBe(true);
  });

  it("keeps the binding hash stable for wording-only model changes", () => {
    const snapshot = makeSnapshot();
    const first = createModelSourceBinding(finding(), snapshot);
    const reworded = createModelSourceBinding(
      finding({
        title: "TLS設定の再確認が必要です",
        rationale: "同じ固定コードについて別の説明文を使う。",
        remediation: {
          guidance: "修正案の表現だけを変更し、人が確認する。",
          humanReviewRequired: true,
        },
      }),
      snapshot,
    );

    expect(hashModelSourceBinding(reworded)).toBe(
      hashModelSourceBinding(first),
    );
    expect(
      hashModelSourceBinding({
        ...first,
        specRefIds: [...first.specRefIds].reverse(),
      }),
    ).toBe(hashModelSourceBinding(first));
  });

  it.each([
    [
      "path",
      () => [
        finding({ path: "src/b.ts" }),
        makeSnapshot(undefined, "src/b.ts"),
      ],
    ],
    ["line", () => [finding({ line: 3 }), makeSnapshot()]],
    [
      "source text",
      () => [
        finding({ originalText: "  const changed = 2;  " }),
        makeSnapshot("const before = 0;\r\n  const changed = 2;  \r\n"),
      ],
    ],
    [
      "target version",
      () => [finding(), makeSnapshot(undefined, "src/a.ts", "b".repeat(40))],
    ],
    [
      "category",
      () => [finding({ category: "authorization" }), makeSnapshot()],
    ],
    ["severity", () => [finding({ severity: "medium" }), makeSnapshot()]],
    [
      "specification references",
      () => [finding({ specRefIds: ["spec-c"] }), makeSnapshot()],
    ],
    [
      "false-positive classification",
      () => [finding({ falsePositiveCandidate: true }), makeSnapshot()],
    ],
    [
      "uncertainty level",
      () => [
        finding({ uncertainty: { level: "high", reasons: [] } }),
        makeSnapshot(),
      ],
    ],
  ] as const)("changes the hash when %s changes", (_field, makeValues) => {
    const original = createModelSourceBinding(finding(), makeSnapshot());
    const [changedFinding, changedSnapshot] = makeValues();
    const changed = createModelSourceBinding(changedFinding, changedSnapshot);
    expect(hashModelSourceBinding(changed)).not.toBe(
      hashModelSourceBinding(original),
    );
  });

  it("rejects a citation that is missing, moved, or not exact", () => {
    const snapshot = makeSnapshot();
    expect(() =>
      createModelSourceBinding(finding({ path: "src/missing.ts" }), snapshot),
    ).toThrow("pathがsnapshotにありません");
    expect(() =>
      createModelSourceBinding(
        finding({ originalText: "const value = 99;" }),
        snapshot,
      ),
    ).toThrow("originalTextがsnapshotと一致しません");
    expect(() =>
      createModelSourceBinding(finding({ line: 0 }), snapshot),
    ).toThrow();
  });

  it("requires an intact snapshot and the versioned binding fields", () => {
    const snapshot = makeSnapshot();
    expect(() =>
      createModelSourceBinding(finding(), {
        ...snapshot,
        files: [{ ...snapshot.files[0]!, hash: "0".repeat(64) }],
      }),
    ).toThrow("file hashがcontentと一致しません");

    const binding = createModelSourceBinding(finding(), snapshot);
    expect(() =>
      modelSourceBindingSchema.parse({
        ...binding,
        version: 0,
      }),
    ).toThrow();
    expect(
      matchesModelSourceBinding(
        binding,
        finding({ category: "authorization" }),
        snapshot,
      ),
    ).toBe(false);
  });

  it("rejects duplicate snapshot paths before creating a binding", () => {
    const snapshot = makeSnapshot();
    const duplicatePathSnapshot = {
      ...snapshot,
      files: [...snapshot.files, { ...snapshot.files[0]! }],
    };

    expect(() =>
      createModelSourceBinding(finding(), duplicatePathSnapshot),
    ).toThrow("snapshotのpathが重複しています");
  });

  it("rejects a snapshot whose manifest hash does not match its files", () => {
    const snapshot = makeSnapshot();
    const tamperedManifestSnapshot = {
      ...snapshot,
      manifestHash: "0".repeat(64),
    };

    expect(() =>
      createModelSourceBinding(finding(), tamperedManifestSnapshot),
    ).toThrow("snapshot manifest hashが内容と一致しません");
  });
});
