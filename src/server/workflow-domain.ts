import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../shared/domain-error.js";
import {
  providerKind as providerKindSchema,
  workflowCommand,
  workflowScopeInput,
  type WorkflowCommand,
  type WorkflowContext,
  type FindingReviewContext,
  type FindingSuppressionEvaluation,
  type FindingSuppressionReason,
  type SuppressionMatchPolicy,
  type Classification,
  type WorkflowDocument,
  type WorkflowFinding,
  type WorkflowImport,
  type WorkflowKnowledge,
  type WorkflowRule,
  type WorkflowScope,
  type WorkflowSourceRef,
  type WorkflowState,
  type WorkflowVerification,
} from "../shared/workflow.js";
import {
  hashModelSourceBinding,
} from "./model-source-binding.js";
import type { ModelSourceBinding } from "../shared/model-source-binding.js";
import type { ResearchReport } from "../shared/repository-research.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const nowAfter = (minimum?: string) => {
  const minimumMs = minimum ? Date.parse(minimum) : Number.NaN;
  const currentMs = Date.now();
  return new Date(
    Number.isFinite(minimumMs) ? Math.max(currentMs, minimumMs + 1) : currentMs,
  ).toISOString();
};
const latestTimestamp = (
  base: string,
  candidates: readonly (string | undefined)[],
) => {
  let latestMs = Date.parse(base);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const candidateMs = Date.parse(candidate);
    if (Number.isFinite(candidateMs))
      latestMs = Math.max(latestMs, candidateMs);
  }
  return new Date(latestMs).toISOString();
};

const canonicalSourceRefs = (refs: readonly WorkflowSourceRef[]) =>
  [...refs]
    .map((ref) => ({
      docId: ref.docId,
      revision: ref.revision,
      excerpt: ref.excerpt,
    }))
    .sort(
      (left, right) =>
        left.docId.localeCompare(right.docId) ||
        left.revision - right.revision ||
        left.excerpt.localeCompare(right.excerpt),
    );

const suppressionPolicy = (
  suppression: { matchPolicy?: SuppressionMatchPolicy },
): SuppressionMatchPolicy => suppression.matchPolicy ?? "exact_evidence";

/**
 * Persisted workflow rows can be older or partially migrated.  Treat an
 * invalid binding as non-matching instead of allowing a source-scope policy
 * to broaden its range accidentally.
 */
const sameModelSourceBinding = (
  left: ModelSourceBinding | undefined,
  right: ModelSourceBinding | undefined,
) => {
  if (!left || !right) return false;
  try {
    return hashModelSourceBinding(left) === hashModelSourceBinding(right);
  } catch {
    return false;
  }
};

/**
 * Hash the complete approved context used by a diagnostic observation.
 *
 * This is intentionally exported so production diagnostics and evaluation
 * adapters can share the same binding.  The hash includes the complete
 * applicable knowledge/rule sets and their source excerpts; a partial rule
 * list or an old source revision therefore cannot reuse a suppression.
 */
export function hashFindingReviewContext(context: FindingReviewContext) {
  return hash(
    JSON.stringify({
      targetVersion: context.targetVersion,
      purpose: context.purpose,
      specificationRevision: context.specificationRevision,
      specificationHash: context.specificationHash,
      ...(context.metadata
        ? {
            metadata: {
              diagnosticMethodologyHash:
                context.metadata.diagnosticMethodologyHash,
            },
          }
        : {}),
      knowledge: [...context.knowledge]
        .map((item) => ({
          id: item.id,
          revision: item.revision,
          contentHash: item.contentHash,
          sourceRefs: canonicalSourceRefs(item.sourceRefs),
        }))
        .sort(
          (left, right) =>
            left.id.localeCompare(right.id) || left.revision - right.revision,
        ),
      rules: [...context.rules]
        .map((item) => ({
          id: item.id,
          revision: item.revision,
          contentHash: item.contentHash,
          appliesToVersion: item.appliesToVersion,
          sourceRefs: canonicalSourceRefs(item.sourceRefs),
        }))
        .sort(
          (left, right) =>
            left.id.localeCompare(right.id) || left.revision - right.revision,
        ),
      // A decision revision is an audit sequence, not an applicability
      // condition.  Omitting it keeps two findings from invalidating one
      // another forever when both judgments are re-recorded sequentially.
      // Changes to target, judgment, reason, or evidence references still
      // change the context hash and require a fresh review.
      pastJudgments: [...(context.pastJudgments ?? [])]
        .map((judgment) => ({
          findingId: judgment.findingId,
          targetVersion: judgment.targetVersion,
          judgment: judgment.judgment,
          reason: judgment.reason,
          sourceRefs: canonicalSourceRefs(judgment.sourceRefs),
          ruleRefs: [...(judgment.ruleRefs ?? [])].sort(
            (left, right) =>
              left.id.localeCompare(right.id) || left.revision - right.revision,
          ),
        }))
        .sort(
          (left, right) => left.findingId.localeCompare(right.findingId),
        ),
    }),
  );
}

/**
 * Stable evidence identity for a diagnostic finding.  Location line numbers
 * and run-specific report references are deliberately excluded so a line
 * move does not invalidate an explicit human suppression.
 */
export function hashFindingEvidence(input: {
  engine: string;
  ruleId: string;
  title: string;
  severity: string;
  path: string;
  evidence: string;
  remediation: string;
  advisoryUrl?: string;
}) {
  return hash(
    JSON.stringify({
      engine: input.engine,
      ruleId: input.ruleId,
      title: input.title,
      severity: input.severity,
      path: input.path.replace(/\\/g, "/"),
      evidence: input.evidence,
      remediation: input.remediation,
      advisoryUrl: input.advisoryUrl ?? null,
    }),
  );
}
const refsFor = (state: WorkflowState, refs: WorkflowSourceRef[]) => {
  for (const ref of refs) {
    const doc = state.documents.find((item) => item.id === ref.docId);
    if (!doc) throw new DomainError("出典資料がありません", 404);
    const version =
      doc.revision === ref.revision
        ? doc
        : doc.history.find((item) => item.revision === ref.revision);
    if (!version || !version.body.includes(ref.excerpt))
      throw new DomainError("出典の版または引用が原文と一致しません");
  }
};
const pushEvent = (
  state: WorkflowState,
  type: string,
  entityId?: string,
  actor?: string,
  reason?: string,
  detail?: string,
) => state.events.push({ type, entityId, actor, reason, detail, at: now() });
const references = (refs: WorkflowSourceRef[], docId: string) =>
  refs.some((ref) => ref.docId === docId);
const activeAndCurrent = (
  state: WorkflowState,
  item: { status: string; sourceRefs: WorkflowSourceRef[] },
) =>
  item.status === "active" &&
  item.sourceRefs.every((ref) => {
    const doc = state.documents.find((candidate) => candidate.id === ref.docId);
    return doc?.revision === ref.revision;
  });
const applicableRule = (state: WorkflowState, item: WorkflowRule) =>
  activeAndCurrent(state, item) &&
  item.appliesToVersion === state.scope.version;

/**
 * Reopen a remediation after its review conditions changed.  Verification
 * entries remain immutable audit history, while the cutoff forces completion
 * to require a fresh proof under the current conditions.
 */
