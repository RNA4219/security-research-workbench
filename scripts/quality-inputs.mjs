/** Reject mixed snapshots and incomplete producer results before graph construction. */
export function validateEvidenceInputs({
  identity,
  findings,
  readiness,
  requirements,
  hate,
  precheck,
  manual,
  cases,
  coverage,
  sourceHash,
}) {
  const head = identity.head;
  if (!/^[a-f0-9]{40}$/.test(head) || identity.dirty)
    throw Error("clean snapshot required");
  if (sourceHash !== requirements.source.sha256)
    throw Error("requirements source hash mismatch");
  if (
    !head.startsWith(findings.repo.revision) ||
    findings.repo.dirty ||
    !head.startsWith(readiness.repo.revision)
  )
    throw Error("static snapshot mismatch");
  if (findings.findings.length || readiness.status !== "passed")
    throw Error("unresolved static findings");
  if (precheck.commit_sha !== head || precheck.payload.decision !== "eligible")
    throw Error("ineligible HATE evidence");
  if (
    !hate.length ||
    hate.some((t) => t.commit_sha !== head || t.payload.status !== "passed")
  )
    throw Error("stale or nonpassing test evidence");
  if (
    new Set(hate.map((t) => t.payload.canonical_test_id)).size !== hate.length
  )
    throw Error("duplicate test identity");
  if (
    manual.head !== head ||
    manual.results.length !== cases.manual_cases.length
  )
    throw Error("manual snapshot incomplete");
  for (const c of cases.manual_cases) {
    const matches = manual.results.filter((r) => r.tc_id === c.tc_id);
    if (
      matches.length !== 1 ||
      matches[0].result !== "pass" ||
      !matches[0].actual.length ||
      !matches[0].attachments.length
    )
      throw Error("missing or nonpassing manual observation");
  }
  if (
    coverage.failures?.length ||
    coverage.changed.pct < 90 ||
    Object.entries(coverage.metrics).some(
      ([k, v]) => k !== "branchesTrue" && v.pct < 90,
    )
  )
    throw Error("coverage gate failed");
}

export function createPolicy({
  identity,
  sourceRef,
  policyRef,
  target,
  binding,
  hash,
}) {
  const policy = {
    policyId: "workbench-local-validation-v1",
    profile: "standard",
    effectiveDate: identity.startedAt,
    approver:
      "Codex: user-authorized technical validation policy (not release approval)",
    sourceRefs: [sourceRef(policyRef)],
    dqScope: Array.from(
      { length: 21 },
      (_, i) => "DQ-" + String(i + 1).padStart(2, "0"),
    ),
    exitCodePolicy: { go: 0, conditional_go: 2, no_go: 2, disqualified: 2 },
    inputContract: {
      mode: "native_graph",
      requiredArtifacts: [
        { adapter: "RanD", kind: "requirements_packet" },
        { adapter: "code-to-gate", kind: "release_readiness" },
        { adapter: "junit", kind: "junit" },
        { adapter: "manual-bb-test-harness", kind: "manual_case_set" },
        { adapter: "manual-bb-test-harness", kind: "gate_decision" },
      ],
      evaluationScope: {
        kind: "real_environment",
        target: "Windows local workbench functional regression",
        notEvaluated: [
          "外部環境へのデプロイ承認",
          "他OS・他ブラウザ互換性",
          "未導入OSSの実運用",
        ],
      },
      requireExecutedTests: true,
      sourceRefs: [sourceRef(policyRef)],
    },
    executionPolicy: {
      target,
      maxEvidenceAgeHours: 72,
      buildBindingRef: {
        ...sourceRef(binding),
        contentHash: binding.contentHash,
      },
      sourceRefs: [sourceRef(policyRef)],
    },
  };
  policy.policyHash = hash(JSON.stringify(policy));
  return policy;
}
