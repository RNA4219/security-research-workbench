import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { calculateMetrics } from "./model-review-evaluation.mjs";

const thisFile = fileURLToPath(import.meta.url);
const defaultGoldRoot = resolve(
  dirname(thisFile),
  "../evaluations/model-review/gold",
);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function inferredGoldPath(split, goldPath) {
  if (goldPath) return resolve(goldPath);
  const fileName = split === "holdout" ? "holdout.json" : "development.json";
  return resolve(defaultGoldRoot, fileName);
}

function portablePath(path) {
  const repoRoot = resolve(dirname(thisFile), "..");
  const relativePath = relative(repoRoot, resolve(path)).replaceAll("\\", "/");
  return relativePath && !relativePath.startsWith("../")
    ? relativePath
    : `external/${basename(resolve(path))}`;
}

function goldCases(document) {
  const cases = Array.isArray(document) ? document : document?.cases;
  if (!Array.isArray(cases)) throw new Error("gold documentのcasesが必要です");
  return new Map(cases.map((item) => [item.caseId, item]));
}

async function readRunFiles(runDir) {
  const paths = {
    artifact: resolve(runDir, "artifact.json"),
    summary: resolve(runDir, "summary.json"),
    records: resolve(runDir, "records.jsonl"),
    manifest: resolve(runDir, "manifest.json"),
  };
  const contents = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [
        name,
        await readFile(path, "utf8"),
      ]),
    ),
  );
  const records = contents.records
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `records.jsonlの${index + 1}行目を解析できません: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  return {
    paths,
    contents,
    artifact: JSON.parse(contents.artifact),
    summary: JSON.parse(contents.summary),
    manifest: JSON.parse(contents.manifest),
    records,
  };
}

function statusCounts(records) {
  return Object.fromEntries(
    [...new Set(records.map((record) => record.status))]
      .sort()
      .map((status) => [status, records.filter((record) => record.status === status).length]),
  );
}

function unscored(record) {
  return record.status !== "completed" || record.normalized?.valid !== true;
}

function postrunMetrics(records, goldByCase) {
  const metrics = calculateMetrics(records, goldByCase);
  return {
    byCondition: metrics.byCondition,
    overall: {
      records: metrics.records,
      successfulRecords: metrics.successfulRecords,
      evaluationRate: metrics.evaluationRate,
      goldFindingCount: metrics.goldFindingCount,
      scorableGoldFindingCount: metrics.scorableGoldFindingCount,
      goldEvaluationRate: metrics.goldEvaluationRate,
      unscoredTaskCount: metrics.unscoredTaskCount,
      unscoredGoldFindingCount: metrics.unscoredGoldFindingCount,
      errorCount: metrics.errorCount,
      timeoutCount: metrics.timeoutCount,
      partialCount: metrics.partialCount,
      precision: metrics.precision,
      recall: metrics.recall,
      f1: metrics.f1,
    },
  };
}

export async function inspectPostrun(
  runDir,
  { goldPath } = {},
) {
  const files = await readRunFiles(resolve(runDir));
  const split = files.artifact.split ?? "development";
  const selectedGoldPath = inferredGoldPath(split, goldPath);
  const goldContents = await readFile(selectedGoldPath, "utf8");
  const goldByCase = goldCases(JSON.parse(goldContents));
  let unscoredGoldFindingCount = 0;
  for (const record of files.records) {
    const gold = goldByCase.get(record.caseId);
    if (!gold) throw new Error(`goldが見つかりません: ${record.caseId}`);
    if (unscored(record)) unscoredGoldFindingCount += (gold.findings ?? []).length;
  }
  const counts = statusCounts(files.records);
  const errorCount = files.records.filter((record) => record.status === "error").length;
  const timeoutCount = files.records.filter((record) => record.status === "timeout").length;
  const partialCount = files.records.filter((record) =>
    ["partial", "stopped", "unavailable"].includes(record.status),
  ).length;
  const completedRecords = files.records.filter((record) => !unscored(record)).length;
  const measurementReasons = [];
  const evaluationDecision =
    files.artifact.evaluation_decision ?? files.summary.evaluation_decision ?? null;
  if (errorCount > 0) measurementReasons.push(`error_count=${errorCount}`);
  if (timeoutCount > 0) measurementReasons.push(`timeout_count=${timeoutCount}`);
  if (partialCount > 0) measurementReasons.push(`partial_count=${partialCount}`);
  if (unscoredGoldFindingCount > 0) {
    measurementReasons.push(`unscored_gold_finding_count=${unscoredGoldFindingCount}`);
  }
  if (
    files.artifact.status !== "completed" &&
    evaluationDecision === null &&
    measurementReasons.length === 0
  ) {
    measurementReasons.push(`artifact.status=${files.artifact.status}`);
  }
  const measurementStatus = measurementReasons.length === 0 ? "completed" : "failed";
  // 測定完了はrunを観測できたことの証拠であり、効果ゲート合格の証拠ではない。
  // runnerがevaluation_decisionを明示しない場合は、全recordが完了していても
  // 効果判定を未測定のまま保持する。
  const decision = evaluationDecision ?? "unmeasured";
  // Evidence is portable and publishable: hash the exact local bytes while
  // recording only stable artifact names, never an absolute user path.
  const source = Object.fromEntries(
    Object.keys(files.paths).map((name) => [`${name}Path`, `${name}.json`]),
  );
  source.recordsPath = "records.jsonl";
  source.goldPath = portablePath(selectedGoldPath);
  // Kept for compatibility with earlier postrun evidence readers; the value
  // now points to the actual gold used for this split rather than always
  // claiming development gold.
  source.goldDevelopmentPath = portablePath(selectedGoldPath);
  for (const [name, path] of Object.entries(files.paths)) {
    source[`${name}Sha256`] = sha256(files.contents[name]);
  }
  source.goldSha256 = sha256(goldContents);
  source.goldDevelopmentSha256 = source.goldSha256;
  const metrics = postrunMetrics(files.records, goldByCase);
  const finiteMetric = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  // The postrun evidence is a copy of the frozen identity manifest.  Keep the
  // canonical schema so workflow-cookbook's checker can validate it; the
  // additional postrun_evidence object carries the honest unscored details.
  const postrunManifest = {
    ...files.manifest,
    status: measurementStatus,
    sourceManifestId: files.manifest.manifest_id,
    sourceManifestSha256: source.manifestSha256,
    source,
    outcome: {
      artifact_path: "artifact.json",
      artifact_sha256: source.artifactSha256,
      records: files.records.length,
      error_count: errorCount,
      crash_count: Number.isInteger(files.artifact.crash_count)
        ? files.artifact.crash_count
        : 0,
      timeout_count: timeoutCount,
      metrics: {
        f1: finiteMetric(files.artifact.metrics?.f1 ?? metrics.overall.f1),
        precision: finiteMetric(
          files.artifact.metrics?.precision ?? metrics.overall.precision,
        ),
        recall: finiteMetric(files.artifact.metrics?.recall ?? metrics.overall.recall),
        evaluationRate: finiteMetric(metrics.overall.evaluationRate),
        goldEvaluationRate: finiteMetric(metrics.overall.goldEvaluationRate),
      },
      decision,
    },
    postrun_evidence: {
      artifactVersion: "model-review-postrun/v2",
      runId: files.artifact.runId,
      split,
      conditions: files.artifact.conditions ?? [
        ...new Set(files.records.map((record) => record.condition)),
      ].sort(),
      completedRecords,
      statusCounts: counts,
      errorCount,
      timeoutCount,
      partialCount,
      unscoredTaskCount: files.records.length - completedRecords,
      unscoredGoldFindingCount,
      holdout: split === "holdout" ? "run" : "not_run",
      measurementStatus,
      measurementReasons,
      evaluationDecision,
      metrics,
      outcome: {
        decision,
        reasons: measurementReasons,
      },
      measurementNotes: [
        "postrun checkerは原runのartifact/summary/records/manifestを変更せず、新規証跡だけを生成します。",
        "error/timeout/partial/stopped/unavailableはFNへ水増しせず、対応するgoldは未採点として評価率とともに記録します。",
        "未採点goldが残るrun、またはerror/partialを含むrunから改善を主張しません。",
        "人の所要時間は測定しておらず、確認件数はproxyです。",
      ],
    },
  };
  const checkerErrors = [];
  if (postrunManifest.outcome.error_count !== 0) {
    checkerErrors.push("outcome.error_count must be zero");
  }
  if (postrunManifest.status !== "completed") {
    checkerErrors.push("status must be completed for postrun");
  }
  const check = {
    status: checkerErrors.length === 0 ? "ok" : "failed",
    stage: "postrun",
    errors: checkerErrors,
  };
  return { postrunManifest, check };
}

export async function writePostrunEvidence(
  runDir,
  { goldPath, force = false } = {},
) {
  const outputDir = resolve(runDir);
  const manifestPath = resolve(outputDir, "postrun-manifest.json");
  const checkPath = resolve(outputDir, "postrun-check.json");
  if (!force && (existsSync(manifestPath) || existsSync(checkPath))) {
    throw new Error(
      "postrun証跡が既に存在します。既存証跡を上書きする場合だけ--forceを指定してください",
    );
  }
  const evidence = await inspectPostrun(outputDir, { goldPath });
  await writeFile(manifestPath, `${JSON.stringify(evidence.postrunManifest, null, 2)}\n`, "utf8");
  await writeFile(checkPath, `${JSON.stringify(evidence.check, null, 2)}\n`, "utf8");
  return {
    ...evidence,
    manifestPath,
    checkPath,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      "run-dir": { type: "string" },
      gold: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/model-review-postrun.mjs --run-dir <result-directory> [--gold <split-gold.json>] [--force]",
    );
    return;
  }
  if (!values["run-dir"]) throw new Error("--run-dirが必要です");
  const result = await writePostrunEvidence(values["run-dir"], {
    goldPath: values.gold,
    force: values.force,
  });
  console.log(JSON.stringify({
    status: result.check.status,
    manifestPath: result.manifestPath,
    checkPath: result.checkPath,
    errors: result.check.errors,
  }, null, 2));
  process.exitCode = result.check.status === "ok" ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
