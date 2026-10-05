import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// This module deliberately imports the production bundle.  The queue result
// must come from the same exported helper used by the application, rather than
// from a test-only suppression implementation.
const productionDomain = await import("../dist/server/workflow-domain.js");
const {
  applyWorkflowCommand,
  evaluateFindingSuppression,
  hashFindingEvidence,
  hashFindingReviewContext,
  newWorkflow,
} = productionDomain;

export const QUEUE_RUNNER_ID = "review-queue-evaluation/v1";
export const QUEUE_CONDITIONS = Object.freeze(["B", "C"]);
export const QUEUE_PRIMARY_METRIC = "queue_reduction_rate";
const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), "..");
const defaultCorpusDir = resolve(repoRoot, "evaluations/review-queue");
const defaultHelperPath = resolve(repoRoot, "dist/server/workflow-domain.js");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

export function prefixedSha256(value) {
  return `sha256:${value}`;
}

export function sha256Json(value) {
  return prefixedSha256(sha256Text(stableStringify(value)));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function orderedCases(cases) {
  return [...cases].sort((left, right) => left.caseId.localeCompare(right.caseId));
}

function validateCorpus(corpus) {
  assert(isRecord(corpus.product), "queue productが必要です");
  assert(Array.isArray(corpus.cases), "queue casesが必要です");
  assert(Array.isArray(corpus.gold), "queue goldが必要です");
  const caseIds = new Set(corpus.cases.map((item) => item.caseId));
  assert(caseIds.size === corpus.cases.length, "queue caseIdが重複しています");
  const goldByCase = new Map();
  for (const item of corpus.gold) {
    assert(caseIds.has(item.caseId), `goldにないcaseです: ${item.caseId}`);
    assert(!goldByCase.has(item.caseId), `gold caseIdが重複しています: ${item.caseId}`);
    for (const condition of QUEUE_CONDITIONS) {
      const expected = item[`expected${condition}`];
      assert(
        isRecord(expected) &&
          typeof expected.reusable === "boolean" &&
          typeof expected.status === "string" &&
          typeof expected.reason === "string",
        `goldの${item.caseId}/${condition}が不正です`,
      );
    }
    goldByCase.set(item.caseId, item);
  }
  assert(goldByCase.size === caseIds.size, "goldとcaseの件数が一致しません");
  for (const item of corpus.cases) {
    assert(typeof item.variant === "string" && item.variant.length > 0, `${item.caseId} variantが必要です`);
    assert(goldByCase.has(item.caseId), `goldがありません: ${item.caseId}`);
  }
  return { ...corpus, cases: orderedCases(corpus.cases), goldByCase };
}

export async function loadQueueCorpus(rootDir = defaultCorpusDir) {
  const root = resolve(rootDir);
  const product = await readJson(resolve(root, "product.json"));
  return validateCorpus({
    corpusVersion: product.corpusVersion ?? "review-queue-corpus/v1",
    product,
    cases: (await readJson(resolve(root, "cases.json"))).cases,
    gold: (await readJson(resolve(root, "gold.json"))).cases,
  });
}

export function queueCorpusHash(corpus) {
  return sha256Json({
    corpusVersion: corpus.corpusVersion,
    product: corpus.product,
    cases: corpus.cases,
    gold: corpus.gold,
  });
}

function prefixedFileHash(path) {
  return prefixedSha256(sha256Text(requireRead(path)));
}

function requireRead(path) {
  // This synchronous helper is used only during preflight, where source
  // identity must be checked before any fixture evaluation starts.
  return readFileSync(path, "utf8");
}

function validateIdentity(identity, label) {
  assert(isRecord(identity), `${label} identityが必要です`);
  for (const field of ["label", "source_path", "source_revision", "source_sha256", "input_sha256"]) {
    assert(typeof identity[field] === "string" && identity[field].length > 0, `${label}.${field}が必要です`);
  }
  assert(/^sha256:[a-f0-9]{64}$/.test(identity.source_sha256), `${label}.source_sha256が不正です`);
  assert(/^sha256:[a-f0-9]{64}$/.test(identity.input_sha256), `${label}.input_sha256が不正です`);
}

export function validateQueueManifest(manifest) {
  assert(isRecord(manifest), "queue manifestがobjectである必要があります");
  assert(manifest.schema_version === "1.1", "queue manifest schema_versionは1.1が必要です");
  assert(manifest.profile === "workflow", "queue manifest profileはworkflowが必要です");
  assert(typeof manifest.manifest_id === "string" && manifest.manifest_id.startsWith("eval:"), "queue manifest_idが不正です");
  assert(manifest.status === "frozen", "queue評価前のmanifestはstatus=frozenが必要です");
  assert(manifest.purpose === "comparison", "queue manifest purposeはcomparisonが必要です");
  assert(isRecord(manifest.identity), "queue identityが必要です");
  validateIdentity(manifest.identity.legacy, "identity.legacy");
  validateIdentity(manifest.identity.candidate, "identity.candidate");
  assert(isRecord(manifest.identity.runner), "identity.runnerが必要です");
  assert(typeof manifest.identity.runner.id === "string", "identity.runner.idが必要です");
  assert(/^sha256:[a-f0-9]{64}$/.test(manifest.identity.runner.sha256), "identity.runner.sha256が不正です");
  assert(isRecord(manifest.identity.production_helper), "identity.production_helperが必要です");
  assert(
    /^sha256:[a-f0-9]{64}$/.test(manifest.identity.production_helper.source_sha256),
    "production helper hashが不正です",
  );
  assert(isRecord(manifest.evaluation), "queue evaluationが必要です");
  assert(manifest.evaluation.measurement_unit === "task", "queue measurement_unitはtaskが必要です");
  assert(manifest.evaluation.primary_metric === QUEUE_PRIMARY_METRIC, "queue primary metricが不正です");
  assert(typeof manifest.evaluation.dataset_sha256 === "string", "queue dataset hashが必要です");
  const configuration = manifest.evaluation.configuration;
  assert(isRecord(configuration), "queue configurationが必要です");
  assert(
    Array.isArray(configuration.conditions) &&
      configuration.conditions.length === QUEUE_CONDITIONS.length &&
      QUEUE_CONDITIONS.every((condition) => configuration.conditions.includes(condition)),
    "queue conditionsはB/C固定です",
  );
  assert(configuration.queue_definition === "!productionEvaluation.reusable", "queue定義が不正です");
  assert(configuration.raw_candidate_required === true, "raw candidate保存を必須にしてください");
  assert(manifest.external_mutations?.registry_frozen === true, "registry_frozen=trueが必要です");
  assert(manifest.external_mutations?.submission_frozen === true, "submission_frozen=trueが必要です");
  return manifest;
}

export function preflightQueueManifest(
  manifest,
  corpus,
  { runnerPath = thisFile, helperPath = defaultHelperPath } = {},
) {
  validateQueueManifest(manifest);
  const datasetHash = queueCorpusHash(corpus);
  assert(manifest.evaluation.dataset_sha256 === datasetHash, "queue dataset hashが一致しません");
  const runnerHash = prefixedFileHash(resolve(runnerPath));
  assert(manifest.identity.runner.sha256 === runnerHash, "queue runner hashが一致しません");
  const helperHash = prefixedFileHash(resolve(helperPath));
  assert(
    manifest.identity.production_helper.source_sha256 === helperHash,
    "production helper bundle hashが一致しません",
  );
  for (const role of ["legacy", "candidate", "production_helper"]) {
    const identity = manifest.identity[role];
    assert(identity.input_sha256 === datasetHash, `${role}.input_sha256がdatasetと一致しません`);
  }
  return {
    ok: true,
    manifestId: manifest.manifest_id,
    datasetSha256: datasetHash,
    runnerSha256: runnerHash,
    productionHelperSha256: helperHash,
  };
}

function apply(state, command) {
  return applyWorkflowCommand(state, command);
}

function renameEntityId(state, collection, oldId, newId) {
  for (const item of state[collection]) {
    if (item.id === oldId) item.id = newId;
  }
  for (const event of state.events) {
    if (event.entityId === oldId) event.entityId = newId;
  }
}

function canonicalizeTimes(state, timestamp) {
  for (const event of state.events) event.at = timestamp;
  for (const finding of state.findings) {
    finding.observedAt = timestamp;
    for (const observation of finding.observationHistory) observation.observedAt = timestamp;
    for (const decision of finding.decisions) decision.at = timestamp;
  }
  for (const query of state.queries) query.at = timestamp;
}

function contentHash(value) {
  return sha256Text(value);
}

function contextFor(product, state) {
  const pastJudgments = state.findings.flatMap((finding) => {
    if (finding.id === product.candidate.findingId) return [];
    if (finding.judgment === "unconfirmed") return [];
    const decision = finding.decisions.at(-1);
    if (
      !decision ||
      decision.targetVersion !== state.scope.version ||
      decision.sourceRefs.length === 0
    )
      return [];
    return [
      {
        findingId: finding.id,
        revision: decision.revision,
        targetVersion: decision.targetVersion,
        judgment: decision.judgment,
        reason: decision.reason,
        sourceRefs: decision.sourceRefs,
      },
    ];
  });
  return {
    targetVersion: state.scope.version,
    purpose: state.scope.purpose,
    specificationRevision: product.specification.revision,
    specificationHash: contentHash(product.specification.text),
    knowledge: state.knowledge
      .filter((item) => item.status === "active")
      .map((item) => ({
        id: item.id,
        revision: item.revision,
        contentHash: contentHash(item.content),
        sourceRefs: item.sourceRefs,
      })),
    rules: state.rules
      .filter(
        (item) =>
          item.status === "active" && item.appliesToVersion === state.scope.version,
      )
      .map((item) => ({
        id: item.id,
        revision: item.revision,
        contentHash: contentHash(item.content),
        appliesToVersion: item.appliesToVersion,
        sourceRefs: item.sourceRefs,
      })),
    pastJudgments,
  };
}

function evidenceInput(candidate) {
  return {
    engine: candidate.engine,
    ruleId: candidate.ruleId,
    title: candidate.title,
    severity: candidate.severity,
    path: candidate.path,
    evidence: candidate.evidence,
    remediation: candidate.remediation,
    advisoryUrl: candidate.advisoryUrl ?? undefined,
  };
}

function buildBaseFixture(product) {
  let state = newWorkflow(product.projectId, product.scope);
  state = apply(state, {
    type: "document",
    value: {
      title: product.document.title,
      body: product.document.body,
      classification: product.document.classification,
    },
  });
  const generatedDocument = state.documents.at(-1);
  assert(generatedDocument, "fixture documentが作成されませんでした");
  renameEntityId(state, "documents", generatedDocument.id, product.document.id);
  const sourceRef = {
    docId: product.document.id,
    revision: 1,
    excerpt: product.document.excerpt,
  };
  state = apply(state, {
    type: "knowledge-draft",
    purpose: product.scope.purpose,
    content: product.knowledge.content,
    sourceRefs: [sourceRef],
    origin: "manual",
  });
  const generatedKnowledge = state.knowledge.at(-1);
  assert(generatedKnowledge, "fixture knowledgeが作成されませんでした");
  renameEntityId(state, "knowledge", generatedKnowledge.id, product.knowledge.id);
  state = apply(state, {
    type: "knowledge-review",
    knowledgeId: product.knowledge.id,
    decision: "active",
    actor: "fixture-reviewer",
    reason: "承認済みfixture知識",
  });
  state = apply(state, {
    type: "rule-draft",
    purpose: product.scope.purpose,
    content: product.rule.content,
    applicability: product.rule.applicability,
    appliesToVersion: product.scope.version,
    sourceRefs: [sourceRef],
  });
  const generatedRule = state.rules.at(-1);
  assert(generatedRule, "fixture ruleが作成されませんでした");
  renameEntityId(state, "rules", generatedRule.id, product.rule.id);
  state = apply(state, {
    type: "rule-review",
    ruleId: product.rule.id,
    decision: "active",
    actor: "fixture-reviewer",
    reason: "承認済みfixture基準",
  });
  if (product.contextFinding) {
    state = apply(state, {
      type: "finding-observation",
      findingId: product.contextFinding.findingId,
      fingerprint: product.contextFinding.fingerprint,
      targetVersion: product.scope.version,
      observation: product.contextFinding.observation,
      sourceRefs: [sourceRef],
    });
    state = apply(state, {
      type: "finding-decision",
      findingId: product.contextFinding.findingId,
      judgment: "accepted_known",
      actor: "fixture-reviewer",
      reason: "別findingの現行条件を確認済み",
      targetVersion: product.scope.version,
      sourceRefs: [sourceRef],
      ruleRefs: [],
    });
  }
  const context = contextFor(product, state);
  const contextHash = hashFindingReviewContext(context);
  const evidenceHash = hashFindingEvidence(evidenceInput(product.candidate));
  state = apply(state, {
    type: "finding-observation",
    findingId: product.candidate.findingId,
    fingerprint: product.candidate.fingerprint,
    targetVersion: product.scope.version,
    observation: product.candidate.evidence,
    sourceRefs: [sourceRef],
    contextHash,
    evidenceHash,
  });
  const observedState = structuredClone(state);
  state = apply(state, {
    type: "finding-decision",
    findingId: product.candidate.findingId,
    judgment: "accepted_known",
    actor: "fixture-reviewer",
    reason: "同一条件の承認済み判断",
    targetVersion: product.scope.version,
    sourceRefs: [sourceRef],
    ruleRefs: [{ id: product.rule.id, revision: 1 }],
  });
  state = apply(state, {
    type: "suppression",
    findingId: product.candidate.findingId,
    actor: "fixture-reviewer",
    reason: "同一条件の確認済み候補",
    targetVersion: product.scope.version,
    fingerprint: product.candidate.fingerprint,
    ruleRefs: [{ id: product.rule.id, revision: 1 }],
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  canonicalizeTimes(observedState, product.at);
  canonicalizeTimes(state, product.at);
  return {
    sourceRef,
    context,
    contextHash,
    evidenceHash,
    observedState,
    reusableState: state,
  };
}

function variantFor(base, product, variant) {
  let state = structuredClone(base.reusableState);
  let expectedContextHash = base.contextHash;
  let expectedEvidenceHash = base.evidenceHash;
  const finding = state.findings.find(
    (item) => item.id === product.candidate.findingId,
  );
  assert(finding, `fixture findingがありません: ${product.candidate.findingId}`);
  switch (variant) {
    case "s01":
      break;
    case "s02":
      finding.suppressions[0].expiresAt = "2020-01-01T00:00:00.000Z";
      break;
    case "s03":
      state.scope.version = "commit-queue-other";
      break;
    case "s04": {
      const context = structuredClone(base.context);
      context.specificationHash = contentHash(`${product.specification.text} changed`);
      expectedContextHash = hashFindingReviewContext(context);
      break;
    }
    case "s05": {
      const context = structuredClone(base.context);
      context.knowledge[0].contentHash = "f".repeat(64);
      expectedContextHash = hashFindingReviewContext(context);
      break;
    }
    case "s06": {
      const context = structuredClone(base.context);
      context.rules[0].contentHash = "e".repeat(64);
      expectedContextHash = hashFindingReviewContext(context);
      break;
    }
    case "s07":
      expectedEvidenceHash = hashFindingEvidence(
        evidenceInput({ ...product.candidate, evidence: `${product.candidate.evidence} changed` }),
      );
      break;
    case "s08":
      delete finding.suppressions[0].contextHash;
      delete finding.suppressions[0].evidenceHash;
      break;
    case "s09":
      state.rules[0].status = "stale";
      break;
    case "s10":
      return {
        state: structuredClone(base.observedState),
        expectedContextHash: base.contextHash,
        expectedEvidenceHash: base.evidenceHash,
      };
    case "s11":
      finding.fingerprint = "fingerprint-other";
      break;
    case "s12":
      return {
        state: apply(state, {
          type: "finding-decision",
          findingId: product.candidate.findingId,
          judgment: "accepted_known",
          actor: "second-fixture-reviewer",
          reason: "後続判断で再確認",
          targetVersion: product.scope.version,
          sourceRefs: [base.sourceRef],
          ruleRefs: [{ id: product.rule.id, revision: 1 }],
        }),
        expectedContextHash,
        expectedEvidenceHash,
      };
    case "s13":
      finding.judgment = "false_positive";
      break;
    case "s14":
      state.documents[0].body = "The source document changed after approval.";
      break;
    case "s15": {
      assert(product.contextFinding, "context findingが必要です: s15");
      state = apply(state, {
        type: "finding-decision",
        findingId: product.contextFinding.findingId,
        judgment: "false_positive",
        actor: "second-fixture-reviewer",
        reason: "別findingの現行判断が変更された",
        targetVersion: product.scope.version,
        sourceRefs: [base.sourceRef],
        ruleRefs: [],
      });
      expectedContextHash = hashFindingReviewContext(
        contextFor(product, state),
      );
      break;
    }
    default:
      throw new Error(`未知のqueue variantです: ${variant}`);
  }
  return { state, expectedContextHash, expectedEvidenceHash };
}

function expectedFor(goldByCase, caseId, condition) {
  const gold = goldByCase.get(caseId);
  assert(gold, `queue goldがありません: ${caseId}`);
  return gold[`expected${condition}`];
}

function sameDecision(actual, expected) {
  return Boolean(
    actual &&
      actual.reusable === expected.reusable &&
      actual.status === expected.status &&
      actual.reason === expected.reason,
  );
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function f1(precision, recall) {
  if (precision === null || recall === null) return null;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function conditionMetrics(records, goldByCase, condition) {
  const selected = records.filter((record) => record.condition === condition);
  const successful = selected.filter((record) => record.status === "completed");
  const expectedReusable = successful.filter(
    (record) => expectedFor(goldByCase, record.caseId, condition).reusable,
  ).length;
  const actualReusable = successful.filter(
    (record) => record.productionResult.reusable,
  ).length;
  const trueReusable = successful.filter((record) =>
    record.productionResult.reusable &&
    expectedFor(goldByCase, record.caseId, condition).reusable,
  ).length;
  const precision = ratio(trueReusable, actualReusable);
  const recall = ratio(trueReusable, expectedReusable);
  return {
    records: selected.length,
    successfulRecords: successful.length,
    errorCount: selected.length - successful.length,
    queueRequiredCount: successful.filter((record) => record.queueRequired).length,
    reusableCount: actualReusable,
    expectedReusableCount: expectedReusable,
    trueReusableCount: trueReusable,
    falseReusableCount: successful.filter(
      (record) =>
        record.productionResult.reusable &&
        !expectedFor(goldByCase, record.caseId, condition).reusable,
    ).length,
    missedReusableCount: successful.filter(
      (record) =>
        !record.productionResult.reusable &&
        expectedFor(goldByCase, record.caseId, condition).reusable,
    ).length,
    goldMismatchCount: successful.filter(
      (record) => !sameDecision(record.productionResult, expectedFor(goldByCase, record.caseId, condition)),
    ).length,
    precision,
    recall,
    f1: f1(precision, recall),
    evaluationRate: ratio(successful.length, selected.length),
  };
}

export function calculateQueueMetrics(records, goldByCase) {
  const byCondition = Object.fromEntries(
    QUEUE_CONDITIONS.map((condition) => [
      condition,
      conditionMetrics(records, goldByCase, condition),
    ]),
  );
  const pairs = [...goldByCase.keys()].map((caseId) => {
    const b = records.find((record) => record.caseId === caseId && record.condition === "B");
    const c = records.find((record) => record.caseId === caseId && record.condition === "C");
    return { caseId, b, c };
  });
  const completedPairs = pairs.filter(
    (pair) => pair.b?.status === "completed" && pair.c?.status === "completed",
  );
  const bQueue = completedPairs.reduce(
    (total, pair) => total + Number(pair.b.queueRequired),
    0,
  );
  const cQueue = completedPairs.reduce(
    (total, pair) => total + Number(pair.c.queueRequired),
    0,
  );
  const reductionCount = bQueue - cQueue;
  const cGold = byCondition.C;
  const metrics = {
    records: records.length,
    successfulRecords: records.filter((record) => record.status === "completed").length,
    errorCount: records.filter((record) => record.status !== "completed").length,
    evaluationRate: ratio(
      records.filter((record) => record.status === "completed").length,
      records.length,
    ),
    queueRequiredB: bQueue,
    queueRequiredC: cQueue,
    queueReductionCount: reductionCount,
    queueReductionRate: ratio(reductionCount, bQueue),
    cReusablePrecision: cGold.precision,
    cReusableRecall: cGold.recall,
    cReusableF1: cGold.f1,
    cFalseReuseCount: cGold.falseReusableCount,
    cMissedReusableCount: cGold.missedReusableCount,
    negativeControlLeakageCount: completedPairs.filter(
      (pair) =>
        !expectedFor(goldByCase, pair.caseId, "C").reusable &&
        pair.c.productionResult.reusable,
    ).length,
    goldMismatchCount: records.filter(
      (record) =>
        record.status === "completed" &&
        !sameDecision(
          record.productionResult,
          expectedFor(goldByCase, record.caseId, record.condition),
        ),
    ).length,
    byCondition,
  };
  return metrics;
}

export async function runQueueEvaluation({
  corpus,
  manifest,
  outputDir,
  conditions = QUEUE_CONDITIONS,
  runId = `review-queue-${Date.now()}`,
  now = () => Date.now(),
  runnerPath = thisFile,
  helperPath = defaultHelperPath,
} = {}) {
  assert(outputDir, "queue outputDirが必要です");
  const normalizedCorpus = validateCorpus(corpus);
  const preflight = preflightQueueManifest(manifest, normalizedCorpus, {
    runnerPath,
    helperPath,
  });
  assert(
    conditions.length === QUEUE_CONDITIONS.length &&
      QUEUE_CONDITIONS.every((condition) => conditions.includes(condition)),
    "queue条件はB/C固定です",
  );
  assert(!existsSync(outputDir) || (await readdir(outputDir)).length === 0, "queue outputは空である必要があります");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    resolve(outputDir, "preflight-check.json"),
    `${JSON.stringify({ status: "ok", stage: "preflight", errors: [] }, null, 2)}\n`,
    "utf8",
  );
  const base = buildBaseFixture(normalizedCorpus.product);
  const records = [];
  for (const condition of conditions) {
    for (const testCase of normalizedCorpus.cases) {
      const started = process.hrtime.bigint();
      const variant = variantFor(base, normalizedCorpus.product, testCase.variant);
      const state = condition === "B" ? base.observedState : variant.state;
      const finding = state.findings.find(
        (item) => item.id === normalizedCorpus.product.candidate.findingId,
      );
      const productionInput = {
        contextHash: condition === "B" ? base.contextHash : variant.expectedContextHash,
        evidenceHash: condition === "B" ? base.evidenceHash : variant.expectedEvidenceHash,
        at: normalizedCorpus.product.at,
      };
      const record = {
        runId,
        caseId: testCase.caseId,
        condition,
        candidateId: normalizedCorpus.product.candidate.id,
        variant: testCase.variant,
        status: "completed",
        rawCandidate: structuredClone(normalizedCorpus.product.candidate),
        productionInput,
        startedAt: new Date(now()).toISOString(),
      };
      try {
        assert(finding, `queue findingがありません: ${testCase.caseId}/${condition}`);
        record.productionResult = evaluateFindingSuppression(
          state,
          finding,
          {
            contextHash: productionInput.contextHash,
            evidenceHash: productionInput.evidenceHash,
          },
          Date.parse(productionInput.at),
        );
        record.queueRequired = !record.productionResult.reusable;
        record.goldMatch = sameDecision(
          record.productionResult,
          expectedFor(normalizedCorpus.goldByCase, testCase.caseId, condition),
        );
        record.failure = null;
      } catch (error) {
        record.status = "error";
        record.queueRequired = null;
        record.productionResult = null;
        record.goldMatch = false;
        record.failure = {
          type: "production-helper-error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      record.elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      record.completedAt = new Date(now()).toISOString();
      records.push(record);
    }
  }
  const metrics = calculateQueueMetrics(records, normalizedCorpus.goldByCase);
  const errorCount = records.filter((record) => record.status !== "completed").length;
  const evaluationDecision =
    errorCount === 0 && metrics.goldMismatchCount === 0 && metrics.negativeControlLeakageCount === 0
      ? "pass"
      : "fail";
  const artifact = {
    artifactVersion: "review-queue-evaluation/v1",
    runId,
    manifestId: manifest.manifest_id,
    status: errorCount === 0 ? "completed" : "failed",
    evaluation_decision: evaluationDecision,
    split: "queue-controls",
    conditions: [...conditions],
    records: records.length,
    error_count: errorCount,
    crash_count: 0,
    timeout_count: 0,
    metrics,
    modelVersions: [],
    generatedAt: new Date(now()).toISOString(),
    source: {
      runnerId: QUEUE_RUNNER_ID,
      datasetSha256: manifest.evaluation.dataset_sha256,
      productionHelperSha256: manifest.identity.production_helper.source_sha256,
    },
    measurementNotes: [
      "Bは承認判断を参照しない観測状態、Cはproduction evaluateFindingSuppressionの結果を使います。現行pastJudgmentsはproduction context hashの入力として扱い、独自抑止条件やpastJudgmentIdsによる代替判定は使いません。",
      "queueRequiredはproduction evaluation.reusableの否定であり、実際の人の所要時間ではありません。確認待ち件数はproxyです。",
      "このartifactは同一候補に対するworkflow効果を測るもので、モデル精度の改善や人の時間短縮を証明しません。",
      "gold mismatch、negative control leakage、helper errorがあればevaluation_decision=failのまま保存します。",
    ],
  };
  const recordsPath = resolve(outputDir, "records.jsonl");
  const artifactPath = resolve(outputDir, "artifact.json");
  const manifestPath = resolve(outputDir, "manifest.json");
  const summaryPath = resolve(outputDir, "summary.json");
  await writeFile(recordsPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const artifactSha256 = prefixedFileHash(artifactPath);
  const summary = {
    ...artifact,
    artifact_path: "artifact.json",
    artifact_sha256: artifactSha256,
    records_path: "records.jsonl",
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { ...summary, outputDir: resolve(outputDir), records, artifact, preflight };
}

async function readRunFiles(runDir) {
  const names = [
    "artifact.json",
    "summary.json",
    "records.jsonl",
    "manifest.json",
    "preflight-check.json",
  ];
  const contents = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(resolve(runDir, name), "utf8")]),
    ),
  );
  const artifact = JSON.parse(contents["artifact.json"]);
  const manifest = JSON.parse(contents["manifest.json"]);
  const records = contents["records.jsonl"]
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { contents, artifact, manifest, records };
}

export async function writeQueuePostrunEvidence(runDir, { force = false } = {}) {
  const outputDir = resolve(runDir);
  const postrunManifestPath = resolve(outputDir, "postrun-manifest.json");
  const checkPath = resolve(outputDir, "postrun-check.json");
  if (!force && (existsSync(postrunManifestPath) || existsSync(checkPath)))
    throw new Error("queue postrun証跡が既に存在します。上書きにはforceが必要です");
  const files = await readRunFiles(outputDir);
  const records = files.records;
  const errorCount = records.filter((record) => record.status !== "completed").length;
  const artifactSha256 = prefixedSha256(sha256Text(files.contents["artifact.json"]));
  const source = Object.fromEntries(
    [
      "artifact.json",
      "summary.json",
      "records.jsonl",
      "manifest.json",
      "preflight-check.json",
    ].map((name) => [
      name,
      prefixedSha256(sha256Text(files.contents[name])),
    ]),
  );
  const metrics = files.artifact.metrics ?? {};
  const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const checkerErrors = [];
  if (errorCount !== 0) checkerErrors.push("outcome.error_count must be zero");
  if (files.artifact.status !== "completed") checkerErrors.push("status must be completed for postrun");
  const postrunManifest = {
    ...files.manifest,
    status: files.artifact.status === "completed" ? "completed" : "failed",
    outcome: {
      artifact_path: "artifact.json",
      artifact_sha256: artifactSha256,
      records: records.length,
      error_count: errorCount,
      crash_count: 0,
      timeout_count: 0,
      metrics: {
        queue_reduction_rate: finite(metrics.queueReductionRate),
        c_reusable_f1: finite(metrics.cReusableF1),
      },
      decision: files.artifact.evaluation_decision,
    },
    postrun_evidence: {
      artifactVersion: "review-queue-postrun/v1",
      source,
      status: files.artifact.status,
      evaluationDecision: files.artifact.evaluation_decision,
      records: records.length,
      errorCount,
      rawCandidateCount: records.filter((record) => record.rawCandidate).length,
      holdout: "not_applicable",
      metrics,
      measurementNotes: files.artifact.measurementNotes,
    },
  };
  const check = {
    status: checkerErrors.length === 0 ? "ok" : "failed",
    stage: "postrun",
    errors: checkerErrors,
  };
  await writeFile(postrunManifestPath, `${JSON.stringify(postrunManifest, null, 2)}\n`, "utf8");
  await writeFile(checkPath, `${JSON.stringify(check, null, 2)}\n`, "utf8");
  return { postrunManifest, check, postrunManifestPath, checkPath };
}

async function main() {
  const { values } = parseArgs({
    options: {
      corpus: { type: "string", default: defaultCorpusDir },
      manifest: { type: "string", default: resolve(defaultCorpusDir, "manifest.json") },
      output: { type: "string" },
      "run-id": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("node scripts/review-queue-evaluation.mjs --output <new-directory> [--corpus evaluations/review-queue] [--manifest evaluations/review-queue/manifest.json]");
    return;
  }
  assert(values.output, "--outputが必要です");
  const corpus = await loadQueueCorpus(values.corpus);
  const manifest = await readJson(values.manifest);
  const result = await runQueueEvaluation({
    corpus,
    manifest,
    outputDir: values.output,
    runId: values["run-id"],
  });
  const postrun = await writeQueuePostrunEvidence(values.output);
  console.log(JSON.stringify({
    runId: result.runId,
    status: result.status,
    evaluationDecision: result.evaluation_decision,
    records: result.records.length,
    metrics: result.metrics,
    postrunCheck: postrun.check,
    outputDir: result.outputDir,
  }, null, 2));
  process.exitCode =
    result.status === "completed" && result.evaluation_decision === "pass" && postrun.check.status === "ok"
      ? 0
      : 2;
}

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
