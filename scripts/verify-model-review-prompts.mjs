import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildReviewInput,
  createReviewSnapshotEngine,
  loadCorpus,
  stableStringify,
} from "./model-review-evaluation.mjs";
import { reviewSnapshot } from "../dist/server/model-review.js";

// Functional comparison only: the invoker captures prompts and returns an
// explicit empty fixture response. It never contacts a model or a network.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { output: { type: "string" } } });
if (!values.output) throw new Error("新規出力先 --output が必要です");
const output = resolve(values.output);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const baselinePath =
  "evaluations/functional/model-review-input-compare-04/fixed-prompts.jsonl";
const baselineBytes = await readFile(resolve(root, baselinePath));
const baseline = baselineBytes
  .toString("utf8")
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse);
const byKey = new Map(
  baseline.map((item) => [`${item.condition}/${item.caseId}`, item]),
);
if (baseline.length !== 27 || byKey.size !== 27)
  throw new Error("固定入力は重複なしの27件を要求します");
for (const item of baseline) {
  if (item.promptSha256 !== `sha256:${hash(item.prompt)}`)
    throw new Error("固定promptのhashが一致しません");
}
await mkdir(output, { recursive: false }); // Existing evidence is never overwritten.
const corpus = await loadCorpus(resolve(root, "evaluations/model-review"));
const calls = [];
const engine = createReviewSnapshotEngine({
  reviewSnapshot,
  provider: {
    id: "functional-fake",
    kind: "injected",
    model: "functional-fake-invoker",
    configVersion: "functional-input-compare-04",
    maxOutputTokens: 2048,
  },
  invoke: async (prompt) => {
    calls.push(prompt);
    return {
      response: JSON.stringify({
        schemaVersion: "1",
        findings: [],
        omitted: [],
        limitations: [],
      }),
      model: "functional-fake-invoker",
      configVersion: "functional-input-compare-04",
      promptTokens: 0,
      completionTokens: 0,
      actualCostUsd: null,
    };
  },
  batchSize: 1,
});
const records = [];
for (const condition of ["A", "B", "C"]) {
  for (const testCase of [...corpus.cases.development].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const input = buildReviewInput(testCase, condition, corpus.product);
    const before = calls.length;
    const result = await engine.review(input, {
      condition,
      caseId: testCase.id,
      budget: { maxOutputTokens: 2048 },
    });
    if (calls.length !== before + 1 || result.report.checkpoint.reused)
      throw new Error("新規呼出し1回という条件が一致しません");
    const previous = byKey.get(`${condition}/${testCase.id}`);
    const prompt = calls.at(-1);
    records.push({
      condition,
      caseId: testCase.id,
      inputSame:
        previous?.inputSha256 === `sha256:${hash(stableStringify(input))}`,
      promptSame: previous?.prompt === prompt,
      promptSha256: hash(prompt),
      prompt,
    });
  }
}
const sourcePaths = [
  "scripts/verify-model-review-prompts.mjs",
  "scripts/model-review-evaluation.mjs",
  "scripts/model-review-production-adapter.mjs",
  "dist/server/model-review.js",
  "dist/shared/model-review.js",
  "package-lock.json",
];
const sources = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (path) => [
      path,
      hash(await readFile(resolve(root, path))),
    ]),
  ),
);
const mismatches = records.filter(
  (item) => !item.inputSame || !item.promptSame,
);
const summary = {
  schemaVersion: "functional-model-review-input-compare/v2",
  createdAt: new Date().toISOString(),
  status: records.length === 27 && !mismatches.length ? "pass" : "fail",
  baseline: { path: baselinePath, sha256: hash(baselineBytes) },
  records: records.length,
  mismatches: mismatches.map(({ condition, caseId }) => ({
    condition,
    caseId,
  })),
  sources,
  realModelUsed: false,
  externalModelCalls: 0,
  scope:
    "development 9 cases x A/B/Cの新規promptが凍結済み比較04と一致するかだけを検査する。人判断再利用・途中保存・精度の再評価ではない。",
};
await writeFile(
  resolve(output, "current-prompts.jsonl"),
  records.map((record) => JSON.stringify(record)).join("\n") + "\n",
);
await writeFile(
  resolve(output, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    output: relative(root, output),
    status: summary.status,
    records: records.length,
    mismatches: mismatches.length,
  }),
);
if (summary.status !== "pass") process.exitCode = 1;