function reopenRemediation(remediation: WorkflowFinding["remediation"]) {
  if (!remediation) return false;
  const needsReverification =
    remediation.status === "completed" || remediation.verifications.length > 0;
  if (!needsReverification) return false;
  const changed =
    remediation.status !== "verification_pending" ||
    remediation.completion !== undefined ||
    remediation.reverificationRequiredAfter === undefined;
  if (!changed) return false;
  remediation.status = "verification_pending";
  remediation.completion = undefined;
  remediation.reverificationRequiredAfter = latestTimestamp(now(), [
    remediation.reverificationRequiredAfter,
    ...remediation.verifications.map(({ at }) => at),
  ]);
  return changed;
}

/**
 * Invalidate the current review state while retaining decisions, suppressions
 * and verification history for audit.  Knowledge dependencies were not
 * persisted in older observation rows, so callers may conservatively apply
 * this to every reviewed finding when a pinned context is superseded.
 */
function invalidateFindingReview(
  state: WorkflowState,
  finding: WorkflowFinding,
  actor: string | undefined,
  reason: string,
  force = false,
  emitEvent = true,
) {
  const hadActiveSuppression = finding.suppressions.some(
    (suppression) => suppression.active,
  );
  const hadReviewState =
    finding.judgment !== "unconfirmed" ||
    hadActiveSuppression ||
    finding.remediation?.status === "completed" ||
    (finding.remediation?.verifications.length ?? 0) > 0;
  if (!force && !hadReviewState) return false;
  const judgmentChanged = finding.judgment !== "unconfirmed";
  finding.judgment = "unconfirmed";
  for (const suppression of finding.suppressions) suppression.active = false;
  const remediationChanged = reopenRemediation(finding.remediation);
  if (
    emitEvent &&
    (judgmentChanged || hadActiveSuppression || remediationChanged)
  )
    pushEvent(state, "finding-review-required", finding.id, actor, reason);
  return judgmentChanged || hadActiveSuppression || remediationChanged;
}

const staleEntities = (state: WorkflowState, docId: string, reason: string) => {
  const staleRuleRefs = new Set(
    state.rules
      .filter((item) => references(item.sourceRefs, docId))
      .map((item) => `${item.id}@${item.revision}`),
  );
  for (const item of state.knowledge) {
    if (item.status === "active" && references(item.sourceRefs, docId)) {
      item.status = "stale";
      pushEvent(state, "knowledge-stale", item.id, undefined, reason);
    }
  }
  for (const item of state.rules) {
    if (item.status === "active" && references(item.sourceRefs, docId)) {
      item.status = "stale";
      pushEvent(state, "rule-stale", item.id, undefined, reason);
    }
  }
  for (const finding of state.findings) {
    const affected = finding.decisions.some(
      (decision) =>
        references(decision.sourceRefs, docId) ||
        decision.ruleRefs.some((ref) =>
          staleRuleRefs.has(`${ref.id}@${ref.revision}`),
        ),
    );
    const verificationAffected =
      finding.remediation?.verifications.some((verification) =>
        references(verification.evidence, docId),
      ) ?? false;
    if (affected || verificationAffected) {
      invalidateFindingReview(state, finding, undefined, reason, true);
    }
  }
};

export function newWorkflow(
  projectId: string,
  scope?: WorkflowScope,
): WorkflowState {
  const parsed = workflowScopeInput.parse(
    scope ?? {
      target: "未設定",
      version: "未設定",
      purpose: "未設定",
      ownership: "未設定",
      allowedProviderIds: [],
      allowedMethods: [],
    },
  );
  return {
    projectId,
    revision: 1,
    scope: parsed,
    documents: [],
    knowledge: [],
    rules: [],
    findings: [],
    queries: [],
    events: [],
    imports: [],
  };
}

/**
 * Resolve the product's initial ref to its immutable commit without treating
 * that first resolution as a user scope change.  A product is created with a
 * ref such as `main` or `baseline`; the first diagnostic replaces that alias
 * with the resolved commit.  Approved knowledge is scoped to the product
 * purpose and source revisions, so invalidating it during this bookkeeping
 * step would silently remove it from the first run.
 */
export function pinInitialScopeVersion(
  state: WorkflowState,
  version: string,
): WorkflowState {
  const next = structuredClone(state);
  next.scope.version = version;
  next.events.push({
    type: "scope-version-pinned",
    reason: "診断開始時にrefを固定commitへ解決",
    at: now(),
  });
  return next;
}

function upsertDocument(
  state: WorkflowState,
  value: WorkflowCommand & { type: "document" },
) {
  const contentHash = hash(value.value.body);
  const current = value.documentId
    ? state.documents.find((item) => item.id === value.documentId)
    : undefined;
  if (value.documentId && !current)
    throw new DomainError("資料がありません", 404);
  if (current) {
    if (
      current.hash === contentHash &&
      current.title === value.value.title &&
      current.url === value.value.url &&
      current.classification === value.value.classification
    )
      return;
    const { history, id, ...previous } = current;
    Object.assign(current, value.value, {
      hash: contentHash,
      revision: current.revision + 1,
      history: [...history, previous],
    });
    staleEntities(state, id, "参照原文が更新されました");
    pushEvent(
      state,
      "document-updated",
      id,
      undefined,
      "資料版が更新されました",
    );
    return;
  }
  const duplicate = state.documents.find(
    (item) => item.hash === contentHash && item.url === value.value.url,
  );
  if (duplicate) {
    if (duplicate.classification !== value.value.classification)
      throw new DomainError(
        "同じ原文の情報区分を変更する場合は既存資料IDを指定してください",
      );
    return;
  }
  const doc: WorkflowDocument = {
    ...value.value,
    id: randomUUID(),
    revision: 1,
    hash: contentHash,
    history: [],
  };
  state.documents.push(doc);
  pushEvent(state, "document-added", doc.id);
}

