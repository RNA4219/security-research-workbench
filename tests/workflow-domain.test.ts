import { describe, expect, it, vi } from "vitest";
import {
  applyWorkflowCommand,
  evaluateFindingSuppression,
  hashFindingReviewContext,
  importResearch,
  isFindingSuppressed,
  newWorkflow,
  workflowContext,
} from "../src/server/workflow-domain.js";
import {
  workflowCommand,
  type WorkflowCommand,
  type WorkflowState,
} from "../src/shared/workflow.js";
import { report, scope, workflow } from "./workflow-fixtures.js";

function apply(state: WorkflowState, command: WorkflowCommand) {
  return applyWorkflowCommand(state, command);
}
function expectAtomicReject(
  state: WorkflowState,
  command: WorkflowCommand | unknown,
) {
  const before = structuredClone(state);
  expect(() =>
    applyWorkflowCommand(state, command as WorkflowCommand),
  ).toThrow();
  expect(state).toEqual(before);
}
function addDoc(
  state: WorkflowState,
  classification: "public" | "local" | "blocked" | "unclassified" = "public",
) {
  const next = apply(state, {
    type: "document",
    value: {
      title: "仕様",
      body: "機能は安全に動作する。利用目的は採用前レビュー。",
      url: `https://example.test/spec-${classification}`,
      classification,
    },
  });
  const doc = next.documents.at(-1)!;
  return {
    state: next,
    ref: {
      docId: doc.id,
      revision: doc.revision,
      excerpt: "機能は安全に動作する",
    },
    id: doc.id,
  };
}
function addKnowledge(
  state: WorkflowState,
  ref: { docId: string; revision: number; excerpt: string },
  content = "機能は安全に動作する",
) {
  let next = apply(state, {
    type: "knowledge-draft",
    purpose: scope.purpose,
    content,
    sourceRefs: [ref],
    origin: "manual",
  });
  const knowledgeId = next.knowledge.at(-1)!.id;
  next = apply(next, {
    type: "knowledge-review",
    knowledgeId,
    decision: "active",
    actor: "reviewer",
    reason: "原文と一致",
  });
  return { state: next, knowledgeId };
}
function addRule(
  state: WorkflowState,
  ref: { docId: string; revision: number; excerpt: string },
  content = "同じ前提を適用する",
) {
  let next = apply(state, {
    type: "rule-draft",
    purpose: scope.purpose,
    content,
    applicability: "採用前",
    sourceRefs: [ref],
  });
  const ruleId = next.rules[0]!.id;
  next = apply(next, {
    type: "rule-review",
    ruleId,
    decision: "active",
    actor: "reviewer",
    reason: "範囲を確認",
  });
  return { state: next, ruleId };
}
function addFinding(
  state: WorkflowState,
  ref?: { docId: string; revision: number; excerpt: string },
  fingerprint = "issue-1",
) {
  const next = apply(state, {
    type: "finding-observation",
    fingerprint,
    targetVersion: scope.version,
    observation: "確認が必要",
    sourceRefs: ref ? [ref] : [],
  });
  return { state: next, findingId: next.findings.at(-1)!.id };
}
function decide(
  state: WorkflowState,
  findingId: string,
  ref: { docId: string; revision: number; excerpt: string },
  judgment:
    | "needs_action"
    | "false_positive"
    | "duplicate"
    | "accepted_known" = "needs_action",
  ruleRefs: { id: string; revision: number }[] = [],
) {
  return apply(state, {
    type: "finding-decision",
    findingId,
    judgment,
    actor: "reviewer",
    reason: "原文と条件を確認",
    targetVersion: scope.version,
    sourceRefs: [ref],
    ruleRefs,
  });
}

