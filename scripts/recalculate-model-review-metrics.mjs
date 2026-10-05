import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  calculateMetrics,
  RUNNER_ID,
  stableStringify,
} from "./model-review-evaluation.mjs";

const thisFile = fileURLToPath(import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePath(path) {
  return relative(process.cwd(), path).replaceAll("\\", "/") || ".";
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label}のJSONを読み込めません: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function parseRecordsJsonl(text, label = "records") {
  const records = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    records.push(parseJson(line, `${label}:${index + 1}`));
  }
  assert(records.length > 0, `${label}にrecordsがありません`);
  return records;
}

function pickConfusion(metrics) {
  return {
    truePositives: metrics?.truePositives ?? null,
    falsePositives: metrics?.falsePositives ?? null,
    falseNegatives: metrics?.falseNegatives ?? null,
  };
}

function categoryConfusion(metrics) {
  return Object.fromEntries(
    Object.entries(metrics?.byCategory ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, value]) => [category, pickConfusion(value)]),
  );
}

export function confusionView(metrics) {
  return {
    overall: pickConfusion(metrics),
    byCategory: categoryConfusion(metrics),
    byCondition: Object.fromEntries(
      Object.entries(metrics?.byCondition ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([condition, value]) => [
          condition,
          {
            overall: pickConfusion(value),
            byCategory: categoryConfusion(value),
          },
        ]),
    ),
  };
}

function validateInputs(records, gold, originalSummary) {
  assert(Array.isArray(records), "recordsは配列である必要があります");
  assert(isRecord(gold), "goldはobjectである必要があります");
  assert(Array.isArray(gold.cases), "gold.casesが必要です");
  assert(isRecord(originalSummary), "元summaryはobjectである必要があります");
  assert(isRecord(originalSummary.metrics), "元summary.metricsが必要です");
  assert(
    typeof gold.split === "string" && gold.split.length > 0,
    "gold.splitが必要です",
  );
  if (originalSummary.split !== undefined) {
    assert(
      originalSummary.split === gold.split,
      "元summaryとgoldのsplitが一致しません",
    );
  }
  for (const record of records) {
    assert(isRecord(record), "recordsの要素はobjectである必要があります");
    assert(typeof record.caseId === "string", "record.caseIdが必要です");
    if (record.split !== undefined) {
      assert(
        record.split === gold.split,
        `record ${record.caseId} のsplitがgoldと一致しません`,
      );
    }
  }
  const goldByCase = new Map();
  for (const goldCase of gold.cases) {
    assert(isRecord(goldCase), "gold.casesの要素はobjectである必要があります");
    assert(
      typeof goldCase.caseId === "string" && goldCase.caseId.length > 0,
      "gold caseIdが必要です",
    );
    assert(!goldByCase.has(goldCase.caseId), `gold case重複: ${goldCase.caseId}`);
    goldByCase.set(goldCase.caseId, goldCase);
  }
  for (const record of records) {
    assert(goldByCase.has(record.caseId), `goldが見つかりません: ${record.caseId}`);
  }
  return goldByCase;
}

