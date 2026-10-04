import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowCommand,
  WorkflowDocument,
  WorkflowFinding,
  WorkflowKnowledge,
  WorkflowRule,
  WorkflowScope,
  WorkflowState,
  WorkflowVerification,
} from "../shared/workflow.js";
import type { ResearchSummary } from "../shared/repository-research.js";
import type {
  WorkflowProviderSummary,
  WorkflowRunComparison,
  WorkflowRun,
  WorkflowRunBudgets,
} from "../shared/workflow-run.js";
import { workflowModelResponse } from "../shared/workflow-run.js";
import { request } from "./api.js";
import {
  SourceReference,
  SourceRefs,
  StatusPill,
  WorkflowField,
} from "./workflow-fields.js";
import "./workflow-page.css";

type RunList = { runs: WorkflowRun[]; providers: WorkflowProviderSummary[] };
const methodLabels: Record<string, string> = {
  "static-review": "静的レビュー",
  "known-issue-match": "既知問題との照合",
  "normal-function-test": "通常機能テスト",
  "regression-test": "回帰テスト",
  "manual-review": "人によるレビュー",
};
const classificationLabels: Record<string, string> = {
  public: "公開",
  local: "ローカル限定",
  blocked: "利用不可",
  unclassified: "未分類",
};
const statusLabels: Record<string, string> = {
  draft: "レビュー待ち",
  active: "承認済み",
  rejected: "却下",
  stale: "失効・再確認",
};
const judgmentLabels: Record<string, string> = {
  unconfirmed: "未確認",
  needs_action: "対応必要",
  false_positive: "誤検出",
  duplicate: "重複",
  accepted_known: "既知の許容事項",
};
const verificationLabels: Record<string, string> = {
  not_run: "未実施",
  passed: "確認済み",
  failed: "失敗",
  unable: "確認不能",
};
const runStatusLabels: Record<string, string> = {
  running: "実行中",
  waiting_response: "手動応答待ち",
  completed: "完了",
  partial: "一部完了",
  failed: "失敗",
  stopped: "停止",
};
const runStepLabels: Record<string, string> = {
  context: "参照情報の固定",
  provider: "手動受渡し",
  reconcile: "応答照合",
};
const runStepStatusLabels: Record<string, string> = {
  queued: "未着手",
  running: "進行中",
  completed: "完了",
  failed: "失敗",
  stopped: "停止",
  skipped: "対象外",
};
const knowledgeOriginLabels: Record<WorkflowKnowledge["origin"], string> = {
  manual: "人が整理",
  query: "照会結果から作成",
  decision: "人の判定から作成",
  remediation: "修正確認から作成",
  research: "保存済み調査から取込",
};
const emptyBudgets: WorkflowRunBudgets = {
  maxDurationMs: 60_000,
  maxCostUsd: 0,
  maxSteps: 3,
  maxConcurrency: 1,
  maxRetries: 0,
};

function latestVerificationRecords(
  verifications: WorkflowVerification[],
): WorkflowVerification[] {
  const latest = new Map<string, WorkflowVerification>();
  for (const entry of verifications) {
    const key = `${entry.method}\u0000${entry.scope}`;
    const previous = latest.get(key);
    if (!previous || entry.at >= previous.at) latest.set(key, entry);
  }
  return [...latest.values()];
}

function hasCurrentDocumentEvidence(
  entry: WorkflowVerification,
  documents: WorkflowDocument[],
): boolean {
  return (
    entry.evidence.length > 0 &&
    entry.evidence.every((ref) =>
      documents.some(
        (document) =>
          document.id === ref.docId && document.revision === ref.revision,
      ),
    )
  );
}