function addKnowledgeDraft(
  state: WorkflowState,
  command: WorkflowCommand & { type: "knowledge-draft" },
) {
  refsFor(state, command.sourceRefs);
  if (command.knowledgeId && command.supersedes)
    throw new DomainError("更新案の対象を二重指定できません");
  const parent = command.supersedes
    ? state.knowledge.find(
        (item) =>
          item.id === command.supersedes!.id &&
          item.revision === command.supersedes!.revision,
      )
    : undefined;
  if (
    command.supersedes &&
    (!parent ||
      !["active", "stale"].includes(parent.status) ||
      parent.purpose !== command.purpose)
  )
    throw new DomainError("更新対象の有効または再確認知識版がありません");
  if (
    parent &&
    state.knowledge.some(
      (item) => item.id === parent.id && item.revision === parent.revision + 1,
    )
  )
    throw new DomainError("同じ知識版を基にした更新案がすでにあります");
  const current = command.knowledgeId
    ? state.knowledge.find((item) => item.id === command.knowledgeId)
    : undefined;
  if (command.knowledgeId && !current)
    throw new DomainError("知識がありません", 404);
  if (current && current.status === "active")
    throw new DomainError("有効知識は更新案で置き換えてください");
  const item: WorkflowKnowledge = {
    id: parent?.id ?? current?.id ?? randomUUID(),
    revision: parent?.revision
      ? parent.revision + 1
      : (current?.revision ?? 0) + 1,
    purpose: command.purpose,
    content: command.content,
    sourceRefs: command.sourceRefs,
    supersedes: command.supersedes,
    status: "draft",
    origin: command.origin,
  };
  if (current) Object.assign(current, item);
  else state.knowledge.push(item);
  pushEvent(
    state,
    "knowledge-draft",
    item.id,
    undefined,
    undefined,
    item.revision.toString(),
  );
}
function reviewKnowledge(
  state: WorkflowState,
  command: WorkflowCommand & { type: "knowledge-review" },
) {
  const item = state.knowledge.find(
    (candidate) =>
      candidate.id === command.knowledgeId && candidate.status === "draft",
  );
  if (!item) throw new DomainError("知識がありません", 404);
  if (item.status !== "draft")
    throw new DomainError("レビューできる知識案ではありません");
  refsFor(state, item.sourceRefs);
  if (
    command.decision === "active" &&
    !item.sourceRefs.every(
      (ref) =>
        state.documents.find((doc) => doc.id === ref.docId)?.revision ===
        ref.revision,
    )
  )
    throw new DomainError("古い資料版を参照する知識案は有効化できません");
  const parent =
    item.supersedes &&
    state.knowledge.find(
      (candidate) =>
        candidate.id === item.supersedes!.id &&
        candidate.revision === item.supersedes!.revision,
    );
  if (
    command.decision === "active" &&
    item.supersedes &&
    (!parent || !["active", "stale"].includes(parent.status))
  )
    throw new DomainError("更新対象の知識版がすでに変更されています");
  item.status = command.decision;
  item.actor = command.actor;
  item.reason = command.reason;
  if (command.decision === "active" && parent) {
    parent.status = "stale";
    pushEvent(
      state,
      "knowledge-stale",
      parent.id,
      command.actor,
      "新しい版が承認されました",
      parent.revision.toString(),
    );
    // Observation rows historically stored only a context hash, not the
    // knowledge revision list.  Until that dependency is explicit, a
    // superseding approved knowledge version conservatively reopens every
    // finding that carries review state so an old suppression cannot survive.
    for (const finding of state.findings)
      invalidateFindingReview(
        state,
        finding,
        command.actor,
        "承認済み知識の版が更新されました",
      );
  }
  pushEvent(
    state,
    `knowledge-${command.decision}`,
    item.id,
    command.actor,
    command.reason,
  );
}
function addRuleDraft(
  state: WorkflowState,
  command: WorkflowCommand & { type: "rule-draft" },
) {
  refsFor(state, command.sourceRefs);
  if (command.ruleId && command.supersedes)
    throw new DomainError("更新案の対象を二重指定できません");
  const parent = command.supersedes
    ? state.rules.find(
        (item) =>
          item.id === command.supersedes!.id &&
          item.revision === command.supersedes!.revision,
      )
    : undefined;
  if (
    command.supersedes &&
    (!parent ||
      !["active", "stale"].includes(parent.status) ||
      parent.purpose !== command.purpose)
  )
    throw new DomainError("更新対象の有効または再確認基準版がありません");
  if (
    parent &&
    state.rules.some(
      (item) => item.id === parent.id && item.revision === parent.revision + 1,
    )
  )
    throw new DomainError("同じ基準版を基にした更新案がすでにあります");
  const current = command.ruleId
    ? state.rules.find((item) => item.id === command.ruleId)
    : undefined;
  if (command.ruleId && !current)
    throw new DomainError("判定基準がありません", 404);
  if (current && current.status === "active")
    throw new DomainError("有効基準は更新案で置き換えてください");
  const item: WorkflowRule = {
    id: parent?.id ?? current?.id ?? randomUUID(),
    revision: parent?.revision
      ? parent.revision + 1
      : (current?.revision ?? 0) + 1,
    purpose: command.purpose,
    content: command.content,
    applicability: command.applicability,
    appliesToVersion: command.appliesToVersion ?? state.scope.version,
    sourceRefs: command.sourceRefs,
    supersedes: command.supersedes,
    status: "draft",
  };
  if (current) Object.assign(current, item);
  else state.rules.push(item);
  pushEvent(
    state,
    "rule-draft",
    item.id,
    undefined,
    undefined,
    item.revision.toString(),
  );
}
function reviewRule(
  state: WorkflowState,
  command: WorkflowCommand & { type: "rule-review" },
) {
  const item = state.rules.find(
    (candidate) =>
      candidate.id === command.ruleId && candidate.status === "draft",
  );
  if (!item) throw new DomainError("判定基準がありません", 404);
  if (item.status !== "draft")
    throw new DomainError("レビューできる判定基準案ではありません");
  refsFor(state, item.sourceRefs);
  if (
    command.decision === "active" &&
    !item.sourceRefs.every(
      (ref) =>
        state.documents.find((doc) => doc.id === ref.docId)?.revision ===
        ref.revision,
    )
  )
    throw new DomainError("古い資料版を参照する判定基準は有効化できません");
  const parent =
    item.supersedes &&
    state.rules.find(
      (candidate) =>
        candidate.id === item.supersedes!.id &&
        candidate.revision === item.supersedes!.revision,
    );
  if (
    command.decision === "active" &&
    item.supersedes &&
    (!parent || !["active", "stale"].includes(parent.status))
  )
    throw new DomainError("更新対象の判定基準版がすでに変更されています");
  item.status = command.decision;
  item.actor = command.actor;
  item.reason = command.reason;
  if (command.decision === "active" && parent) {
    parent.status = "stale";
    pushEvent(
      state,
      "rule-stale",
      parent.id,
      command.actor,
      "新しい基準版が承認されました",
      parent.revision.toString(),
    );
  }
  pushEvent(
    state,
    `rule-${command.decision}`,
    item.id,
    command.actor,
    command.reason,
  );
  if (command.decision === "active") {
    const relatedRuleRefs = item.supersedes
      ? [item.supersedes]
      : state.rules
          .filter(
            (rule) => rule.purpose === item.purpose && rule.status === "active",
          )
          .map((rule) => ({ id: rule.id, revision: rule.revision }));
    for (const finding of state.findings) {
      if (
        finding.decisions.some((decision) =>
          decision.ruleRefs.some((ref) =>
            relatedRuleRefs.some(
              (related) =>
                related.id === ref.id && related.revision === ref.revision,
            ),
          ),
        )
      ) {
        invalidateFindingReview(
          state,
          finding,
          command.actor,
          "判定基準が更新されました",
          true,
        );
      }
    }
  }
}

