import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helperPath = resolve(
  repoRoot,
  process.env.QUEUE04_HELPER ?? ".cache/coverage-build/server/workflow-domain.js",
);
const corpusRoot = resolve(repoRoot, "evaluations/review-queue/v2");
const baseManifestPath = resolve(corpusRoot, "manifest.json");
const manifestPath = resolve(corpusRoot, "manifest-04.json");
const outputDir = resolve(
  repoRoot,
  process.env.QUEUE04_OUTPUT ??
    "evaluations/review-queue/results/queue-controls-20261005-04",
);
const runnerPath = fileURLToPath(import.meta.url);
const conditions = ["B", "C"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

function stableStringify(value) {
  return JSON.stringify(sortedValue(value));
}

function sha256Text(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function prefixedSha256(value) {
  return `sha256:${value}`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function fileHash(path) {
  return prefixedSha256(
    createHash("sha256").update(await readFile(path)).digest("hex"),
  );
}

function relativeRepo(path) {
  return relative(repoRoot, resolve(path)).replaceAll("\\", "/");
}

async function loadCorpus() {
  const product = await readJson(resolve(corpusRoot, "product.json"));
  const cases = (await readJson(resolve(corpusRoot, "cases.json"))).cases;
  const gold = (await readJson(resolve(corpusRoot, "gold.json"))).cases;
  const goldByCase = new Map(gold.map((item) => [item.caseId, item]));
  assert(cases.length === gold.length, "queue04 cases/gold件数が一致しません");
  for (const item of cases) {
    assert(goldByCase.has(item.caseId), `queue04 goldがありません: ${item.caseId}`);
    for (const condition of conditions) {
      assert(isRecord(goldByCase.get(item.caseId)[`expected${condition}`]), `queue04 goldが不正です: ${item.caseId}/${condition}`);
    }
  }
  const orderedCases = [...cases].sort((left, right) => left.caseId.localeCompare(right.caseId));
  return {
    corpusVersion: product.corpusVersion ?? "review-queue-corpus/v2",
    product,
    cases: orderedCases,
    gold,
    goldByCase,
  };
}

function queueCorpusHash(corpus) {
  return prefixedSha256(
    sha256Text(
      stableStringify({
        corpusVersion: corpus.corpusVersion,
        product: corpus.product,
        cases: corpus.cases,
        gold: corpus.gold,
      }),
    ),
  );
}

function apply(state, command, productionDomain) {
  return productionDomain.applyWorkflowCommand(state, command);
}

function renameEntityId(state, collection, oldId, newId) {
  for (const item of state[collection]) if (item.id === oldId) item.id = newId;
  for (const event of state.events) if (event.entityId === oldId) event.entityId = newId;
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

function contextFor(product, state, productionDomain) {
  const pastJudgments = state.findings.flatMap((finding) => {
    if (finding.id === product.candidate.findingId) return [];
    if (finding.judgment === "unconfirmed") return [];
    const decision = finding.decisions.at(-1);
    if (!decision || decision.targetVersion !== state.scope.version || decision.sourceRefs.length === 0) return [];
    return [{
      findingId: finding.id,
      revision: decision.revision,
      targetVersion: decision.targetVersion,
      judgment: decision.judgment,
      reason: decision.reason,
      sourceRefs: decision.sourceRefs,
    }];
  });
  return {
    targetVersion: state.scope.version,
    purpose: state.scope.purpose,
    specificationRevision: product.specification.revision,
    specificationHash: contentHash(product.specification.text),
    knowledge: state.knowledge.filter((item) => item.status === "active").map((item) => ({
      id: item.id,
      revision: item.revision,
      contentHash: contentHash(item.content),
      sourceRefs: item.sourceRefs,
    })),
    rules: state.rules.filter((item) => item.status === "active" && item.appliesToVersion === state.scope.version).map((item) => ({
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

function buildBaseFixture(product, productionDomain) {
  let state = productionDomain.newWorkflow(product.projectId, product.scope);
  state = apply(state, {
    type: "document",
    value: {
      title: product.document.title,
      body: product.document.body,
      classification: product.document.classification,
    },
  }, productionDomain);
  const generatedDocument = state.documents.at(-1);
  assert(generatedDocument, "queue04 fixture documentが作成されませんでした");
  renameEntityId(state, "documents", generatedDocument.id, product.document.id);
  const sourceRef = { docId: product.document.id, revision: 1, excerpt: product.document.excerpt };
  state = apply(state, {
    type: "knowledge-draft",
    purpose: product.scope.purpose,
    content: product.knowledge.content,
    sourceRefs: [sourceRef],
    origin: "manual",
  }, productionDomain);
  const generatedKnowledge = state.knowledge.at(-1);
  assert(generatedKnowledge, "queue04 fixture knowledgeが作成されませんでした");
  renameEntityId(state, "knowledge", generatedKnowledge.id, product.knowledge.id);
  state = apply(state, {
    type: "knowledge-review",
    knowledgeId: product.knowledge.id,
    decision: "active",
    actor: "fixture-reviewer",
    reason: "承認済みfixture知識",
  }, productionDomain);
  state = apply(state, {
    type: "rule-draft",
    purpose: product.scope.purpose,
    content: product.rule.content,
    applicability: product.rule.applicability,
    appliesToVersion: product.scope.version,
    sourceRefs: [sourceRef],
  }, productionDomain);
  const generatedRule = state.rules.at(-1);
  assert(generatedRule, "queue04 fixture ruleが作成されませんでした");
  renameEntityId(state, "rules", generatedRule.id, product.rule.id);
  state = apply(state, {
    type: "rule-review",
    ruleId: product.rule.id,
    decision: "active",
    actor: "fixture-reviewer",
    reason: "承認済みfixture基準",
  }, productionDomain);
  if (product.contextFinding) {
    state = apply(state, {
      type: "finding-observation",
      findingId: product.contextFinding.findingId,
      fingerprint: product.contextFinding.fingerprint,
      targetVersion: product.scope.version,
      observation: product.contextFinding.observation,
      sourceRefs: [sourceRef],
    }, productionDomain);
    state = apply(state, {
      type: "finding-decision",
      findingId: product.contextFinding.findingId,
      judgment: "accepted_known",
      actor: "fixture-reviewer",
      reason: "別findingの現行条件を確認済み",
      targetVersion: product.scope.version,
      sourceRefs: [sourceRef],
      ruleRefs: [],
    }, productionDomain);
  }
  const context = contextFor(product, state, productionDomain);
  const contextHash = productionDomain.hashFindingReviewContext(context);
  const evidenceHash = productionDomain.hashFindingEvidence(evidenceInput(product.candidate));
  state = apply(state, {
    type: "finding-observation",
    findingId: product.candidate.findingId,
    fingerprint: product.candidate.fingerprint,
    targetVersion: product.scope.version,
    observation: product.candidate.evidence,
    sourceRefs: [sourceRef],
    contextHash,
    evidenceHash,
  }, productionDomain);
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
  }, productionDomain);
  state = apply(state, {
    type: "suppression",
    findingId: product.candidate.findingId,
    actor: "fixture-reviewer",
    reason: "同一条件の確認済み候補",
    targetVersion: product.scope.version,
    fingerprint: product.candidate.fingerprint,
    ruleRefs: [{ id: product.rule.id, revision: 1 }],
    expiresAt: "2099-01-01T00:00:00.000Z",
  }, productionDomain);
  canonicalizeTimes(observedState, product.at);
  canonicalizeTimes(state, product.at);
  return { sourceRef, context, contextHash, evidenceHash, observedState, reusableState: state };
}

function variantFor(base, product, variant, productionDomain) {
  let state = structuredClone(base.reusableState);
  let expectedContextHash = base.contextHash;
  let expectedEvidenceHash = base.evidenceHash;
  const finding = state.findings.find((item) => item.id === product.candidate.findingId);
  assert(finding, `queue04 fixture findingがありません: ${product.candidate.findingId}`);
  switch (variant) {
    case "s01": break;
    case "s02": finding.suppressions[0].expiresAt = "2020-01-01T00:00:00.000Z"; break;
    case "s03": state.scope.version = "commit-queue-other"; break;
    case "s04": {
      const context = structuredClone(base.context);
      context.specificationHash = contentHash(`${product.specification.text} changed`);
      expectedContextHash = productionDomain.hashFindingReviewContext(context);
      break;
    }
    case "s05": {
      const context = structuredClone(base.context);
      context.knowledge[0].contentHash = "f".repeat(64);
      expectedContextHash = productionDomain.hashFindingReviewContext(context);
      break;
    }
    case "s06": {
      const context = structuredClone(base.context);
      context.rules[0].contentHash = "e".repeat(64);
      expectedContextHash = productionDomain.hashFindingReviewContext(context);
      break;
    }
    case "s07": expectedEvidenceHash = productionDomain.hashFindingEvidence(evidenceInput({ ...product.candidate, evidence: `${product.candidate.evidence} changed` })); break;
    case "s08": delete finding.suppressions[0].contextHash; delete finding.suppressions[0].evidenceHash; break;
    case "s09": state.rules[0].status = "stale"; break;
    case "s10": return { state: structuredClone(base.observedState), expectedContextHash: base.contextHash, expectedEvidenceHash: base.evidenceHash };
    case "s11": finding.fingerprint = "fingerprint-other"; break;
    case "s12": return { state: apply(state, { type: "finding-decision", findingId: product.candidate.findingId, judgment: "accepted_known", actor: "second-fixture-reviewer", reason: "後続判断で再確認", targetVersion: product.scope.version, sourceRefs: [base.sourceRef], ruleRefs: [{ id: product.rule.id, revision: 1 }] }, productionDomain), expectedContextHash, expectedEvidenceHash };
    case "s13": finding.judgment = "false_positive"; break;
    case "s14": state.documents[0].body = "The source document changed after approval."; break;
    case "s15": {
      assert(product.contextFinding, "context findingが必要です: s15");
      state = apply(state, { type: "finding-decision", findingId: product.contextFinding.findingId, judgment: "false_positive", actor: "second-fixture-reviewer", reason: "別findingの現行判断が変更された", targetVersion: product.scope.version, sourceRefs: [base.sourceRef], ruleRefs: [] }, productionDomain);
      expectedContextHash = productionDomain.hashFindingReviewContext(contextFor(product, state, productionDomain));
      break;
    }
    default: throw new Error(`未知のqueue04 variantです: ${variant}`);
  }
  return { state, expectedContextHash, expectedEvidenceHash };
}

function expectedFor(goldByCase, caseId, condition) {
  const gold = goldByCase.get(caseId);
  assert(gold, `queue04 goldがありません: ${caseId}`);
  return gold[`expected${condition}`];
}

function sameDecision(actual, expected) {
  return Boolean(actual && actual.reusable === expected.reusable && actual.status === expected.status && actual.reason === expected.reason);
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
  const expectedReusable = successful.filter((record) => expectedFor(goldByCase, record.caseId, condition).reusable).length;
  const actualReusable = successful.filter((record) => record.productionResult.reusable).length;
  const trueReusable = successful.filter((record) => record.productionResult.reusable && expectedFor(goldByCase, record.caseId, condition).reusable).length;
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
    falseReusableCount: successful.filter((record) => record.productionResult.reusable && !expectedFor(goldByCase, record.caseId, condition).reusable).length,
    missedReusableCount: successful.filter((record) => !record.productionResult.reusable && expectedFor(goldByCase, record.caseId, condition).reusable).length,
    goldMismatchCount: successful.filter((record) => !sameDecision(record.productionResult, expectedFor(goldByCase, record.caseId, condition))).length,
    precision,
    recall,
    f1: f1(precision, recall),
    evaluationRate: ratio(successful.length, selected.length),
  };
}

function calculateMetrics(records, goldByCase) {
  const byCondition = Object.fromEntries(conditions.map((condition) => [condition, conditionMetrics(records, goldByCase, condition)]));
  const pairs = [...goldByCase.keys()].map((caseId) => ({
    caseId,
    b: records.find((record) => record.caseId === caseId && record.condition === "B"),
    c: records.find((record) => record.caseId === caseId && record.condition === "C"),
  }));
  const completedPairs = pairs.filter((pair) => pair.b?.status === "completed" && pair.c?.status === "completed");
  const bQueue = completedPairs.reduce((total, pair) => total + Number(pair.b.queueRequired), 0);
  const cQueue = completedPairs.reduce((total, pair) => total + Number(pair.c.queueRequired), 0);
  const cGold = byCondition.C;
  return {
    records: records.length,
    successfulRecords: records.filter((record) => record.status === "completed").length,
    errorCount: records.filter((record) => record.status !== "completed").length,
    evaluationRate: ratio(records.filter((record) => record.status === "completed").length, records.length),
    queueRequiredB: bQueue,
    queueRequiredC: cQueue,
    queueReductionCount: bQueue - cQueue,
    queueReductionRate: ratio(bQueue - cQueue, bQueue),
    cReusablePrecision: cGold.precision,
    cReusableRecall: cGold.recall,
    cReusableF1: cGold.f1,
    cFalseReuseCount: cGold.falseReusableCount,
    cMissedReusableCount: cGold.missedReusableCount,
    negativeControlLeakageCount: completedPairs.filter((pair) => !expectedFor(goldByCase, pair.caseId, "C").reusable && pair.c.productionResult.reusable).length,
    goldMismatchCount: records.filter((record) => record.status === "completed" && !sameDecision(record.productionResult, expectedFor(goldByCase, record.caseId, record.condition))).length,
    byCondition,
  };
}

async function makeManifest(datasetSha256, helperSha256) {
  const manifest = structuredClone(await readJson(baseManifestPath));
  const runnerSha256 = await fileHash(runnerPath);
  manifest.manifest_id = "eval:20261005-review-queue-04";
  manifest.task_id = "review-queue-20261005-04";
  manifest.freeze_date = "2026-10-05";
  manifest.hypothesis = `${manifest.hypothesis} queue04はcoverage-buildの新production helperで再評価する。`;
  manifest.identity.runner = { id: "review-queue-evaluation/v2-04", sha256: runnerSha256 };
  for (const role of ["legacy", "candidate"]) {
    manifest.identity[role].source_revision = "dirty-bundle:review-queue-evaluation-04";
    manifest.identity[role].input_sha256 = datasetSha256;
  }
  manifest.identity.legacy.source_path = relativeRepo(runnerPath);
  manifest.identity.legacy.source_sha256 = runnerSha256;
  manifest.identity.candidate.source_path = relativeRepo(helperPath);
  manifest.identity.candidate.source_sha256 = helperSha256;
  manifest.identity.candidate.source_revision = "coverage-build:workflow-domain-04";
  manifest.identity.production_helper.source_path = relativeRepo(helperPath);
  manifest.identity.production_helper.source_sha256 = helperSha256;
  manifest.identity.production_helper.source_revision = "coverage-build:workflow-domain-04";
  manifest.identity.production_helper.input_sha256 = datasetSha256;
  manifest.evaluation.dataset_sha256 = datasetSha256;
  manifest.evaluation.configuration.case_count = 15;
  manifest.evaluation.configuration.helper_build = relativeRepo(helperPath);
  return manifest;
}

async function writePostrun(output, manifest, artifact, records) {
  const files = ["artifact.json", "summary.json", "records.jsonl", "manifest.json", "preflight-check.json"];
  const resolvedSource = {};
  for (const name of files) resolvedSource[name] = await fileHash(resolve(output, name));
  const artifactSha256 = await fileHash(resolve(output, "artifact.json"));
  const metrics = artifact.metrics;
  const errors = [];
  if (artifact.error_count !== 0) errors.push("outcome.error_count must be zero");
  if (artifact.status !== "completed") errors.push("status must be completed for postrun");
  const postrunManifest = {
    ...manifest,
    status: artifact.status === "completed" ? "completed" : "failed",
    sourceManifestId: manifest.manifest_id,
    source: {
      artifactPath: "artifact.json",
      summaryPath: "summary.json",
      recordsPath: "records.jsonl",
      manifestPath: "manifest.json",
      preflightCheckPath: "preflight-check.json",
      artifactSha256,
      summarySha256: resolvedSource["summary.json"],
      recordsSha256: resolvedSource["records.jsonl"],
      manifestSha256: resolvedSource["manifest.json"],
      preflightCheckSha256: resolvedSource["preflight-check.json"],
    },
    outcome: {
      artifact_path: "artifact.json",
      artifact_sha256: artifactSha256,
      records: records.length,
      error_count: artifact.error_count,
      crash_count: artifact.crash_count,
      timeout_count: artifact.timeout_count,
      metrics: {
        queue_reduction_rate: Number.isFinite(Number(metrics.queueReductionRate)) ? Number(metrics.queueReductionRate) : 0,
        c_reusable_f1: Number.isFinite(Number(metrics.cReusableF1)) ? Number(metrics.cReusableF1) : 0,
      },
      decision: artifact.evaluation_decision,
    },
    postrun_evidence: {
      artifactVersion: "review-queue-postrun/v2",
      source: resolvedSource,
      status: artifact.status,
      evaluationDecision: artifact.evaluation_decision,
      records: records.length,
      errorCount: artifact.error_count,
      rawCandidateCount: records.filter((record) => record.rawCandidate).length,
      holdout: "not_applicable",
      metrics,
      measurementNotes: artifact.measurementNotes,
    },
  };
  const check = { status: errors.length === 0 ? "ok" : "failed", stage: "postrun", errors };
  await writeFile(resolve(output, "postrun-manifest.json"), `${JSON.stringify(postrunManifest, null, 2)}\n`, "utf8");
  await writeFile(resolve(output, "postrun-check.json"), `${JSON.stringify(check, null, 2)}\n`, "utf8");
  return { postrunManifest, check };
}

async function main() {
  assert(existsSync(helperPath), `queue04 helperがありません: ${helperPath}`);
  assert(!existsSync(manifestPath), `queue04 manifestは既に存在します: ${manifestPath}`);
  assert(!existsSync(outputDir) || (await readdir(outputDir)).length === 0, "queue04 outputは新規空ディレクトリが必要です");
  const productionDomain = await import(`${pathToFileURL(helperPath).href}?queue04=04`);
  for (const name of ["newWorkflow", "applyWorkflowCommand", "hashFindingReviewContext", "hashFindingEvidence", "evaluateFindingSuppression"])
    assert(typeof productionDomain[name] === "function", `queue04 production helper exportがありません: ${name}`);
  const corpus = await loadCorpus();
  const datasetSha256 = queueCorpusHash(corpus);
  const helperSha256 = await fileHash(helperPath);
  const manifest = await makeManifest(datasetSha256, helperSha256);
  assert(manifest.evaluation.dataset_sha256 === datasetSha256, "queue04 dataset hashが一致しません");
  assert(manifest.identity.production_helper.source_sha256 === helperSha256, "queue04 helper hashが一致しません");
  assert(manifest.identity.runner.sha256 === await fileHash(runnerPath), "queue04 runner hashが一致しません");
  for (const identity of [manifest.identity.legacy, manifest.identity.candidate, manifest.identity.production_helper])
    assert(identity.input_sha256 === datasetSha256, "queue04 identity input hashが一致しません");
  await mkdir(corpusRoot, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "preflight-check.json"), `${JSON.stringify({ status: "ok", stage: "preflight", errors: [] }, null, 2)}\n`, "utf8");
  const base = buildBaseFixture(corpus.product, productionDomain);
  const records = [];
  for (const condition of conditions) {
    for (const testCase of corpus.cases) {
      const started = process.hrtime.bigint();
      const variant = variantFor(base, corpus.product, testCase.variant, productionDomain);
      const state = condition === "B" ? base.observedState : variant.state;
      const finding = state.findings.find((item) => item.id === corpus.product.candidate.findingId);
      const productionInput = {
        contextHash: condition === "B" ? base.contextHash : variant.expectedContextHash,
        evidenceHash: condition === "B" ? base.evidenceHash : variant.expectedEvidenceHash,
        at: corpus.product.at,
      };
      const record = {
        runId: "queue-controls-20261005-04",
        caseId: testCase.caseId,
        condition,
        candidateId: corpus.product.candidate.id,
        variant: testCase.variant,
        status: "completed",
        rawCandidate: structuredClone(corpus.product.candidate),
        productionInput,
        startedAt: new Date().toISOString(),
      };
      try {
        assert(finding, `queue04 findingがありません: ${testCase.caseId}/${condition}`);
        record.productionResult = productionDomain.evaluateFindingSuppression(state, finding, {
          contextHash: productionInput.contextHash,
          evidenceHash: productionInput.evidenceHash,
        }, Date.parse(productionInput.at));
        record.queueRequired = !record.productionResult.reusable;
        record.goldMatch = sameDecision(record.productionResult, expectedFor(corpus.goldByCase, testCase.caseId, condition));
        record.failure = null;
      } catch (error) {
        record.status = "error";
        record.queueRequired = null;
        record.productionResult = null;
        record.goldMatch = false;
        record.failure = { type: "production-helper-error", message: error instanceof Error ? error.message : String(error) };
      }
      record.elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      record.completedAt = new Date().toISOString();
      records.push(record);
    }
  }
  const metrics = calculateMetrics(records, corpus.goldByCase);
  const errorCount = records.filter((record) => record.status !== "completed").length;
  const evaluationDecision = errorCount === 0 && metrics.goldMismatchCount === 0 && metrics.negativeControlLeakageCount === 0 ? "pass" : "fail";
  const artifact = {
    artifactVersion: "review-queue-evaluation/v2",
    runId: "queue-controls-20261005-04",
    manifestId: manifest.manifest_id,
    status: errorCount === 0 ? "completed" : "failed",
    evaluation_decision: evaluationDecision,
    split: "queue-controls",
    conditions,
    records: records.length,
    error_count: errorCount,
    crash_count: 0,
    timeout_count: 0,
    metrics,
    modelVersions: [],
    generatedAt: new Date().toISOString(),
    source: {
      runnerId: manifest.identity.runner.id,
      runnerSha256: manifest.identity.runner.sha256,
      datasetSha256: datasetSha256,
      productionHelperPath: relativeRepo(helperPath),
      productionHelperSha256: helperSha256,
    },
    measurementNotes: [
      "Bは承認判断を参照しない観測状態、Cは新buildのproduction evaluateFindingSuppressionの結果を使います。独自抑止ロジックやpastJudgmentIdsの存在だけによる除外は使いません。",
      "queueRequiredはproduction evaluation.reusableの否定であり、実際の人の所要時間ではありません。確認待ち件数はproxyです。",
      "このartifactは同一候補に対するworkflow効果を測るもので、モデル精度の改善や人の時間短縮を証明しません。",
      "gold mismatch、negative control leakage、helper errorがあればevaluation_decision=failのまま保存します。",
    ],
  };
  await writeFile(resolve(outputDir, "records.jsonl"), records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  await writeFile(resolve(outputDir, "artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const summary = { ...artifact, artifact_path: "artifact.json", artifact_sha256: await fileHash(resolve(outputDir, "artifact.json")), records_path: "records.jsonl" };
  await writeFile(resolve(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const postrun = await writePostrun(outputDir, manifest, artifact, records);
  console.log(JSON.stringify({ outputDir, manifestPath, status: artifact.status, evaluationDecision, records: records.length, metrics, postrun: postrun.check }, null, 2));
  if (artifact.status !== "completed" || postrun.check.status !== "ok") process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