export function buildRecalculationReport({
  records,
  gold,
  originalSummary,
  input,
  implementation,
  manifest = null,
  generatedAt = new Date().toISOString(),
}) {
  const goldByCase = validateInputs(records, gold, originalSummary);
  const correctedMetrics = calculateMetrics(records, goldByCase);
  const originalConfusion = confusionView(originalSummary.metrics);
  const correctedConfusion = confusionView(correctedMetrics);
  const confusionCountsUnchanged =
    stableStringify(originalConfusion) === stableStringify(correctedConfusion);
  assert(
    confusionCountsUnchanged,
    "再集計でTP/FP/FNが元summaryと一致しません。sidecarを出力しません",
  );

  return {
    schemaVersion: "model-review-corrected-metrics/v1",
    generatedAt,
    purpose:
      "凍結済みmodel-review結果のカテゴリ別未採点境界と再確認欠測指標を再集計する。モデル呼出しや採点基準の変更は行わない。",
    source: {
      runnerId: RUNNER_ID,
      implementation,
      manifest: manifest
        ? {
            path: manifest.path,
            sha256: manifest.sha256,
            manifestId: manifest.value?.manifest_id ?? null,
          }
        : null,
    },
    input,
    invariance: {
      confusionCountsUnchanged,
      fields: ["truePositives", "falsePositives", "falseNegatives"],
      original: originalConfusion,
      corrected: correctedConfusion,
    },
    originalSummary: {
      runId: originalSummary.runId ?? null,
      status: originalSummary.status ?? null,
      split: originalSummary.split ?? gold.split,
    },
    correctedMetrics,
    interpretation: {
      categoryEvaluationRatesRecalculated: true,
      unavailableRecheckMetricsRemainNullWhenUnmeasured: true,
      modelPerformanceWasNotReevaluated: true,
    },
  };
}

export async function writeRecalculationReport(outputPath, report) {
  const absoluteOutput = resolve(outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  assert(!existsSync(absoluteOutput), `出力が既に存在するため上書きしません: ${absoluteOutput}`);
  await writeFile(
    absoluteOutput,
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return absoluteOutput;
}

async function readInputFile(path, label) {
  const absolutePath = resolve(path);
  const bytes = await readFile(absolutePath);
  return {
    absolutePath,
    bytes,
    text: bytes.toString("utf8"),
    metadata: {
      path: portablePath(absolutePath),
      sha256: sha256Bytes(bytes),
      bytes: bytes.length,
      label,
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      records: { type: "string" },
      gold: { type: "string" },
      summary: { type: "string" },
      manifest: { type: "string" },
      implementation: {
        type: "string",
        default: "scripts/model-review-evaluation.mjs",
      },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/recalculate-model-review-metrics.mjs --records <records.jsonl> --gold <gold.json> --summary <summary.json> --output <new-sidecar.json> [--manifest <manifest.json>] [--implementation <runner.mjs>]",
    );
    return;
  }
  for (const name of ["records", "gold", "summary", "output"]) {
    assert(values[name], `--${name}が必要です`);
  }
  const [recordsInput, goldInput, summaryInput] = await Promise.all([
    readInputFile(values.records, "records"),
    readInputFile(values.gold, "gold"),
    readInputFile(values.summary, "summary"),
  ]);
  const implementationInput = await readInputFile(
    values.implementation,
    "implementation",
  );
  const records = parseRecordsJsonl(recordsInput.text, recordsInput.metadata.path);
  const gold = parseJson(goldInput.text, goldInput.metadata.path);
  const originalSummary = parseJson(
    summaryInput.text,
    summaryInput.metadata.path,
  );
  let manifest = null;
  if (values.manifest) {
    const manifestInput = await readInputFile(values.manifest, "manifest");
    manifest = {
      path: manifestInput.metadata.path,
      sha256: manifestInput.metadata.sha256,
      value: parseJson(manifestInput.text, manifestInput.metadata.path),
    };
  }
  const report = buildRecalculationReport({
    records,
    gold,
    originalSummary,
    input: {
      records: { ...recordsInput.metadata, recordCount: records.length },
      gold: {
        ...goldInput.metadata,
        split: gold.split,
        caseCount: gold.cases.length,
      },
      originalSummary: {
        ...summaryInput.metadata,
        runId: originalSummary.runId ?? null,
        status: originalSummary.status ?? null,
        split: originalSummary.split ?? gold.split,
      },
    },
    implementation: {
      ...implementationInput.metadata,
      sourceSha256: `sha256:${sha256Bytes(implementationInput.bytes)}`,
    },
    manifest,
  });
  const outputPath = await writeRecalculationReport(values.output, report);
  console.log(
    JSON.stringify(
      {
        output: portablePath(outputPath),
        split: gold.split,
        records: records.length,
        confusionCountsUnchanged: report.invariance.confusionCountsUnchanged,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