function addQuery(
  state: WorkflowState,
  command: WorkflowCommand & { type: "query" },
) {
  const kind = providerKindSchema.parse(command.providerKind);
  const knowledge = command.knowledge.map((ref) => {
    const item = state.knowledge.find(
      (candidate) =>
        candidate.id === ref.id && candidate.revision === ref.revision,
    );
    if (!item || !activeAndCurrent(state, item))
      throw new DomainError("未承認または失効した知識は問い合わせに使えません");
    if (item.purpose !== state.scope.purpose)
      throw new DomainError("案件目的外の知識は使えません");
    assertProviderAccess(state, item.sourceRefs, kind);
    return ref;
  });
  const rules = command.rules.map((ref) => {
    const item = state.rules.find(
      (candidate) =>
        candidate.id === ref.id && candidate.revision === ref.revision,
    );
    if (!item || !applicableRule(state, item))
      throw new DomainError(
        "未承認・失効または別対象版の基準は問い合わせに使えません",
      );
    if (item.purpose !== state.scope.purpose)
      throw new DomainError("案件目的外の基準は使えません");
    assertProviderAccess(state, item.sourceRefs, kind);
    return ref;
  });
  const selectedKnowledge = knowledge.map((ref) =>
    state.knowledge.find(
      (item) => item.id === ref.id && item.revision === ref.revision,
    )!,
  );
  const conflicted = selectedKnowledge.some((left, index) =>
    selectedKnowledge
      .slice(index + 1)
      .some((right) => overlaps(left.content, right.content)),
  );
  const uncertainty = conflicted
    ? "conflict"
    : knowledge.length
      ? command.uncertainty
      : "insufficient";
  if (!knowledge.length && command.answer)
    throw new DomainError("案件知識がない問い合わせの回答は記録できません");
  const item = {
    id: command.queryId ?? randomUUID(),
    question: command.question,
    target: state.scope.target,
    targetVersion: state.scope.version,
    purpose: state.scope.purpose,
    providerKind: kind,
    knowledge,
    rules,
    answer: command.answer,
    uncertainty,
    at: now(),
  } as const;
  if (state.queries.some((query) => query.id === item.id))
    throw new DomainError("問い合わせIDが重複しています");
  state.queries.push(item);
  pushEvent(state, "query-recorded", item.id);
}

function assertProviderAccess(
  state: WorkflowState,
  refs: WorkflowSourceRef[],
  kind: "cloud" | "local" | "manual",
) {
  for (const ref of refs) {
    const doc = state.documents.find((item) => item.id === ref.docId);
    if (!doc) throw new DomainError("出典資料がありません", 404);
    if (
      doc.classification === "blocked" ||
      doc.classification === "unclassified"
    )
      throw new DomainError("送信不可または未分類の資料を含む知識です");
    if (kind === "cloud" && doc.classification !== "public")
      throw new DomainError("外部モデルには公開資料だけを送信できます");
  }
}

