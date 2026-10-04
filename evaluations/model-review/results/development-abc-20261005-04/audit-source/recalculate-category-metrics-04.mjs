import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCorpus,
  matchFindings,
} from "../scripts/model-review-evaluation.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runRelative = "evaluations/model-review/results/development-abc-20261005-04";
const runDir = resolve(repoRoot, runRelative);
const goldRelative = "evaluations/model-review/gold/development.json";
const runnerRelative = "scripts/model-review-evaluation.mjs";
const outputRelative = `${runRelative}/category-recalculation-20261005-04.json`;
const outputPath = resolve(repoRoot, outputRelative);

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readHashed(relativePath) {
  const path = resolve(repoRoot, relativePath);
  const bytes = await readFile(path);
  return {
    path: relativePath.replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
    text: bytes.toString("utf8"),
  };
}

function emptyCounts() {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    duplicateCount: 0,
    predictedFindingCount: 0,
    goldFindingCount: 0,
    records: 0,
    successfulRecords: 0,
  };
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function f1(precision, recall) {
  if (precision === null || recall === null) return null;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function finalize(counts) {
  const precision = ratio(
    counts.truePositives,
    counts.truePositives + counts.falsePositives,
  );
  const recall = ratio(
    counts.truePositives,
    counts.truePositives + counts.falseNegatives,
  );
  return {
    ...counts,
    evaluationRate: ratio(counts.successfulRecords, counts.records),
    evaluatedRecordRate: ratio(counts.successfulRecords, counts.records),
    precision,
    recall,
    f1: f1(precision, recall),
  };
}

function addMatch(counts, predicted, gold) {
  const matched = matchFindings(predicted, gold);
  counts.truePositives += matched.truePositiveCount;
  counts.falsePositives += matched.falsePositiveCount;
  counts.falseNegatives += matched.falseNegativeCount;
  counts.duplicateCount += matched.duplicateCount;
  counts.predictedFindingCount += predicted.length;
  counts.goldFindingCount += gold.length;
}

function parseRecords(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`records.jsonlの${index + 1}行目が不正です: ${error}`);
      }
    });
}