export function WorkflowPage({
  projectId,
  initialQuery,
  onInitialQueryApplied,
}: {
  projectId: string;
  initialQuery?: string;
  onInitialQueryApplied?: () => void;
}) {
  const [state, setState] = useState<WorkflowState>();
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [providers, setProviders] = useState<WorkflowProviderSummary[]>([]);
  const [research, setResearch] = useState<ResearchSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [scope, setScope] = useState<WorkflowScope>({
    target: "",
    version: "",
    purpose: "",
    ownership: "",
    allowedProviderIds: [],
    allowedMethods: [],
  });
  const [doc, setDoc] = useState({
    title: "",
    body: "",
    url: "",
    classification: "unclassified" as WorkflowDocument["classification"],
  });
  const [editingDoc, setEditingDoc] = useState("");
  const [source, setSource] = useState({ docId: "", excerpt: "" });
  const [knowledge, setKnowledge] = useState({
    purpose: "",
    content: "",
    origin: "manual" as WorkflowKnowledge["origin"],
  });
  const [rule, setRule] = useState({
    purpose: "",
    content: "",
    applicability: "",
    appliesToVersion: "",
  });
  const [supersedesKnowledge, setSupersedesKnowledge] = useState("");
  const [supersedesRule, setSupersedesRule] = useState("");
  const [actor, setActor] = useState("");
  const [reason, setReason] = useState("");
  const [question, setQuestion] = useState("");
  const [queryAnswer, setQueryAnswer] = useState("");
  const [providerKind, setProviderKind] = useState<
    "manual" | "local" | "cloud"
  >("manual");
  const [uncertainty, setUncertainty] = useState<
    "none" | "insufficient" | "conflict"
  >("insufficient");
  const [selectedKnowledge, setSelectedKnowledge] = useState<string[]>([]);
  const [selectedRules, setSelectedRules] = useState<string[]>([]);
  const [finding, setFinding] = useState({
    fingerprint: "",
    observation: "",
    targetVersion: "",
  });
  const [judgment, setJudgment] =
    useState<Exclude<WorkflowFinding["judgment"], "unconfirmed">>(
      "needs_action",
    );
  const [remediation, setRemediation] = useState({
    assignee: "",
    taskRef: "",
    plan: "",
    targetVersion: "",
    fixCommit: "",
  });
  const [verification, setVerification] = useState({
    method: "manual-review" as WorkflowVerification["method"],
    rationale: "",
    scope: "",
    status: "not_run" as WorkflowVerification["status"],
  });
  const [runQuery, setRunQuery] = useState("");
  const [runProvider, setRunProvider] = useState("");
  const [queryClassification, setQueryClassification] = useState<
    "public" | "local"
  >("public");
  const [budgets, setBudgets] = useState(emptyBudgets);
  const [manualResponse, setManualResponse] = useState("");
  const [comparisonForm, setComparisonForm] = useState({
    leftRunId: "",
    rightRunId: "",
    labelSetId: "",
    expected: "",
    emptyExpected: false,
    leftReviewTime: "",
    rightReviewTime: "",
  });
  const [comparison, setComparison] = useState<WorkflowRunComparison>();
  useEffect(() => {
    if (!initialQuery) return;
    setRunQuery(initialQuery);
    setQueryClassification("local");
    setRunProvider("manual");
    onInitialQueryApplied?.();
  }, [initialQuery, onInitialQueryApplied]);
  const updateComparisonForm = (value: typeof comparisonForm) => {
    setComparison(undefined);
    setComparisonForm(value);
  };

  const refresh = useCallback(async () => {
    const [next, runList, reports] = await Promise.all([
      request<WorkflowState>(`/projects/${projectId}/workflow`),
      request<RunList>(`/projects/${projectId}/workflow/runs`),
      request<ResearchSummary[]>("/research"),
    ]);
    setState(next);
    setRuns(runList.runs);
    setProviders(runList.providers);
    setResearch(reports);
    setScope(next.scope);
    setRunProvider(
      (previous) =>
        previous || runList.providers.find((item) => item.available)?.id || "",
    );
  }, [projectId]);
  useEffect(() => {
    void refresh().catch((value: unknown) => setError(String(value)));
  }, [refresh]);
  const activeRunId = runs.find(
    (item) => item.status === "waiting_response" || item.status === "running",
  )?.id;
  useEffect(() => {
    if (!activeRunId) return;
    const timer = window.setInterval(() => {
      void request<RunList>(`/projects/${projectId}/workflow/runs`)
        .then((result) => setRuns(result.runs))
        .catch((value: unknown) =>
          setError(value instanceof Error ? value.message : String(value)),
        );
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [activeRunId, projectId]);

  const execute = async (
    action: () => Promise<void>,
    onSuccess?: () => void,
  ) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await refresh();
      setNotice("保存しました。最新の案件状態を再読込しました。");
      onSuccess?.();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };
  const command = async (value: WorkflowCommand) => {
    if (!state) return;
    const next = await request<WorkflowState>(
      `/projects/${projectId}/workflow/commands`,
      { revision: state.revision, command: value },
    );
    setState(next);
  };
  const citation = useMemo(() => {
    const selected = state?.documents.find((item) => item.id === source.docId);
    return selected && source.excerpt.trim()
      ? [
          {
            docId: selected.id,
            revision: selected.revision,
            excerpt: source.excerpt,
          },
        ]
      : [];
  }, [source, state]);
  const usableRefs = (refs: { docId: string; revision: number }[]) =>
    refs.every((ref) => {
      const doc = state?.documents.find((item) => item.id === ref.docId);
      return (
        !!doc &&
        doc.revision === ref.revision &&
        (doc.classification === "public" ||
          (providerKind !== "cloud" && doc.classification === "local"))
      );
    });
  const activeKnowledge =
    state?.knowledge.filter(
      (item) =>
        item.status === "active" &&
        item.purpose === state.scope.purpose &&
        usableRefs(item.sourceRefs),
    ) ?? [];
  const activeRules =
    state?.rules.filter(
      (item) =>
        item.status === "active" &&
        item.purpose === state.scope.purpose &&
        usableRefs(item.sourceRefs),
    ) ?? [];
  const allowedQueryProviders = providers.filter(
    (item) =>
      item.available && state?.scope.allowedProviderIds.includes(item.id),
  );
  const allowedQueryKinds = [
    ...new Set(allowedQueryProviders.map((item) => item.kind)),
  ];
  const currentRun = runs.find(
    (item) => item.status === "waiting_response" || item.status === "running",
  );

  if (!state)
    return (
      <section className="workflow-page" aria-label="継続調査ワークフロー">
        <h1>継続調査ワークフロー</h1>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p>案件の範囲と保存状態を読み込んでいます…</p>
        )}
      </section>
    );

  return (
    <section className="workflow-page" aria-label="継続調査ワークフロー">
      <header className="wf-hero">
        <div>
          <p className="wf-eyebrow">継続調査 · 案件 v{state.revision}</p>
          <h1>次の調査と修正につなぐ</h1>
          <p>
            対象と許可範囲を定め、根拠を承認してから照会します。観測と人の判断を分け、修正の確認まで履歴をつなぎます。
          </p>
        </div>
        <div className="wf-flow" aria-label="調査の流れ">
          <span>対象を定める</span>
          <b>→</b>
          <span>根拠を整える</span>
          <b>→</b>
          <span>照会と判断</span>
          <b>→</b>
          <span>修正を確認</span>
        </div>
      </header>
      {error && (
        <p className="wf-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="wf-notice" role="status">
          {notice}
        </p>
      )}
      <section className="wf-section" aria-labelledby="wf-scope-title">
        <div className="wf-section-heading">
          <div>
            <span className="wf-step">01</span>
            <h2 id="wf-scope-title">対象と許可範囲</h2>
          </div>
          <p>
            対象の版、所有範囲、資料の公開区分、利用できる処理と送信先を固定します。
          </p>
        </div>
        <form
          className="wf-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void execute(() => command({ type: "scope", value: scope }));
          }}
        >
          <WorkflowField label="調査対象URL・製品">
            <input
              aria-label="調査対象"
              required
              value={scope.target}
              onChange={(e) => setScope({ ...scope, target: e.target.value })}
            />
          </WorkflowField>
          <WorkflowField label="対象の版">
            <input
              aria-label="対象の版"
              required
              value={scope.version}
              onChange={(e) => setScope({ ...scope, version: e.target.value })}
            />
          </WorkflowField>
          <WorkflowField label="調査目的">
            <textarea
              aria-label="調査目的"
              required
              value={scope.purpose}
              onChange={(e) => setScope({ ...scope, purpose: e.target.value })}
            />
          </WorkflowField>
          <WorkflowField label="所有・管理範囲">
            <textarea
              aria-label="所有・管理範囲"
              required
              value={scope.ownership}
              onChange={(e) =>
                setScope({ ...scope, ownership: e.target.value })
              }
            />
          </WorkflowField>
          <fieldset className="wf-choice">
            <legend>許可する確認方法</legend>
            {Object.entries(methodLabels).map(([id, label]) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={scope.allowedMethods.includes(
                    id as WorkflowScope["allowedMethods"][number],
                  )}
                  onChange={(e) => {
                    const method =
                      id as WorkflowScope["allowedMethods"][number];
                    setScope({
                      ...scope,
                      allowedMethods: e.target.checked
                        ? [...scope.allowedMethods, method]
                        : scope.allowedMethods.filter((x) => x !== method),
                    });
                  }}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset className="wf-choice">
            <legend>許可する送信先</legend>
            {providers.length ? (
              providers.map((provider) => (
                <label key={provider.id}>
                  <input
                    type="checkbox"
                    checked={scope.allowedProviderIds.includes(provider.id)}
                    onChange={(e) =>
                      setScope({
                        ...scope,
                        allowedProviderIds: e.target.checked
                          ? [...scope.allowedProviderIds, provider.id]
                          : scope.allowedProviderIds.filter(
                              (x) => x !== provider.id,
                            ),
                      })
                    }
                  />
                  {provider.label}（{provider.kind}）
                  {provider.available ? "" : " · 利用不可"}
                </label>
              ))
            ) : (
              <p className="wf-muted">利用可能なproviderがありません。</p>
            )}
          </fieldset>
          <button className="primary" disabled={busy}>
            範囲を保存
          </button>
        </form>
      </section>

      <section className="wf-section" aria-labelledby="wf-research-title">
        <div className="wf-section-heading">
          <div>
            <span className="wf-step">02</span>
            <h2 id="wf-research-title">原文資料とURL調査</h2>
          </div>
          <p>
            原文は保持されます。公開・ローカル限定・利用不可・未分類を明示し、改版時は参照中の知識を再確認へ送ります。
          </p>
        </div>
        {research.length > 0 && (
          <ResearchImport
            reports={research}
            projectId={projectId}
            revision={state.revision}
            busy={busy}
            execute={execute}
          />
        )}
        <form
          className="wf-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void execute(
              () =>
                command({
                  type: "document",
                  ...(editingDoc ? { documentId: editingDoc } : {}),
                  value: {
                    title: doc.title,
                    body: doc.body,
                    classification: doc.classification,
                    ...(doc.url ? { url: doc.url } : {}),
                  },
                }),
              () => {
                setEditingDoc("");
                setDoc({
                  title: "",
                  body: "",
                  url: "",
                  classification: "unclassified",
                });
              },
            );
          }}
        >
          <WorkflowField label="資料名">
            <input
              aria-label="資料名"
              required
              value={doc.title}
              onChange={(e) => setDoc({ ...doc, title: e.target.value })}
            />
          </WorkflowField>
          <WorkflowField label="資料URL（任意）">
            <input
              aria-label="資料URL"
              type="url"
              value={doc.url}
              onChange={(e) => setDoc({ ...doc, url: e.target.value })}
            />
          </WorkflowField>
          <WorkflowField label="公開区分">
            <select
              aria-label="公開区分"
              value={doc.classification}
              onChange={(e) =>
                setDoc({
                  ...doc,
                  classification: e.target
                    .value as WorkflowDocument["classification"],
                })
              }
            >
              {Object.entries(classificationLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </WorkflowField>
          <WorkflowField label="原文">
            <textarea
              aria-label="原文"
              required
              rows={4}
              value={doc.body}
              onChange={(e) => setDoc({ ...doc, body: e.target.value })}
            />
          </WorkflowField>
          <button className="primary" disabled={busy}>
            {editingDoc ? "資料の新しい版を保存" : "資料を保存"}
          </button>
        </form>
        <div className="wf-card-list">
          {state.documents.map((item) => (
            <article className="wf-card" key={item.id}>
              <div className="wf-card-title">
                <h3>{item.title}</h3>
                <StatusPill
                  tone={
                    item.classification === "public"
                      ? "good"
                      : item.classification === "unclassified" ||
                          item.classification === "blocked"
                        ? "bad"
                        : "warn"
                  }
                >
                  {classificationLabels[item.classification]}
                </StatusPill>
              </div>
              <p>
                版 v{item.revision} · SHA256 {item.hash.slice(0, 12)}…
                {item.url ? (
                  <>
                    {" "}
                    ·{" "}
                    <a href={item.url} target="_blank" rel="noreferrer">
                      出典
                    </a>
                  </>
                ) : (
                  ""
                )}
              </p>
              <details>
                <summary>原文と更新履歴を確認</summary>
                <pre>{item.body}</pre>
                {item.history.map((old) => (
                  <p key={old.revision}>
                    旧版 v{old.revision} · SHA256 {old.hash.slice(0, 12)}…
                  </p>
                ))}
              </details>
              <button
                onClick={() => {
                  setEditingDoc(item.id);
                  setDoc({
                    title: item.title,
                    body: item.body,
                    url: item.url ?? "",
                    classification: item.classification,
                  });
                }}
              >
                新しい版を編集
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className="wf-section" aria-labelledby="wf-knowledge-title">
        <div className="wf-section-heading">
          <div>
            <span className="wf-step">03</span>
            <h2 id="wf-knowledge-title">製品知識とレビュー基準</h2>
          </div>
          <p>
            仕様・権限・設計理由・環境・過去判断を原文の引用に結び付け、案と承認済み知識を分けます。
          </p>
        </div>
        <div className="wf-two-col">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!citation.length) return;
              const prior = state.knowledge.find(
                (item) => `${item.id}@${item.revision}` === supersedesKnowledge,
              );
              void execute(() =>
                command({
                  type: "knowledge-draft",
                  purpose: knowledge.purpose || state.scope.purpose,
                  content: knowledge.content,
                  origin: knowledge.origin,
                  sourceRefs: citation,
                  ...(prior
                    ? { supersedes: { id: prior.id, revision: prior.revision } }
                    : {}),
                }),
              );
            }}
          >
            <h3>知識の更新案</h3>
            <WorkflowField label="知識の目的">
              <input
                aria-label="知識の目的"
                required
                value={knowledge.purpose || state.scope.purpose}
                onChange={(e) =>
                  setKnowledge({ ...knowledge, purpose: e.target.value })
                }
              />
            </WorkflowField>
            <WorkflowField label="整理した知識">
              <textarea
                aria-label="整理した知識"
                required
                value={knowledge.content}
                onChange={(e) =>
                  setKnowledge({ ...knowledge, content: e.target.value })
                }
              />
            </WorkflowField>
            <WorkflowField label="置き換える知識（任意）">
              <select
                aria-label="置き換える知識"
                value={supersedesKnowledge}
                onChange={(e) => setSupersedesKnowledge(e.target.value)}
              >
                <option value="">新しい知識として追加</option>
                {state.knowledge
                  .filter(
                    (item) =>
                      item.status === "active" || item.status === "stale",
                  )
                  .map((item) => (
                    <option
                      key={`${item.id}@${item.revision}`}
                      value={`${item.id}@${item.revision}`}
                    >
                      {item.content.slice(0, 80)} · v{item.revision}
                    </option>
                  ))}
              </select>
            </WorkflowField>
            <WorkflowField label="案の由来">
              <select
                aria-label="案の由来"
                value={knowledge.origin}
                onChange={(e) =>
                  setKnowledge({
                    ...knowledge,
                    origin: e.target.value as WorkflowKnowledge["origin"],
                  })
                }
              >
                {["manual", "query", "decision", "remediation", "research"].map(
                  (item) => (
                    <option key={item} value={item}>
                      {
                        knowledgeOriginLabels[
                          item as WorkflowKnowledge["origin"]
                        ]
                      }
                    </option>
                  ),
                )}
              </select>
            </WorkflowField>
            <SourceReference
              documents={state.documents}
              value={source}
              onChange={setSource}
            />
            <button
              className="primary"
              disabled={busy || citation.length === 0}
            >
              知識案を保存
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!citation.length) return;
              const prior = state.rules.find(
                (item) => `${item.id}@${item.revision}` === supersedesRule,
              );
              void execute(() =>
                command({
                  type: "rule-draft",
                  purpose: rule.purpose || state.scope.purpose,
                  content: rule.content,
                  applicability: rule.applicability,
                  appliesToVersion:
                    rule.appliesToVersion || state.scope.version,
                  sourceRefs: citation,
                  ...(prior
                    ? { supersedes: { id: prior.id, revision: prior.revision } }
                    : {}),
                }),
              );
            }}
          >
            <h3>判定基準の更新案</h3>
            <WorkflowField label="基準の目的">
              <input
                aria-label="基準の目的"
                required
                value={rule.purpose || state.scope.purpose}
                onChange={(e) => setRule({ ...rule, purpose: e.target.value })}
              />
            </WorkflowField>
            <WorkflowField label="判定ルール">
              <textarea
                aria-label="判定ルール"
                required
                value={rule.content}
                onChange={(e) => setRule({ ...rule, content: e.target.value })}
              />
            </WorkflowField>
            <WorkflowField label="適用条件">
              <textarea
                aria-label="適用条件"
                required
                value={rule.applicability}
                onChange={(e) =>
                  setRule({ ...rule, applicability: e.target.value })
                }
              />
            </WorkflowField>
            <WorkflowField label="適用対象の版">
              <input
                aria-label="適用対象の版"
                value={rule.appliesToVersion || state.scope.version}
                onChange={(e) =>
                  setRule({ ...rule, appliesToVersion: e.target.value })
                }
              />
            </WorkflowField>
            <WorkflowField label="置き換える基準（任意）">
              <select
                aria-label="置き換える基準"
                value={supersedesRule}
                onChange={(e) => setSupersedesRule(e.target.value)}
              >
                <option value="">新しい基準として追加</option>
                {state.rules
                  .filter(
                    (item) =>
                      item.status === "active" || item.status === "stale",
                  )
                  .map((item) => (
                    <option
                      key={`${item.id}@${item.revision}`}
                      value={`${item.id}@${item.revision}`}
                    >
                      {item.content.slice(0, 80)} · v{item.revision}
                    </option>
                  ))}
              </select>
            </WorkflowField>
            <SourceReference
              documents={state.documents}
              value={source}
              onChange={setSource}
            />
            <button
              className="primary"
              disabled={busy || citation.length === 0}
            >
              基準案を保存
            </button>
          </form>
        </div>
        <div className="wf-two-col">
          {state.knowledge.map((item) => (
            <ReviewCard
              key={`k-${item.id}@${item.revision}`}
              title={item.content}
              revision={item.revision}
              status={item.status}
              refs={item.sourceRefs}
              documents={state.documents}
              actor={actor}
              setActor={setActor}
              reason={reason}
              setReason={setReason}
              busy={busy}
              onReview={(decision) =>
                execute(() =>
                  command({
                    type: "knowledge-review",
                    knowledgeId: item.id,
                    decision,
                    actor,
                    reason,
                  }),
                )
              }
            />
          ))}
          {state.rules.map((item: WorkflowRule) => (
            <ReviewCard
              key={`r-${item.id}@${item.revision}`}
              title={item.content}
              revision={item.revision}
              status={item.status}
              refs={item.sourceRefs}
              documents={state.documents}
              actor={actor}
              setActor={setActor}
              reason={reason}
              setReason={setReason}
              busy={busy}
              extra={`適用条件: ${item.applicability} · 対象版: ${item.appliesToVersion}`}
              onReview={(decision) =>
                execute(() =>
                  command({
                    type: "rule-review",
                    ruleId: item.id,
                    decision,
                    actor,
                    reason,
                  }),
                )
              }
            />
          ))}
        </div>
      </section>

      <section className="wf-section" aria-labelledby="wf-query-title">
        <div className="wf-section-heading">
          <div>
            <span className="wf-step">04</span>
            <h2 id="wf-query-title">承認済み知識で照会</h2>
          </div>
          <p>
            照会に使う知識・基準と各版を記録します。未承認・失効・目的外・送信不可の知識は選べません。
          </p>
        </div>
        <form
          className="wf-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void execute(() =>
              command({
                type: "query",
                question,
                providerKind,
                knowledge: activeKnowledge
                  .filter((item) => selectedKnowledge.includes(item.id))
                  .map(({ id, revision }) => ({ id, revision })),
                rules: activeRules
                  .filter((item) => selectedRules.includes(item.id))
                  .map(({ id, revision }) => ({ id, revision })),
                ...(queryAnswer ? { answer: queryAnswer } : {}),
                uncertainty,
              }),
            );
          }}
        >
          <WorkflowField label="照会内容">
            <textarea
              aria-label="照会内容"
              required
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </WorkflowField>
          <WorkflowField label="方式">
            <select
              aria-label="照会方式"
              value={providerKind}
              onChange={(e) =>
                setProviderKind(e.target.value as typeof providerKind)
              }
            >
              {["manual", "local", "cloud"].map((item) => (
                <option
                  key={item}
                  value={item}
                  disabled={
                    !allowedQueryProviders.some(
                      (provider) => provider.kind === item,
                    )
                  }
                >
                  {item === "manual"
                    ? "手動受渡し"
                    : item === "local"
                      ? "ローカルモデル"
                      : "許可された外部モデル"}
                </option>
              ))}
            </select>
          </WorkflowField>
          <fieldset className="wf-choice">
            <legend>参照する知識の版</legend>
            {activeKnowledge.length ? (
              activeKnowledge.map((item) => (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={selectedKnowledge.includes(item.id)}
                    onChange={(e) =>
                      setSelectedKnowledge(
                        e.target.checked
                          ? [...selectedKnowledge, item.id]
                          : selectedKnowledge.filter((id) => id !== item.id),
                      )
                    }
                  />
                  {item.content} · v{item.revision}
                </label>
              ))
            ) : (
              <p className="wf-muted">
                この目的で使える承認済み知識がありません。
              </p>
            )}
          </fieldset>
          <fieldset className="wf-choice">
            <legend>参照する判定基準</legend>
            {activeRules.map((item) => (
              <label key={item.id}>
                <input
                  type="checkbox"
                  checked={selectedRules.includes(item.id)}
                  onChange={(e) =>
                    setSelectedRules(
                      e.target.checked
                        ? [...selectedRules, item.id]
                        : selectedRules.filter((id) => id !== item.id),
                    )
                  }
                />
                {item.content} · v{item.revision}
              </label>
            ))}
          </fieldset>
          <WorkflowField label="回答（手動受渡し時は任意）">
            <textarea
              aria-label="回答"
              value={queryAnswer}
              onChange={(e) => setQueryAnswer(e.target.value)}
            />
          </WorkflowField>
          <WorkflowField label="確実性">
            <select
              aria-label="確実性"
              value={uncertainty}
              onChange={(e) =>
                setUncertainty(e.target.value as typeof uncertainty)
              }
            >
              <option value="none">根拠に矛盾・不足なし</option>
              <option value="insufficient">根拠不足・未確認</option>
              <option value="conflict">根拠間に矛盾</option>
            </select>
          </WorkflowField>
          <button
            className="primary"
            disabled={
              busy ||
              !allowedQueryKinds.includes(providerKind) ||
              !selectedKnowledge.some((id) =>
                activeKnowledge.some((item) => item.id === id),
              )
            }
          >
            照会と参照版を保存
          </button>
        </form>
        {state.queries.map((item) => (
          <article className="wf-card" key={item.id}>
            <div className="wf-card-title">
              <h3>{item.question}</h3>
              <StatusPill tone={item.uncertainty === "none" ? "good" : "warn"}>
                {item.uncertainty === "none"
                  ? "未確認事項なし"
                  : item.uncertainty === "conflict"
                    ? "矛盾あり"
                    : "根拠不足・未確認"}
              </StatusPill>
            </div>
            <p>
              方式 {item.providerKind} · {item.at} · 知識{" "}
              {item.knowledge
                .map((ref) => `${ref.id.slice(0, 8)} v${ref.revision}`)
                .join("、")}
            </p>
            {item.answer && <p>{item.answer}</p>}
            {item.knowledge.map((ref) => {
              const used = state.knowledge.find(
                (k) => k.id === ref.id && k.revision === ref.revision,
              );
              return used ? (
                <SourceRefs
                  key={ref.id}
                  refs={used.sourceRefs}
                  documents={state.documents}
                />
              ) : (
                <p key={ref.id}>
                  参照版 {ref.id} v{ref.revision} は現在の一覧にありません。
                </p>
              );
            })}
            <button
              onClick={() => {
                setKnowledge({
                  purpose: state.scope.purpose,
                  content: item.answer ?? "",
                  origin: "query",
                });
                setQuestion(item.question);
              }}
            >
              照会結果から知識更新案を作る
            </button>
          </article>
        ))}
      </section>

      <section className="wf-section" aria-labelledby="wf-findings-title">
        <div className="wf-section-heading">
          <div>
            <span className="wf-step">05</span>
            <h2 id="wf-findings-title">観測と人の判定</h2>
          </div>
          <p>
            候補の観測結果は未確認で記録します。確定には担当者・理由・対象版・出典が必要です。
          </p>
        </div>
        <form
          className="wf-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void execute(() =>
              command({
                type: "finding-observation",
                fingerprint: finding.fingerprint,
                targetVersion: finding.targetVersion || state.scope.version,
                observation: finding.observation,
                sourceRefs: citation,
              }),
            );
          }}
        >
          <WorkflowField label="指摘の識別子">
            <input
              aria-label="指摘の識別子"
              required
              value={finding.fingerprint}
              onChange={(e) =>
                setFinding({ ...finding, fingerprint: e.target.value })
              }
            />
          </WorkflowField>
          <WorkflowField label="観測対象版">
            <input
              aria-label="観測対象版"
              required
              value={finding.targetVersion || state.scope.version}
              onChange={(e) =>
                setFinding({ ...finding, targetVersion: e.target.value })
              }
            />
          </WorkflowField>
          <WorkflowField label="観測内容">
            <textarea
              aria-label="観測内容"
              required
              value={finding.observation}
              onChange={(e) =>
                setFinding({ ...finding, observation: e.target.value })
              }
            />
          </WorkflowField>
          <SourceReference
            documents={state.documents}
            value={source}
            onChange={setSource}
          />
          <button className="primary" disabled={busy}>
            未確認の観測を記録
          </button>
        </form>
        {state.findings.map((item) => (
          <FindingCard
            key={item.id}
            item={item}
            state={state}
            actor={actor}
            setActor={setActor}
            reason={reason}
            setReason={setReason}
            judgment={judgment}
            setJudgment={setJudgment}
            source={source}
            setSource={setSource}
            busy={busy}
            onRun={execute}
            command={command}
          />
        ))}
      </section>

      <section className="wf-section" aria-labelledby="wf-runs-title">
        <div className="wf-section-heading">
          <div>
            <span className="wf-step">06</span>
            <h2 id="wf-runs-title">保存・再開できる調査実行</h2>
          </div>
          <p>
            実行前に方式と上限を決めます。完了済み工程、入力版、知識版、停止理由、未取得の費用を履歴に残します。
          </p>
        </div>
        <form
          className="wf-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void execute(async () => {
              const result = await request<WorkflowRun>(
                `/projects/${projectId}/workflow/runs`,
                {
                  revision: state.revision,
                  query: runQuery,
                  queryClassification,
                  providerId: runProvider,
                  budgets,
                },
              );
              setRuns((previous) => [result, ...previous]);
            });
          }}
        >
          <WorkflowField label="調査内容">
            <textarea
              aria-label="実行内容"
              required
              value={runQuery}
              onChange={(e) => setRunQuery(e.target.value)}
            />
          </WorkflowField>
          <WorkflowField label="調査内容の区分">
            <select
              aria-label="調査内容の区分"
              value={queryClassification}
              onChange={(e) =>
                setQueryClassification(
                  e.target.value as typeof queryClassification,
                )
              }
            >
              <option value="public">公開情報</option>
              <option value="local">ローカル限定</option>
            </select>
          </WorkflowField>
          <WorkflowField label="実行方式">
            <select
              aria-label="実行方式"
              required
              value={runProvider}
              onChange={(e) => setRunProvider(e.target.value)}
            >
              <option value="">方式を選択</option>
              {providers.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                  disabled={
                    !item.available ||
                    !state.scope.allowedProviderIds.includes(item.id) ||
                    (queryClassification === "local" && item.kind === "cloud")
                  }
                >
                  {item.label} · {item.kind}
                  {item.costKnown ? "" : " · 費用未取得"}
                </option>
              ))}
            </select>
          </WorkflowField>
          <WorkflowField label="時間上限（ミリ秒）">
            <input
              aria-label="時間上限"
              type="number"
              min="1000"
              max="1800000"
              value={budgets.maxDurationMs}
              onChange={(e) =>
                setBudgets({
                  ...budgets,
                  maxDurationMs: Number(e.target.value),
                })
              }
            />
          </WorkflowField>
          <WorkflowField label="費用上限（USD）">
            <input
              aria-label="費用上限"
              type="number"
              min="0"
              step="0.01"
              value={budgets.maxCostUsd}
              onChange={(e) =>
                setBudgets({ ...budgets, maxCostUsd: Number(e.target.value) })
              }
            />
          </WorkflowField>
          <WorkflowField label="最大工程数">
            <input
              aria-label="最大工程数"
              type="number"
              min="1"
              max="10"
              value={budgets.maxSteps}
              onChange={(e) =>
                setBudgets({ ...budgets, maxSteps: Number(e.target.value) })
              }
            />
          </WorkflowField>
          <WorkflowField label="最大並列数">
            <input
              aria-label="最大並列数"
              type="number"
              min="1"
              max="4"
              value={budgets.maxConcurrency}
              onChange={(e) =>
                setBudgets({
                  ...budgets,
                  maxConcurrency: Number(e.target.value),
                })
              }
            />
          </WorkflowField>
          <WorkflowField label="最大再試行">
            <input
              aria-label="最大再試行"
              type="number"
              min="0"
              max="5"
              value={budgets.maxRetries}
              onChange={(e) =>
                setBudgets({ ...budgets, maxRetries: Number(e.target.value) })
              }
            />
          </WorkflowField>
          <button
            className="primary"
            disabled={
              busy || !state.scope.allowedProviderIds.includes(runProvider)
            }
          >
            この条件で調査を開始
          </button>
        </form>
        {currentRun?.status === "waiting_response" &&
          currentRun.providerKind === "manual" && (
            <div className="wf-manual">
              <h3>手動モデルの受渡し</h3>
              <p>
                プロンプトをコピーして選んだ方式へ渡し、回答を貼り付けてください。
              </p>
              <pre>
                {String(
                  currentRun.artifacts.find((item) => item.kind === "prompt")
                    ?.value ?? "プロンプトがありません",
                )}
              </pre>
              <WorkflowField label="モデル応答">
                <textarea
                  aria-label="モデル応答"
                  value={manualResponse}
                  onChange={(e) => setManualResponse(e.target.value)}
                  placeholder='{"answer":"...","citedKnowledgeIds":[],"findingReferences":[]}'
                />
              </WorkflowField>
              <button
                className="primary"
                disabled={busy || !manualResponse.trim()}
                onClick={() =>
                  void execute(async () => {
                    const response = workflowModelResponse.parse(
                      JSON.parse(manualResponse),
                    );
                    await request(
                      `/projects/${projectId}/workflow/runs/${currentRun.id}/response`,
                      { response },
                    );
                  })
                }
              >
                応答を取り込み
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void execute(() =>
                    request(
                      `/projects/${projectId}/workflow/runs/${currentRun.id}/stop`,
                      {},
                    ),
                  )
                }
              >
                停止
              </button>
            </div>
          )}
        <div className="wf-card-list">
          {runs.map((item) => (
            <RunCard
              key={item.id}
              item={item}
              projectId={projectId}
              busy={busy}
              execute={execute}
            />
          ))}
        </div>
        <div className="wf-comparison">
          <h3>同条件の方式を比較</h3>
          <p>
            同じ対象版・知識版・判定基準の実行だけを比べます。正解ラベルを指定し、人の確認時間や費用を測れていない項目は未測定として残します。
          </p>
          <form
            className="wf-grid"
            onSubmit={(event) => {
              event.preventDefault();
              const expectedFindingReferences = comparisonForm.emptyExpected
                ? []
                : comparisonForm.expected
                    .split(/\r?\n|,/u)
                    .map((value) => value.trim())
                    .filter(Boolean);
              setComparison(undefined);
              void execute(async () => {
                const result = await request<WorkflowRunComparison>(
                  `/projects/${projectId}/workflow/compare`,
                  {
                    leftRunId: comparisonForm.leftRunId,
                    rightRunId: comparisonForm.rightRunId,
                    labelSetId: comparisonForm.labelSetId,
                    expectedFindingReferences,
                    reviewTimeMsByRunId: {
                      [comparisonForm.leftRunId]:
                        comparisonForm.leftReviewTime === ""
                          ? null
                          : Number(comparisonForm.leftReviewTime),
                      [comparisonForm.rightRunId]:
                        comparisonForm.rightReviewTime === ""
                          ? null
                          : Number(comparisonForm.rightReviewTime),
                    },
                  },
                );
                setComparison(result);
              });
            }}
          >
            <WorkflowField label="方式A">
              <select
                aria-label="方式A"
                required
                value={comparisonForm.leftRunId}
                onChange={(e) =>
                  updateComparisonForm({
                    ...comparisonForm,
                    leftRunId: e.target.value,
                  })
                }
              >
                <option value="">実行を選択</option>
                {runs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.query} · {item.providerId}
                  </option>
                ))}
              </select>
            </WorkflowField>
            <WorkflowField label="方式B">
              <select
                aria-label="方式B"
                required
                value={comparisonForm.rightRunId}
                onChange={(e) =>
                  updateComparisonForm({
                    ...comparisonForm,
                    rightRunId: e.target.value,
                  })
                }
              >
                <option value="">実行を選択</option>
                {runs
                  .filter((item) => item.id !== comparisonForm.leftRunId)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.query} · {item.providerId}
                    </option>
                  ))}
              </select>
            </WorkflowField>
            <WorkflowField label="正解ラベルセットID">
              <input
                aria-label="正解ラベルセットID"
                required
                value={comparisonForm.labelSetId}
                onChange={(e) =>
                  updateComparisonForm({
                    ...comparisonForm,
                    labelSetId: e.target.value,
                  })
                }
              />
            </WorkflowField>
            <WorkflowField label="正解指摘参照（1行1件）">
              <textarea
                aria-label="正解指摘参照"
                disabled={comparisonForm.emptyExpected}
                value={comparisonForm.expected}
                onChange={(e) =>
                  updateComparisonForm({
                    ...comparisonForm,
                    expected: e.target.value,
                  })
                }
                placeholder="finding-id-1&#10;finding-id-2"
              />
            </WorkflowField>
            <label className="wf-empty-label">
              <input
                type="checkbox"
                checked={comparisonForm.emptyExpected}
                onChange={(e) =>
                  updateComparisonForm({
                    ...comparisonForm,
                    emptyExpected: e.target.checked,
                    expected: e.target.checked ? "" : comparisonForm.expected,
                  })
                }
              />
              正解ラベル上の指摘は0件
            </label>
            <WorkflowField label="方式Aの確認時間（ミリ秒・未測定可）">
              <input
                aria-label="方式Aの確認時間"
                type="number"
                min="0"
                value={comparisonForm.leftReviewTime}
                onChange={(e) =>
                  updateComparisonForm({
                    ...comparisonForm,
                    leftReviewTime: e.target.value,
                  })
                }
              />
            </WorkflowField>
            <WorkflowField label="方式Bの確認時間（ミリ秒・未測定可）">
              <input
                aria-label="方式Bの確認時間"
                type="number"
                min="0"
                value={comparisonForm.rightReviewTime}
                onChange={(e) =>
                  updateComparisonForm({
                    ...comparisonForm,
                    rightReviewTime: e.target.value,
                  })
                }
              />
            </WorkflowField>
            <button
              className="primary"
              disabled={
                busy ||
                !comparisonForm.leftRunId ||
                !comparisonForm.rightRunId ||
                comparisonForm.leftRunId === comparisonForm.rightRunId ||
                (!comparisonForm.emptyExpected &&
                  !comparisonForm.expected.trim())
              }
            >
              条件を照合して比較
            </button>
          </form>
          {comparison && (
            <div
              role="status"
              className="wf-comparison-result"
              data-testid="workflow-comparison-result"
            >
              <h4>
                {comparison.eligible
                  ? "同条件で比較可能"
                  : "比較条件が一致しません"}
              </h4>
              <p>
                方式A:{" "}
                {runs.find((run) => run.id === comparison.leftRunId)?.query ??
                  "実行"}
                {" · "}
                {comparison.leftRunId.slice(0, 8)}
                {" · "}
                方式B:{" "}
                {runs.find((run) => run.id === comparison.rightRunId)?.query ??
                  "実行"}
                {" · "}
                {comparison.rightRunId.slice(0, 8)}
              </p>
              {comparison.reason && <p>{comparison.reason}</p>}
              <div className="wf-metrics">
                {(
                  [
                    "falseNegatives",
                    "falsePositives",
                    "duplicateFindings",
                    "reviewTimeMs",
                    "executionTimeMs",
                    "costUsd",
                  ] as const
                ).map((key) => (
                  <div key={key}>
                    <span>
                      {
                        {
                          falseNegatives: "見落とし",
                          falsePositives: "誤提示",
                          duplicateFindings: "重複再提示",
                          reviewTimeMs: "人の確認時間",
                          executionTimeMs: "実行時間",
                          costUsd: "取得費用",
                        }[key]
                      }
                    </span>
                    <strong>
                      {comparison.metrics.left[key] === null
                        ? "未測定"
                        : comparison.metrics.left[key]}{" "}
                      /{" "}
                      {comparison.metrics.right[key] === null
                        ? "未測定"
                        : comparison.metrics.right[key]}
                    </strong>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="wf-section" aria-labelledby="wf-remediation-title">
        <div className="wf-section-heading">
          <div>
            <span className="wf-step">07</span>
            <h2 id="wf-remediation-title">修正と確認</h2>
          </div>
          <p>
            対応必要の判定から担当・タスク・コミットを記録し、許可された確認方法で対象版の証跡を残します。
          </p>
        </div>
        {state.findings
          .filter(
            (item) => item.judgment === "needs_action" || item.remediation,
          )
          .map((item) => (
            <RemediationCard
              key={item.id}
              item={item}
              state={state}
              actor={actor}
              setActor={setActor}
              reason={reason}
              setReason={setReason}
              remediation={remediation}
              setRemediation={setRemediation}
              verification={verification}
              setVerification={setVerification}
              source={source}
              setSource={setSource}
              busy={busy}
              execute={execute}
              command={command}
            />
          ))}
      </section>
    </section>
  );
}

function ReviewCard({
  title,
  revision,
  status,
  refs,
  documents,
  actor,
  setActor,
  reason,
  setReason,
  busy,
  extra,
  onReview,
}: {
  title: string;
  revision: number;
  status: WorkflowKnowledge["status"];
  refs: WorkflowKnowledge["sourceRefs"];
  documents: WorkflowDocument[];
  actor: string;
  setActor: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  extra?: string;
  onReview: (decision: "active" | "rejected") => Promise<void>;
}) {
  return (
    <article className="wf-card">
      <div className="wf-card-title">
        <h3>{title}</h3>
        <StatusPill
          tone={
            status === "active"
              ? "good"
              : status === "draft"
                ? "warn"
                : undefined
          }
        >
          {statusLabels[status]} · v{revision}
        </StatusPill>
      </div>
      {extra && <p>{extra}</p>}
      <SourceRefs refs={refs} documents={documents} />
      {status === "draft" && (
        <div className="wf-review-controls">
          <WorkflowField label="レビュー担当">
            <input
              aria-label="レビュー担当"
              required
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            />
          </WorkflowField>
          <WorkflowField label="判断理由">
            <input
              aria-label="判断理由"
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </WorkflowField>
          <button
            className="primary"
            disabled={busy || !actor.trim() || !reason.trim()}
            onClick={() => void onReview("active")}
          >
            承認して有効化
          </button>
          <button
            disabled={busy || !actor.trim() || !reason.trim()}
            onClick={() => void onReview("rejected")}
          >
            却下
          </button>
        </div>
      )}
    </article>
  );
}

function ResearchImport({
  reports,
  projectId,
  revision,
  busy,
  execute,
}: {
  reports: ResearchSummary[];
  projectId: string;
  revision: number;
  busy: boolean;
  execute: (action: () => Promise<void>) => Promise<void>;
}) {
  const [researchId, setResearchId] = useState("");
  return (
    <div className="wf-import">
      <WorkflowField label="保存済みOSS調査">
        <select
          aria-label="保存済みOSS調査"
          value={researchId}
          onChange={(event) => setResearchId(event.target.value)}
        >
          <option value="">調査結果を選択</option>
          {reports.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.findings}件 · {item.status} ·{" "}
              {item.collectedAt}
            </option>
          ))}
        </select>
      </WorkflowField>
      <button
        disabled={busy || !researchId}
        onClick={() =>
          void execute(() =>
            request(`/projects/${projectId}/workflow/import-research`, {
              revision,
              researchId,
            }),
          )
        }
      >
        案件へ取込
      </button>
      <span>取込後も指摘候補と判断は未確認から始まります。</span>
    </div>
  );
}