function observeFinding(
  state: WorkflowState,
  command: WorkflowCommand & { type: "finding-observation" },
) {
  if (
    command.modelSourceBinding &&
    command.modelSourceBinding.targetVersion !== command.targetVersion
  )
    throw new DomainError("観測のsource bindingと対象版が一致しません");
  refsFor(state, command.sourceRefs);
  const existing = state.findings.find(
    (item) =>
      item.fingerprint === command.fingerprint &&
      item.targetVersion === command.targetVersion,
  );
  if (existing) {
    if (command.findingId && command.findingId !== existing.id)
      throw new DomainError("同じ条件の指摘IDが一致しません");
    const refsMatch = (left: WorkflowSourceRef[], right: WorkflowSourceRef[]) =>
      JSON.stringify(left) === JSON.stringify(right);
    const lastObservation = existing.observationHistory.at(-1);
    const bindingChanged = Boolean(
      lastObservation?.modelSourceBinding &&
        command.modelSourceBinding &&
        !sameModelSourceBinding(
          lastObservation.modelSourceBinding,
          command.modelSourceBinding,
        ),
    );
    const hashesMatch = Boolean(
      command.contextHash &&
      command.evidenceHash &&
      lastObservation?.contextHash === command.contextHash &&
      lastObservation.evidenceHash === command.evidenceHash &&
      !bindingChanged,
    );
    const changed =
      !hashesMatch &&
      (!lastObservation ||
        lastObservation.observation !== command.observation ||
        !refsMatch(lastObservation.sourceRefs, command.sourceRefs) ||
        (lastObservation.contextHash ?? null) !==
          (command.contextHash ?? null) ||
        (lastObservation.evidenceHash ?? null) !==
          (command.evidenceHash ?? null) ||
        bindingChanged);
    const sourceScopeRetained = existing.suppressions.some((suppression) =>
      suppression.active &&
      suppressionPolicy(suppression) === "source_scope" &&
      Boolean(command.contextHash) &&
      suppression.contextHash === command.contextHash &&
      sameModelSourceBinding(
        suppression.modelSourceBinding,
        command.modelSourceBinding,
      ) &&
      suppressionValid(state, existing, suppression),
    );
    const observedAt = now();
    if (changed && !sourceScopeRetained) {
      existing.judgment = "unconfirmed";
      for (const suppression of existing.suppressions)
        suppression.active = false;
      if (existing.remediation?.status === "completed") {
        existing.remediation.status = "verification_pending";
        existing.remediation.completion = undefined;
      }
      if (existing.remediation?.verifications.length) {
        existing.remediation.reverificationRequiredAfter = latestTimestamp(
          observedAt,
          [
            existing.remediation.reverificationRequiredAfter,
            ...existing.remediation.verifications.map(({ at }) => at),
          ],
        );
      }
      pushEvent(
        state,
        "finding-review-required",
        existing.id,
        undefined,
        "同条件の再観測内容または根拠が変わりました",
      );
    }
    for (const suppression of existing.suppressions) {
      if (
        suppression.active &&
        !suppressionValid(state, existing, suppression)
      ) {
        suppression.active = false;
        existing.judgment = "unconfirmed";
        pushEvent(
          state,
          "suppression-invalidated",
          existing.id,
          undefined,
          "対象版・基準版・期限が変わりました",
        );
      }
    }
    existing.observation = command.observation;
    existing.observedAt = observedAt;
    existing.observationHistory.push({
      observation: command.observation,
      observedAt: existing.observedAt,
      targetVersion: command.targetVersion,
      sourceRefs: command.sourceRefs,
      ...(command.contextHash ? { contextHash: command.contextHash } : {}),
      ...(command.evidenceHash ? { evidenceHash: command.evidenceHash } : {}),
      ...(command.modelSourceBinding
        ? { modelSourceBinding: command.modelSourceBinding }
        : {}),
    });
    if (command.sourceRefs.length)
      existing.sourceRefs = [
        ...existing.sourceRefs,
        ...command.sourceRefs.filter(
          (ref) =>
            !existing.sourceRefs.some(
              (old) =>
                old.docId === ref.docId &&
                old.revision === ref.revision &&
                old.excerpt === ref.excerpt,
            ),
        ),
      ];
    pushEvent(
      state,
      "finding-associated",
      existing.id,
      undefined,
      undefined,
      command.fingerprint,
    );
    return;
  }
  if (
    command.findingId &&
    state.findings.some((item) => item.id === command.findingId)
  )
    throw new DomainError("別条件の指摘で使用済みのIDです");
  const finding: WorkflowFinding = {
    id: command.findingId ?? randomUUID(),
    revision: 1,
    fingerprint: command.fingerprint,
    targetVersion: command.targetVersion,
    observation: command.observation,
    observedAt: now(),
    sourceRefs: command.sourceRefs,
    observationHistory: [
      {
        observation: command.observation,
        observedAt: now(),
        targetVersion: command.targetVersion,
        sourceRefs: command.sourceRefs,
        ...(command.contextHash ? { contextHash: command.contextHash } : {}),
        ...(command.evidenceHash ? { evidenceHash: command.evidenceHash } : {}),
        ...(command.modelSourceBinding
          ? { modelSourceBinding: command.modelSourceBinding }
          : {}),
      },
    ],
    judgment: "unconfirmed",
    decisions: [],
    suppressions: [],
  };
  state.findings.push(finding);
  pushEvent(state, "finding-observed", finding.id);
}
function decideFinding(
  state: WorkflowState,
  command: WorkflowCommand & { type: "finding-decision" },
) {
  const finding = state.findings.find((item) => item.id === command.findingId);
  if (!finding) throw new DomainError("指摘がありません", 404);
  if (
    command.targetVersion !== finding.targetVersion ||
    command.targetVersion !== state.scope.version
  )
    throw new DomainError("判定対象版が現在の案件版と一致しません");
  refsFor(state, command.sourceRefs);
  if (
    !command.sourceRefs.every(
      (ref) =>
        state.documents.find((doc) => doc.id === ref.docId)?.revision ===
        ref.revision,
    )
  )
    throw new DomainError("過去資料版の根拠で現在の指摘を確定できません");
  const rules = command.ruleRefs.map((ref) => {
    const rule = state.rules.find(
      (item) => item.id === ref.id && item.revision === ref.revision,
    );
    if (!rule || !applicableRule(state, rule))
      throw new DomainError("判定に使う基準が有効ではありません");
    return ref;
  });
  // Bind the human decision to the exact diagnostic observation that was
  // reviewed.  The command API predates this provenance, so legacy/manual
  // observations may not have hashes; those decisions remain auditable but
  // are conservatively ineligible for model context reuse.
  const observation = finding.observationHistory.at(-1);
  finding.judgment = command.judgment;
  finding.revision += 1;
  finding.decisions.push({
    revision: finding.revision,
    judgment: command.judgment,
    actor: command.actor,
    reason: command.reason,
    targetVersion: command.targetVersion,
    sourceRefs: command.sourceRefs,
    ruleRefs: rules,
    at: now(),
    ...(observation?.contextHash
      ? { contextHash: observation.contextHash }
      : {}),
    ...(observation?.evidenceHash
      ? { evidenceHash: observation.evidenceHash }
      : {}),
    ...(observation?.modelSourceBinding
      ? { modelSourceBinding: observation.modelSourceBinding }
      : {}),
  });
  for (const suppression of finding.suppressions) suppression.active = false;
  reopenRemediation(finding.remediation);
  pushEvent(
    state,
    "finding-decided",
    finding.id,
    command.actor,
    command.reason,
    command.judgment,
  );
}
function setSuppression(
  state: WorkflowState,
  command: WorkflowCommand & { type: "suppression" },
) {
  const finding = state.findings.find((item) => item.id === command.findingId);
  if (!finding) throw new DomainError("指摘がありません", 404);
  if (
    finding.judgment !== "false_positive" &&
    finding.judgment !== "accepted_known" &&
    finding.judgment !== "duplicate"
  )
    throw new DomainError("誤検出・重複・既知許容の人判断後に抑止できます");
  const ruleRefs = command.ruleRefs.map((ref) => {
    const rule = state.rules.find(
      (item) => item.id === ref.id && item.revision === ref.revision,
    );
    if (!rule || !applicableRule(state, rule))
      throw new DomainError("抑止に使う判定基準が有効ではありません");
    return ref;
  });
  if (
    command.targetVersion !== finding.targetVersion ||
    command.fingerprint !== finding.fingerprint
  )
    throw new DomainError("抑止条件が指摘条件と一致しません");
  const decision = finding.decisions.at(-1);
  if (
    !decision ||
    decision.judgment !== finding.judgment ||
    decision.targetVersion !== command.targetVersion ||
    JSON.stringify(decision.ruleRefs) !== JSON.stringify(ruleRefs)
  )
    throw new DomainError("抑止条件は直近の人判断・基準版と一致させてください");
  if (Date.parse(command.expiresAt) <= Date.now())
    throw new DomainError("抑止期限は未来にしてください");
  const observation = finding.observationHistory.at(-1);
  const policy = command.matchPolicy ?? "exact_evidence";
  if (policy === "source_scope") {
    // A broad source-range policy is an explicit opt-in.  It can only be
    // recorded when both the judged observation and the decision carry the
    // same verified binding and the original context/evidence are retained.
    if (
      !observation?.modelSourceBinding ||
      !decision.modelSourceBinding ||
      !sameModelSourceBinding(
        observation.modelSourceBinding,
        decision.modelSourceBinding,
      ) ||
      observation.modelSourceBinding.targetVersion !== finding.targetVersion ||
      !observation.contextHash ||
      !observation.evidenceHash ||
      decision.contextHash !== observation.contextHash ||
      decision.evidenceHash !== observation.evidenceHash
    )
      throw new DomainError(
        "コード範囲の抑止には検証済みsource bindingと判断時の根拠が必要です",
      );
  }
  if (
    policy === "exact_evidence" &&
    observation?.modelSourceBinding &&
    !sameModelSourceBinding(
      observation.modelSourceBinding,
      decision.modelSourceBinding,
    )
  )
    throw new DomainError("抑止対象のsource bindingが人判断と一致しません");
  finding.suppressions.push({
    ...command,
    matchPolicy: policy,
    decisionRevision: decision.revision,
    sourceRefs: decision.sourceRefs,
    active: true,
    ...(observation?.contextHash
      ? { contextHash: observation.contextHash }
      : {}),
    ...(observation?.evidenceHash
      ? { evidenceHash: observation.evidenceHash }
      : {}),
    ...(observation?.modelSourceBinding
      ? { modelSourceBinding: observation.modelSourceBinding }
      : {}),
  });
  pushEvent(
    state,
    "suppression-added",
    finding.id,
    command.actor,
    command.reason,
  );
}

