import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const RUNNER_ID = "model-review-evaluation/v1";
export const ENGINE_INPUT_CONTRACT = "model-review-engine-input/v1";
export const ENGINE_OUTPUT_CONTRACT = "model-review-engine-output/v1";
export const CONDITIONS = Object.freeze(["A", "B", "C"]);
export const SPLITS = Object.freeze(["development", "holdout"]);
export const DEFAULT_BUDGET = Object.freeze({
  maxDurationMs: 120_000,
  // Qwen3.5-4B is run with ctx16384; leave headroom for the wrapper and
  // reserve a fixed output budget for comparable local runs.
  maxInputTokens: 12_000,
  maxOutputTokens: 2_048,
});

const CATEGORY_NAMES = new Set([
  "authorization",
  "tenant-isolation",
  "input-validation",
  "state-transition",
  "pii-logging",
  "cryptography",
]);

const thisFile = fileURLToPath(import.meta.url);
const defaultCorpusDir = resolve(
  dirname(thisFile),
  "../evaluations/model-review",
);

export const SOURCE_BUNDLE_ENTRIES = Object.freeze([
  {
    role: "runner",
    identityRole: "runner",
    bundlePath: "runner/model-review-evaluation.mjs",
  },
  {
    role: "adapter",
    identityRole: "adapter",
    bundlePath: "adapter/model-review-production-adapter.mjs",
  },
  {
    role: "engine",
    identityRole: "engine",
    bundlePath: "engine/model-review.js",
  },
  {
    role: "provider",
    identityRole: "provider",
    bundlePath: "provider/workflow-providers.js",
  },
  {
    role: "shared-diagnostic-engine",
    sourcePath: "dist/shared/diagnostic-engine.js",
    bundlePath: "shared/diagnostic-engine.js",
  },
  {
    role: "shared-model-review",
    sourcePath: "dist/shared/model-review.js",
    bundlePath: "shared/model-review.js",
  },
  {
    role: "shared-model",
    sourcePath: "dist/shared/model.js",
    bundlePath: "shared/model.js",
  },
  {
    role: "shared-domain-error",
    sourcePath: "dist/shared/domain-error.js",
    bundlePath: "shared/domain-error.js",
  },
  {
    role: "package-lock",
    sourcePath: "package-lock.json",
    bundlePath: "package-lock.json",
  },
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedValue(value[key])]),
    );
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(sortedValue(value));
}

export function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function sha256Json(value) {
  return sha256Text(stableStringify(value));
}

/** Hash the exact specification inputs used to decide whether a prior judgment applies. */
export function conditionHashForSpecification(specification) {
  return sha256Json({
    revision: specification?.revision ?? null,
    text: specification?.text ?? null,
    requirements: specification?.requirements ?? [],
  });
}

