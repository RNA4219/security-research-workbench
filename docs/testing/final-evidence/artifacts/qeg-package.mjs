import { executionWriter } from "./qeg-execution.mjs";
import { validateEvidenceInputs, createPolicy } from "./quality-inputs.mjs";
export { validateEvidenceInputs } from "./quality-inputs.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bridgeFiles = [
  "qeg-package.mjs",
  "quality-inputs.mjs",
  "qeg-execution.mjs",
  "quality-chain.py",
];
const hash = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const read = (path) =>
  JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));

export function createPackage(out) {
  const identity = read(out + "/run-identity.json");
  const findings = read(out + "/ctg/findings.json");
  const readiness = read(out + "/ctg/release-readiness.json");
  const requirements = read(out + "/rand/requirements_document.json");
  const hate = readFileSync(out + "/hate/HATE-test-results.ndjson", "utf8")
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  const precheck = read(out + "/hate/precheck-decision.json");
  const manual = read(out + "/manual-observations.json");
  const cases = read(out + "/manual/manual_case_set.json");
  const coverage = read(out + "/coverage-gate.json");
  const manualGate = read(out + "/manual-gate.json");
  validateEvidenceInputs({
    identity,
    findings,
    readiness,
    requirements,
    hate,
    precheck,
    manual,
    cases,
    coverage,
    sourceHash: hash(readFileSync(root + "/docs/requirements.md")).slice(7),
  });
  for (const [path, expected] of Object.entries(identity.sourceHashes)) {
    // The bridge is a separately hash-pinned producer. Never relabel the tested
    // application or test definitions when repairing an artifact conversion.
    if (bridgeFiles.some((name) => path === "scripts/" + name)) continue;
    if (hash(readFileSync(resolve(root, path))).slice(7) !== expected)
      throw Error("source changed since execution: " + path);
  }
  const dest = resolve(out, "qeg");
  mkdirSync(dest + "/artifacts", { recursive: true });
  const artifacts = [];
  const addBytes = (id, adapter, kind, name, bytes) => {
    const path = "artifacts/" + name;
    writeFileSync(dest + "/" + path, bytes);
    const ref = {
      id,
      adapter,
      kind,
      path,
      contentHash: hash(bytes),
      revision: identity.head,
    };
    artifacts.push(ref);
    return ref;
  };
  const add = (id, adapter, kind, name, data) =>
    addBytes(id, adapter, kind, name, JSON.stringify(data, null, 2) + "\n");
  const copy = (id, adapter, kind, name, path) =>
    addBytes(id, adapter, kind, name, readFileSync(path));
  const sourceRef = (ref) => ({
    id: ref.id,
    path: ref.path,
    revision: ref.revision,
  });
  const trace = (...refs) => ({
    sourceRefs: refs.map(sourceRef),
    assumptions: [],
    confidence: "high",
  });
  const spec = copy(
    "spec",
    "qeg-native",
    "feature_spec",
    "requirements.md",
    root + "/docs/requirements.md",
  );
  const bridgeRefs = bridgeFiles.map((name) => {
    const ref = copy(
      "bridge-" + name,
      "qeg-native",
      "audit",
      name,
      root + "/scripts/" + name,
    );
    delete ref.revision;
    return ref;
  });
  const bridgeVersion =
    "workbench-bridge/1:" +
    hash(bridgeRefs.map((r) => r.contentHash).join(":"));
  const rand = copy(
    "rand",
    "RanD",
    "requirements_packet",
    "rand-document.json",
    out + "/rand/requirements_document.json",
  );
  copy(
    "rand-audit",
    "RanD",
    "requirements_audit_packet",
    "rand-audit.json",
    out + "/rand/requirements_audit_packet.json",
  );
  const ctg = copy(
    "ctg",
    "code-to-gate",
    "findings",
    "ctg-findings.json",
    out + "/ctg/findings.json",
  );
  const ready = copy(
    "ctg-readiness",
    "code-to-gate",
    "release_readiness",
    "ctg-readiness.json",
    out + "/ctg/release-readiness.json",
  );
  const auto = copy(
    "hate",
    "junit",
    "junit",
    "hate-test-results.ndjson",
    out + "/hate/HATE-test-results.ndjson",
  );
  copy(
    "hate-precheck",
    "qeg-native",
    "audit",
    "hate-precheck.json",
    out + "/hate/precheck-decision.json",
  );
  copy("junit", "junit", "junit", "junit.xml", out + "/hate-input/junit.xml");
  copy(
    "coverage",
    "coverage",
    "coverage",
    "coverage-gate.json",
    out + "/coverage-gate.json",
  );
  copy(
    "run-identity",
    "qeg-native",
    "audit",
    "run-identity.json",
    out + "/run-identity.json",
  );
  const mbb = copy(
    "manual-cases",
    "manual-bb-test-harness",
    "manual_case_set",
    "manual-cases.json",
    out + "/manual/manual_case_set.json",
  );
  copy(
    "manual-gate-original",
    "qeg-native",
    "audit",
    "manual-gate-original.json",
    out + "/manual-gate.json",
  );
  // QEG 0.5 embeds the earlier manual-bb schema; retain the full original and
  // project only its expanded evidence_summary into that declared contract.
  const mg = add(
    "manual-gate",
    "manual-bb-test-harness",
    "gate_decision",
    "manual-gate.json",
    {
      ...manualGate,
      evidence_summary: {
        manual_by_priority: manualGate.evidence_summary.manual_by_priority,
        mandatory_observation_rate:
          manualGate.evidence_summary.mandatory_observation_rate,
      },
    },
  );
  const riskRef = copy(
    "manual-risks",
    "manual-bb-test-harness",
    "risk_register",
    "manual-risks.json",
    out + "/manual/risk_register.json",
  );
  for (const kind of [
    "feature_spec",
    "test_model",
    "observation_set",
    "automation_evidence",
  ])
    copy(
      "manual-" + kind,
      "manual-bb-test-harness",
      kind === "automation_evidence" ? "execution_evidence" : kind,
      kind + ".json",
      out + "/manual/" + kind + ".json",
    );
  const nodes = [],
    edges = [];
  const base = (id, kind, title, refs) => ({
    id,
    kind,
    title,
    traceability: trace(...refs),
    sourceArtifactIds: refs.map((r) => r.id),
  });
  const edge = (kind, from, to, ref) =>
    edges.push({
      id: `edge-${edges.length + 1}`,
      kind,
      from,
      to,
      traceability: trace(ref),
    });
  const requirementIds = requirements.requirements.map((r) => r.external_id);
  if (requirementIds.length !== 15 || new Set(requirementIds).size !== 15)
    throw Error("requirements inventory changed; review mapping");
  for (const r of requirements.requirements) {
    nodes.push({
      ...base(r.external_id, "requirement", r.statement, [rand, spec]),
      priority: "P1",
      acceptanceCriteriaIds: [r.external_id + "-AC"],
    });
    nodes.push({
      ...base(
        r.external_id + "-AC",
        "acceptance_criteria",
        r.acceptance_criteria.join(" / "),
        [rand, spec],
      ),
      requirementIds: [r.external_id],
      oracleRefs: [{ ...sourceRef(spec), evidenceKind: "spec" }],
    });
    edge("derives_from", r.external_id + "-AC", r.external_id, rand);
  }
  const manualPlan = read(root + "/docs/manual-bb/final-plan.json");
  const risks = read(out + "/manual/risk_register.json").risks;
  for (const [i, r] of risks.entries()) {
    nodes.push({
      ...base(r.id, "risk", r.scenario, [riskRef]),
      priority: r.priority,
      severity: "high",
      likelihood: r.likelihood / 5,
      businessImpact: 1,
      complianceCriticality: 0,
      evidenceGap: 0,
      novelty: 0.3,
    });
    for (const req of manualPlan.cases[i].requirements)
      edge("risks", r.id, req, riskRef);
  }
  const changed = Object.keys(identity.sourceHashes)
    .filter((p) => p.startsWith("src/"))
    .map((path, i) => ({ path, id: "code-" + i }));
  for (const c of changed) {
    const ref = copy(
      c.id,
      "git-diff",
      "git_diff",
      c.id + "-" + basename(c.path),
      root + "/" + c.path,
    );
    nodes.push({
      ...base(c.id, "changed_code", c.path, [ref]),
      path: c.path,
      language: c.path.endsWith("tsx") ? "tsx" : "ts",
      symbols: [],
      hunks: [sourceRef(ref)],
      blastRadius: 0.5,
    });
  }
  const target = {
    projectId: "RNA4219/security-research-workbench",
    buildId: identity.head,
    revision: identity.head,
    environmentId: "windows-node24-local",
  };
  const binding = add(
    "build-binding",
    "qeg-native",
    "execution_evidence",
    "build-binding.json",
    { bindingVersion: "qeg-build/v1", target },
  );
  const execution = executionWriter({
    nodes,
    base,
    spec,
    target,
    identity,
    bridgeVersion,
    add,
    sourceRef,
    edge,
  });
  // Suites are explicit aggregates of every HATE record, not invented per-case coverage.
  for (const layer of ["unit", "e2e"]) {
    const records = hate.filter(
      (t) => t.payload.file.includes("tests/e2e/") === (layer === "e2e"),
    );
    if (!records.length) throw Error("missing suite " + layer);
    const reqs =
      layer === "unit"
        ? requirementIds.filter((id) => id !== "FR-10")
        : requirementIds.filter((id) => !["FR-09", "FR-10"].includes(id));
    execution(
      layer + "-suite",
      `${layer} ${records.length}件の集約`,
      layer,
      reqs,
      risks.map((r) => r.id),
      changed
        .filter((c) =>
          layer === "unit"
            ? !c.path.startsWith("src/client/")
            : c.path.startsWith("src/client/"),
        )
        .map((c) => c.id),
      auto,
      identity.finishedAt,
      {
        records: records.map((r) => r.record_id),
        dependencyDoubles:
          "個別テストのスタブはテスト名と原文を参照。アプリ実行自体は実測",
      },
      ["全収集ケースが成功し、規定カバレッジを満たす"],
    );
  }
  const build = read(out + "/build.json");
  if (build.head !== identity.head || build.exitCode !== 0)
    throw Error("build identity failed");
  const buildRef = copy(
    "build",
    "qeg-native",
    "execution_evidence",
    "build.json",
    out + "/build.json",
  );
  copy("build-log", "qeg-native", "audit", "build.log", out + "/build.log");
  execution(
    "build",
    "通常ビルド",
    "integration",
    ["FR-10"],
    [],
    [],
    buildRef,
    build.finishedAt,
    build,
    ["npm run build が成功する。クリーン導入は同commitのCIでも検証する"],
  );
  for (const [i, c] of cases.manual_cases.entries()) {
    const observation = manual.results.find((r) => r.tc_id === c.tc_id);
    const ref = copy(
      "manual-" + c.tc_id,
      "manual-bb-test-harness",
      "execution_evidence",
      c.tc_id + ".json",
      out + "/manual/executions/" + c.tc_id + ".json",
    );
    for (const [n, path] of observation.attachments.entries())
      copy(
        c.tc_id + "-attachment-" + n,
        "manual-bb-test-harness",
        "execution_evidence",
        c.tc_id + "-attachment-" + n + ".txt",
        out + "/" + path,
      );
    execution(
      c.tc_id,
      c.title,
      "manual-scripted",
      manualPlan.cases[i].requirements,
      [risks[i].id],
      [],
      ref,
      observation.timestamp,
      observation,
      c.expected_results,
    );
  }
  const verdict = manualGate.status;
  if (verdict !== "go")
    throw Error("manual gate not go: " + JSON.stringify(manualGate));
  nodes.push({
    ...base("upstream-manual", "gate_verdict", "manual-bb standard gate", [mg]),
    verdict,
    profile: "standard",
    disqualifications: [],
    blockers: [],
    residualRisks: [],
  });
  nodes.push({
    ...base("upstream-static", "gate_verdict", "Code-to-gate readiness", [
      ready,
      ctg,
    ]),
    verdict: "go",
    profile: "standard",
    disqualifications: [],
    blockers: [],
    residualRisks: [],
  });
  const policyRef = copy(
    "policy",
    "qeg-native",
    "audit",
    "quality-policy.md",
    root + "/docs/testing/quality-policy.md",
  );
  const policy = createPolicy({
    identity,
    sourceRef,
    policyRef,
    target,
    binding,
    hash,
  });
  const metadata = {
    qegVersion: "0.2",
    runId: "workbench-final-" + identity.head.slice(0, 12),
    createdAt: new Date().toISOString(),
    profile: "standard",
    headRef: identity.head,
    inputArtifacts: artifacts,
    requiredConnectorStatus: {
      RanD: "success",
      "code-to-gate": "success",
      "manual-bb-test-harness": "success",
      junit: "success",
      "qeg-native": "success",
    },
  };
  const graph = {
    metadata,
    nodes,
    edges,
    completeness: {
      score: 1,
      partial: false,
      parserFailures: [],
      unsupportedClaims: [],
    },
  };
  writeFileSync(
    dest + "/gate-input.json",
    JSON.stringify({ metadata, graph, policy, waivers: [] }, null, 2) + "\n",
  );
  return {
    nodes: nodes.length,
    edges: edges.length,
    artifacts: artifacts.length,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(createPackage(resolve(process.argv[2] ?? ".cache/final-chain")));
