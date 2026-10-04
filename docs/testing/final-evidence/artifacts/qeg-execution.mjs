export function executionWriter({
  nodes,
  base,
  spec,
  target,
  identity,
  bridgeVersion,
  add,
  sourceRef,
  edge,
}) {
  function execution(
    testId,
    title,
    layer,
    reqs,
    riskIds,
    codeIds,
    ref,
    completedAt,
    rawSource,
    expectedResults,
  ) {
    const id = {
      producer:
        layer === "manual-scripted"
          ? "workbench-manual-bb-bridge"
          : "workbench-hate-bridge",
      projectId: target.projectId,
      featureId: "WORKBENCH-FINAL",
      caseId: testId,
    };
    nodes.push({
      ...base(testId, "test", title, [ref, spec]),
      layer,
      testExecutionMode: "real",
      existing: true,
      recentGreenRuns: 1,
      executionIdentity: id,
      coveredRequirementIds: reqs,
      coveredRiskIds: riskIds,
      coveredChangedCodeIds: codeIds,
      oracleType: "specified",
      oracleRefs: [{ ...sourceRef(spec), evidenceKind: "spec" }],
      expectedResults,
    });
    const raw = {
      executionVersion: "qeg-execution/v1",
      testId,
      identity: id,
      producerVersion: bridgeVersion,
      runId: "final-" + identity.head.slice(0, 12),
      target,
      completedAt,
      status: "pass",
      executionMode: "real",
    };
    const normalization = add(
      "normalization-" + testId,
      "qeg-native",
      "audit",
      testId + "-normalization.json",
      {
        producerArtifact: sourceRef(ref),
        sourceRecord: rawSource,
        bridgeVersion,
      },
    );
    const rawRef = add(
      "raw-" + testId,
      "qeg-native",
      "execution_evidence",
      testId + "-execution.json",
      raw,
    );
    const verified = { ...sourceRef(rawRef), contentHash: rawRef.contentHash };
    nodes.push({
      ...base("exec-" + testId, "execution_evidence", title + " 実行結果", [
        rawRef,
        ref,
        normalization,
      ]),
      passed: true,
      evidenceRefs: [
        { ...verified, evidenceKind: "test_result", capturedAt: completedAt },
      ],
      execution: { ...raw, rawArtifactRef: verified },
    });
    edge("evidenced_by", testId, "exec-" + testId, rawRef);
    for (const req of reqs) edge("satisfies", testId, req, ref);
  }

  return execution;
}
