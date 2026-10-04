import { describe, expect, it } from "vitest";
import { applyWorkflowCommand } from "../src/server/workflow-domain.js";
import type { WorkflowCommand, WorkflowState } from "../src/shared/workflow.js";
import { scope, workflow } from "./workflow-fixtures.js";

const apply = (state: WorkflowState, command: WorkflowCommand) =>
  applyWorkflowCommand(state, command);

function remediationFixture() {
  let state = workflow();
  state = apply(state, {
    type: "document",
    value: {
      title: "Finding source",
      body: "Issue evidence",
      url: "https://example.test/finding",
      classification: "public",
    },
  });
  const sourceDoc = state.documents[0]!;
  const sourceRef = {
    docId: sourceDoc.id,
    revision: sourceDoc.revision,
    excerpt: "Issue evidence",
  };
  state = apply(state, {
    type: "finding-observation",
    fingerprint: "issue-1",
    targetVersion: scope.version,
    observation: "The issue needs a fix",
    sourceRefs: [sourceRef],
  });
  const findingId = state.findings[0]!.id;
  state = apply(state, {
    type: "finding-decision",
    findingId,
    judgment: "needs_action",
    actor: "reviewer",
    reason: "Confirmed against source",
    targetVersion: scope.version,
    sourceRefs: [sourceRef],
    ruleRefs: [],
  });
  state = apply(state, {
    type: "remediation-start",
    findingId,
    assignee: "dev",
    taskRef: "TASK-1",
    plan: "Fix the reported condition",
    targetVersion: scope.version,
  });
  state = apply(state, {
    type: "remediation-progress",
    findingId,
    status: "in_progress",
    actor: "dev",
    reason: "Started fix",
    targetVersion: scope.version,
  });
  return { state, findingId, sourceDoc, sourceRef };
}

function evidenceDoc(state: WorkflowState) {
  const next = apply(state, {
    type: "document",
    value: {
      title: "Verification evidence",
      body: "Regression test passed",
      url: "https://example.test/verification",
      classification: "public",
    },
  });
  const doc = next.documents.at(-1)!;
  return {
    state: next,
    ref: {
      docId: doc.id,
      revision: doc.revision,
      excerpt: "Regression test passed",
    },
    doc,
  };
}