function startRemediation(
  state: WorkflowState,
  command: WorkflowCommand & { type: "remediation-start" },
) {
  const finding = state.findings.find((item) => item.id === command.findingId);
  if (!finding) throw new DomainError("指摘がありません", 404);
  if (finding.judgment !== "needs_action")
    throw new DomainError("対応必要と判定された指摘だけ修正を開始できます");
  if (finding.remediation) throw new DomainError("修正タスクがすでにあります");
  if (
    command.targetVersion !== finding.targetVersion ||
    command.targetVersion !== state.scope.version
  )
    throw new DomainError("修正対象版が指摘と現在の案件版に一致しません");
  finding.remediation = {
    status: "awaiting",
    assignee: command.assignee,
    taskRef: command.taskRef,
    plan: command.plan,
    targetVersion: command.targetVersion,
    verifications: [],
  };
  pushEvent(
    state,
    "remediation-started",
    finding.id,
    command.assignee,
    command.plan,
  );
}
function updateRemediation(
  state: WorkflowState,
  command: WorkflowCommand & { type: "remediation-progress" },
) {
  const finding = state.findings.find((item) => item.id === command.findingId);
  const remediation = finding?.remediation;
  if (!finding || !remediation)
    throw new DomainError("修正タスクがありません", 404);
  if (command.targetVersion !== state.scope.version)
    throw new DomainError("現在の案件対象版に一致しません");
  if (
    command.status === "in_progress" &&
    !["awaiting", "in_progress", "verification_pending"].includes(
      remediation.status,
    )
  )
    throw new DomainError("修正中へ遷移できません");
  if (
    command.status === "verification_pending" &&
    !["in_progress", "verification_pending"].includes(remediation.status)
  )
    throw new DomainError("確認待ちへ遷移できません");
  if (command.status === "verification_pending" && !command.fixCommit)
    throw new DomainError("修正コミットが必要です");
  if (command.status === "in_progress") {
    if (
      remediation.targetVersion !== command.targetVersion ||
      remediation.status !== "in_progress"
    )
      remediation.fixCommit = undefined;
    remediation.targetVersion = command.targetVersion;
    remediation.completion = undefined;
  }
  remediation.status = command.status;
  if (command.status === "verification_pending") {
    remediation.targetVersion = command.targetVersion;
    remediation.fixCommit = command.fixCommit;
    remediation.completion = undefined;
  }
  pushEvent(
    state,
    `remediation-${command.status}`,
    finding.id,
    command.actor,
    command.reason,
    command.fixCommit,
  );
}
function addVerification(
  state: WorkflowState,
  command: WorkflowCommand & { type: "verification" },
) {
  const finding = state.findings.find((item) => item.id === command.findingId);
  const remediation = finding?.remediation;
  if (!finding || !remediation)
    throw new DomainError("修正タスクがありません", 404);
  if (remediation.status !== "verification_pending")
    throw new DomainError("修正確認待ちではありません");
  if (
    command.targetVersion !== remediation.targetVersion ||
    command.targetVersion !== state.scope.version
  )
    throw new DomainError("確認対象版が現在の案件版と一致しません");
  if (!remediation.fixCommit)
    throw new DomainError("確認対象の修正コミットがありません");
  if (!state.scope.allowedMethods.includes(command.method))
    throw new DomainError("案件で許可されていない確認方法です");
  refsFor(state, command.evidence);
  const item: WorkflowVerification = {
    ...command,
    fixCommit: remediation.fixCommit,
    at: nowAfter(remediation.reverificationRequiredAfter),
  };
  remediation.verifications.push(item);
  pushEvent(
    state,
    "verification-recorded",
    finding.id,
    command.actor,
    command.rationale,
    command.status,
  );
}
function completeRemediation(
  state: WorkflowState,
  command: WorkflowCommand & { type: "remediation-complete" },
) {
  const finding = state.findings.find((item) => item.id === command.findingId);
  const remediation = finding?.remediation;
  if (!finding || !remediation)
    throw new DomainError("修正タスクがありません", 404);
  if (remediation.status !== "verification_pending")
    throw new DomainError("確認待ちの修正だけ完了できます");
  if (
    command.targetVersion !== remediation.targetVersion ||
    command.targetVersion !== state.scope.version
  )
    throw new DomainError("確認対象版が現在の案件版と一致しません");
  if (!remediation.fixCommit) throw new DomainError("修正コミットがありません");
  const reverificationRequiredAfter = remediation.reverificationRequiredAfter;
  const reverificationRequiredAfterMs = reverificationRequiredAfter
    ? Date.parse(reverificationRequiredAfter)
    : undefined;
  if (
    reverificationRequiredAfter !== undefined &&
    !Number.isFinite(reverificationRequiredAfterMs)
  )
    throw new DomainError("再確認期限の記録が不正です");
  const latestByCheck = new Map<string, WorkflowVerification>();
  for (const verification of remediation.verifications) {
    if (reverificationRequiredAfterMs !== undefined) {
      const verificationAt = Date.parse(verification.at);
      if (
        !Number.isFinite(verificationAt) ||
        verificationAt <= reverificationRequiredAfterMs
      )
        continue;
    }
    if (
      verification.targetVersion !== command.targetVersion ||
      verification.fixCommit !== remediation.fixCommit
    )
      continue;
    latestByCheck.set(
      `${verification.method}\u0000${verification.scope}`,
      verification,
    );
  }
  const latestChecks = [...latestByCheck.values()];
  if (
    !latestChecks.length ||
    latestChecks.some(
      (verification) =>
        verification.status !== "passed" ||
        !verification.evidence.length ||
        !verification.evidence.every(
          (ref) =>
            state.documents.find((doc) => doc.id === ref.docId)?.revision ===
            ref.revision,
        ),
    )
  )
    throw new DomainError("対象版に一致する確認証跡がありません");
  if (!command.actor.trim() || !command.reason.trim())
    throw new DomainError("完了判断者と理由が必要です");
  remediation.status = "completed";
  remediation.completion = {
    actor: command.actor,
    reason: command.reason,
    at: now(),
    targetVersion: command.targetVersion,
  };
  pushEvent(
    state,
    "remediation-completed",
    finding.id,
    command.actor,
    command.reason,
  );
}

export function applyWorkflowCommand(
  original: WorkflowState,
  input: WorkflowCommand,
): WorkflowState {
  const command = workflowCommand.parse(input);
  const state = structuredClone(original);
  switch (command.type) {
    case "scope": {
      const changed =
        JSON.stringify(state.scope) !== JSON.stringify(command.value);
      state.scope = command.value;
      if (changed) {
        for (const item of state.knowledge)
          if (item.status === "active") item.status = "stale";
        for (const item of state.rules)
          if (item.status === "active") item.status = "stale";
        for (const finding of state.findings) {
          invalidateFindingReview(
            state,
            finding,
            undefined,
            "案件の対象・目的・実行範囲が更新されました",
            true,
            false,
          );
        }
        pushEvent(
          state,
          "scope-changed",
          undefined,
          undefined,
          "案件の対象・目的・実行範囲が更新されました",
        );
      }
      break;
    }
    case "document":
      upsertDocument(state, command);
      break;
    case "knowledge-draft":
      addKnowledgeDraft(state, command);
      break;
    case "knowledge-review":
      reviewKnowledge(state, command);
      break;
    case "rule-draft":
      addRuleDraft(state, command);
      break;
    case "rule-review":
      reviewRule(state, command);
      break;
    case "query":
      addQuery(state, command);
      break;
    case "finding-observation":
      observeFinding(state, command);
      break;
    case "finding-decision":
      decideFinding(state, command);
      break;
    case "suppression":
      setSuppression(state, command);
      break;
    case "remediation-start":
      startRemediation(state, command);
      break;
    case "remediation-progress":
      updateRemediation(state, command);
      break;
    case "verification":
      addVerification(state, command);
      break;
    case "remediation-complete":
      completeRemediation(state, command);
      break;
  }
  return state;
}