function recalculate(records, goldByCase) {
  const global = emptyCounts();
  const byCondition = new Map();
  const byCategory = new Map();
  const recheckUnavailable = new Map();

  for (const record of records) {
    const goldCase = goldByCase.get(record.caseId);
    if (!goldCase) throw new Error(`goldがありません: ${record.caseId}`);
    const goldFindings = goldCase.findings ?? [];
    const predictedFindings = record.normalized?.findings ?? [];
    const scored = record.status === "completed" && record.normalized?.valid;
    global.records += 1;
    const condition = String(record.condition);
    if (!byCondition.has(condition)) byCondition.set(condition, emptyCounts());
    const conditionCounts = byCondition.get(condition);
    conditionCounts.records += 1;

    if (!scored) continue;
    global.successfulRecords += 1;
    conditionCounts.successfulRecords += 1;
    if (record.normalized.recheckPriorDecision === null) {
      recheckUnavailable.set(
        condition,
        (recheckUnavailable.get(condition) ?? 0) + 1,
      );
    }
    addMatch(global, predictedFindings, goldFindings);
    addMatch(conditionCounts, predictedFindings, goldFindings);

    const categories = new Set([
      ...goldFindings.map((finding) => finding.category),
      ...predictedFindings.map((finding) => finding.category),
    ]);
    for (const category of categories) {
      if (!byCategory.has(condition)) byCategory.set(condition, new Map());
      const categoryMap = byCategory.get(condition);
      if (!categoryMap.has(category)) categoryMap.set(category, emptyCounts());
      const categoryCounts = categoryMap.get(category);
      // 凍結runnerの欠陥を補正する独立再集計。matching結果は変更しない。
      categoryCounts.records += 1;
      categoryCounts.successfulRecords += 1;
      addMatch(
        categoryCounts,
        predictedFindings.filter((finding) => finding.category === category),
        goldFindings.filter((finding) => finding.category === category),
      );
    }
  }

  return {
    global: finalize(global),
    byCondition: Object.fromEntries(
      [...byCondition.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([condition, counts]) => [condition, finalize(counts)]),
    ),
    byCategory: Object.fromEntries(
      [...byCategory.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([condition, categoryMap]) => [
          condition,
          Object.fromEntries(
            [...categoryMap.entries()]
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([category, counts]) => [category, finalize(counts)]),
          ),
        ]),
    ),
    recheckUnavailableCount: Object.fromEntries(
      [...recheckUnavailable.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

function selectedMetrics(metrics) {
  return {
    truePositives: metrics.truePositives,
    falsePositives: metrics.falsePositives,
    falseNegatives: metrics.falseNegatives,
    records: metrics.records,
    successfulRecords: metrics.successfulRecords,
  };
}

function assertSame(label, left, right) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label}が元summaryと一致しません`);
  }
}

const recordsFile = await readHashed(`${runRelative}/records.jsonl`);
const goldFile = await readHashed(goldRelative);
const summaryFile = await readHashed(`${runRelative}/summary.json`);
const artifactFile = await readHashed(`${runRelative}/artifact.json`);
const manifestFile = await readHashed(`${runRelative}/manifest.json`);
const runnerFile = await readHashed(runnerRelative);
const records = parseRecords(recordsFile.text);
const summary = JSON.parse(summaryFile.text);
const corpus = await loadCorpus();
const goldByCase = corpus.goldBySplit.development;
const recalculated = recalculate(records, goldByCase);

const originalGlobal = selectedMetrics(summary.metrics);
const recalculatedGlobal = selectedMetrics(recalculated.global);
assertSame("global metrics", originalGlobal, recalculatedGlobal);
const originalByCondition = Object.fromEntries(
  Object.entries(summary.metrics.byCondition).map(([condition, metrics]) => [
    condition,
    selectedMetrics(metrics),
  ]),
);
const recalculatedByCondition = Object.fromEntries(
  Object.entries(recalculated.byCondition).map(([condition, metrics]) => [
    condition,
    selectedMetrics(metrics),
  ]),
);
assertSame("condition metrics", originalByCondition, recalculatedByCondition);

const originalCategory = {};
const correctedCategory = {};
for (const [condition, categories] of Object.entries(recalculated.byCategory)) {
  originalCategory[condition] = {};
  correctedCategory[condition] = {};
  for (const [category, metrics] of Object.entries(categories)) {
    const original = summary.metrics.byCondition[condition].byCategory[category];
    if (!original) throw new Error(`元summaryにカテゴリがありません: ${condition}/${category}`);
    const originalMatching = {
      truePositives: original.truePositives,
      falsePositives: original.falsePositives,
      falseNegatives: original.falseNegatives,
      duplicateCount: original.duplicateCount,
      predictedFindingCount: original.predictedFindingCount,
      goldFindingCount: original.goldFindingCount,
      records: original.records,
    };
    const correctedMatching = {
      truePositives: metrics.truePositives,
      falsePositives: metrics.falsePositives,
      falseNegatives: metrics.falseNegatives,
      duplicateCount: metrics.duplicateCount,
      predictedFindingCount: metrics.predictedFindingCount,
      goldFindingCount: metrics.goldFindingCount,
      records: metrics.records,
    };
    assertSame(`${condition}/${category} matching metrics`, originalMatching, correctedMatching);
    originalCategory[condition][category] = {
      ...originalMatching,
      successfulRecords: original.successfulRecords,
      evaluationRate: original.evaluationRate,
    };
    correctedCategory[condition][category] = {
      ...correctedMatching,
      successfulRecords: metrics.successfulRecords,
      evaluationRate: metrics.evaluationRate,
    };
  }
}

const evidence = {
  schemaVersion: "model-review-category-recalculation/v1",
  runId: summary.runId,
  manifestId: summary.manifestId,
  split: summary.split,
  conditions: summary.conditions,
  repetitions: summary.repetitions,
  sourceFiles: {
    records: {
      path: recordsFile.path,
      bytes: recordsFile.bytes,
      sha256: recordsFile.sha256,
    },
    gold: {
      path: goldFile.path,
      bytes: goldFile.bytes,
      sha256: goldFile.sha256,
    },
    summary: {
      path: summaryFile.path,
      bytes: summaryFile.bytes,
      sha256: summaryFile.sha256,
    },
    artifact: {
      path: artifactFile.path,
      bytes: artifactFile.bytes,
      sha256: artifactFile.sha256,
    },
    manifest: {
      path: manifestFile.path,
      bytes: manifestFile.bytes,
      sha256: manifestFile.sha256,
    },
    runner: {
      path: runnerFile.path,
      bytes: runnerFile.bytes,
      sha256: runnerFile.sha256,
    },
  },
  matching: {
    key: "normalized path + category + lineStart-lineEnd + normalized anchor",
    duplicateHandling: "duplicate predictions remain false positives",
    labels: ["truePositives", "falsePositives", "falseNegatives"],
    implementation: "scripts/model-review-evaluation.mjs#matchFindings",
  },
  method: {
    reason: "凍結runnerがカテゴリbucketのsuccessfulRecordsを加算していないため、同じ成功recordをカテゴリbucketにも加算してevaluationRateだけを再集計した。",
    changed: ["byCondition.*.byCategory.*.successfulRecords", "byCondition.*.byCategory.*.evaluationRate"],
    unchanged: ["matching", "labels", "truePositives", "falsePositives", "falseNegatives", "global metrics", "condition metrics"],
  },
  globalImpact: {
    unchanged: true,
    fields: ["truePositives", "falsePositives", "falseNegatives"],
    note: "カテゴリsuccessfulRecordsの補正はglobal A/B/CのTP/FP/FNおよび見逃し数を変更しない。",
    original: {
      global: originalGlobal,
      byCondition: originalByCondition,
    },
    independentlyRecalculated: {
      global: recalculatedGlobal,
      byCondition: recalculatedByCondition,
    },
  },
  categoryMetrics: {
    originalFrozenSummary: originalCategory,
    correctedIndependentRecalculation: correctedCategory,
  },
  missingness: {
    recheckUnavailableCount: {
      original: Object.fromEntries(
        Object.entries(summary.metrics.byCondition).map(([condition, metrics]) => [
          condition,
          metrics.recheckUnavailableCount,
        ]),
      ),
      independentlyObserved: recalculated.recheckUnavailableCount,
      interpretation: "CのrecheckUnavailableCount=27はモデルがrecheckPriorDecisionを返していない欠測であり、補完・推定しない。",
    },
  },
  validation: {
    originalFilesUnmodified: true,
    modelInvocations: 0,
    goldOrMatchingChanged: false,
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputRelative, globalImpact: evidence.globalImpact, categoryMetrics: evidence.categoryMetrics }));