export function prefixedSha256(value) {
  return `sha256:${value}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertString(value, message) {
  assert(typeof value === "string" && value.trim().length > 0, message);
}

function assertSha(value, message) {
  assert(
    typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value),
    message,
  );
}

function assertRawSha(value, message) {
  assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), message);
}

function assertInteger(value, message, { min = Number.MIN_SAFE_INTEGER } = {}) {
  assert(Number.isInteger(value) && value >= min, message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function normalizePath(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}

function normalizeAnchor(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function positiveLine(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function conditionIndex(condition) {
  const index = CONDITIONS.indexOf(condition);
  assert(index >= 0, `未知の評価条件: ${condition}`);
  return index;
}

function orderedCases(cases) {
  return [...cases].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeSplit(split) {
  assert(SPLITS.includes(split), `未知のsplit: ${split}`);
  return split;
}

function outputFindingFromCandidate(candidate, topLevelHumanConfirmation) {
  if (!isRecord(candidate)) {
    return {
      path: "",
      category: "",
      lineStart: null,
      lineEnd: null,
      anchor: "",
      requiresHumanConfirmation: Boolean(topLevelHumanConfirmation),
      invalid: true,
    };
  }
  const location = isRecord(candidate.location)
    ? candidate.location
    : isRecord(candidate.evidenceLocation)
      ? candidate.evidenceLocation
      : isRecord(candidate.evidence)
        ? candidate.evidence
        : {};
  const lineStart = positiveLine(
    candidate.lineStart ??
      candidate.startLine ??
      candidate.line ??
      location.lineStart ??
      location.startLine ??
      location.line,
  );
  const lineEnd = positiveLine(
    candidate.lineEnd ??
      candidate.endLine ??
      candidate.line ??
      location.lineEnd ??
      location.endLine ??
      location.line,
  );
  const finding = {
    path: normalizePath(
      candidate.path ?? candidate.file ?? location.path ?? location.file,
    ),
    category: String(candidate.category ?? candidate.kind ?? "").trim(),
    lineStart,
    lineEnd,
    anchor: normalizeAnchor(
      candidate.anchor ??
        candidate.snippet ??
        candidate.excerpt ??
        candidate.originalText ??
        location.anchor ??
        location.snippet,
    ),
    requiresHumanConfirmation: Boolean(
      candidate.requiresHumanConfirmation ??
      candidate.needsHumanConfirmation ??
      candidate.remediation?.humanReviewRequired ??
      topLevelHumanConfirmation,
    ),
  };
  return {
    ...finding,
    invalid:
      !finding.path ||
      !finding.category ||
      !Number.isInteger(finding.lineStart) ||
      !Number.isInteger(finding.lineEnd) ||
      finding.lineEnd < finding.lineStart ||
      !finding.anchor,
  };
}

function parseEnginePayload(result) {
  if (typeof result === "string") {
    try {
      return { payload: JSON.parse(result), rawResponse: result };
    } catch (error) {
      return {
        payload: null,
        rawResponse: result,
        parseError: `engine response JSONの解析に失敗: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (isRecord(result) && typeof result.response === "string") {
    try {
      return {
        payload: JSON.parse(result.response),
        rawResponse: result.response,
        envelope: result,
      };
    } catch (error) {
      return {
        payload: null,
        rawResponse: result.response,
        envelope: result,
        parseError: `engine response JSONの解析に失敗: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { payload: result, rawResponse: result };
}

export function normalizeReviewOutput(result) {
  const parsed = parseEnginePayload(result);
  if (parsed.parseError) {
    return {
      valid: false,
      error: parsed.parseError,
      findings: [],
      requiresHumanConfirmation: false,
      recheckPriorDecision: false,
      rawResponse: parsed.rawResponse,
    };
  }
  const payload = parsed.payload;
  if (!isRecord(payload)) {
    return {
      valid: false,
      error: "engine responseはobjectである必要があります",
      findings: [],
      requiresHumanConfirmation: false,
      recheckPriorDecision: false,
      rawResponse: parsed.rawResponse,
    };
  }
  const requiresHumanConfirmation = Boolean(
    payload.requiresHumanConfirmation ?? payload.needsHumanConfirmation,
  );
  const findingsValue = Array.isArray(payload.findings)
    ? payload.findings
    : Array.isArray(payload.issues)
      ? payload.issues
      : [];
  const findings = findingsValue.map((item) =>
    outputFindingFromCandidate(item, requiresHumanConfirmation),
  );
  const invalid = findings.some((finding) => finding.invalid);
  const rawResponse = payload.rawResponse ?? parsed.rawResponse;
  return {
    valid: !invalid,
    error: invalid
      ? "findingにはpath/category/lineStart/lineEnd/anchorが必要です"
      : null,
    findings: findings.map(({ invalid: _invalid, ...finding }) => finding),
    requiresHumanConfirmation:
      requiresHumanConfirmation ||
      findings.some((finding) => finding.requiresHumanConfirmation),
    recheckPriorDecision:
      typeof (payload.recheckPriorDecision ?? payload.reviewPriorDecision) ===
      "boolean"
        ? (payload.recheckPriorDecision ?? payload.reviewPriorDecision)
        : null,
    rawResponse,
    prompt: typeof payload.prompt === "string" ? payload.prompt : undefined,
    model: typeof payload.model === "string" ? payload.model : undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
  };
}

function findingKey(finding) {
  return [
    normalizePath(finding.path),
    String(finding.category ?? "").trim(),
    `${finding.lineStart}-${finding.lineEnd}`,
    normalizeAnchor(finding.anchor),
  ].join("|");
}

export function matchFindings(predicted, gold) {
  const available = new Map();
  for (const item of gold) {
    const key = findingKey(item);
    available.set(key, (available.get(key) ?? 0) + 1);
  }
  const seenPredictions = new Set();
  const truePositives = [];
  const falsePositives = [];
  const duplicatePredictions = [];
  for (const item of predicted) {
    const key = findingKey(item);
    const previous = seenPredictions.has(key);
    seenPredictions.add(key);
    if (previous) duplicatePredictions.push(item);
    const remaining = available.get(key) ?? 0;
    if (remaining > 0 && !previous) {
      available.set(key, remaining - 1);
      truePositives.push(item);
    } else {
      // 重複も予測件数に残し、再出力filterでprecisionを水増ししない。
      falsePositives.push(item);
    }
  }
  const falseNegatives = [];
  for (const item of gold) {
    const key = findingKey(item);
    const matched = truePositives.filter(
      (candidate) => findingKey(candidate) === key,
    ).length;
    const expected = gold.filter(
      (candidate) => findingKey(candidate) === key,
    ).length;
    const alreadyReported = falseNegatives.filter(
      (candidate) => findingKey(candidate) === key,
    ).length;
    if (matched + alreadyReported < expected) falseNegatives.push(item);
  }
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    duplicatePredictions,
    truePositiveCount: truePositives.length,
    falsePositiveCount: falsePositives.length,
    falseNegativeCount: falseNegatives.length,
    duplicateCount: duplicatePredictions.length,
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

function blankCounts() {
  return {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    duplicateCount: 0,
    predictedFindingCount: 0,
    goldFindingCount: 0,
    records: 0,
    successfulRecords: 0,
    errorCount: 0,
    timeoutCount: 0,
    partialCount: 0,
    unscoredTaskCount: 0,
    unscoredGoldFindingCount: 0,
    predictedHumanConfirmationCount: 0,
    goldHumanConfirmationCount: 0,
    predictedRecheckCount: 0,
    goldRecheckCount: 0,
    recheckUnavailableCount: 0,
    recheckMeasuredCount: 0,
    measuredGoldRecheckCount: 0,
    negativeControlRecords: 0,
    negativeControlFalseAlarms: 0,
    changedAssumptionRecords: 0,
    changedAssumptionMeasuredRecords: 0,
    changedAssumptionMisses: 0,
  };
}

function finalizeCounts(counts) {
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
    // エラーや中断をFNへ変換せず、実際に採点できた範囲を明示する。
    evaluationRate: ratio(counts.successfulRecords, counts.records),
    evaluatedRecordRate: ratio(counts.successfulRecords, counts.records),
    scorableGoldFindingCount:
      counts.goldFindingCount - counts.unscoredGoldFindingCount,
    goldEvaluationRate: ratio(
      counts.goldFindingCount - counts.unscoredGoldFindingCount,
      counts.goldFindingCount,
    ),
    evaluatedGoldFindingRate: ratio(
      counts.goldFindingCount - counts.unscoredGoldFindingCount,
      counts.goldFindingCount,
    ),
    unscoredGoldFindingRate: ratio(
      counts.unscoredGoldFindingCount,
      counts.goldFindingCount,
    ),
    precision,
    recall,
    f1: f1(precision, recall),
    humanConfirmationRate: ratio(
      counts.predictedHumanConfirmationCount,
      counts.records,
    ),
    humanConfirmationOverreach:
      counts.predictedHumanConfirmationCount -
      counts.goldHumanConfirmationCount,
    recheckPriorDecisionOverreach:
      counts.recheckMeasuredCount === 0
        ? null
        : counts.predictedRecheckCount - counts.measuredGoldRecheckCount,
    negativeControlFalseAlarmRate: ratio(
      counts.negativeControlFalseAlarms,
      counts.negativeControlRecords,
    ),
    changedAssumptionMissRate: ratio(
      counts.changedAssumptionMisses,
      counts.changedAssumptionMeasuredRecords,
    ),
  };
}

function expectedFlag(goldCase, name) {
  return Boolean(goldCase.expectedReview?.[name]);
}

function calculateMetricsForRecords(records, goldByCase) {
  const totals = blankCounts();
  const byCategory = new Map();
  for (const record of records) {
    totals.records += 1;
    const goldCase = goldByCase.get(record.caseId);
    assert(goldCase, `goldが見つかりません: ${record.caseId}`);
    const goldFindings = goldCase.findings ?? [];
    totals.goldFindingCount += goldFindings.length;
    if (expectedFlag(goldCase, "requiresHumanConfirmation")) {
      totals.goldHumanConfirmationCount += 1;
    }
    if (expectedFlag(goldCase, "recheckPriorDecision")) {
      totals.goldRecheckCount += 1;
    }
    const negativeControl =
      goldCase.controlType === "unchanged-assumption" ||
      goldCase.controlType === "hard-negative";
    const changedAssumption = goldCase.controlType === "changed-assumption";
    if (negativeControl) totals.negativeControlRecords += 1;
    if (changedAssumption) totals.changedAssumptionRecords += 1;
    const categorySeen = new Set([
      ...goldFindings.map((finding) => finding.category),
      ...(record.normalized?.findings ?? []).map((finding) => finding.category),
    ]);
    if (record.status !== "completed" || !record.normalized?.valid) {
      totals.unscoredTaskCount += 1;
      totals.unscoredGoldFindingCount += goldFindings.length;
      if (record.status === "error" || !record.normalized?.valid) {
        totals.errorCount += 1;
      }
      if (record.status === "timeout") totals.timeoutCount += 1;
      if (["partial", "stopped", "unavailable"].includes(record.status)) {
        totals.partialCount += 1;
      }
      for (const category of categorySeen) {
        if (!byCategory.has(category)) byCategory.set(category, blankCounts());
        const categoryCounts = byCategory.get(category);
        const categoryGold = goldFindings.filter(
          (finding) => finding.category === category,
        );
        categoryCounts.records += 1;
        categoryCounts.goldFindingCount += categoryGold.length;
        categoryCounts.unscoredTaskCount += 1;
        categoryCounts.unscoredGoldFindingCount += categoryGold.length;
        if (record.status === "error" || !record.normalized?.valid) {
          categoryCounts.errorCount += 1;
        }
        if (record.status === "timeout") categoryCounts.timeoutCount += 1;
        if (["partial", "stopped", "unavailable"].includes(record.status)) {
          categoryCounts.partialCount += 1;
        }
      }
      continue;
    }
    totals.successfulRecords += 1;
    const matched = matchFindings(record.normalized.findings, goldFindings);
    totals.truePositives += matched.truePositiveCount;
    totals.falsePositives += matched.falsePositiveCount;
    totals.falseNegatives += matched.falseNegativeCount;
    totals.duplicateCount += matched.duplicateCount;
    totals.predictedFindingCount += record.normalized.findings.length;
    const human = Boolean(
      record.normalized.requiresHumanConfirmation ||
      record.normalized.findings.some(
        (finding) => finding.requiresHumanConfirmation,
      ),
    );
    const recheckValue = record.normalized.recheckPriorDecision;
    const recheckMeasured = typeof recheckValue === "boolean";
    const recheck = recheckMeasured && recheckValue;
    if (recheckMeasured) {
      totals.recheckMeasuredCount += 1;
      if (expectedFlag(goldCase, "recheckPriorDecision")) {
        totals.measuredGoldRecheckCount += 1;
      }
      if (changedAssumption) {
        totals.changedAssumptionMeasuredRecords += 1;
        if (!recheck) totals.changedAssumptionMisses += 1;
      }
    } else {
      totals.recheckUnavailableCount += 1;
    }
    if (human) totals.predictedHumanConfirmationCount += 1;
    if (recheck) totals.predictedRecheckCount += 1;
    if (
      negativeControl &&
      (record.normalized.findings.length > 0 || human || recheck)
    ) {
      totals.negativeControlFalseAlarms += 1;
    }
    for (const category of categorySeen) {
      if (!byCategory.has(category)) byCategory.set(category, blankCounts());
      const categoryCounts = byCategory.get(category);
      categoryCounts.records += 1;
      categoryCounts.successfulRecords += 1;
      const categoryGold = goldFindings.filter(
        (finding) => finding.category === category,
      );
      const categoryPredicted = record.normalized.findings.filter(
        (finding) => finding.category === category,
      );
      const categoryMatch = matchFindings(categoryPredicted, categoryGold);
      categoryCounts.truePositives += categoryMatch.truePositiveCount;
      categoryCounts.falsePositives += categoryMatch.falsePositiveCount;
      categoryCounts.falseNegatives += categoryMatch.falseNegativeCount;
      categoryCounts.duplicateCount += categoryMatch.duplicateCount;
      categoryCounts.predictedFindingCount += categoryPredicted.length;
      categoryCounts.goldFindingCount += categoryGold.length;
    }
  }
  const metrics = finalizeCounts(totals);
  metrics.byCategory = Object.fromEntries(
    [...byCategory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, counts]) => [category, finalizeCounts(counts)]),
  );
  return metrics;
}

export function calculateMetrics(records, goldByCase) {
  const metrics = calculateMetricsForRecords(records, goldByCase);
  const conditions = [
    ...new Set(
      records
        .map((record) => record.condition)
        .filter(
          (condition) => typeof condition === "string" && condition.length,
        ),
    ),
  ].sort();
  metrics.byCondition = Object.fromEntries(
    conditions.map((condition) => [
      condition,
      calculateMetricsForRecords(
        records.filter((record) => record.condition === condition),
        goldByCase,
      ),
    ]),
  );
  return metrics;
}

function assertSourcePath(value, message) {
  assertString(value, message);
  assert(!isAbsolute(value) && !value.includes(".."), message);
}

function validateGoldFinding(finding, location) {
  assert(isRecord(finding), `${location}はobjectである必要があります`);
  assertString(finding.path, `${location}.pathが必要です`);
  assert(
    CATEGORY_NAMES.has(finding.category),
    `${location}.categoryが未知です`,
  );
  assertInteger(finding.lineStart, `${location}.lineStartが必要です`, {
    min: 1,
  });
  assertInteger(finding.lineEnd, `${location}.lineEndが必要です`, { min: 1 });
  assert(
    finding.lineEnd >= finding.lineStart,
    `${location}.line範囲が不正です`,
  );
  assertString(finding.anchor, `${location}.anchorが必要です`);
}

function validateSpecification(specification, location) {
  assert(isRecord(specification), `${location}が必要です`);
  assertString(specification.revision, `${location}.revisionが必要です`);
  assertString(specification.text, `${location}.textが必要です`);
  assert(
    Array.isArray(specification.requirements),
    `${location}.requirementsが必要です`,
  );
  for (const [index, requirement] of specification.requirements.entries()) {
    assert(
      isRecord(requirement),
      `${location}.requirements[${index}]が不正です`,
    );
    assertString(
      requirement.id,
      `${location}.requirements[${index}].idが必要です`,
    );
    assertString(
      requirement.content ?? requirement.text,
      `${location}.requirements[${index}].contentが必要です`,
    );
  }
}

function validateKnowledgeItem(knowledge, location) {
  assert(isRecord(knowledge), `${location}が不正です`);
  assertString(knowledge.id, `${location}.idが必要です`);
  assert(
    knowledge.status === "approved" || knowledge.status === "active",
    `${location}はapproved/activeが必要です`,
  );
  assertString(knowledge.content, `${location}.contentが必要です`);
  assertRawSha(knowledge.hash, `${location}.hashが必要です`);
  assert(
    knowledge.hash === sha256Text(knowledge.content),
    `${location}.hashが本文と一致しません`,
  );
  assert(
    Array.isArray(knowledge.sourceRefs) && knowledge.sourceRefs.length > 0,
    `${location}.sourceRefsが必要です`,
  );
  for (const [index, sourceRef] of knowledge.sourceRefs.entries()) {
    const sourceLocation = `${location}.sourceRefs[${index}]`;
    assert(isRecord(sourceRef), `${sourceLocation}が不正です`);
    assertString(sourceRef.id, `${sourceLocation}.idが必要です`);
    assertString(sourceRef.version, `${sourceLocation}.versionが必要です`);
    assertString(sourceRef.excerpt, `${sourceLocation}.excerptが必要です`);
    assertRawSha(sourceRef.hash, `${sourceLocation}.hashが必要です`);
    assert(
      sourceRef.hash === sha256Text(sourceRef.excerpt),
      `${sourceLocation}.hashが出典excerptと一致しません`,
    );
  }
}

function validateCase(testCase, expectedSplit, productId) {
  assert(isRecord(testCase), "caseはobjectである必要があります");
  assert(
    /^[a-z]\d{2}$/.test(testCase.id),
    `case idがopaque形式ではありません: ${testCase.id}`,
  );
  assert(testCase.split === expectedSplit, `${testCase.id}のsplitが不一致です`);
  assert(isRecord(testCase.source), `${testCase.id}.sourceが必要です`);
  assert(
    testCase.source.productId === productId,
    `${testCase.id}のproductIdが不一致です`,
  );
  assertSourcePath(
    testCase.source.path,
    `${testCase.id}.source.pathが不正です`,
  );
  assertString(
    testCase.source.commit,
    `${testCase.id}.source.commitが必要です`,
  );
  assertString(testCase.code, `${testCase.id}.codeが必要です`);
  assertSha(
    testCase.source.codeSha256,
    `${testCase.id}.source.codeSha256が不正です`,
  );
  assert(
    prefixedSha256(sha256Text(testCase.code)) === testCase.source.codeSha256,
    `${testCase.id}.codeSha256が一致しません`,
  );
  validateSpecification(testCase.specification, `${testCase.id}.specification`);
  assertRawSha(
    testCase.conditionHash,
    `${testCase.id}.conditionHashが必要です`,
  );
  assert(
    testCase.conditionHash ===
      conditionHashForSpecification(testCase.specification),
    `${testCase.id}.conditionHashがspecificationと一致しません`,
  );
  assert(
    Array.isArray(testCase.approvedKnowledge),
    `${testCase.id}.approvedKnowledgeが必要です`,
  );
  for (const [index, knowledge] of testCase.approvedKnowledge.entries()) {
    validateKnowledgeItem(
      knowledge,
      `${testCase.id}.approvedKnowledge[${index}]`,
    );
  }
  assert(
    Array.isArray(testCase.approvedDecisions),
    `${testCase.id}.approvedDecisionsが必要です`,
  );
  for (const [index, decision] of testCase.approvedDecisions.entries()) {
    assert(
      isRecord(decision),
      `${testCase.id}.approvedDecisions[${index}]が不正です`,
    );
    assertString(
      decision.id,
      `${testCase.id}.approvedDecisions[${index}].idが必要です`,
    );
    assert(
      decision.status === "approved",
      `${testCase.id}.approvedDecisions[${index}]はapprovedが必要です`,
    );
    assertString(
      decision.targetCommit,
      `${testCase.id}.approvedDecisions[${index}].targetCommitが必要です`,
    );
    assertString(
      decision.applicability,
      `${testCase.id}.approvedDecisions[${index}].applicabilityが必要です`,
    );
    const decisionLocation = `${testCase.id}.approvedDecisions[${index}]`;
    const conditionBasis = decision.conditionBasis ?? testCase.specification;
    validateSpecification(conditionBasis, `${decisionLocation}.conditionBasis`);
    assertRawSha(
      decision.conditionHash,
      `${decisionLocation}.conditionHashが必要です`,
    );
    assert(
      decision.conditionHash === conditionHashForSpecification(conditionBasis),
      `${decisionLocation}.conditionHashがconditionBasisと一致しません`,
    );
    assert(
      Array.isArray(decision.sourceRefs) && decision.sourceRefs.length > 0,
      `${decisionLocation}.sourceRefsが必要です`,
    );
    for (const [sourceIndex, sourceRef] of decision.sourceRefs.entries()) {
      const sourceLocation = `${decisionLocation}.sourceRefs[${sourceIndex}]`;
      assert(isRecord(sourceRef), `${sourceLocation}が不正です`);
      assertString(sourceRef.id, `${sourceLocation}.idが必要です`);
      assertString(sourceRef.version, `${sourceLocation}.versionが必要です`);
      assertString(sourceRef.excerpt, `${sourceLocation}.excerptが必要です`);
      assertRawSha(sourceRef.hash, `${sourceLocation}.hashが必要です`);
      assert(
        sourceRef.hash === sha256Text(sourceRef.excerpt),
        `${sourceLocation}.hashが出典excerptと一致しません`,
      );
    }
  }
}

function validateGold(gold, expectedSplit, caseIds) {
  assert(isRecord(gold), `${expectedSplit} goldが不正です`);
  assert(
    gold.split === expectedSplit,
    `${expectedSplit} goldのsplitが不一致です`,
  );
  assert(Array.isArray(gold.cases), `${expectedSplit} gold.casesが必要です`);
  const seen = new Set();
  for (const [index, goldCase] of gold.cases.entries()) {
    assert(isRecord(goldCase), `gold.cases[${index}]が不正です`);
    assert(caseIds.has(goldCase.caseId), `goldの未知case: ${goldCase.caseId}`);
    assert(!seen.has(goldCase.caseId), `goldのcase重複: ${goldCase.caseId}`);
    seen.add(goldCase.caseId);
    assert(
      Array.isArray(goldCase.findings),
      `${goldCase.caseId}.findingsが必要です`,
    );
    for (const [findingIndex, finding] of goldCase.findings.entries()) {
      validateGoldFinding(
        finding,
        `${goldCase.caseId}.findings[${findingIndex}]`,
      );
    }
    const keys = new Set(goldCase.findings.map(findingKey));
    assert(
      keys.size === goldCase.findings.length,
      `${goldCase.caseId}のgold findingが重複しています`,
    );
    assert(
      isRecord(goldCase.expectedReview),
      `${goldCase.caseId}.expectedReviewが必要です`,
    );
    assert(
      typeof goldCase.expectedReview.requiresHumanConfirmation === "boolean",
      `${goldCase.caseId}.expectedReview.requiresHumanConfirmationが必要です`,
    );
    assert(
      typeof goldCase.expectedReview.recheckPriorDecision === "boolean",
      `${goldCase.caseId}.expectedReview.recheckPriorDecisionが必要です`,
    );
    assert(
      [
        "positive",
        "hard-negative",
        "changed-assumption",
        "unchanged-assumption",
      ].includes(goldCase.controlType),
      `${goldCase.caseId}.controlTypeが不正です`,
    );
  }
  assert(
    seen.size === caseIds.size,
    `${expectedSplit} goldとcase集合が一致しません`,
  );
  return new Map(gold.cases.map((goldCase) => [goldCase.caseId, goldCase]));
}

export function validateCorpus(corpus) {
  assert(isRecord(corpus), "corpusがobjectである必要があります");
  assert(
    corpus.corpusVersion === "model-review-corpus/v1",
    "corpusVersionが不正です",
  );
  assert(isRecord(corpus.product), "productが必要です");
  assertString(corpus.product.productId, "product.productIdが必要です");
  assertString(corpus.product.name, "product.nameが必要です");
  assertString(corpus.product.description, "product.descriptionが必要です");
  assert(
    Array.isArray(corpus.product.approvedKnowledge),
    "product.approvedKnowledgeが必要です",
  );
  for (const [index, knowledge] of corpus.product.approvedKnowledge.entries()) {
    validateKnowledgeItem(knowledge, `product.approvedKnowledge[${index}]`);
  }
  const development = corpus.cases?.development;
  const holdout = corpus.cases?.holdout;
  assert(
    Array.isArray(development) && development.length >= 6,
    "developmentは6件以上必要です",
  );
  assert(
    Array.isArray(holdout) && holdout.length >= 6,
    "holdoutは6件以上必要です",
  );
  const allIds = new Set();
  for (const testCase of development) {
    validateCase(testCase, "development", corpus.product.productId);
    assert(!allIds.has(testCase.id), `case id重複: ${testCase.id}`);
    allIds.add(testCase.id);
  }
  for (const testCase of holdout) {
    validateCase(testCase, "holdout", corpus.product.productId);
    assert(!allIds.has(testCase.id), `case id重複: ${testCase.id}`);
    allIds.add(testCase.id);
  }
  const goldBySplit = {
    development: validateGold(
      corpus.gold?.development,
      "development",
      new Set(development.map((testCase) => testCase.id)),
    ),
    holdout: validateGold(
      corpus.gold?.holdout,
      "holdout",
      new Set(holdout.map((testCase) => testCase.id)),
    ),
  };
  const caseById = new Map(
    [...development, ...holdout].map((testCase) => [testCase.id, testCase]),
  );
  for (const goldCase of [
    ...goldBySplit.development.values(),
    ...goldBySplit.holdout.values(),
  ]) {
    const testCase = caseById.get(goldCase.caseId);
    const decisionHashes = testCase.approvedDecisions.map(
      (decision) => decision.conditionHash,
    );
    if (goldCase.controlType === "changed-assumption") {
      assert(
        decisionHashes.some((hash) => hash !== testCase.conditionHash),
        `${goldCase.caseId}の前提変更controlに不一致conditionHashがありません`,
      );
    }
    if (goldCase.controlType === "unchanged-assumption") {
      assert(
        decisionHashes.every((hash) => hash === testCase.conditionHash),
        `${goldCase.caseId}の前提不変controlがspecificationと一致しません`,
      );
    }
  }
  const categories = new Set();
  for (const gold of [
    ...goldBySplit.development.values(),
    ...goldBySplit.holdout.values(),
  ]) {
    for (const finding of gold.findings) categories.add(finding.category);
  }
  assert(categories.size >= 6, "goldには6種類以上の問題カテゴリが必要です");
  assert(
    [...development, ...holdout].some(
      (testCase) => testCase.approvedDecisions.length > 0,
    ),
    "承認済み判断履歴を含むcaseが必要です",
  );
  assert(
    [...goldBySplit.development.values(), ...goldBySplit.holdout.values()].some(
      (gold) => gold.controlType === "changed-assumption",
    ),
    "前提変更caseが必要です",
  );
  assert(
    [...goldBySplit.development.values(), ...goldBySplit.holdout.values()].some(
      (gold) =>
        gold.findings.length === 0 && gold.controlType === "hard-negative",
    ),
    "hard negativeが必要です",
  );
  return { ...corpus, goldBySplit };
}

export function corpusDatasetView(corpus) {
  return {
    corpusVersion: corpus.corpusVersion,
    product: corpus.product,
    cases: {
      development: corpus.cases.development,
      holdout: corpus.cases.holdout,
    },
    gold: corpus.gold,
  };
}

export function corpusDatasetHash(corpus) {
  return prefixedSha256(sha256Json(corpusDatasetView(corpus)));
}

export function buildReviewInput(testCase, condition, product) {
  conditionIndex(condition);
  const base = {
    contractVersion: ENGINE_INPUT_CONTRACT,
    target: {
      productId: product.productId,
      path: testCase.source.path,
      commit: testCase.source.commit,
      previousCommit: testCase.source.previousCommit ?? null,
    },
    task: {
      instruction:
        "与えられた製品文脈だけを根拠にコードを静的レビューし、問題がある場合は正確なpath・1-based line範囲・短いanchorを返す。問題がなければfindingsを空にする。カテゴリはauthorization、tenant-isolation、input-validation、state-transition、pii-logging、cryptographyのいずれかを使う。推測した問題は断定せず、production model-review契約のfinding schemaだけを返す。",
      output: {
        findings:
          "array of production findings; return the exact production response instance keys schemaVersion, findings, omitted, limitations, and each finding must cite path, line, originalText, category, severity, title, rationale, specRefIds, relatedFixedFindingIds, pastJudgmentIds, remediation, falsePositiveCandidate, uncertainty",
        allowedCategories: [...CATEGORY_NAMES].sort(),
      },
    },
    code: {
      path: testCase.source.path,
      text: testCase.code,
    },
  };
  if (condition === "A") return base;
  const withKnowledge = {
    ...base,
    specification: {
      revision: testCase.specification.revision,
      text: [product.specification?.text, testCase.specification.text]
        .filter(Boolean)
        .join("\n"),
      requirements: [
        ...(product.specification?.requirements ?? []),
        ...testCase.specification.requirements,
      ],
    },
    approvedKnowledge: [
      ...(product.approvedKnowledge ?? []),
      ...testCase.approvedKnowledge,
    ],
    conditionHash: testCase.conditionHash,
  };
  if (condition === "B") return withKnowledge;
  return {
    ...withKnowledge,
    approvedDecisionHistory: testCase.approvedDecisions,
  };
}

export function conditionInputHash(corpus, condition) {
  const cases = [...corpus.cases.development, ...corpus.cases.holdout]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((testCase) => ({
      id: testCase.id,
      input: buildReviewInput(testCase, condition, corpus.product),
    }));
  return prefixedSha256(sha256Json({ condition, cases }));
}

export function buildPrompt(input) {
  return [
    "Model review input (JSON):",
    stableStringify(input),
    "Return only the structured model-review response required by the contract.",
  ].join("\n");
}

function sourceRefFromText(id, version, content) {
  const text = String(content ?? "");
  return {
    id,
    version: String(version ?? "v1"),
    hash: sha256Text(text),
    excerpt: text.slice(0, 4000),
  };
}

function modelKnowledgeFromEvaluation(item, index) {
  const content = String(item.content ?? item.text ?? "");
  const sourceRefs =
    Array.isArray(item.sourceRefs) && item.sourceRefs.length
      ? item.sourceRefs
      : [
          sourceRefFromText(
            `${item.id ?? `knowledge-${index + 1}`}-source`,
            item.version,
            content,
          ),
        ];
  return {
    id: String(item.id ?? `knowledge-${index + 1}`),
    ...(item.revision === undefined ? {} : { revision: item.revision }),
    version: String(item.version ?? "v1"),
    hash: item.hash ?? sha256Text(content),
    content,
    sourceRefs,
    status: "active",
  };
}

function modelJudgmentFromEvaluation(
  item,
  index,
  targetVersion,
  conditionHash,
) {
  const reason = String(item.reason ?? item.rationale ?? "承認済み判断の根拠");
  return {
    id: String(item.id ?? `judgment-${index + 1}`),
    revision: Number.isInteger(item.revision) ? item.revision : index + 1,
    targetVersion: String(item.targetVersion ?? targetVersion),
    ...((item.conditionHash ?? conditionHash)
      ? { conditionHash: item.conditionHash ?? conditionHash }
      : {}),
    judgment: item.judgment ?? "accepted_known",
    reason,
    sourceRefs:
      Array.isArray(item.sourceRefs) && item.sourceRefs.length
        ? item.sourceRefs
        : [
            sourceRefFromText(
              `${item.id ?? `judgment-${index + 1}`}-source`,
              item.version,
              reason,
            ),
          ],
  };
}

export function evaluationInputToDiagnosticSnapshot(input) {
  const commit = String(input.target?.commit ?? "");
  assert(
    /^[a-f0-9]{40}$/.test(commit),
    "evaluation inputのcommitは40桁hexが必要です",
  );
  const path = normalizePath(input.code?.path);
  const content = String(input.code?.text ?? "");
  assert(path && !path.includes(".."), "evaluation inputのcode pathが不正です");
  const hash = sha256Text(content);
  return {
    commit,
    manifestHash: sha256Text(
      stableStringify({ commit, files: [{ path, hash }], omitted: [] }),
    ),
    files: [{ path, content, hash }],
    omitted: [],
  };
}

export function evaluationInputToModelReviewInput(
  input,
  { conditionHash } = {},
) {
  const currentConditionHash =
    input.conditionHash ??
    conditionHash ??
    sha256Text(stableStringify(input.specification ?? {}));
  const targetVersion = String(input.target?.commit ?? "");
  const specificationRefs = (input.specification?.requirements ?? []).map(
    (item, index) => {
      const content = String(item.content ?? item.text ?? "");
      return {
        id: String(item.id ?? `spec-${index + 1}`),
        version: String(item.version ?? input.specification.revision ?? "v1"),
        hash: item.hash ?? sha256Text(content),
        excerpt: String(item.excerpt ?? content).slice(0, 4000),
      };
    },
  );
  return {
    target: String(input.target?.productId ?? "evaluation-product"),
    targetVersion,
    purpose: String(
      input.task?.instruction ?? "固定source snapshotの静的レビュー",
    ),
    conditionHash: currentConditionHash,
    approvedKnowledge: (input.approvedKnowledge ?? []).map(
      modelKnowledgeFromEvaluation,
    ),
    pastJudgments: (input.approvedDecisionHistory ?? []).map((item, index) =>
      modelJudgmentFromEvaluation(
        item,
        index,
        targetVersion,
        currentConditionHash,
      ),
    ),
    fixedFindings: [],
    specificationRefs,
  };
}

/**
 * Existing production contract adapter.  It delegates every review to the
 * supplied reviewSnapshot implementation and captures its injected prompt and
 * provider response without reimplementing the product review engine.
 */
export function createReviewSnapshotEngine({
  reviewSnapshot,
  provider,
  invoke,
  conditionHashForInput,
  batchSize = 1,
} = {}) {
  assert(typeof reviewSnapshot === "function", "reviewSnapshotが必要です");
  assert(typeof invoke === "function", "production model invokeが必要です");
  return {
    contractVersion: ENGINE_OUTPUT_CONTRACT,
    model: provider?.model ?? null,
    async review(input, context = {}) {
      const snapshot = evaluationInputToDiagnosticSnapshot(input);
      const reviewInput = evaluationInputToModelReviewInput(input, {
        conditionHash: conditionHashForInput?.(input, context),
      });
      const prompts = [];
      const invocations = [];
      try {
        const result = await reviewSnapshot(snapshot, reviewInput, {
          provider,
          batchSize,
          signal: context.signal,
          maxBudget: {
            maxBatches: 1,
            maxFiles: 1,
            maxInputChars: Math.max(1, input.code.text.length + 10_000),
            maxBatchChars: Math.max(1, input.code.text.length + 10_000),
            maxOutputTokens: context.budget?.maxOutputTokens ?? 2048,
          },
          invoke: async (prompt, signal, maxOutputTokens, batch) => {
            prompts.push(prompt);
            const invocation = await invoke(
              prompt,
              signal,
              maxOutputTokens,
              batch,
              context,
            );
            invocations.push(invocation);
            return invocation;
          },
        });
        return {
          findings: result.findings,
          requiresHumanConfirmation: result.findings.length > 0,
          // reviewSnapshot currently has no persisted recheck-queue field. Keep
          // this unavailable instead of inferring a queue decision from a
          // finding's pastJudgmentIds.
          recheckPriorDecision: result.recheckPriorDecision ?? null,
          prompt: prompts.join("\n---MODEL-REVIEW-BATCH---\n"),
          rawResponse: invocations,
          model: result.report.model,
          usage: {
            inputTokens: result.report.used.promptTokens ?? null,
            outputTokens: result.report.used.completionTokens ?? null,
          },
          report: result.report,
          coverage: result.coverage,
        };
      } catch (error) {
        // Production validation errors are still evidence. Attach the prompt
        // and every successful provider invocation before rethrowing so the
        // runner records a failed observation instead of erasing its cause.
        const enriched =
          error instanceof Error ? error : new Error(String(error));
        enriched.prompt = prompts.join("\n---MODEL-REVIEW-BATCH---\n");
        enriched.rawResponse = invocations;
        enriched.model = provider?.model ?? null;
        const promptTokens = invocations
          .map((item) => item?.promptTokens ?? item?.usage?.promptTokens)
          .filter((value) => Number.isFinite(Number(value)))
          .reduce((sum, value) => sum + Number(value), 0);
        const outputTokens = invocations
          .map(
            (item) => item?.completionTokens ?? item?.usage?.completionTokens,
          )
          .filter((value) => Number.isFinite(Number(value)))
          .reduce((sum, value) => sum + Number(value), 0);
        enriched.usage = {
          inputTokens: promptTokens || null,
          outputTokens: outputTokens || null,
        };
        throw enriched;
      }
    },
  };
}

function validateIdentityEntry(entry, location) {
  assert(isRecord(entry), `${location}が必要です`);
  assertString(entry.label, `${location}.labelが必要です`);
  assertSourcePath(entry.source_path, `${location}.source_pathが不正です`);
  assertString(entry.source_revision, `${location}.source_revisionが必要です`);
  assertSha(entry.source_sha256, `${location}.source_sha256が不正です`);
  assertSha(entry.input_sha256, `${location}.input_sha256が不正です`);
}

export function validateManifest(manifest) {
  assert(isRecord(manifest), "manifestがobjectである必要があります");
  assert(manifest.schema_version === "1.1", "schema_versionは1.1が必要です");
  assert(manifest.profile === "workflow", "profileはworkflowが必要です");
  assertString(manifest.manifest_id, "manifest_idが必要です");
  assertString(manifest.task_id, "task_idが必要です");
  assertString(manifest.owner, "ownerが必要です");
  assert(manifest.purpose === "comparison", "purposeはcomparisonが必要です");
  assert(
    manifest.status === "frozen",
    "評価前のmanifestはstatus=frozenが必要です",
  );
  assertString(manifest.freeze_date, "freeze_dateが必要です");
  assertString(manifest.hypothesis, "hypothesisが必要です");
  assertString(manifest.action_delta, "action_deltaが必要です");
  assertString(manifest.negative_control, "negative_controlが必要です");
  assert(isRecord(manifest.identity), "identityが必要です");
  validateIdentityEntry(manifest.identity.legacy, "identity.legacy");
  validateIdentityEntry(manifest.identity.candidate, "identity.candidate");
  assert(isRecord(manifest.identity.runner), "identity.runnerが必要です");
  assertString(manifest.identity.runner.id, "identity.runner.idが必要です");
  assertSha(
    manifest.identity.runner.sha256,
    "identity.runner.sha256が不正です",
  );
  for (const identityName of ["engine", "adapter", "provider"]) {
    if (manifest.identity[identityName] !== undefined) {
      validateIdentityEntry(
        manifest.identity[identityName],
        `identity.${identityName}`,
      );
    }
  }
  assert(isRecord(manifest.evaluation), "evaluationが必要です");
  assertString(
    manifest.evaluation.dataset_id,
    "evaluation.dataset_idが必要です",
  );
  assertSha(
    manifest.evaluation.dataset_sha256,
    "evaluation.dataset_sha256が不正です",
  );
  assert(
    manifest.evaluation.measurement_unit === "task",
    "measurement_unitはtaskが必要です",
  );
  assertString(manifest.evaluation.primary_metric, "primary_metricが必要です");
  assertString(manifest.evaluation.model_version, "model_versionが必要です");
  assertString(manifest.evaluation.policy_version, "policy_versionが必要です");
  const configuration = manifest.evaluation.configuration;
  assert(isRecord(configuration), "evaluation.configurationが必要です");
  assert(
    Array.isArray(configuration.conditions) &&
      configuration.conditions.length === 3,
    "conditionsはA/B/C全件が必要です",
  );
  for (const condition of CONDITIONS) {
    assert(
      configuration.conditions.includes(condition),
      `condition ${condition}が不足しています`,
    );
  }
  assert(
    Array.isArray(configuration.splits) &&
      configuration.splits.includes("development") &&
      configuration.splits.includes("holdout"),
    "development/holdout splitが必要です",
  );
  assertInteger(configuration.repetitions, "repetitionsが必要です", { min: 2 });
  assert(
    configuration.tuning_split === "development",
    "tuning_splitはdevelopmentが必要です",
  );
  assert(
    configuration.final_test_split === "holdout",
    "final_test_splitはholdoutが必要です",
  );
  assert(
    configuration.matching === "path+category+location",
    "matching方式が不正です",
  );
  assert(isRecord(configuration.budget), "budgetが必要です");
  for (const key of ["maxDurationMs", "maxInputTokens", "maxOutputTokens"]) {
    assertInteger(configuration.budget[key], `budget.${key}が必要です`, {
      min: 1,
    });
  }
  assert(
    isRecord(configuration.condition_input_sha256),
    "condition_input_sha256が必要です",
  );
  for (const condition of CONDITIONS) {
    assertSha(
      configuration.condition_input_sha256[condition],
      `condition_input_sha256.${condition}が不正です`,
    );
  }
  assert(isRecord(manifest.external_mutations), "external_mutationsが必要です");
  assert(
    manifest.external_mutations.registry_frozen === true,
    "registry_frozen=trueが必要です",
  );
  assert(
    manifest.external_mutations.submission_frozen === true,
    "submission_frozen=trueが必要です",
  );
  return manifest;
}

export async function preflightManifest(
  manifest,
  corpus,
  { runnerPath = thisFile } = {},
) {
  validateManifest(manifest);
  const normalizedCorpus = validateCorpus(corpus);
  const datasetHash = corpusDatasetHash(normalizedCorpus);
  assert(
    manifest.evaluation.dataset_sha256 === datasetHash,
    "manifestのdataset_sha256がcorpusと一致しません",
  );
  for (const name of ["legacy", "candidate", "engine", "adapter", "provider"]) {
    const identity = manifest.identity[name];
    if (!identity) continue;
    assert(
      identity.input_sha256 === datasetHash,
      `manifestの${name} input hashがcorpusと一致しません`,
    );
  }
  for (const condition of CONDITIONS) {
    assert(
      manifest.evaluation.configuration.condition_input_sha256[condition] ===
        conditionInputHash(normalizedCorpus, condition),
      `manifestの${condition} input hashがcorpusと一致しません`,
    );
  }
  if (runnerPath && existsSync(runnerPath)) {
    const sourceHash = prefixedSha256(
      sha256Text(await readFile(runnerPath, "utf8")),
    );
    assert(
      manifest.identity.runner.sha256 === sourceHash,
      "manifestのrunner hashが実ファイルと一致しません",
    );
  }
  for (const identityName of ["engine", "adapter", "provider"]) {
    const identity = manifest.identity[identityName];
    if (!identity) continue;
    const sourcePath = resolve(
      dirname(runnerPath ?? thisFile),
      "..",
      identity.source_path,
    );
    assert(
      existsSync(sourcePath),
      `manifestの${identityName} source fileが存在しません`,
    );
    const sourceHash = prefixedSha256(
      sha256Text(await readFile(sourcePath, "utf8")),
    );
    assert(
      identity.source_sha256 === sourceHash,
      `manifestの${identityName} hashが実ファイルと一致しません`,
    );
  }
  return {
    ok: true,
    manifestId: manifest.manifest_id,
    datasetSha256: datasetHash,
    conditionInputSha256: Object.fromEntries(
      CONDITIONS.map((condition) => [
        condition,
        conditionInputHash(normalizedCorpus, condition),
      ]),
    ),
  };
}

function repositoryRootForRunner(runnerPath) {
  return resolve(dirname(resolve(runnerPath ?? thisFile)), "..");
}

function portableSourcePath(sourceRoot, sourcePath) {
  return relative(sourceRoot, sourcePath).replaceAll("\\", "/");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Copy the exact production inputs read by the model-review run before the
 * first engine call.  The manifest identity is checked again while copying;
 * this keeps a run from silently mixing a frozen manifest with another local
 * bundle.  The hash list has no timestamps or absolute paths so it is stable
 * and portable evidence.
 */
export async function captureSourceBundle({
  outputDir,
  manifest,
  runnerPath = thisFile,
  entries = SOURCE_BUNDLE_ENTRIES,
} = {}) {
  assert(outputDir, "source bundleにはoutputDirが必要です");
  const sourceRoot = repositoryRootForRunner(runnerPath);
  const resolvedRunnerPath = resolve(runnerPath);
  const sourceBundleDir = resolve(outputDir, "source-bundle");
  await mkdir(sourceBundleDir, { recursive: true });
  const files = [];
  for (const entry of entries) {
    const identity = entry.identityRole
      ? manifest?.identity?.[entry.identityRole]
      : null;
    if (entry.identityRole) {
      assert(
        isRecord(identity),
        `source bundleのmanifest identityがありません: ${entry.identityRole}`,
      );
    }
    const sourcePath = entry.identityRole === "runner"
      ? resolvedRunnerPath
      : resolve(sourceRoot, identity?.source_path ?? entry.sourcePath);
    assert(
      existsSync(sourcePath),
      `source bundleの実ファイルがありません: ${portableSourcePath(sourceRoot, sourcePath)}`,
    );
    const bytes = await readFile(sourcePath);
    const sourceSha256 = prefixedSha256(sha256Bytes(bytes));
    if (identity) {
      const expectedSourceSha256 =
        identity.source_sha256 ?? identity.sha256;
      assert(
        expectedSourceSha256 === sourceSha256,
        `source bundleの${entry.identityRole} hashがmanifestと一致しません`,
      );
    }
    const bundlePath = resolve(sourceBundleDir, entry.bundlePath);
    await mkdir(dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, bytes);
    const bundleSha256 = prefixedSha256(
      sha256Bytes(await readFile(bundlePath)),
    );
    assert(
      sourceSha256 === bundleSha256,
      `source bundleのコピーhashが一致しません: ${entry.role}`,
    );
    files.push({
      role: entry.role,
      source_path: portableSourcePath(sourceRoot, sourcePath),
      bundle_path: `source-bundle/${entry.bundlePath}`,
      source_sha256: sourceSha256,
      bundle_sha256: bundleSha256,
      bytes: bytes.length,
    });
  }
  const hashes = {
    schema_version: "1.0",
    files,
  };
  const hashesPath = resolve(sourceBundleDir, "hashes.json");
  await writeFile(hashesPath, `${JSON.stringify(hashes, null, 2)}\n`, "utf8");
  const hashesSha256 = prefixedSha256(
    sha256Bytes(await readFile(hashesPath)),
  );
  return {
    path: "source-bundle",
    hashesPath: "source-bundle/hashes.json",
    hashesSha256,
    files,
  };
}

export function resolveUsage(value) {
  if (!isRecord(value)) return null;
  const inputTokens =
    value.inputTokens ?? value.promptTokens ?? value.input_tokens;
  const outputTokens =
    value.outputTokens ?? value.completionTokens ?? value.output_tokens;
  const count = (tokenCount) =>
    typeof tokenCount === "number" &&
    Number.isSafeInteger(tokenCount) &&
    tokenCount >= 0
      ? tokenCount
      : null;
  return {
    inputTokens: count(inputTokens),
    outputTokens: count(outputTokens),
    totalTokens: count(value.totalTokens ?? value.total_tokens),
  };
}

function usageBudgetViolations(usage, budget) {
  if (!usage) return [];
  const violations = [];
  if (usage.inputTokens !== null && usage.inputTokens > budget.maxInputTokens) {
    violations.push({
      field: "inputTokens",
      actual: usage.inputTokens,
      maximum: budget.maxInputTokens,
    });
  }
  if (
    usage.outputTokens !== null &&
    usage.outputTokens > budget.maxOutputTokens
  ) {
    violations.push({
      field: "outputTokens",
      actual: usage.outputTokens,
      maximum: budget.maxOutputTokens,
    });
  }
  return violations;
}

function timeoutError(duration) {
  const error = new Error(`model review timeout after ${duration}ms`);
  error.code = "MODEL_REVIEW_TIMEOUT";
  return error;
}

async function invokeWithTimeout(engine, input, context, timeoutMs) {
  assert(
    engine && typeof engine.review === "function",
    "modelReviewEngine.review(input, context)が必要です",
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(timeoutError(timeoutMs)),
    timeoutMs,
  );
  try {
    return await Promise.race([
      Promise.resolve(
        engine.review(input, { ...context, signal: controller.signal }),
      ),
      new Promise((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason ?? timeoutError(timeoutMs)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function elapsedMilliseconds(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function resultRecordBase({
  runId,
  testCase,
  condition,
  repetition,
  input,
  prompt,
  startedAt,
}) {
  return {
    runId,
    caseId: testCase.id,
    split: testCase.split,
    condition,
    repetition,
    target: structuredClone(testCase.source),
    input,
    prompt,
    startedAt,
  };
}

function incompleteReviewStatus(envelope) {
  if (!isRecord(envelope)) return null;
  const statuses = [
    [envelope.coverage, "coverage"],
    [envelope.report, "report"],
  ];
  for (const [value, source] of statuses) {
    if (!isRecord(value)) continue;
    const status =
      typeof value.status === "string" ? value.status.toLowerCase() : "";
    if (["partial", "stopped", "unavailable"].includes(status)) {
      return { status, source };
    }
  }
  return null;
}

export async function runEvaluation({
  corpus,
  manifest,
  engine,
  outputDir,
  runId = `model-review-${Date.now()}`,
  split = "holdout",
  conditions = CONDITIONS,
  repetitions = manifest?.evaluation?.configuration?.repetitions,
  now = () => Date.now(),
  runnerPath = thisFile,
} = {}) {
  assert(
    outputDir,
    "outputDirが必要です。raw artifact保存先を明示してください",
  );
  const normalizedCorpus = validateCorpus(corpus);
  // preflightをengine呼出しより前に実行し、未凍結条件で測定を始めない。
  await preflightManifest(manifest, normalizedCorpus, { runnerPath });
  normalizeSplit(split);
  assert(
    Array.isArray(conditions) && conditions.length > 0,
    "conditionsは1件以上の配列が必要です",
  );
  assert(
    new Set(conditions).size === conditions.length,
    "conditionsに重複があります",
  );
  const manifestConditions = manifest.evaluation.configuration.conditions;
  for (const condition of conditions) {
    assert(
      manifestConditions.includes(condition),
      `manifestで許可されていないcondition: ${condition}`,
    );
    conditionIndex(condition);
  }
  assertInteger(repetitions, "repetitionsが必要です", { min: 2 });
  assert(
    repetitions === manifest.evaluation.configuration.repetitions,
    "repetitionsはmanifestの固定値と一致する必要があります",
  );
  assert(
    manifest.evaluation.configuration.splits.includes(split),
    `manifestに${split}がありません`,
  );
  assert(
    !existsSync(outputDir) || (await readdir(outputDir)).length === 0,
    "出力先が存在し、空ではありません。既存artifactを上書きしないでください",
  );
  await mkdir(outputDir, { recursive: true });
  // Capture all runtime source inputs before the first model invocation.  A
  // missing or mismatched bundle therefore stops the run without a record.
  const sourceBundle = await captureSourceBundle({
    outputDir,
    manifest,
    runnerPath,
  });
  const goldByCase = normalizedCorpus.goldBySplit[split];
  const cases = orderedCases(normalizedCorpus.cases[split]);
  const records = [];
  const budget = {
    ...DEFAULT_BUDGET,
    ...manifest.evaluation.configuration.budget,
  };
  for (const condition of conditions) {
    for (const testCase of cases) {
      const input = buildReviewInput(
        testCase,
        condition,
        normalizedCorpus.product,
      );
      const runnerPrompt = buildPrompt(input);
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const startedAt = nowIso(now);
        const start = process.hrtime.bigint();
        const record = resultRecordBase({
          runId,
          testCase,
          condition,
          repetition,
          input,
          prompt: runnerPrompt,
          startedAt,
        });
        try {
          const response = await invokeWithTimeout(
            engine,
            input,
            {
              runId,
              caseId: testCase.id,
              split,
              condition,
              repetition,
              budget,
              contractVersion: ENGINE_INPUT_CONTRACT,
            },
            budget.maxDurationMs,
          );
          const normalized = normalizeReviewOutput(response);
          const envelope = isRecord(response) ? response : {};
          const incomplete = incompleteReviewStatus(envelope);
          record.status = normalized.valid
            ? (incomplete?.status ?? "completed")
            : "error";
          record.normalized = normalized;
          record.rawResponse = normalized.rawResponse;
          record.coverage = envelope.coverage ?? null;
          record.report = envelope.report ?? null;
          record.prompt =
            typeof envelope.prompt === "string"
              ? envelope.prompt
              : (normalized.prompt ?? runnerPrompt);
          record.model =
            envelope.model ?? normalized.model ?? engine.model ?? null;
          record.usage = resolveUsage(envelope.usage ?? normalized.usage);
          const budgetViolations = usageBudgetViolations(record.usage, budget);
          record.budgetCheck = {
            maxInputTokens: budget.maxInputTokens,
            maxOutputTokens: budget.maxOutputTokens,
            violations: budgetViolations,
          };
          record.failure = normalized.valid
            ? incomplete
              ? {
                  type: "incomplete-review",
                  status: incomplete.status,
                  source: incomplete.source,
                  message: `${incomplete.source} status=${incomplete.status}のため未採点`,
                }
              : null
            : { type: "invalid-output", message: normalized.error };
          if (budgetViolations.length > 0) {
            record.status = "error";
            record.failure = {
              type: "budget-exceeded",
              message: "実測token usageがmanifest budgetを超えました",
              violations: budgetViolations,
            };
          }
        } catch (error) {
          const isTimeout =
            error?.code === "MODEL_REVIEW_TIMEOUT" ||
            error?.name === "AbortError";
          record.status = isTimeout ? "timeout" : "error";
          record.prompt =
            typeof error?.prompt === "string" ? error.prompt : record.prompt;
          record.rawResponse = error?.rawResponse ?? null;
          record.coverage = error?.coverage ?? null;
          record.report = error?.report ?? null;
          record.model = error?.model ?? engine.model ?? null;
          record.usage = resolveUsage(error?.usage);
          const budgetViolations = usageBudgetViolations(record.usage, budget);
          record.budgetCheck = {
            maxInputTokens: budget.maxInputTokens,
            maxOutputTokens: budget.maxOutputTokens,
            violations: budgetViolations,
          };
          record.failure = {
            type: isTimeout ? "timeout" : "engine-error",
            message: error instanceof Error ? error.message : String(error),
            name: error instanceof Error ? error.name : "Error",
          };
          if (budgetViolations.length > 0) {
            record.failure = {
              type: "budget-exceeded",
              message: "実測token usageがmanifest budgetを超えました",
              violations: budgetViolations,
              causeType: record.failure.type,
            };
          }
        }
        record.elapsedMs = elapsedMilliseconds(start);
        record.completedAt = nowIso(now);
        records.push(record);
      }
    }
  }
  const metrics = calculateMetrics(records, goldByCase);
  const errorCount = records.filter(
    (record) => record.status === "error",
  ).length;
  const timeoutCount = records.filter(
    (record) => record.status === "timeout",
  ).length;
  const partialCount = records.filter((record) =>
    ["partial", "stopped", "unavailable"].includes(record.status),
  ).length;
  const status =
    errorCount + timeoutCount + partialCount === 0 ? "completed" : "failed";
  const artifact = {
    artifactVersion: "model-review-evaluation/v1",
    runId,
    manifestId: manifest.manifest_id,
    status,
    split,
    conditions: [...conditions],
    repetitions,
    records: records.length,
    error_count: errorCount,
    crash_count: 0,
    timeout_count: timeoutCount,
    partial_count: partialCount,
    budget_violation_count: records.filter(
      (record) => record.failure?.type === "budget-exceeded",
    ).length,
    metrics,
    modelVersions: [
      ...new Set(records.map((record) => record.model).filter(Boolean)),
    ].sort(),
    generatedAt: nowIso(now),
    source: {
      runnerId: RUNNER_ID,
      datasetSha256: manifest.evaluation.dataset_sha256,
      inputSha256: Object.fromEntries(
        conditions.map((condition) => [
          condition,
          manifest.evaluation.configuration.condition_input_sha256[condition],
        ]),
      ),
      sourceBundlePath: sourceBundle.path,
      sourceBundleHashesPath: sourceBundle.hashesPath,
      sourceBundleHashesSha256: sourceBundle.hashesSha256,
    },
    measurementNotes: [
      "humanConfirmationCountは実レビュー時間ではなく、モデルが要人確認を要求したtask/repetition数のproxyです。",
      "error/timeout/partial/stopped/unavailableはFNへ変換せず未採点として集計し、evaluationRateとgoldEvaluationRateを必ず併記します。",
      "未採点率が0でないartifactから改善を主張してはいけません。",
      "改善の主張はこのartifactだけでは行わず、developmentで調整した後のholdout最終結果を別途確認します。",
    ],
  };
  const artifactPath = resolve(outputDir, "artifact.json");
  const recordsPath = resolve(outputDir, "records.jsonl");
  const manifestPath = resolve(outputDir, "manifest.json");
  const summaryPath = resolve(outputDir, "summary.json");
  await writeFile(
    recordsPath,
    records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    "utf8",
  );
  await writeFile(
    artifactPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const artifactSha256 = prefixedSha256(
    sha256Text(await readFile(artifactPath, "utf8")),
  );
  const summary = {
    ...artifact,
    artifact_path: "artifact.json",
    artifact_sha256: artifactSha256,
    records_path: "records.jsonl",
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return {
    ...summary,
    outputDir: resolve(outputDir),
    records,
    artifact,
  };
}

export async function loadCorpus(rootDir = defaultCorpusDir) {
  const corpus = {
    corpusVersion: "model-review-corpus/v1",
    product: await readJson(resolve(rootDir, "product.json")),
    cases: {
      development: await readJson(
        resolve(rootDir, "cases", "development.json"),
      ),
      holdout: await readJson(resolve(rootDir, "cases", "holdout.json")),
    },
    gold: {
      development: await readJson(resolve(rootDir, "gold", "development.json")),
      holdout: await readJson(resolve(rootDir, "gold", "holdout.json")),
    },
  };
  return validateCorpus(corpus);
}

async function loadEngine(modulePath) {
  const imported = await import(pathToFileURL(resolve(modulePath)).href);
  const engine = imported.modelReviewEngine ?? imported.default ?? imported;
  assert(
    engine && typeof engine.review === "function",
    "engine moduleはmodelReviewEngine.reviewをexportしてください",
  );
  return engine;
}

async function main() {
  const { values } = parseArgs({
    options: {
      engine: { type: "string" },
      manifest: {
        type: "string",
        default: resolve(defaultCorpusDir, "manifest.json"),
      },
      corpus: { type: "string", default: defaultCorpusDir },
      output: { type: "string" },
      split: { type: "string", default: "holdout" },
      conditions: { type: "string" },
      "run-id": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/model-review-evaluation.mjs --engine <engine.mjs> --manifest <frozen.json> --output <new-directory> [--split development|holdout] [--conditions A,B,C]",
    );
    return;
  }
  assert(
    values.engine,
    "--engineが必要です。製品のmodel-review exported contractを指定してください",
  );
  assert(
    values.output,
    "--outputが必要です。raw artifactの保存先を指定してください",
  );
  const corpus = await loadCorpus(values.corpus);
  const manifest = await readJson(values.manifest);
  const engine = await loadEngine(values.engine);
  const result = await runEvaluation({
    corpus,
    manifest,
    engine,
    outputDir: values.output,
    split: values.split,
    conditions: values.conditions
      ? values.conditions
          .split(",")
          .map((condition) => condition.trim())
          .filter(Boolean)
      : CONDITIONS,
    runId: values["run-id"],
  });
  console.log(
    JSON.stringify(
      {
        runId: result.runId,
        status: result.status,
        split: result.split,
        records: result.records.length,
        metrics: result.metrics,
        outputDir: result.outputDir,
        artifactSha256: result.artifact_sha256,
      },
      null,
      2,
    ),
  );
  process.exitCode = result.status === "completed" ? 0 : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