function normalizedRepo(value: string) {
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const path = parsed.pathname
      .replace(/\.git$/i, "")
      .replace(/\/$/, "")
      .toLowerCase();
    return path.split("/").filter(Boolean).length === 2 ? path : undefined;
  } catch {
    return undefined;
  }
}
export function importResearch(
  state: WorkflowState,
  report: ResearchReport,
): WorkflowState {
  if (state.imports.some((item) => item.reportId === report.id))
    return structuredClone(state);
  if (
    !report.id ||
    !report.repository?.url ||
    !report.repository.name ||
    !report.collectedAt ||
    !report.sources ||
    !report.dependencies?.findings ||
    !report.actions ||
    !report.limitations
  )
    throw new DomainError("調査レポートの必須情報がありません");
  if (
    !Number.isFinite(Date.parse(report.collectedAt)) ||
    (report.repository.commit !== null &&
      !/^[0-9a-f]{7,64}$/i.test(report.repository.commit))
  )
    throw new DomainError("調査レポートの日時またはcommitが不正です");
  const expectedRepo = normalizedRepo(state.scope.target);
  const reportRepo = normalizedRepo(report.repository.url);
  if (!expectedRepo || !reportRepo || expectedRepo !== reportRepo)
    throw new DomainError("調査対象リポジトリが案件の対象と一致しません");
  if (
    report.sources.length > 100 ||
    report.dependencies.findings.length > 200 ||
    report.actions.length > 100 ||
    report.limitations.length > 100
  )
    throw new DomainError("調査レポートの件数上限を超えています");
  const next = structuredClone(state);
  const body = JSON.stringify(report);
  if (body.length > 1_000_000)
    throw new DomainError("調査レポートの本文上限を超えています");
  for (const source of report.sources) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(source.url);
    } catch {
      throw new DomainError("調査レポートの出典URLが不正です");
    }
    if (
      !["http:", "https:"].includes(parsedUrl.protocol) ||
      parsedUrl.username ||
      parsedUrl.password ||
      !/^[0-9a-f]{64}$/i.test(source.sha256)
    )
      throw new DomainError("調査レポートの出典URLまたはSHA256が不正です");
  }
  const docId = randomUUID();
  const doc: WorkflowDocument = {
    id: docId,
    title: `${report.repository.name} 調査結果 ${report.repository.commit ?? "commit未取得"}`,
    body,
    url: report.repository.url,
    classification: "public",
    revision: 1,
    hash: hash(body),
    history: [],
  };
  next.documents.push(doc);
  const imported: WorkflowImport = {
    reportId: report.id,
    repositoryUrl: report.repository.url,
    repositoryName: report.repository.name,
    commit: report.repository.commit,
    collectedAt: report.collectedAt,
    sourceRefs: report.sources.map((source) => source.url),
    hash: doc.hash,
  };
  next.imports.push(imported);
  pushEvent(
    next,
    "research-imported",
    report.id,
    undefined,
    undefined,
    imported.commit ?? "commit未取得",
  );
  const lines = report.dependencies.findings;
  for (const [index, item] of lines.entries()) {
    const excerpt = JSON.stringify(item);
    const finding: WorkflowFinding = {
      id: randomUUID(),
      revision: 1,
      fingerprint: `research-${hash(`${report.repository.url}|${report.repository.commit ?? "unknown"}|${item.advisoryId}|${item.name}|${item.version}`).slice(0, 40)}`,
      targetVersion: report.repository.commit ?? "unknown",
      observation: `${item.advisoryId}: ${item.summary}`,
      observedAt: report.collectedAt,
      sourceRefs: [{ docId, revision: 1, excerpt }],
      observationHistory: [
        {
          observation: `${item.advisoryId}: ${item.summary}`,
          observedAt: report.collectedAt,
          targetVersion: report.repository.commit ?? "unknown",
          sourceRefs: [{ docId, revision: 1, excerpt }],
        },
      ],
      judgment: "unconfirmed",
      decisions: [],
      suppressions: [],
    };
    next.findings.push(finding);
    pushEvent(
      next,
      "research-finding-imported",
      finding.id,
      undefined,
      undefined,
      String(index),
    );
  }
  return next;
}