describe("Workflowの共有domain", () => {
  it("作成時に独立した空状態を返し、strict command schemaで未知fieldを拒否する", () => {
    const one = workflow();
    const two = newWorkflow("project-1", scope);
    expect(one).not.toBe(two);
    expect(one).toMatchObject({
      projectId: "project-1",
      revision: 1,
      documents: [],
      knowledge: [],
      rules: [],
      findings: [],
      queries: [],
      events: [],
      imports: [],
    });
    expect(
      workflowCommand.safeParse({
        type: "document",
        value: { title: "x", body: "y", classification: "public", extra: true },
      }).success,
    ).toBe(false);
    expect(workflowCommand.safeParse({ type: "surprise" }).success).toBe(false);
    expectAtomicReject(one, {
      type: "scope",
      value: { ...scope, surprise: true },
    });
    expect(newWorkflow("project-default").scope.target).toBe("未設定");
    const sameScope = apply(one, { type: "scope", value: scope });
    expect(sameScope.events).toHaveLength(0);
  });

  it("重複資料と不存在の対象を扱い、失敗時に状態を保つ", () => {
    let state = workflow();
    const value = {
      title: "仕様",
      body: "同じ内容",
      url: "https://example.test/spec",
      classification: "public" as const,
    };
    state = apply(state, { type: "document", value });
    const originalId = state.documents[0]!.id;
    state = apply(state, { type: "document", value });
    expect(state.documents).toHaveLength(1);
    expect(state.documents[0]!.id).toBe(originalId);
    expectAtomicReject(state, {
      type: "document",
      value: { ...value, classification: "local" },
    });
    expectAtomicReject(state, {
      type: "document",
      documentId: "missing",
      value,
    });
    expectAtomicReject(state, {
      type: "knowledge-draft",
      knowledgeId: "missing",
      purpose: scope.purpose,
      content: "x",
      sourceRefs: [{ docId: originalId, revision: 1, excerpt: "同じ内容" }],
      origin: "manual",
    });
    expectAtomicReject(state, {
      type: "knowledge-draft",
      supersedes: { id: "missing", revision: 1 },
      purpose: scope.purpose,
      content: "x",
      sourceRefs: [{ docId: originalId, revision: 1, excerpt: "同じ内容" }],
      origin: "manual",
    });
    expectAtomicReject(state, {
      type: "knowledge-review",
      knowledgeId: "missing",
      decision: "active",
      actor: "reviewer",
      reason: "x",
    });
    expectAtomicReject(state, {
      type: "rule-draft",
      ruleId: "missing",
      purpose: scope.purpose,
      content: "x",
      applicability: "x",
      sourceRefs: [{ docId: originalId, revision: 1, excerpt: "同じ内容" }],
    });
    expectAtomicReject(state, {
      type: "rule-review",
      ruleId: "missing",
      decision: "active",
      actor: "reviewer",
      reason: "x",
    });
    expectAtomicReject(state, {
      type: "finding-decision",
      findingId: "missing",
      judgment: "needs_action",
      actor: "reviewer",
      reason: "x",
      targetVersion: scope.version,
      sourceRefs: [{ docId: originalId, revision: 1, excerpt: "同じ内容" }],
      ruleRefs: [],
    });
  });

  it("資料を版/hash付きで保持し、内容変更で根拠のある知識・基準・判定・抑止を失効する", () => {
    let state = workflow();
    const doc = addDoc(state);
    state = doc.state;
    const knowledge = addKnowledge(state, doc.ref);
    state = knowledge.state;
    const rule = addRule(state, doc.ref);
    state = rule.state;
    const finding = addFinding(state, doc.ref);
    state = decide(
      finding.state,
      finding.findingId,
      doc.ref,
      "false_positive",
      [{ id: rule.ruleId, revision: 1 }],
    );
    state = apply(state, {
      type: "suppression",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "同条件",
      targetVersion: scope.version,
      fingerprint: "issue-1",
      ruleRefs: [{ id: rule.ruleId, revision: 1 }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(
      isFindingSuppressed(
        state,
        state.findings[0]!,
        Date.parse("2098-01-01T00:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isFindingSuppressed(
        state,
        state.findings[0]!,
        Date.parse("2100-01-01T00:00:00.000Z"),
      ),
    ).toBe(false);
    const changed = apply(state, {
      type: "document",
      documentId: doc.id,
      value: {
        title: "仕様改訂",
        body: "機能は安全に動作する。変更版です。",
        url: "https://example.test/spec",
        classification: "public",
      },
    });
    expect(changed.documents[0]).toMatchObject({
      revision: 2,
      history: [{ revision: 1, hash: expect.any(String) }],
    });
    expect(
      changed.knowledge.find((item) => item.id === knowledge.knowledgeId)
        ?.status,
    ).toBe("stale");
    expect(changed.rules.find((item) => item.id === rule.ruleId)?.status).toBe(
      "stale",
    );
    expect(changed.findings[0]).toMatchObject({
      judgment: "unconfirmed",
      suppressions: [{ active: false }],
    });
    expect(
      changed.events.some((event) => event.type === "finding-review-required"),
    ).toBe(true);
    expect(state.documents[0]!.revision).toBe(1);
    const unchanged = apply(changed, {
      type: "document",
      documentId: doc.id,
      value: {
        title: "仕様改訂",
        body: "機能は安全に動作する。変更版です。",
        url: "https://example.test/spec",
        classification: "public",
      },
    });
    expect(unchanged.events).toHaveLength(changed.events.length);
  });

  it("知識案の承認・却下と原文照合を守り、更新案が旧有効知識を上書きしない", () => {
    let state = workflow();
    const doc = addDoc(state);
    state = doc.state;
    const active = addKnowledge(state, doc.ref);
    state = active.state;
    expectAtomicReject(state, {
      type: "knowledge-draft",
      knowledgeId: active.knowledgeId,
      purpose: scope.purpose,
      content: "変更案",
      sourceRefs: [doc.ref],
      origin: "query",
    });
    expectAtomicReject(state, {
      type: "knowledge-draft",
      purpose: scope.purpose,
      content: "根拠なし",
      sourceRefs: [{ ...doc.ref, excerpt: "存在しない原文" }],
      origin: "manual",
    });
    let draft = apply(state, {
      type: "knowledge-draft",
      purpose: scope.purpose,
      content: "次の案",
      sourceRefs: [doc.ref],
      origin: "query",
    });
    const draftId = draft.knowledge[1]!.id;
    draft = apply(draft, {
      type: "knowledge-review",
      knowledgeId: draftId,
      decision: "rejected",
      actor: "reviewer",
      reason: "根拠が不足",
    });
    expect(
      draft.knowledge.find((item) => item.id === active.knowledgeId)?.status,
    ).toBe("active");
    expect(draft.knowledge.find((item) => item.id === draftId)).toMatchObject({
      status: "rejected",
      actor: "reviewer",
      reason: "根拠が不足",
    });
    expectAtomicReject(draft, {
      type: "knowledge-review",
      knowledgeId: draftId,
      decision: "active",
      actor: "reviewer",
      reason: "再承認",
    });
    const changedDoc = apply(state, {
      type: "document",
      documentId: doc.id,
      value: {
        title: "仕様",
        body: "新しい原文",
        url: "https://example.test/spec",
        classification: "public",
      },
    });
    const staleDraft = apply(changedDoc, {
      type: "knowledge-draft",
      purpose: scope.purpose,
      content: "古い原文を使う案",
      sourceRefs: [doc.ref],
      origin: "manual",
    });
    expectAtomicReject(staleDraft, {
      type: "knowledge-review",
      knowledgeId: staleDraft.knowledge[1]!.id,
      decision: "active",
      actor: "reviewer",
      reason: "古い",
    });
  });

  it("知識の更新案は承認まで旧版を保ち、承認後に旧版を失効して新revisionを使う", () => {
    const doc = addDoc(workflow());
    const active = addKnowledge(doc.state, doc.ref);
    const old = active.state.knowledge[0]!;
    let proposal = apply(active.state, {
      type: "knowledge-draft",
      supersedes: { id: old.id, revision: old.revision },
      purpose: scope.purpose,
      content: "承認後に採用する新しい仕様",
      sourceRefs: [doc.ref],
      origin: "query",
    });
    expect(proposal.knowledge).toMatchObject([
      { status: "active", revision: 1 },
      { status: "draft", revision: 2, supersedes: { id: old.id, revision: 1 } },
    ]);
    expect(workflowContext(proposal, "q", "manual").knowledge).toHaveLength(1);
    const newVersion = proposal.knowledge[1]!;
    proposal = apply(proposal, {
      type: "knowledge-review",
      knowledgeId: newVersion.id,
      decision: "active",
      actor: "reviewer",
      reason: "新しい出典を確認",
    });
    expect(proposal.knowledge).toMatchObject([
      { status: "stale", revision: 1 },
      { status: "active", revision: 2 },
    ]);
    expect(workflowContext(proposal, "q", "manual").knowledge).toMatchObject([
      { id: old.id, revision: 2, content: "承認後に採用する新しい仕様" },
    ]);
    expectAtomicReject(proposal, {
      type: "query",
      question: "q",
      providerKind: "manual",
      knowledge: [{ id: old.id, revision: 1 }],
      rules: [],
    });
    expectAtomicReject(proposal, {
      type: "knowledge-draft",
      supersedes: { id: old.id, revision: 1 },
      purpose: scope.purpose,
      content: "二重更新案",
      sourceRefs: [doc.ref],
      origin: "manual",
    });
  });

  it("対象版が変わって失効した知識から現在版の更新案を作り直せる", () => {
    const doc = addDoc(workflow());
    const active = addKnowledge(doc.state, doc.ref);
    const old = active.state.knowledge[0]!;
    const newScope = { ...scope, version: "new-target-version" };
    let state = apply(active.state, { type: "scope", value: newScope });
    expect(state.knowledge[0]?.status).toBe("stale");
    state = apply(state, {
      type: "knowledge-draft",
      supersedes: { id: old.id, revision: 1 },
      purpose: scope.purpose,
      content: "新対象版を確認済み",
      sourceRefs: [doc.ref],
      origin: "manual",
    });
    state = apply(state, {
      type: "knowledge-review",
      knowledgeId: old.id,
      decision: "active",
      actor: "reviewer",
      reason: "新対象版で再確認",
    });
    expect(state.knowledge).toMatchObject([
      { status: "stale", revision: 1 },
      { status: "active", revision: 2 },
    ]);
    expect(workflowContext(state, "q", "manual")).toMatchObject({
      targetVersion: "new-target-version",
      knowledge: [{ revision: 2 }],
    });
  });

  it("問い合わせに案件・目的・有効版と情報区分を適用し、不足・矛盾を返す", () => {
    let state = workflow();
    const pub = addDoc(state, "public");
    state = pub.state;
    const local = addDoc(state, "local");
    state = local.state;
    const pubKnowledge = addKnowledge(state, pub.ref, "Service retains logs");
    state = pubKnowledge.state;
    const localKnowledge = addKnowledge(
      state,
      local.ref,
      "Service retains logs not",
    );
    state = localKnowledge.state;
    const rule = addRule(state, pub.ref);
    state = rule.state;
    expect(workflowContext(workflow(), "question", "manual")).toMatchObject({
      knowledge: [],
      uncertainty: "insufficient",
    });
    const context = workflowContext(state, "question", "local");
    expect(context).toMatchObject({
      target: scope.target,
      targetVersion: scope.version,
      purpose: scope.purpose,
      uncertainty: "conflict",
    });
    expect(context.knowledge).toHaveLength(2);
    expect(context.rules[0]).toMatchObject({
      appliesToVersion: scope.version,
      classifications: ["public"],
    });
    expect(workflowContext(state, "question", "cloud").knowledge).toHaveLength(
      1,
    );
    expect(
      workflowContext(state, "question", "cloud").knowledge[0]?.classifications,
    ).toEqual(["public"]);
    expectAtomicReject(state, {
      type: "query",
      question: "q",
      providerKind: "cloud",
      knowledge: [{ id: localKnowledge.knowledgeId, revision: 1 }],
      rules: [],
    });
    expectAtomicReject(state, {
      type: "query",
      question: "q",
      providerKind: "local",
      knowledge: [{ id: pubKnowledge.knowledgeId, revision: 9 }],
      rules: [],
    });
    const noKnowledge = apply(state, {
      type: "query",
      question: "q",
      providerKind: "local",
      knowledge: [],
      rules: [],
      uncertainty: "none",
    });
    expect(noKnowledge.queries.at(-1)?.uncertainty).toBe("insufficient");
    expectAtomicReject(noKnowledge, {
      type: "query",
      question: "q",
      providerKind: "local",
      knowledge: [],
      rules: [],
      answer: "根拠なし回答",
    });
    const recorded = apply(state, {
      type: "query",
      queryId: "query-1",
      question: "question",
      providerKind: "local",
      knowledge: [
        { id: pubKnowledge.knowledgeId, revision: 1 },
        { id: localKnowledge.knowledgeId, revision: 1 },
      ],
      rules: [{ id: rule.ruleId, revision: 1 }],
      answer: "未確認",
      uncertainty: "none",
    });
    expect(recorded.queries[0]).toMatchObject({
      target: scope.target,
      targetVersion: scope.version,
      knowledge: [{ revision: 1 }, { revision: 1 }],
      rules: [{ revision: 1 }],
      uncertainty: "conflict",
    });
    expectAtomicReject(recorded, {
      type: "query",
      queryId: "query-1",
      question: "again",
      providerKind: "manual",
      knowledge: [{ id: pubKnowledge.knowledgeId, revision: 1 }],
      rules: [],
    });
    const blocked = addDoc(workflow(), "blocked");
    const blockedKnowledge = addKnowledge(blocked.state, blocked.ref);
    expectAtomicReject(blockedKnowledge.state, {
      type: "query",
      providerKind: "manual",
      question: "q",
      knowledge: [{ id: blockedKnowledge.knowledgeId, revision: 1 }],
      rules: [],
    });
    const unclassified = addDoc(workflow(), "unclassified");
    const unclassifiedKnowledge = addKnowledge(
      unclassified.state,
      unclassified.ref,
    );
    expect(() =>
      workflowContext(unclassifiedKnowledge.state, "q", "local"),
    ).toThrow(/未分類/);
  });

  it("判定基準の適用対象版は自由記述ではなく現在のtarget版に完全一致する", () => {
    const doc = addDoc(workflow());
    let state = apply(doc.state, {
      type: "rule-draft",
      purpose: scope.purpose,
      content: "v2だけの基準",
      applicability: "導入時",
      appliesToVersion: "v2",
      sourceRefs: [doc.ref],
    });
    const ruleId = state.rules[0]!.id;
    state = apply(state, {
      type: "rule-review",
      ruleId,
      decision: "active",
      actor: "reviewer",
      reason: "v2適用を確認",
    });
    expect(state.rules[0]).toMatchObject({
      appliesToVersion: "v2",
      status: "active",
    });
    expect(workflowContext(state, "question", "manual").rules).toEqual([]);
    const finding = addFinding(state, doc.ref);
    expectAtomicReject(state, {
      type: "query",
      question: "question",
      providerKind: "manual",
      knowledge: [],
      rules: [{ id: ruleId, revision: 1 }],
    });
    expectAtomicReject(finding.state, {
      type: "finding-decision",
      findingId: finding.findingId,
      judgment: "needs_action",
      actor: "reviewer",
      reason: "対象版が異なる基準を除外",
      targetVersion: scope.version,
      sourceRefs: [doc.ref],
      ruleRefs: [{ id: ruleId, revision: 1 }],
    });
  });

  it("判定基準の承認は関連判断だけを再確認へ戻し、古い根拠は承認させない", () => {
    let state = workflow();
    const doc = addDoc(state);
    state = doc.state;
    const firstRule = addRule(state, doc.ref);
    state = firstRule.state;
    const first = addFinding(state, doc.ref);
    const second = addFinding(first.state, undefined, "issue-2");
    state = decide(second.state, first.findingId, doc.ref, "needs_action", [
      { id: firstRule.ruleId, revision: 1 },
    ]);
    state = decide(state, second.findingId, doc.ref, "needs_action");
    state = apply(state, {
      type: "rule-draft",
      purpose: scope.purpose,
      content: "基準版2",
      applicability: "採用前",
      sourceRefs: [doc.ref],
    });
    const draftRuleId = state.rules[1]!.id;
    state = apply(state, {
      type: "rule-review",
      ruleId: draftRuleId,
      decision: "active",
      actor: "reviewer",
      reason: "条件変更",
    });
    expect(
      state.findings.find((item) => item.id === first.findingId)?.judgment,
    ).toBe("unconfirmed");
    expect(
      state.findings.find((item) => item.id === second.findingId)?.judgment,
    ).toBe("needs_action");
    const updated = apply(state, {
      type: "document",
      documentId: doc.id,
      value: {
        title: "仕様",
        body: "新仕様",
        url: "https://example.test/spec",
        classification: "public",
      },
    });
    const staleRule = apply(updated, {
      type: "rule-draft",
      purpose: scope.purpose,
      content: "古い基準案",
      applicability: "採用前",
      sourceRefs: [doc.ref],
    });
    expectAtomicReject(staleRule, {
      type: "rule-review",
      ruleId: staleRule.rules.at(-1)!.id,
      decision: "active",
      actor: "reviewer",
      reason: "古い",
    });
  });

  it("判定基準の更新案も承認までv1を保ち、承認で参照した指摘だけを再確認へ戻す", () => {
    const doc = addDoc(workflow());
    const rule = addRule(doc.state, doc.ref);
    const old = rule.state.rules[0]!;
    const affected = addFinding(rule.state, doc.ref);
    const unrelated = addFinding(affected.state, undefined, "other-issue");
    let state = decide(
      unrelated.state,
      affected.findingId,
      doc.ref,
      "needs_action",
      [{ id: old.id, revision: old.revision }],
    );
    state = decide(state, unrelated.findingId, doc.ref, "needs_action");
    state = apply(state, {
      type: "rule-draft",
      supersedes: { id: old.id, revision: old.revision },
      purpose: scope.purpose,
      content: "新しい判定基準",
      applicability: "採用前",
      sourceRefs: [doc.ref],
    });
    expect(state.rules[0]?.status).toBe("active");
    expect(
      state.findings.find((item) => item.id === affected.findingId)?.judgment,
    ).toBe("needs_action");
    state = apply(state, {
      type: "rule-review",
      ruleId: old.id,
      decision: "active",
      actor: "reviewer",
      reason: "新基準を承認",
    });
    expect(state.rules).toMatchObject([
      { status: "stale", revision: 1 },
      { status: "active", revision: 2 },
    ]);
    expect(
      state.findings.find((item) => item.id === affected.findingId)?.judgment,
    ).toBe("unconfirmed");
    expect(
      state.findings.find((item) => item.id === unrelated.findingId)?.judgment,
    ).toBe("needs_action");
  });

  it("過去資料版や過去案件版の根拠から指摘を確定しない", () => {
    const doc = addDoc(workflow());
    const finding = addFinding(doc.state, doc.ref);
    const changed = apply(finding.state, {
      type: "document",
      documentId: doc.id,
      value: {
        title: "仕様v2",
        body: "新版仕様です",
        url: `https://example.test/spec-${"public"}`,
        classification: "public",
      },
    });
    const currentRef = { docId: doc.id, revision: 2, excerpt: "新版仕様" };
    expectAtomicReject(changed, {
      type: "finding-decision",
      findingId: finding.findingId,
      judgment: "needs_action",
      actor: "reviewer",
      reason: "旧根拠",
      targetVersion: scope.version,
      sourceRefs: [doc.ref],
      ruleRefs: [],
    });
    const changedScope = apply(changed, {
      type: "scope",
      value: { ...scope, version: "new-target-version" },
    });
    expectAtomicReject(changedScope, {
      type: "finding-decision",
      findingId: finding.findingId,
      judgment: "needs_action",
      actor: "reviewer",
      reason: "過去案件版",
      targetVersion: scope.version,
      sourceRefs: [currentRef],
      ruleRefs: [],
    });
  });

  it("同じ指摘を関連付け、条件付き抑止と期限・対象版・基準変更を適用する", () => {
    let state = workflow();
    const doc = addDoc(state);
    state = doc.state;
    const rule = addRule(state, doc.ref);
    state = rule.state;
    const finding = addFinding(state, doc.ref);
    state = decide(
      finding.state,
      finding.findingId,
      doc.ref,
      "accepted_known",
      [{ id: rule.ruleId, revision: 1 }],
    );
    state = apply(state, {
      type: "suppression",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "現在の仕様",
      targetVersion: scope.version,
      fingerprint: "issue-1",
      ruleRefs: [{ id: rule.ruleId, revision: 1 }],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(state.findings[0]!.suppressions[0]).toMatchObject({
      decisionRevision: 2,
      sourceRefs: [doc.ref],
    });
    expect(
      isFindingSuppressed(
        state,
        state.findings[0]!,
        Date.parse("2098-01-01T00:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isFindingSuppressed(
        state,
        state.findings[0]!,
        Date.parse("2100-01-01T00:00:00.000Z"),
      ),
    ).toBe(false);
    const duplicate = apply(state, {
      type: "finding-observation",
      fingerprint: "issue-1",
      targetVersion: scope.version,
      observation: "確認が必要",
      sourceRefs: [doc.ref],
    });
    expect(duplicate.findings).toHaveLength(1);
    expect(duplicate.findings[0]!.sourceRefs).toHaveLength(1);
    expect(duplicate.findings[0]!.judgment).toBe("accepted_known");
    expect(duplicate.findings[0]!.observationHistory).toHaveLength(2);
    expect(duplicate.findings[0]!.observationHistory[0]?.observation).toBe(
      "確認が必要",
    );
    expectAtomicReject(duplicate, {
      type: "finding-observation",
      findingId: finding.findingId,
      fingerprint: "different-issue",
      targetVersion: scope.version,
      observation: "ID collision",
      sourceRefs: [],
    });
    const changedObservation = apply(duplicate, {
      type: "finding-observation",
      fingerprint: "issue-1",
      targetVersion: scope.version,
      observation: "根拠に変化がある",
      sourceRefs: [],
    });
    expect(changedObservation.findings[0]).toMatchObject({
      judgment: "unconfirmed",
      suppressions: [{ active: false }],
      observationHistory: [
        { observation: "確認が必要" },
        { observation: "確認が必要" },
        { observation: "根拠に変化がある" },
      ],
    });
    expect(
      decide(duplicate, finding.findingId, doc.ref, "accepted_known", [
        { id: rule.ruleId, revision: 1 },
      ]).findings[0]!.suppressions[0]!.active,
    ).toBe(false);
    expectAtomicReject(state, {
      type: "suppression",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "wrong",
      targetVersion: "other",
      fingerprint: "issue-1",
      ruleRefs: [],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expectAtomicReject(state, {
      type: "suppression",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "wrong",
      targetVersion: scope.version,
      fingerprint: "other",
      ruleRefs: [],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expectAtomicReject(state, {
      type: "suppression",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "wrong rule",
      targetVersion: scope.version,
      fingerprint: "issue-1",
      ruleRefs: [],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expectAtomicReject(state, {
      type: "suppression",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "expired",
      targetVersion: scope.version,
      fingerprint: "issue-1",
      ruleRefs: [],
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const changedScope = apply(state, {
      type: "scope",
      value: { ...scope, version: "def5678" },
    });
    expect(changedScope.findings[0]).toMatchObject({
      judgment: "unconfirmed",
      suppressions: [{ active: false }],
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
    const expired = apply(duplicate, {
      type: "finding-observation",
      fingerprint: "issue-1",
      targetVersion: scope.version,
      observation: "期限後",
      sourceRefs: [],
    });
    vi.useRealTimers();
    expect(expired.findings[0]).toMatchObject({
      judgment: "unconfirmed",
      suppressions: [{ active: false }],
    });
  });

  it("診断用抑止helperは現行contextとevidenceが一致した人判断だけ再利用する", () => {
    let state = workflow();
    const doc = addDoc(state);
    state = doc.state;
    const finding = addFinding(state, doc.ref);
    state = finding.state;
    const contextHash = "a".repeat(64);
    const evidenceHash = "b".repeat(64);
    state = apply(state, {
      type: "finding-observation",
      findingId: finding.findingId,
      fingerprint: "issue-1",
      targetVersion: scope.version,
      observation: "確認が必要",
      sourceRefs: [doc.ref],
      contextHash,
      evidenceHash,
    });
    state = decide(state, finding.findingId, doc.ref, "accepted_known");
    state = apply(state, {
      type: "suppression",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "現行仕様で確認済み",
      targetVersion: scope.version,
      fingerprint: "issue-1",
      ruleRefs: [],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const current = state.findings[0]!;
    expect(
      evaluateFindingSuppression(state, current, {
        contextHash,
        evidenceHash,
      }),
    ).toMatchObject({
      reusable: true,
      status: "active",
      reason: "active",
      decisionRevision: 2,
      judgment: "accepted_known",
    });
    expect(
      evaluateFindingSuppression(state, current, {
        contextHash: "c".repeat(64),
        evidenceHash,
      }),
    ).toMatchObject({
      reusable: false,
      status: "invalidated",
      reason: "context_changed",
    });
    expect(
      evaluateFindingSuppression(state, current, {
        contextHash,
        evidenceHash: "d".repeat(64),
      }),
    ).toMatchObject({
      reusable: false,
      status: "invalidated",
      reason: "evidence_changed",
    });
    expect(
      evaluateFindingSuppression(
        state,
        current,
        {
          contextHash,
          evidenceHash,
        },
        Date.parse("2100-01-01T00:00:00.000Z"),
      ),
    ).toMatchObject({ reusable: false, status: "expired", reason: "expired" });
    expect(evaluateFindingSuppression(state, current)).toMatchObject({
      reusable: true,
      status: "active",
    });
    const activeDecisionChanged = structuredClone(state);
    activeDecisionChanged.findings[0]!.suppressions[0]!.decisionRevision = 999;
    expect(
      evaluateFindingSuppression(
        activeDecisionChanged,
        activeDecisionChanged.findings[0]!,
      ),
    ).toMatchObject({
      reusable: false,
      status: "invalidated",
      reason: "latest_decision_changed",
    });
    const activeSourceChanged = structuredClone(state);
    activeSourceChanged.findings[0]!.suppressions[0]!.sourceRefs[0]!.excerpt =
      "出典にない引用";
    expect(
      evaluateFindingSuppression(
        activeSourceChanged,
        activeSourceChanged.findings[0]!,
      ),
    ).toMatchObject({
      reusable: false,
      status: "invalidated",
      reason: "source_changed",
    });
    const activeJudgmentChanged = structuredClone(state);
    activeJudgmentChanged.findings[0]!.judgment = "unconfirmed";
    expect(
      evaluateFindingSuppression(
        activeJudgmentChanged,
        activeJudgmentChanged.findings[0]!,
      ),
    ).toMatchObject({
      reusable: false,
      status: "invalidated",
      reason: "judgment_changed",
    });
    const inactive = structuredClone(state);
    inactive.findings[0]!.suppressions[0]!.active = false;
    expect(
      evaluateFindingSuppression(inactive, inactive.findings[0]!, {
        contextHash,
        evidenceHash,
      }),
    ).toMatchObject({
      reusable: false,
      status: "missing",
      reason: "no_active_suppression",
    });
    const inactiveContextChanged = structuredClone(inactive);
    inactiveContextChanged.findings[0]!.observationHistory.at(-1)!.contextHash =
      "c".repeat(64);
    expect(
      evaluateFindingSuppression(
        inactiveContextChanged,
        inactiveContextChanged.findings[0]!,
        { contextHash, evidenceHash },
      ),
    ).toMatchObject({
      reusable: false,
      status: "invalidated",
      reason: "context_changed",
    });
    const inactiveEvidenceChanged = structuredClone(inactive);
    inactiveEvidenceChanged.findings[0]!.observationHistory.at(
      -1,
    )!.evidenceHash = "d".repeat(64);
    expect(
      evaluateFindingSuppression(
        inactiveEvidenceChanged,
        inactiveEvidenceChanged.findings[0]!,
        { contextHash, evidenceHash },
      ),
    ).toMatchObject({
      reusable: false,
      status: "invalidated",
      reason: "evidence_changed",
    });
    const changedDecision = decide(
      state,
      finding.findingId,
      doc.ref,
      "needs_action",
    );
    expect(
      evaluateFindingSuppression(
        changedDecision,
        changedDecision.findings[0]!,
        {
          contextHash,
          evidenceHash,
        },
      ),
    ).toMatchObject({
      reusable: false,
      status: "invalidated",
      reason: "latest_decision_changed",
    });
    let legacyState = workflow();
    const legacyDoc = addDoc(legacyState);
    legacyState = legacyDoc.state;
    const legacyFinding = addFinding(legacyState, legacyDoc.ref);
    legacyState = decide(
      legacyFinding.state,
      legacyFinding.findingId,
      legacyDoc.ref,
      "accepted_known",
    );
    legacyState = apply(legacyState, {
      type: "suppression",
      findingId: legacyFinding.findingId,
      actor: "reviewer",
      reason: "旧データ",
      targetVersion: scope.version,
      fingerprint: "issue-1",
      ruleRefs: [],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(
      evaluateFindingSuppression(legacyState, legacyState.findings[0]!, {
        contextHash,
        evidenceHash,
      }),
    ).toMatchObject({
      reusable: false,
      status: "unknown",
      reason: "legacy_context_unknown",
    });
    expect(
      hashFindingReviewContext({
        targetVersion: scope.version,
        purpose: scope.purpose,
        specificationRevision: 1,
        specificationHash: "e".repeat(64),
        knowledge: [],
        rules: [],
      }),
    ).toMatch(/^[a-f0-9]{64}$/);
    const context = {
      targetVersion: scope.version,
      purpose: scope.purpose,
      specificationRevision: 1,
      specificationHash: "e".repeat(64),
      knowledge: [],
      rules: [],
      pastJudgments: [
        {
          findingId: "other-finding",
          revision: 2,
          targetVersion: scope.version,
          judgment: "accepted_known" as const,
          reason: "現行条件で確認済み",
          sourceRefs: [doc.ref],
        },
      ],
    };
    expect(
      hashFindingReviewContext({
        ...context,
        pastJudgments: context.pastJudgments.map((judgment) => ({
          ...judgment,
          sourceRefs: [...judgment.sourceRefs].reverse(),
        })),
      }),
    ).toBe(hashFindingReviewContext(context));
    expect(
      hashFindingReviewContext({
        ...context,
        pastJudgments: context.pastJudgments.map((judgment) => ({
          ...judgment,
          reason: "別の判断理由",
        })),
      }),
    ).not.toBe(hashFindingReviewContext(context));
    expect(
      hashFindingReviewContext({
        ...context,
        metadata: { diagnosticMethodologyHash: "f".repeat(64) },
      }),
    ).not.toBe(hashFindingReviewContext(context));
  });

  it("修正を確認証跡と人の判断が揃うまで完了させない", () => {
    let state = workflow();
    const doc = addDoc(state);
    state = doc.state;
    const finding = addFinding(state, doc.ref);
    state = decide(finding.state, finding.findingId, doc.ref);
    expectAtomicReject(state, {
      type: "remediation-start",
      findingId: finding.findingId,
      assignee: "dev",
      taskRef: "TASK-1",
      plan: "既知の修正計画",
      targetVersion: "wrong",
    });
    state = apply(state, {
      type: "remediation-start",
      findingId: finding.findingId,
      assignee: "dev",
      taskRef: "TASK-1",
      plan: "修正箇所を更新して再確認する",
      targetVersion: scope.version,
    });
    expectAtomicReject(state, {
      type: "remediation-progress",
      findingId: finding.findingId,
      status: "verification_pending",
      actor: "dev",
      reason: "修正済み",
      fixCommit: "abcdef0",
      targetVersion: scope.version,
    });
    state = apply(state, {
      type: "remediation-progress",
      findingId: finding.findingId,
      status: "in_progress",
      actor: "dev",
      reason: "着手",
      targetVersion: scope.version,
    });
    expectAtomicReject(state, {
      type: "remediation-progress",
      findingId: finding.findingId,
      status: "verification_pending",
      actor: "dev",
      reason: "修正済み",
      targetVersion: scope.version,
    });
    state = apply(state, {
      type: "remediation-progress",
      findingId: finding.findingId,
      status: "verification_pending",
      actor: "dev",
      reason: "修正済み",
      fixCommit: "abcdef0123",
      targetVersion: scope.version,
    });
    expectAtomicReject(state, {
      type: "remediation-complete",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "完了",
      targetVersion: scope.version,
    });
    expectAtomicReject(state, {
      type: "verification",
      findingId: finding.findingId,
      method: "normal-function-test",
      rationale: "通常動作",
      scope: "対象機能",
      status: "passed",
      actor: "reviewer",
      targetVersion: "other",
      evidence: [],
    });
    state = apply(state, {
      type: "verification",
      findingId: finding.findingId,
      method: "normal-function-test",
      rationale: "通常動作",
      scope: "対象機能",
      status: "passed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [],
    });
    expectAtomicReject(state, {
      type: "remediation-complete",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "証跡がない",
      targetVersion: scope.version,
    });
    const restricted = apply(state, {
      type: "scope",
      value: { ...scope, allowedMethods: ["static-review"] },
    });
    expectAtomicReject(restricted, {
      type: "verification",
      findingId: finding.findingId,
      method: "normal-function-test",
      rationale: "通常動作",
      scope: "対象機能",
      status: "passed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [doc.ref],
    });
    state = apply(state, {
      type: "verification",
      findingId: finding.findingId,
      method: "static-review",
      rationale: "差分を確認",
      scope: "変更箇所",
      status: "passed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [doc.ref],
    });
    state = apply(state, {
      type: "verification",
      findingId: finding.findingId,
      method: "static-review",
      rationale: "再確認で失敗",
      scope: "変更箇所",
      status: "failed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [doc.ref],
    });
    state = apply(state, {
      type: "verification",
      findingId: finding.findingId,
      method: "manual-review",
      rationale: "別方法は成功",
      scope: "変更箇所",
      status: "passed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [doc.ref],
    });
    expectAtomicReject(state, {
      type: "remediation-complete",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "別方法の成功で失敗結果を消さない",
      targetVersion: scope.version,
    });
    state = apply(state, {
      type: "verification",
      findingId: finding.findingId,
      method: "static-review",
      rationale: "差分を再確認",
      scope: "変更箇所",
      status: "passed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [doc.ref],
    });
    state = apply(state, {
      type: "verification",
      findingId: finding.findingId,
      method: "normal-function-test",
      rationale: "通常動作を証跡付きで再確認",
      scope: "対象機能",
      status: "passed",
      actor: "reviewer",
      targetVersion: scope.version,
      evidence: [doc.ref],
    });
    expectAtomicReject(state, {
      type: "remediation-complete",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "完了",
      targetVersion: "other",
    });
    const complete = apply(state, {
      type: "remediation-complete",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "対象版の証跡を確認",
      targetVersion: scope.version,
    });
    expect(complete.findings[0]!.remediation).toMatchObject({
      status: "completed",
      assignee: "dev",
      taskRef: "TASK-1",
      plan: "修正箇所を更新して再確認する",
      fixCommit: "abcdef0123",
      completion: { actor: "reviewer", targetVersion: scope.version },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00.000Z"));
    try {
      const changedObservation = apply(complete, {
        type: "finding-observation",
        findingId: finding.findingId,
        fingerprint: "issue-1",
        targetVersion: scope.version,
        observation: "条件に変更があるため再確認が必要",
        sourceRefs: [doc.ref],
        contextHash: "a".repeat(64),
        evidenceHash: "b".repeat(64),
      });
      expect(changedObservation.findings[0]!.remediation).toMatchObject({
        status: "verification_pending",
        completion: undefined,
      });
      expectAtomicReject(changedObservation, {
        type: "remediation-complete",
        findingId: finding.findingId,
        actor: "reviewer",
        reason: "根拠変更後の古い確認だけでは完了できない",
        targetVersion: scope.version,
      });
      const reverified = apply(changedObservation, {
        type: "verification",
        findingId: finding.findingId,
        method: "static-review",
        rationale: "変更後の根拠を再確認",
        scope: "変更箇所",
        status: "passed",
        actor: "reviewer",
        targetVersion: scope.version,
        evidence: [doc.ref],
      });
      const recommitted = apply(reverified, {
        type: "remediation-complete",
        findingId: finding.findingId,
        actor: "reviewer",
        reason: "現行根拠を再確認",
        targetVersion: scope.version,
      });
      expect(recommitted.findings[0]!.remediation?.status).toBe("completed");
      const changedAgain = apply(recommitted, {
        type: "finding-observation",
        findingId: finding.findingId,
        fingerprint: "issue-1",
        targetVersion: scope.version,
        observation: "同一時刻にさらに条件が変更された",
        sourceRefs: [doc.ref],
        contextHash: "c".repeat(64),
        evidenceHash: "d".repeat(64),
      });
      expectAtomicReject(changedAgain, {
        type: "remediation-complete",
        findingId: finding.findingId,
        actor: "reviewer",
        reason: "2回目の根拠変更後も再確認が必要",
        targetVersion: scope.version,
      });
    } finally {
      vi.useRealTimers();
    }
    expectAtomicReject(complete, {
      type: "remediation-complete",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "二重完了",
      targetVersion: scope.version,
    });
    const revised = apply(complete, {
      type: "document",
      documentId: doc.id,
      value: {
        title: "仕様更新",
        body: "根拠が更新されました",
        url: doc.state.documents[0]!.url,
        classification: "public",
      },
    });
    expect(revised.findings[0]).toMatchObject({
      judgment: "unconfirmed",
      remediation: { status: "verification_pending" },
    });
    expectAtomicReject(revised, {
      type: "remediation-complete",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "古い文書版の確認",
      targetVersion: scope.version,
    });
    const nextVersion = { ...scope, version: "v2" };
    state = apply(revised, { type: "scope", value: nextVersion });
    state = apply(state, {
      type: "remediation-progress",
      findingId: finding.findingId,
      status: "in_progress",
      actor: "dev",
      reason: "v2対象へ更新",
      targetVersion: nextVersion.version,
    });
    state = apply(state, {
      type: "remediation-progress",
      findingId: finding.findingId,
      status: "verification_pending",
      actor: "dev",
      reason: "v2修正コミット",
      fixCommit: "fedcba9876",
      targetVersion: nextVersion.version,
    });
    const currentDoc = state.documents.find((item) => item.id === doc.id)!;
    const currentRef = {
      docId: doc.id,
      revision: currentDoc.revision,
      excerpt: "根拠が更新",
    };
    state = apply(state, {
      type: "verification",
      findingId: finding.findingId,
      method: "static-review",
      rationale: "v2で確認",
      scope: "変更箇所",
      status: "passed",
      actor: "reviewer",
      targetVersion: nextVersion.version,
      evidence: [currentRef],
    });
    state = apply(state, {
      type: "remediation-complete",
      findingId: finding.findingId,
      actor: "reviewer",
      reason: "v2と現行証跡を確認",
      targetVersion: nextVersion.version,
    });
    expect(state.findings[0]!.remediation).toMatchObject({
      status: "completed",
      targetVersion: "v2",
      fixCommit: "fedcba9876",
    });
  });

  it("ResearchReportを同一repoの別commitごとに未承認資料と指摘候補へ引き継ぐ", () => {
    const initial = workflow();
    const first = importResearch(initial, report());
    expect(first).not.toBe(initial);
    expect(first.imports).toMatchObject([
      {
        reportId: "report-1",
        commit: "abc1234",
        sourceRefs: ["https://github.com/example/widget"],
      },
    ]);
    expect(first.documents[0]).toMatchObject({
      classification: "public",
      revision: 1,
      hash: expect.any(String),
    });
    expect(first.findings[0]).toMatchObject({
      judgment: "unconfirmed",
      targetVersion: "abc1234",
      decisions: [],
    });
    expect(first.findings[0]!.sourceRefs[0]!.excerpt).toContain(
      "GHSA-0000-0000-0000",
    );
    const repeated = importResearch(first, report());
    expect(repeated).toEqual(first);
    const second = importResearch(first, report("report-2", "def5678"));
    expect(second.imports).toHaveLength(2);
    expect(second.findings).toHaveLength(2);
    expect(second.findings[0]!.fingerprint).not.toBe(
      second.findings[1]!.fingerprint,
    );
    const mismatch = {
      ...report(),
      repository: {
        ...report().repository,
        url: "https://github.com/other/repo",
      },
    };
    const before = structuredClone(initial);
    expect(() => importResearch(initial, mismatch)).toThrow(/一致しません/);
    expect(initial).toEqual(before);
    const foreign = {
      ...report(),
      repository: {
        ...report().repository,
        url: "https://evil.test/example/widget",
      },
    };
    expect(() => importResearch(initial, foreign)).toThrow(/一致しません/);
    expect(() => importResearch(initial, { id: "bad" } as never)).toThrow(
      /必須情報/,
    );
    const tooMany = {
      ...report(),
      dependencies: {
        ...report().dependencies,
        findings: Array.from(
          { length: 201 },
          () => report().dependencies.findings[0]!,
        ),
      },
    };
    expect(() => importResearch(initial, tooMany)).toThrow(/上限/);
    const badSource = {
      ...report(),
      sources: [{ ...report().sources[0]!, sha256: "not-a-hash" }],
    };
    expect(() => importResearch(initial, badSource)).toThrow(/SHA256/);
    const oversized = { ...report(), limitations: ["x".repeat(1_000_001)] };
    expect(() => importResearch(initial, oversized)).toThrow(/本文上限/);
    const noCommit = importResearch(initial, report("no-commit", null));
    expect(noCommit.findings[0]!.targetVersion).toBe("unknown");
  });
});