function FindingCard({
  item,
  state,
  actor,
  setActor,
  reason,
  setReason,
  judgment,
  setJudgment,
  source,
  setSource,
  busy,
  onRun,
  command,
}: {
  item: WorkflowFinding;
  state: WorkflowState;
  actor: string;
  setActor: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
  judgment: Exclude<WorkflowFinding["judgment"], "unconfirmed">;
  setJudgment: (v: Exclude<WorkflowFinding["judgment"], "unconfirmed">) => void;
  source: { docId: string; excerpt: string };
  setSource: (v: { docId: string; excerpt: string }) => void;
  busy: boolean;
  onRun: (action: () => Promise<void>) => Promise<void>;
  command: (v: WorkflowCommand) => Promise<void>;
}) {
  const [expiresAt, setExpiresAt] = useState("");
  const [suppressionReason, setSuppressionReason] = useState("");
  const citation =
    source.docId && source.excerpt.trim()
      ? [
          {
            docId: source.docId,
            revision:
              state.documents.find((doc) => doc.id === source.docId)
                ?.revision ?? 0,
            excerpt: source.excerpt,
          },
        ]
      : [];
  const suppressionCurrent = (
    suppression: WorkflowFinding["suppressions"][number],
  ) =>
    suppression.active &&
    Date.parse(suppression.expiresAt) > Date.now() &&
    suppression.targetVersion === state.scope.version &&
    suppression.fingerprint === item.fingerprint &&
    item.decisions.at(-1)?.revision === suppression.decisionRevision &&
    suppression.ruleRefs.every((ref) => {
      const current = state.rules.find(
        (candidate) =>
          candidate.id === ref.id && candidate.revision === ref.revision,
      );
      return (
        !!current &&
        current.status === "active" &&
        current.sourceRefs.every(
          (sourceRef) =>
            state.documents.find((doc) => doc.id === sourceRef.docId)
              ?.revision === sourceRef.revision,
        )
      );
    });
  return (
    <article className="wf-card" aria-label={`指摘 ${item.fingerprint}`}>
      <div className="wf-card-title">
        <h3>{item.observation}</h3>
        <StatusPill
          tone={
            item.judgment === "needs_action"
              ? "bad"
              : item.judgment === "unconfirmed"
                ? "warn"
                : "good"
          }
        >
          {judgmentLabels[item.judgment]}
        </StatusPill>
      </div>
      <p>
        指摘ID {item.fingerprint} · 対象版 {item.targetVersion} · 観測{" "}
        {item.observedAt}
      </p>
      {item.observationHistory.length > 1 && (
        <details>
          <summary>再観測履歴（{item.observationHistory.length}件）</summary>
          {item.observationHistory.map((entry, index) => (
            <div key={`${entry.observedAt}-${index}`}>
              <p>
                版 {entry.targetVersion} · {entry.observedAt}
              </p>
              <p>{entry.observation}</p>
              <SourceRefs refs={entry.sourceRefs} documents={state.documents} />
            </div>
          ))}
        </details>
      )}
      <SourceRefs refs={item.sourceRefs} documents={state.documents} />
      {item.judgment === "unconfirmed" && (
        <div className="wf-review-controls">
          <WorkflowField label="人の判定">
            <select
              aria-label="人の判定"
              value={judgment}
              onChange={(e) => setJudgment(e.target.value as typeof judgment)}
            >
              {Object.entries(judgmentLabels)
                .filter(([key]) => key !== "unconfirmed")
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </WorkflowField>
          <WorkflowField label="判断担当">
            <input
              aria-label="判断担当"
              value={actor}
              onChange={(e) => setActor(e.target.value)}
            />
          </WorkflowField>
          <WorkflowField label="判断理由">
            <input
              aria-label="判断理由"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </WorkflowField>
          <SourceReference
            documents={state.documents}
            value={source}
            onChange={setSource}
          />
          <button
            className="primary"
            disabled={
              busy || !actor.trim() || !reason.trim() || !citation.length
            }
            onClick={() =>
              void onRun(() =>
                command({
                  type: "finding-decision",
                  findingId: item.id,
                  judgment,
                  actor,
                  reason,
                  targetVersion: item.targetVersion,
                  sourceRefs: citation,
                  ruleRefs: state.rules
                    .filter((rule) => rule.status === "active")
                    .map(({ id, revision }) => ({ id, revision })),
                }),
              )
            }
          >
            人の判定を記録
          </button>
        </div>
      )}
      {item.decisions.map((decision, index) => (
        <p key={`${decision.at}-${index}`}>
          判定: {judgmentLabels[decision.judgment]} · {decision.actor} ·{" "}
          {decision.reason} · 基準{" "}
          {decision.ruleRefs.map((ref) => `v${ref.revision}`).join(", ") ||
            "なし"}
        </p>
      ))}
      {item.judgment !== "unconfirmed" &&
        ["false_positive", "duplicate", "accepted_known"].includes(
          item.judgment,
        ) && (
          <div className="wf-review-controls">
            <WorkflowField label="抑止理由">
              <input
                aria-label="抑止理由"
                value={suppressionReason}
                onChange={(e) => setSuppressionReason(e.target.value)}
              />
            </WorkflowField>
            <WorkflowField label="抑止期限">
              <input
                aria-label="抑止期限"
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </WorkflowField>
            <button
              disabled={busy || !expiresAt || !suppressionReason.trim()}
              onClick={() =>
                void onRun(() =>
                  command({
                    type: "suppression",
                    findingId: item.id,
                    actor,
                    reason: suppressionReason,
                    targetVersion: item.targetVersion,
                    fingerprint: item.fingerprint,
                    ruleRefs: state.rules
                      .filter((r) => r.status === "active")
                      .map(({ id, revision }) => ({ id, revision })),
                    expiresAt: new Date(expiresAt).toISOString(),
                  }),
                )
              }
            >
              期限付きで再提示を抑止
            </button>
          </div>
        )}
      {item.suppressions.map((suppression, index) => (
        <p key={`${suppression.expiresAt}-${index}`}>
          抑止 {suppressionCurrent(suppression) ? "有効" : "失効・再確認"} ·{" "}
          {suppression.actor} · {suppression.reason} · 期限{" "}
          {suppression.expiresAt}
        </p>
      ))}
    </article>
  );
}

function RunCard({
  item,
  projectId,
  busy,
  execute,
}: {
  item: WorkflowRun;
  projectId: string;
  busy: boolean;
  execute: (action: () => Promise<void>) => Promise<void>;
}) {
  const currentStep = item.steps.find(
    (step) => step.status === "running" || step.status === "queued",
  );
  const citedKnowledge = (item.answer?.citedKnowledgeIds ?? []).map((id) =>
    item.snapshot.knowledge.find((entry) => entry.id === id),
  );
  return (
    <article className="wf-card">
      <div className="wf-card-title">
        <h3>{item.query}</h3>
        <StatusPill
          tone={
            item.status === "completed"
              ? "good"
              : ["failed", "stopped"].includes(item.status)
                ? "bad"
                : "warn"
          }
        >
          {runStatusLabels[item.status] ?? item.status}
        </StatusPill>
      </div>
      <p>
        {currentStep
          ? `現在の工程: ${runStepLabels[currentStep.name] ?? currentStep.name} · ${runStepStatusLabels[currentStep.status] ?? currentStep.status}`
          : item.status === "waiting_response"
            ? "手動応答を入力してください。"
            : "次の工程はありません。"}
      </p>
      {item.status === "waiting_response" && (
        <p>下の手動受渡し用の質問に回答して、応答を照合してください。</p>
      )}
      {item.answer && (
        <section aria-label="照会への回答">
          <h4>照会への回答（提案）</h4>
          <p>{item.answer.answer}</p>
          <h5>参照した承認済み知識</h5>
          {citedKnowledge.length ? (
            <ul>
              {citedKnowledge.map((entry, index) => (
                <li key={`${entry?.id ?? "unknown"}-${index}`}>
                  {entry
                    ? `v${entry.revision}: ${entry.content}`
                    : "参照先の知識をsnapshotから確認できません。"}
                </li>
              ))}
            </ul>
          ) : (
            <p>回答に知識の参照はありません。</p>
          )}
          <p>回答は提案です。指摘の判定は担当者が別途確認してください。</p>
        </section>
      )}
      <details>
        <summary>実行条件と詳細記録</summary>
        <p>
          実行ID {item.id} · {item.createdAt} · 対象版 {item.targetVersion} ·
          provider {item.providerId}
        </p>
        <p>
          知識版 {item.knowledgeVersion} · 基準版 {item.ruleVersion} · 入力{" "}
          {item.inputFingerprint.slice(0, 12)}…
        </p>
        <p>
          時間 {item.elapsedMs === null ? "未測定" : `${item.elapsedMs} ms`} ·
          費用{" "}
          {item.actualCostUsd === null ? "未取得" : `$${item.actualCostUsd}`}
          {item.stopReason ? ` · 停止理由 ${item.stopReason}` : ""}
        </p>
        <ol className="wf-steps">
          {item.steps.map((step) => (
            <li key={step.name}>
              <strong>{runStepLabels[step.name] ?? step.name}</strong>:{" "}
              {runStepStatusLabels[step.status] ?? step.status} · 試行{" "}
              {step.attempts}
              {step.error ? ` · ${step.error}` : ""}
              {step.artifacts.map((artifact) => (
                <pre key={artifact.hash}>
                  {typeof artifact.value === "string"
                    ? artifact.value
                    : JSON.stringify(artifact.value, null, 2)}
                </pre>
              ))}
            </li>
          ))}
        </ol>
      </details>
      {(item.status === "partial" || item.status === "stopped") && (
        <button
          disabled={busy}
          onClick={() =>
            void execute(() =>
              request(
                `/projects/${projectId}/workflow/runs/${item.id}/resume`,
                {},
              ),
            )
          }
        >
          未完了工程から再開
        </button>
      )}
      {item.status === "running" && (
        <button
          disabled={busy}
          onClick={() =>
            void execute(() =>
              request(
                `/projects/${projectId}/workflow/runs/${item.id}/stop`,
                {},
              ),
            )
          }
        >
          実行を停止
        </button>
      )}
    </article>
  );
}

function RemediationCard({
  item,
  state,
  actor,
  setActor,
  reason,
  setReason,
  remediation,
  setRemediation,
  verification,
  setVerification,
  source,
  setSource,
  busy,
  execute,
  command,
}: {
  item: WorkflowFinding;
  state: WorkflowState;
  actor: string;
  setActor: (v: string) => void;
  reason: string;
  setReason: (v: string) => void;
  remediation: {
    assignee: string;
    taskRef: string;
    plan: string;
    targetVersion: string;
    fixCommit: string;
  };
  setRemediation: (v: typeof remediation) => void;
  verification: {
    method: WorkflowVerification["method"];
    rationale: string;
    scope: string;
    status: WorkflowVerification["status"];
  };
  setVerification: (v: typeof verification) => void;
  source: { docId: string; excerpt: string };
  setSource: (v: { docId: string; excerpt: string }) => void;
  busy: boolean;
  execute: (action: () => Promise<void>) => Promise<void>;
  command: (v: WorkflowCommand) => Promise<void>;
}) {
  const current = item.remediation;
  const latestVerifications = latestVerificationRecords(
    current?.verifications ?? [],
  );
  const verificationReady =
    latestVerifications.length > 0 &&
    latestVerifications.every(
      (entry) =>
        entry.status === "passed" &&
        entry.targetVersion === current?.targetVersion &&
        entry.fixCommit === current?.fixCommit &&
        hasCurrentDocumentEvidence(entry, state.documents),
    );
  const evidence =
    source.docId && source.excerpt.trim()
      ? [
          {
            docId: source.docId,
            revision:
              state.documents.find((doc) => doc.id === source.docId)
                ?.revision ?? 0,
            excerpt: source.excerpt,
          },
        ]
      : [];
  return (
    <article className="wf-card">
      <div className="wf-card-title">
        <h3>{item.observation}</h3>
        <StatusPill tone={current?.status === "completed" ? "good" : "warn"}>
          {current?.status ?? "対応待ち"}
        </StatusPill>
      </div>
      <p>担当者・TaskContract・修正commit・対象版・確認証跡を関連付けます。</p>
      {!current && (
        <form
          className="wf-grid"
          onSubmit={(event) => {
            event.preventDefault();
            void execute(() =>
              command({
                type: "remediation-start",
                findingId: item.id,
                assignee: remediation.assignee,
                taskRef: remediation.taskRef,
                plan: remediation.plan,
                targetVersion: item.targetVersion,
              }),
            );
          }}
        >
          <WorkflowField label="担当者">
            <input
              aria-label="修正担当者"
              required
              value={remediation.assignee}
              onChange={(e) =>
                setRemediation({ ...remediation, assignee: e.target.value })
              }
            />
          </WorkflowField>
          <WorkflowField label="タスクまたはTaskContract参照">
            <input
              aria-label="TaskContract参照"
              required
              value={remediation.taskRef}
              onChange={(e) =>
                setRemediation({ ...remediation, taskRef: e.target.value })
              }
            />
          </WorkflowField>
          <WorkflowField label="修正計画">
            <textarea
              aria-label="修正計画"
              required
              value={remediation.plan}
              onChange={(e) =>
                setRemediation({ ...remediation, plan: e.target.value })
              }
            />
          </WorkflowField>
          <button className="primary" disabled={busy}>
            修正タスクを開始
          </button>
        </form>
      )}
      {current && (
        <>
          <p>
            担当 {current.assignee} · タスク {current.taskRef} · 対象版{" "}
            {current.targetVersion} · commit {current.fixCommit ?? "未登録"}
          </p>
          {current.status === "awaiting" && (
            <button
              disabled={busy}
              onClick={() =>
                void execute(() =>
                  command({
                    type: "remediation-progress",
                    findingId: item.id,
                    status: "in_progress",
                    actor: actor || current.assignee,
                    reason: reason || "修正作業を開始",
                    targetVersion: current.targetVersion,
                  }),
                )
              }
            >
              修正中にする
            </button>
          )}
          {current.status === "in_progress" && (
            <div>
              <WorkflowField label="修正対象の版">
                <input
                  aria-label="修正対象の版"
                  required
                  value={remediation.targetVersion || state.scope.version}
                  onChange={(e) =>
                    setRemediation({
                      ...remediation,
                      targetVersion: e.target.value,
                    })
                  }
                />
              </WorkflowField>
              <WorkflowField label="修正commit（7〜64桁）">
                <input
                  aria-label="修正commit"
                  value={remediation.fixCommit}
                  onChange={(e) =>
                    setRemediation({
                      ...remediation,
                      fixCommit: e.target.value,
                    })
                  }
                />
              </WorkflowField>
              <WorkflowField label="変更理由">
                <input
                  aria-label="変更理由"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </WorkflowField>
              <button
                disabled={
                  busy || !/^[0-9a-f]{7,64}$/i.test(remediation.fixCommit)
                }
                onClick={() =>
                  void execute(() =>
                    command({
                      type: "remediation-progress",
                      findingId: item.id,
                      status: "verification_pending",
                      actor: actor || current.assignee,
                      reason: reason || "修正を確認へ提出",
                      targetVersion:
                        remediation.targetVersion || state.scope.version,
                      fixCommit: remediation.fixCommit,
                    }),
                  )
                }
              >
                確認待ちにする
              </button>
            </div>
          )}
          {current.status === "verification_pending" && (
            <div className="wf-verification">
              <h4>確認方法を人が選択</h4>
              <p>
                静的確認・既知問題照合・通常機能・回帰試験から、今回の修正に合う範囲を選びます。ここでは実行せず結果だけ記録します。
              </p>
              <WorkflowField label="確認方法">
                <select
                  aria-label="確認方法"
                  value={verification.method}
                  onChange={(e) =>
                    setVerification({
                      ...verification,
                      method: e.target.value as WorkflowVerification["method"],
                    })
                  }
                >
                  {state.scope.allowedMethods.map((method) => (
                    <option key={method} value={method}>
                      {methodLabels[method]}
                    </option>
                  ))}
                </select>
              </WorkflowField>
              <WorkflowField label="選択理由">
                <input
                  aria-label="確認理由"
                  value={verification.rationale}
                  onChange={(e) =>
                    setVerification({
                      ...verification,
                      rationale: e.target.value,
                    })
                  }
                />
              </WorkflowField>
              <WorkflowField label="確認範囲・未実施項目">
                <input
                  aria-label="確認範囲"
                  value={verification.scope}
                  onChange={(e) =>
                    setVerification({ ...verification, scope: e.target.value })
                  }
                />
              </WorkflowField>
              <WorkflowField label="結果">
                <select
                  aria-label="確認結果"
                  value={verification.status}
                  onChange={(e) =>
                    setVerification({
                      ...verification,
                      status: e.target.value as WorkflowVerification["status"],
                    })
                  }
                >
                  {Object.entries(verificationLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </WorkflowField>
              <WorkflowField label="確認担当">
                <input
                  aria-label="確認担当"
                  value={actor}
                  onChange={(e) => setActor(e.target.value)}
                />
              </WorkflowField>
              <SourceReference
                documents={state.documents}
                value={source}
                onChange={setSource}
              />
              <button
                disabled={
                  busy ||
                  !verification.rationale.trim() ||
                  !verification.scope.trim() ||
                  !actor.trim() ||
                  !state.scope.allowedMethods.includes(verification.method) ||
                  (verification.status === "passed" && !evidence.length)
                }
                onClick={() =>
                  void execute(() =>
                    command({
                      type: "verification",
                      findingId: item.id,
                      method: verification.method,
                      rationale: verification.rationale,
                      scope: verification.scope,
                      status: verification.status,
                      actor,
                      targetVersion: current.targetVersion,
                      evidence,
                    }),
                  )
                }
              >
                確認結果と証跡を記録
              </button>
              <div className="wf-review-controls">
                <WorkflowField label="完了判断理由">
                  <input
                    aria-label="完了判断理由"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </WorkflowField>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !actor.trim() ||
                    !reason.trim() ||
                    !verificationReady
                  }
                  onClick={() =>
                    void execute(() =>
                      command({
                        type: "remediation-complete",
                        findingId: item.id,
                        actor,
                        reason,
                        targetVersion: current.targetVersion,
                      }),
                    )
                  }
                >
                  証跡を確認して完了
                </button>
              </div>
            </div>
          )}
          <section aria-label="修正確認の記録">
            <h4>方式・範囲ごとの最新記録</h4>
            {current.verifications.map((entry, index) => {
              const latest = latestVerifications.includes(entry);
              const currentEvidence = hasCurrentDocumentEvidence(
                entry,
                state.documents,
              );
              return (
                <p key={`${entry.at}-${index}`}>
                  {methodLabels[entry.method]} · {entry.scope} ·{" "}
                  {verificationLabels[entry.status]} · {entry.actor} · 対象版{" "}
                  {entry.targetVersion} · commit {entry.fixCommit || "未登録"} ·{" "}
                  {currentEvidence
                    ? "現行資料の根拠あり"
                    : "現行資料の根拠なし"}
                  {latest ? " · 最新" : " · 過去の記録"}
                </p>
              );
            })}
            <p role="status">
              {verificationReady
                ? "各方式・範囲の最新結果と現行資料の根拠を確認できます。"
                : "完了には各方式・範囲の最新結果がすべて合格し、現対象版・commitと現行資料の根拠が必要です。"}
            </p>
          </section>
        </>
      )}
    </article>
  );
}