function overlaps(a: string, b: string) {
  const words = (value: string) =>
    new Set(value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  const ratio = shared / Math.max(1, Math.min(left.size, right.size));
  const negated = (value: string) =>
    /\bnot\b|\bno\b|ない|ません|しない/u.test(value);
  return ratio >= 0.7 && negated(a) !== negated(b);
}
function suppressionValid(
  state: WorkflowState,
  finding: WorkflowFinding,
  suppression: WorkflowFinding["suppressions"][number],
) {
  const expiresAt = Date.parse(suppression.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  if (state.scope.version !== suppression.targetVersion) return false;
  if (suppression.fingerprint !== finding.fingerprint) return false;
  if (finding.decisions.at(-1)?.revision !== suppression.decisionRevision)
    return false;
  const policy = suppressionPolicy(suppression);
  const sourceRefsCurrent = suppression.sourceRefs.every((ref) => {
    const document = state.documents.find((item) => item.id === ref.docId);
    if (!document) return false;
    if (document.revision === ref.revision)
      return document.body.includes(ref.excerpt);
    // A source-scope suppression is deliberately tied to the verified model
    // source binding.  Its human decision may cite an older generated report
    // revision after a wording-only observation update; retain that audit
    // source as long as the immutable history still contains the excerpt.
    if (policy !== "source_scope") return false;
    return Boolean(
      document.history.find(
        (version) =>
          version.revision === ref.revision &&
          version.body.includes(ref.excerpt),
      ),
    );
  });
  if (!sourceRefsCurrent) return false;
  if (
    suppression.modelSourceBinding &&
    (!sameModelSourceBinding(
      suppression.modelSourceBinding,
      finding.observationHistory.at(-1)?.modelSourceBinding,
    ) ||
      !sameModelSourceBinding(
        suppression.modelSourceBinding,
        finding.decisions.at(-1)?.modelSourceBinding,
      ))
  )
    return false;
  if (policy === "source_scope" && !suppression.modelSourceBinding) return false;
  return suppression.ruleRefs.every((ref) => {
    const rule = state.rules.find(
      (item) => item.id === ref.id && item.revision === ref.revision,
    );
    return Boolean(rule && applicableRule(state, rule));
  });
}

/**
 * Evaluate whether a human suppression can be reused for a diagnostic
 * observation.  Suppression records from before context/evidence hashes were
 * introduced deliberately return `unknown` when strict diagnostic input is
 * supplied; they remain readable and continue to work with the legacy boolean
 * helper used by the generic workflow UI.
 */
export function evaluateFindingSuppression(
  state: WorkflowState,
  finding: WorkflowFinding,
  expected?: {
    contextHash?: string;
    evidenceHash?: string;
    modelSourceBinding?: ModelSourceBinding;
  },
  at = Date.now(),
): FindingSuppressionEvaluation {
  const active = [...finding.suppressions]
    .reverse()
    .find((suppression) => suppression.active);
  const latestDecision = finding.decisions.at(-1);
  const empty = (
    status: FindingSuppressionEvaluation["status"],
    reason: FindingSuppressionReason,
    suppression?: WorkflowFinding["suppressions"][number],
  ): FindingSuppressionEvaluation => ({
    reusable: false,
    status,
    reason,
    decisionRevision: latestDecision?.revision ?? null,
    judgment: latestDecision?.judgment ?? null,
    expiresAt: suppression?.expiresAt ?? null,
    matchPolicy: suppressionPolicy(suppression ?? {}),
  });

  /**
   * Validate the persisted provenance after the ordinary target/rule checks.
   * Exact evidence requires every hash to remain equal.  source_scope keeps
   * the original evidence hashes for audit, but intentionally permits a new
   * wording observation when the explicit source binding and context remain
   * identical.
   */
  const expectedContext = (
    suppression: WorkflowFinding["suppressions"][number],
  ): FindingSuppressionEvaluation | null => {
    if (expected === undefined) return null;
    const policy = suppressionPolicy(suppression);
    const lastObservation = finding.observationHistory.at(-1);
    if (
      !expected.contextHash ||
      !expected.evidenceHash ||
      !suppression.contextHash ||
      !suppression.evidenceHash ||
      !latestDecision?.contextHash ||
      !latestDecision.evidenceHash ||
      !lastObservation?.contextHash ||
      !lastObservation.evidenceHash
    )
      return empty("unknown", "legacy_context_unknown", suppression);
    if (latestDecision.contextHash !== lastObservation.contextHash)
      return empty("unknown", "legacy_context_unknown", suppression);
    if (suppression.contextHash !== expected.contextHash)
      return empty("invalidated", "context_changed", suppression);
    if (lastObservation.contextHash !== suppression.contextHash)
      return empty("invalidated", "context_changed", suppression);

    if (policy === "source_scope") {
      if (
        !suppression.modelSourceBinding ||
        !expected.modelSourceBinding ||
        !lastObservation.modelSourceBinding ||
        !latestDecision.modelSourceBinding ||
        !sameModelSourceBinding(
          suppression.modelSourceBinding,
          expected.modelSourceBinding,
        ) ||
        !sameModelSourceBinding(
          suppression.modelSourceBinding,
          lastObservation.modelSourceBinding,
        ) ||
        !sameModelSourceBinding(
          suppression.modelSourceBinding,
          latestDecision.modelSourceBinding,
        )
      )
        return empty("invalidated", "binding_changed", suppression);
      // Evidence is required as retained audit data, but source_scope does
      // not compare it: the explicit binding is the user's broad opt-in.
      return null;
    }

    if (latestDecision.evidenceHash !== lastObservation.evidenceHash)
      return empty("unknown", "legacy_context_unknown", suppression);
    if (suppression.evidenceHash !== expected.evidenceHash)
      return empty("invalidated", "evidence_changed", suppression);
    if (lastObservation.evidenceHash !== suppression.evidenceHash)
      return empty("invalidated", "evidence_changed", suppression);
    if (
      suppression.modelSourceBinding &&
      expected.modelSourceBinding &&
      !sameModelSourceBinding(
        suppression.modelSourceBinding,
        expected.modelSourceBinding,
      )
    )
      return empty("invalidated", "binding_changed", suppression);
    return null;
  };

  if (!active) {
    const previous = finding.suppressions.at(-1);
    if (!previous) return empty("missing", "no_active_suppression");
    const previousExpiry = Date.parse(previous.expiresAt);
    if (Number.isFinite(previousExpiry) && previousExpiry <= at)
      return empty("expired", "expired", previous);
    if (state.scope.version !== previous.targetVersion)
      return empty("invalidated", "target_version_changed", previous);
    if (previous.fingerprint !== finding.fingerprint)
      return empty("invalidated", "fingerprint_changed", previous);
    if (
      !latestDecision ||
      latestDecision.revision !== previous.decisionRevision
    )
      return empty("invalidated", "latest_decision_changed", previous);
    if (!suppressionValid(state, finding, previous))
      return empty("invalidated", "source_changed", previous);
    if (finding.judgment !== latestDecision.judgment)
      return empty("invalidated", "judgment_changed", previous);
    const previousContext = expectedContext(previous);
    if (previousContext) return previousContext;
    return empty("missing", "no_active_suppression", previous);
  }

  const expiresAt = Date.parse(active.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= at)
    return empty("expired", "expired", active);
  if (state.scope.version !== active.targetVersion)
    return empty("invalidated", "target_version_changed", active);
  if (active.fingerprint !== finding.fingerprint)
    return empty("invalidated", "fingerprint_changed", active);
  if (!latestDecision || latestDecision.revision !== active.decisionRevision)
    return empty("invalidated", "latest_decision_changed", active);
  if (!suppressionValid(state, finding, active))
    return empty("invalidated", "source_changed", active);
  if (finding.judgment !== latestDecision.judgment)
    return empty("invalidated", "judgment_changed", active);
  const activeContext = expectedContext(active);
  if (activeContext) return activeContext;
  return {
    reusable: true,
    status: "active",
    reason: "active",
    decisionRevision: latestDecision.revision,
    judgment: latestDecision.judgment,
    expiresAt: active.expiresAt,
    matchPolicy: suppressionPolicy(active),
  };
}
export function isFindingSuppressed(
  state: WorkflowState,
  finding: WorkflowFinding,
  at = Date.now(),
) {
  return evaluateFindingSuppression(state, finding, undefined, at).reusable;
}
export function workflowContext(
  state: WorkflowState,
  question: string,
  kind: "cloud" | "local" | "manual",
): WorkflowContext {
  providerKindSchema.parse(kind);
  const selected = state.knowledge
    .filter(
      (item) =>
        item.purpose === state.scope.purpose && activeAndCurrent(state, item),
    )
    .filter((item) => contextAccess(state, item.sourceRefs, kind));
  const rules = state.rules
    .filter(
      (item) =>
        item.purpose === state.scope.purpose && applicableRule(state, item),
    )
    .filter((item) => contextAccess(state, item.sourceRefs, kind));
  const conflict = selected.some((left, index) =>
    selected
      .slice(index + 1)
      .some((right) => overlaps(left.content, right.content)),
  );
  const uncertainty = conflict
    ? "conflict"
    : selected.length
      ? "none"
      : "insufficient";
  const fingerprint = hash(
    JSON.stringify({
      question,
      target: state.scope.target,
      version: state.scope.version,
      purpose: state.scope.purpose,
      knowledge: selected.map(({ id, revision }) => [id, revision]),
      rules: rules.map(({ id, revision }) => [id, revision]),
    }),
  );
  return {
    question,
    target: state.scope.target,
    targetVersion: state.scope.version,
    purpose: state.scope.purpose,
    knowledge: selected.map(({ id, revision, content, sourceRefs }) => ({
      id,
      revision,
      content,
      sourceRefs,
      classifications: sourceClassifications(state, sourceRefs),
    })),
    rules: rules.map(
      ({ id, revision, content, appliesToVersion, sourceRefs }) => ({
        id,
        revision,
        content,
        appliesToVersion,
        classifications: sourceClassifications(state, sourceRefs),
      }),
    ),
    fingerprint,
    uncertainty,
  };
}
function sourceClassifications(
  state: WorkflowState,
  refs: WorkflowSourceRef[],
): Classification[] {
  return refs.map(
    (ref) =>
      state.documents.find((doc) => doc.id === ref.docId)?.classification ??
      "unclassified",
  );
}
function contextAccess(
  state: WorkflowState,
  refs: WorkflowSourceRef[],
  kind: "cloud" | "local" | "manual",
) {
  if (
    kind === "cloud" &&
    refs.some(
      (ref) =>
        state.documents.find((doc) => doc.id === ref.docId)?.classification ===
        "local",
    )
  )
    return false;
  assertProviderAccess(state, refs, kind);
  return true;
}