describe("workflow domain regression review", () => {
  it("moves remediation verification to the current scope version after a version change", () => {
    const { state: initial, findingId } = remediationFixture();
    let state = apply(initial, {
      type: "scope",
      value: { ...scope, version: "def5678" },
    });

    expect(() =>
      apply(state, {
        type: "remediation-progress",
        findingId,
        status: "verification_pending",
        actor: "dev",
        reason: "Fix is committed for the new target version",
        fixCommit: "abcdef012345",
        targetVersion: "def5678",
      }),
    ).not.toThrow();
    state = apply(state, {
      type: "remediation-progress",
      findingId,
      status: "verification_pending",
      actor: "dev",
      reason: "Fix is committed for the new target version",
      fixCommit: "abcdef012345",
      targetVersion: "def5678",
    });
    expect(state.findings[0]?.remediation).toMatchObject({
      status: "verification_pending",
      targetVersion: "def5678",
      fixCommit: "abcdef012345",
    });
  });

  it("does not complete remediation using an older pass after a later failed verification", () => {
    let { state, findingId } = remediationFixture();
    const evidence = evidenceDoc(state);
    state = evidence.state;
    const evidenceRef = evidence.ref;
    state = apply(state, {
      type: "remediation-progress",
      findingId,
      status: "verification_pending",
      actor: "dev",
      reason: "Fix committed",
      fixCommit: "abcdef012345",
      targetVersion: scope.version,
    });
    state = apply(state, {
      type: "verification",
      findingId,
      method: "regression-test",
      rationale: "Current regression suite",
      scope: "Affected feature",
      status: "passed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [evidenceRef],
    });
    state = apply(state, {
      type: "verification",
      findingId,
      method: "regression-test",
      rationale: "Follow-up verification failed",
      scope: "Affected feature",
      status: "failed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [evidenceRef],
    });

    expect(() =>
      apply(state, {
        type: "remediation-complete",
        findingId,
        actor: "reviewer",
        reason: "Should not complete",
        targetVersion: scope.version,
      }),
    ).toThrow();
  });

  it("invalidates completed remediation when its verification evidence document changes", () => {
    let { state, findingId } = remediationFixture();
    const evidence = evidenceDoc(state);
    state = apply(evidence.state, {
      type: "remediation-progress",
      findingId,
      status: "verification_pending",
      actor: "dev",
      reason: "Fix committed",
      fixCommit: "abcdef012345",
      targetVersion: scope.version,
    });
    state = apply(state, {
      type: "verification",
      findingId,
      method: "regression-test",
      rationale: "Current regression suite",
      scope: "Affected feature",
      status: "passed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [evidence.ref],
    });
    state = apply(state, {
      type: "remediation-complete",
      findingId,
      actor: "reviewer",
      reason: "Evidence reviewed",
      targetVersion: scope.version,
    });
    const changed = apply(state, {
      type: "document",
      documentId: evidence.doc.id,
      value: {
        title: evidence.doc.title,
        body: "Evidence document was corrected",
        url: evidence.doc.url,
        classification: "public",
      },
    });
    expect(changed.findings[0]?.remediation?.status).not.toBe("completed");
  });

  it("reopens decisions that depend on a rule when the rule's source document changes", () => {
    let state = workflow();
    state = apply(state, {
      type: "document",
      value: {
        title: "Rule source",
        body: "Rule evidence v1",
        url: "https://example.test/rule-source",
        classification: "public",
      },
    });
    const ruleDoc = state.documents[0]!;
    const ruleRef = {
      docId: ruleDoc.id,
      revision: ruleDoc.revision,
      excerpt: "Rule evidence v1",
    };
    state = apply(state, {
      type: "rule-draft",
      purpose: scope.purpose,
      content: "This condition is not actionable",
      applicability: "Current release",
      sourceRefs: [ruleRef],
    });
    const rule = state.rules[0]!;
    state = apply(state, {
      type: "rule-review",
      ruleId: rule.id,
      decision: "active",
      actor: "reviewer",
      reason: "Reviewed",
    });

    state = apply(state, {
      type: "document",
      value: {
        title: "Finding source",
        body: "Finding evidence",
        url: "https://example.test/finding-source",
        classification: "public",
      },
    });
    const findingDoc = state.documents.find((item) => item.id !== ruleDoc.id)!;
    const findingRef = {
      docId: findingDoc.id,
      revision: findingDoc.revision,
      excerpt: "Finding evidence",
    };
    state = apply(state, {
      type: "finding-observation",
      fingerprint: "issue-1",
      targetVersion: scope.version,
      observation: "Review under current rule",
      sourceRefs: [findingRef],
    });
    const findingId = state.findings[0]!.id;
    state = apply(state, {
      type: "finding-decision",
      findingId,
      judgment: "false_positive",
      actor: "reviewer",
      reason: "Rule says this is acceptable",
      targetVersion: scope.version,
      sourceRefs: [findingRef],
      ruleRefs: [{ id: rule.id, revision: rule.revision }],
    });
    state = apply(state, {
      type: "suppression",
      findingId,
      actor: "reviewer",
      reason: "Current rule applies",
      targetVersion: scope.version,
      fingerprint: "issue-1",
      ruleRefs: [{ id: rule.id, revision: rule.revision }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const changed = apply(state, {
      type: "document",
      documentId: ruleDoc.id,
      value: {
        title: ruleDoc.title,
        body: "Rule evidence v2",
        url: ruleDoc.url,
        classification: "public",
      },
    });
    expect(changed.rules.find((item) => item.id === rule.id)?.status).toBe(
      "stale",
    );
    expect(changed.findings[0]).toMatchObject({
      judgment: "unconfirmed",
      suppressions: [{ active: false }],
    });
  });
});
