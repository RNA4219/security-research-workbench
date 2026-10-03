import { createRoot } from "react-dom/client";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import Markdown from "react-markdown";
import type {
  CandidateInput,
  Command,
  Project,
  ProjectInput,
  Requirement,
  RequirementInput,
  Source,
  SourceInput,
} from "../shared/model.js";
import {
  exampleCandidates,
  exampleProject,
  exampleSources,
} from "../shared/example.js";
import { request, download } from "./api.js";
import "./style.css";

type Tab =
  "sources" | "compare" | "requirements" | "export" | "history" | "settings";
const tabs: [Tab, string, string][] = [
  ["sources", "01", "調査資料"],
  ["compare", "02", "OSS比較"],
  ["requirements", "03", "要件とレビュー"],
  ["export", "04", "出力"],
  ["history", "↺", "履歴"],
  ["settings", "⚙", "設定・連携"],
];
const labels = {
  draft: "未レビュー",
  approved: "承認済み",
  needs_review: "再確認が必要",
  consider: "検討中",
  adopt: "採用",
  reject: "見送り",
};
const blankProject: ProjectInput = {
  title: "",
  objective: "",
  audience: "",
  constraints: "",
};
const blankSource = (): SourceInput => ({
  title: "",
  url: "",
  version: "1",
  retrievedAt: new Date().toISOString(),
  body: "",
});
const blankCandidate: CandidateInput = {
  name: "",
  url: "",
  features: "",
  license: "未確認",
  maintenance: "未確認",
  decision: "consider",
  rationale: "",
  sourceIds: [],
};

function Field({
  label,
  value,
  onChange,
  area = false,
  type = "text",
  required = true,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  area?: boolean;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {area ? (
        <textarea
          aria-label={label}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
      ) : (
        <input
          aria-label={label}
          type={type}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}
function SourcesChoice({
  sources,
  selected,
  onChange,
}: {
  sources: Source[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  return (
    <fieldset className="choices">
      <legend>出典資料</legend>
      {sources.length === 0 && (
        <p className="muted">資料を登録すると選択できます。</p>
      )}
      {sources.map((s) => (
        <label key={s.id}>
          <input
            type="checkbox"
            checked={selected.includes(s.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, s.id]
                  : selected.filter((id) => id !== s.id),
              )
            }
          />
          <span>
            {s.title} <small>v{s.version}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
function ProjectForm({
  value,
  onSubmit,
  button = "作成する",
}: {
  value: ProjectInput;
  onSubmit: (v: ProjectInput) => void;
  button?: string;
}) {
  const [v, set] = useState(value);
  const change = (key: keyof ProjectInput) => (value: string) =>
    set({ ...v, [key]: value });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
    >
      <Field
        label="プロジェクト名"
        value={v.title}
        onChange={change("title")}
      />
      <Field
        label="目的"
        area
        value={v.objective}
        onChange={change("objective")}
      />
      <Field
        label="対象利用者"
        value={v.audience}
        onChange={change("audience")}
      />
      <Field
        label="制約・対象外"
        area
        required={false}
        value={v.constraints}
        onChange={change("constraints")}
      />
      <button className="primary">{button}</button>
    </form>
  );
}
function SourceEditor({
  source,
  onSubmit,
  onClose,
  onBundle,
}: {
  source?: Source;
  onSubmit: (v: SourceInput) => void;
  onClose: () => void;
  onBundle: (raw: string) => void;
}) {
  const [v, set] = useState<SourceInput>(
    source
      ? {
          title: source.title,
          url: source.url,
          version: source.version,
          retrievedAt: source.retrievedAt,
          body: source.body,
        }
      : blankSource(),
  );
  const [error, setError] = useState("");
  const change = (key: keyof SourceInput) => (value: string) =>
    set({ ...v, [key]: value });
  return (
    <section className="panel">
      <div className="section-head">
        <h2>{source ? "資料を更新" : "資料を取り込む"}</h2>
        <button onClick={onClose}>閉じる</button>
      </div>
      <label className="upload">
        Markdown・テキスト・資料JSONを選択
        <input
          type="file"
          accept=".md,.txt,.json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            if (f.size > 1_500_000) {
              setError("ファイルは1.5MB以下にしてください");
              return;
            }
            const raw = await f.text();
            if (f.name.endsWith(".json")) onBundle(raw);
            else set({ ...v, title: v.title || f.name, body: raw });
          }}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(v);
        }}
      >
        <div className="grid2">
          <Field label="資料名" value={v.title} onChange={change("title")} />
          <Field
            label="出典URL"
            type="url"
            value={v.url}
            onChange={change("url")}
          />
          <Field
            label="資料の版"
            value={v.version}
            onChange={change("version")}
          />
          <Field
            label="取得日時（UTC）"
            value={v.retrievedAt}
            onChange={change("retrievedAt")}
          />
        </div>
        <Field label="資料本文" area value={v.body} onChange={change("body")} />
        <button className="primary">資料を保存</button>
      </form>
    </section>
  );
}
function CandidateEditor({
  value,
  sources,
  onSubmit,
  onClose,
}: {
  value: CandidateInput;
  sources: Source[];
  onSubmit: (v: CandidateInput) => void;
  onClose: () => void;
}) {
  const [v, set] = useState(value);
  const change = (key: keyof CandidateInput) => (value: string) =>
    set({ ...v, [key]: value });
  return (
    <section className="panel">
      <div className="section-head">
        <h2>OSS候補を編集</h2>
        <button onClick={onClose}>閉じる</button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(v);
        }}
      >
        <div className="grid2">
          <Field label="OSS名" value={v.name} onChange={change("name")} />
          <Field
            label="リポジトリURL"
            type="url"
            value={v.url}
            onChange={change("url")}
          />
          <Field
            label="機能"
            area
            value={v.features}
            onChange={change("features")}
          />
          <Field
            label="ライセンス"
            value={v.license}
            onChange={change("license")}
          />
          <Field
            label="保守状況・確認日"
            area
            value={v.maintenance}
            onChange={change("maintenance")}
          />
          <Field
            label="採否理由"
            area
            value={v.rationale}
            onChange={change("rationale")}
          />
        </div>
        <label className="field">
          <span>採否</span>
          <select
            aria-label="採否"
            value={v.decision}
            onChange={(e) =>
              set({
                ...v,
                decision: e.target.value as CandidateInput["decision"],
              })
            }
          >
            {(["consider", "adopt", "reject"] as const).map((s) => (
              <option key={s} value={s}>
                {labels[s]}
              </option>
            ))}
          </select>
        </label>
        <SourcesChoice
          sources={sources}
          selected={v.sourceIds}
          onChange={(sourceIds) => set({ ...v, sourceIds })}
        />
        <button className="primary">候補を保存</button>
      </form>
    </section>
  );
}
function RequirementEditor({
  requirement,
  sources,
  onSave,
  onClose,
}: {
  requirement: Requirement;
  sources: Source[];
  onSave: (r: RequirementInput) => void;
  onClose: () => void;
}) {
  const { status: _, sourceVersions: __, ...input } = requirement;
  const [v, set] = useState(input);
  return (
    <section className="panel">
      <div className="section-head">
        <h2>{v.id} を編集</h2>
        <button onClick={onClose}>閉じる</button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(v);
        }}
      >
        <Field
          label="要件名"
          value={v.title}
          onChange={(title) => set({ ...v, title })}
        />
        <Field
          label="要件の説明"
          area
          value={v.description}
          onChange={(description) => set({ ...v, description })}
        />
        <label className="field">
          <span>優先度</span>
          <select
            aria-label="優先度"
            value={v.priority}
            onChange={(e) =>
              set({
                ...v,
                priority: e.target.value as RequirementInput["priority"],
              })
            }
          >
            {["low", "medium", "high", "critical"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <SourcesChoice
          sources={sources}
          selected={v.sourceIds}
          onChange={(sourceIds) => set({ ...v, sourceIds })}
        />
        <Field
          label="利用者判断・補足理由"
          area
          required={false}
          value={v.rationale}
          onChange={(rationale) => set({ ...v, rationale })}
        />
        <Field
          label="受入条件（1行に1件）"
          area
          value={v.acceptance.join("\n")}
          onChange={(acceptance) =>
            set({ ...v, acceptance: acceptance.split("\n") })
          }
        />
        <Field
          label="実装タスク（1行に1件）"
          area
          value={v.tasks.join("\n")}
          onChange={(tasks) => set({ ...v, tasks: tasks.split("\n") })}
        />
        <button className="primary">要件を保存</button>
        <p className="muted">編集すると未レビューに戻ります。</p>
      </form>
    </section>
  );
}
function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        skipHtml
        components={{
          img: () => null,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

function App() {
  const [projects, setProjects] = useState<
    { id: string; title: string; revision: number }[]
  >([]);
  const [p, setP] = useState<Project>();
  const [tab, setTab] = useState<Tab>("sources");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sourceEdit, setSourceEdit] = useState<string | null>(null);
  const [candidateEdit, setCandidateEdit] = useState<string | null>(null);
  const [requirementEdit, setRequirementEdit] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [promptText, setPromptText] = useState("");
  const [raw, setRaw] = useState("");
  const [memx, setMemx] = useState(false);
  const [query, setQuery] = useState("");
  const [memxResult, setMemxResult] = useState("");
  const [history, setHistory] = useState<{ revision: number }[]>([]);
  const [historyContent, setHistoryContent] = useState("");
  const [artifacts, setArtifacts] = useState<
    { id: number; kind: string; created_at: string; body: string }[]
  >([]);
  const refresh = async () => setProjects(await request("/projects"));
  useEffect(() => {
    void Promise.all([
      refresh(),
      request<{ memx: boolean }>("/config").then((c) => setMemx(c.memx)),
    ]).catch((e) => setError(String(e)));
  }, []);
  const inFlight = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const select = async (pid: string) => {
    setP(await request(`/projects/${pid}`));
    setCreating(false);
    setTab("sources");
    setSourceEdit(null);
    setCandidateEdit(null);
    setRequirementEdit(null);
    setSelected([]);
    setPromptText("");
    setRaw("");
    setHistoryContent("");
    setMemxResult("");
  };
  const mutate = async (command: Command) => {
    if (!p) return;
    const next = await request<Project>(`/projects/${p.id}/commands`, {
      revision: p.revision,
      command,
    });
    setP(next);
    await refresh();
    setNotice("保存しました");
  };
  const sample = async () => {
    let current = await request<Project>("/projects", exampleProject);
    const cmd = async (command: Command) => {
      current = await request<Project>(`/projects/${current.id}/commands`, {
        revision: current.revision,
        command,
      });
    };
    await cmd({
      type: "sources",
      value: { schemaVersion: "1.0", sources: exampleSources },
    });
    for (const [i, c] of exampleCandidates.entries())
      await cmd({
        type: "candidate",
        value: { ...c, sourceIds: [current.sources[i].id] },
      });
    await cmd({
      type: "reply",
      raw: JSON.stringify({
        schemaVersion: "1.0",
        requirements: [
          {
            id: "REQ-001",
            title: "依存関係の結果を比較できる",
            description:
              "採用候補の機能と導入条件を、公開資料の根拠とともに確認する。",
            priority: "high",
            sourceIds: [current.sources[0].id, current.sources[1].id],
            rationale: "導入前に人が採否を決める。",
            acceptance: [
              "候補を同じ項目で比較できる",
              "各候補から出典を参照できる",
            ],
            tasks: [
              "比較項目とデータ形式を定義する",
              "根拠付き比較画面を実装する",
            ],
          },
        ],
      }),
    });
    await refresh();
    await select(current.id);
    setNotice("公開資料だけのサンプルを作成しました");
  };
  const openHistory = async () => {
    if (!p) return;
    setTab("history");
    setHistory(await request(`/projects/${p.id}/history`));
    setArtifacts(await request(`/projects/${p.id}/artifacts`));
  };
  const memxAction = async (body: unknown) => {
    if (p)
      setMemxResult(
        JSON.stringify(await request(`/projects/${p.id}/memx`, body), null, 2),
      );
  };
  const approvalCount =
    p?.requirements.filter((r) => r.status === "approved").length ?? 0;
  let content: ReactNode;
  if (creating)
    content = (
      <section className="panel narrow">
        <p className="eyebrow">NEW PROJECT</p>
        <h1>調査の目的を決める</h1>
        <p className="muted">何を作り、誰のために調べるかを記録します。</p>
        <ProjectForm
          value={blankProject}
          onSubmit={(v) =>
            void run(async () => {
              const next = await request<Project>("/projects", v);
              await refresh();
              await select(next.id);
            })
          }
        />
      </section>
    );
  else if (!p)
    content = (
      <section className="welcome">
        <p className="eyebrow">FROM RESEARCH TO REQUIREMENTS</p>
        <h1>
          根拠を残して、
          <br />
          次の実装へ。
        </h1>
        <p>
          公開OSSの調査を整理し、比較から要件、
          <br />
          実装タスクまでをひとつの場所でつなぎます。
        </p>
        <div className="actions">
          <button className="primary" onClick={() => setCreating(true)}>
            プロジェクトを作成 →
          </button>
          <button onClick={() => void run(sample)}>サンプルで試す</button>
        </div>
        <div className="welcome-grid">
          {[
            ["01", "集める", "資料の出典と版を保存"],
            ["02", "比べる", "OSSの機能と採否を整理"],
            ["03", "定義する", "要件をレビューして実装へ"],
          ].map(([n, title, body]) => (
            <article key={n}>
              <span>{n}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>
    );
  else
    content = (
      <>
        <header className="project-head">
          <div>
            <p className="eyebrow">
              RESEARCH WORKSPACE <span> / REV {p.revision}</span>
            </p>
            <h1>{p.title}</h1>
            <p className="muted">{p.objective}</p>
          </div>
          <span className="local-badge">● ローカル保存</span>
        </header>
        <div className="metrics">
          <span>
            <b>{p.sources.length}</b> 調査資料
          </span>
          <span>
            <b>{p.candidates.length}</b> OSS候補
          </span>
          <span>
            <b>{p.requirements.length}</b> 要件
          </span>
          <span>
            <b>{approvalCount}</b> 承認済み
          </span>
        </div>
        <nav className="tabs" aria-label="作業工程">
          {tabs.map(([key, n, label]) => (
            <button
              key={key}
              aria-current={tab === key ? "page" : undefined}
              className={tab === key ? "active" : ""}
              onClick={() =>
                key === "history" ? void run(openHistory) : setTab(key)
              }
            >
              <small>{n}</small>
              {label}
            </button>
          ))}
        </nav>
        {tab === "sources" && (
          <>
            <div className="section-head">
              <div>
                <h2>調査資料</h2>
                <p className="muted">
                  必要な資料だけを取り込み、出典と版を残します。
                </p>
              </div>
              <button className="primary" onClick={() => setSourceEdit("new")}>
                ＋ 資料を追加
              </button>
            </div>
            {sourceEdit !== null && (
              <SourceEditor
                key={sourceEdit}
                source={p.sources.find((s) => s.id === sourceEdit)}
                onClose={() => setSourceEdit(null)}
                onSubmit={(value) =>
                  void run(async () => {
                    await mutate({
                      type: "source",
                      ...(sourceEdit === "new" ? {} : { sourceId: sourceEdit }),
                      value,
                    });
                    setSourceEdit(null);
                  })
                }
                onBundle={(value) =>
                  void run(async () => {
                    await mutate({ type: "sources", value: JSON.parse(value) });
                    setSourceEdit(null);
                  })
                }
              />
            )}
            {p.sources.length === 0 ? (
              <div className="empty">
                まだ資料がありません。公開情報の要約や調査レポートを追加してください。
              </div>
            ) : (
              <div className="source-grid">
                {p.sources.map((s) => (
                  <article className="source-card" key={s.id}>
                    <div className="section-head">
                      <span className="tag">SOURCE · v{s.version}</span>
                      <button onClick={() => setSourceEdit(s.id)}>編集</button>
                    </div>
                    <h3>{s.title}</h3>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {new URL(s.url).hostname} ↗
                    </a>
                    <p className="muted">
                      取得: {s.retrievedAt.slice(0, 10)} · 履歴{" "}
                      {s.history.length} 件
                    </p>
                    <details>
                      <summary>本文・出典IDを見る</summary>
                      <code className="source-id">{s.id}</code>
                      <SafeMarkdown>{s.body}</SafeMarkdown>
                      <small>SHA256: {s.hash}</small>
                    </details>
                  </article>
                ))}
              </div>
            )}
            <section className="panel prompt-panel">
              <h2>ChatGPTへの受け渡し</h2>
              <p className="muted">
                資料を選んでプロンプトを作成します。内容を確認してChatGPTに貼り付けてください。
              </p>
              <SourcesChoice
                sources={p.sources}
                selected={selected}
                onChange={setSelected}
              />
              <button
                disabled={!selected.length}
                onClick={() =>
                  void run(async () => {
                    const r = await request<{ prompt: string }>(
                      `/projects/${p.id}/prompt`,
                      { sourceIds: selected },
                    );
                    setPromptText(r.prompt);
                  })
                }
              >
                プロンプトを作成
              </button>
              {promptText && (
                <>
                  <label className="field">
                    <span>生成したプロンプト</span>
                    <textarea rows={10} readOnly value={promptText} />
                  </label>
                  <button
                    onClick={() =>
                      void run(async () => {
                        await navigator.clipboard.writeText(promptText);
                        setNotice("コピーしました");
                      })
                    }
                  >
                    プロンプトをコピー
                  </button>
                </>
              )}
            </section>
          </>
        )}
        {tab === "compare" && (
          <>
            <div className="section-head">
              <div>
                <h2>OSSを比較する</h2>
                <p className="muted">
                  確認した事実と採否の判断を分けて記録します。
                </p>
              </div>
              <button
                className="primary"
                onClick={() => setCandidateEdit("new")}
              >
                ＋ 候補を追加
              </button>
            </div>
            {candidateEdit !== null && (
              <CandidateEditor
                key={candidateEdit}
                value={(() => {
                  const c = p.candidates.find((c) => c.id === candidateEdit);
                  if (!c) return blankCandidate;
                  const { id: _, ...rest } = c;
                  return rest;
                })()}
                sources={p.sources}
                onClose={() => setCandidateEdit(null)}
                onSubmit={(value) =>
                  void run(async () => {
                    await mutate({
                      type: "candidate",
                      ...(candidateEdit === "new"
                        ? {}
                        : { candidateId: candidateEdit }),
                      value,
                    });
                    setCandidateEdit(null);
                  })
                }
              />
            )}
            {p.candidates.length === 0 ? (
              <div className="empty">
                候補を登録して、共通の項目で比較しましょう。
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>OSS / 出典</th>
                      <th>主な機能</th>
                      <th>ライセンス・保守</th>
                      <th>判断</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.candidates.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <a href={c.url} target="_blank" rel="noreferrer">
                            <b>{c.name} ↗</b>
                          </a>
                          {c.sourceIds.map((id) => (
                            <small key={id}>
                              {p.sources.find((s) => s.id === id)?.title}
                            </small>
                          ))}
                          {!c.sourceIds.length && <small>出典未登録</small>}
                        </td>
                        <td>{c.features}</td>
                        <td>
                          <span className="tag">{c.license}</span>
                          <p>{c.maintenance}</p>
                        </td>
                        <td>
                          <span className={`status ${c.decision}`}>
                            {labels[c.decision]}
                          </span>
                          <p>{c.rationale}</p>
                        </td>
                        <td>
                          <button onClick={() => setCandidateEdit(c.id)}>
                            編集
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {tab === "requirements" && (
          <>
            <div className="section-head">
              <div>
                <h2>要件とレビュー</h2>
                <p className="muted">
                  受入条件と根拠を確認し、実装へ渡す要件を決めます。
                </p>
              </div>
              <span className="tag">
                {approvalCount} / {p.requirements.length} 承認済み
              </span>
            </div>
            <details className="panel" open={p.requirements.length === 0}>
              <summary>ChatGPTの回答JSONを取り込む</summary>
              <label className="upload">
                回答JSONファイル
                <input
                  type="file"
                  accept=".json"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f)
                      void run(async () => {
                        if (f.size > 1_500_000)
                          throw new Error("ファイルは1.5MB以下にしてください");
                        setRaw(await f.text());
                      });
                  }}
                />
              </label>
              <Field label="回答JSON" area value={raw} onChange={setRaw} />
              <button
                className="primary"
                onClick={() =>
                  void run(async () => {
                    await mutate({ type: "reply", raw });
                    setRaw("");
                  })
                }
              >
                回答を取り込む
              </button>
              <p className="muted">
                取り込んだ要件は未レビューになります。元の回答は履歴に残ります。
              </p>
            </details>
            {requirementEdit && (
              <RequirementEditor
                key={requirementEdit}
                requirement={p.requirements.find(
                  (r) => r.id === requirementEdit,
                )!}
                sources={p.sources}
                onClose={() => setRequirementEdit(null)}
                onSave={(value) =>
                  void run(async () => {
                    await mutate({ type: "requirement", value });
                    setRequirementEdit(null);
                  })
                }
              />
            )}
            {p.requirements.map((r) => (
              <article className="requirement-card" key={r.id}>
                <div className="section-head">
                  <div className="actions">
                    <span className="req-id">{r.id}</span>
                    <span className={`status ${r.status}`}>
                      {labels[r.status]}
                    </span>
                    <span className="priority">{r.priority}</span>
                  </div>
                  <button onClick={() => setRequirementEdit(r.id)}>編集</button>
                </div>
                <h3>{r.title}</h3>
                <p>{r.description}</p>
                <div className="grid2">
                  <div>
                    <h4>受入条件</h4>
                    <ul>
                      {r.acceptance.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4>実装タスク</h4>
                    <ol>
                      {r.tasks.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ol>
                  </div>
                </div>
                <div className="evidence">
                  <strong>根拠</strong>
                  {r.sourceIds.map((id) => {
                    const s = p.sources.find((s) => s.id === id)!;
                    return (
                      <a key={id} href={s.url} target="_blank" rel="noreferrer">
                        {s.title} · v{s.version} ↗
                      </a>
                    );
                  })}
                  {r.rationale && <p>利用者判断: {r.rationale}</p>}
                </div>
                <div className="card-footer">
                  <small>
                    {r.status === "needs_review"
                      ? "参照資料が更新されました。根拠を再確認してください。"
                      : "承認はこの要件と現在の資料の版に対して記録されます。"}
                  </small>
                  <button
                    className={r.status === "approved" ? "" : "primary"}
                    onClick={() =>
                      void run(() =>
                        mutate({
                          type: "review",
                          requirementId: r.id,
                          status:
                            r.status === "approved" ? "draft" : "approved",
                        }),
                      )
                    }
                  >
                    {r.status === "approved"
                      ? "未レビューに戻す"
                      : "確認して承認"}
                  </button>
                </div>
              </article>
            ))}
            {!p.requirements.length && (
              <div className="empty">
                プロンプトの回答JSONを取り込むと、ここに要件が表示されます。
              </div>
            )}
          </>
        )}
        {tab === "export" && (
          <>
            <h2>次の実装へ渡す</h2>
            <p className="muted">
              ローカルファイルとして出力します。外部への送信やワーカーの実行は行いません。
            </p>
            <div className="export-grid">
              {[
                [
                  "markdown",
                  "要件定義 Markdown",
                  "比較・要件・受入条件・出典をまとめたレビュー文書",
                  "md",
                ],
                [
                  "json",
                  "プロジェクト JSON",
                  "資料と履歴を含む、版付きのデータスナップショット",
                  "json",
                ],
                [
                  "contracts",
                  "実装タスク契約",
                  "承認済み要件からagent-protocols v2のドラフトを生成",
                  "json",
                ],
              ].map(([format, title, description, extension]) => (
                <article className="panel" key={format}>
                  <span className="file-icon">{extension.toUpperCase()}</span>
                  <h3>{title}</h3>
                  <p>{description}</p>
                  <button
                    disabled={format === "contracts" && !approvalCount}
                    onClick={() =>
                      void run(() =>
                        download(
                          `/projects/${p.id}/export/${format}`,
                          `workbench-${format}.${extension}`,
                        ),
                      )
                    }
                  >
                    ダウンロード ↓
                  </button>
                </article>
              ))}
            </div>
            <p className="muted">
              契約出力: 承認済み {approvalCount}{" "}
              件。未レビュー・再確認の要件は含まれません。
            </p>
          </>
        )}
        {tab === "history" && (
          <>
            <h2>判断の履歴</h2>
            <p className="muted">
              過去の状態と、AIに渡したプロンプト・元回答を確認できます。
            </p>
            <div className="grid2">
              <section className="panel">
                <h3>保存された版</h3>
                <div className="revision-list">
                  {history.map((h) => (
                    <button
                      key={h.revision}
                      onClick={() =>
                        void run(async () =>
                          setHistoryContent(
                            JSON.stringify(
                              await request(
                                `/projects/${p.id}/history/${h.revision}`,
                              ),
                              null,
                              2,
                            ),
                          ),
                        )
                      }
                    >
                      REV {h.revision}
                    </button>
                  ))}
                </div>
              </section>
              <section className="panel">
                <h3>プロンプト・元回答（直近50件）</h3>
                {artifacts.map((a) => (
                  <details key={a.id}>
                    <summary>
                      {a.kind === "prompt" ? "プロンプト" : "AI回答"} ·{" "}
                      {a.created_at}
                    </summary>
                    <pre>{a.body}</pre>
                  </details>
                ))}
              </section>
            </div>
            {historyContent && <pre className="panel">{historyContent}</pre>}
          </>
        )}
        {tab === "settings" && (
          <div className="grid2">
            <section className="panel">
              <h2>プロジェクト設定</h2>
              <ProjectForm
                key={p.id + ":" + p.revision}
                value={{
                  title: p.title,
                  objective: p.objective,
                  audience: p.audience,
                  constraints: p.constraints,
                }}
                button="設定を保存"
                onSubmit={(value) =>
                  void run(() => mutate({ type: "project", value }))
                }
              />
            </section>
            <section className="panel">
              <div className="section-head">
                <h2>memx-resolver</h2>
                <span className="tag">{memx ? "設定済み" : "未設定"}</span>
              </div>
              <p className="muted">
                登録した資料だけをローカルのresolverに同期します。検索結果は自動で取り込みません。
              </p>
              {!memx ? (
                <p>起動時に MEMX_URL を設定すると利用できます。</p>
              ) : (
                <>
                  <div className="actions">
                    <button
                      onClick={() =>
                        void run(() => memxAction({ action: "sync" }))
                      }
                    >
                      資料を同期
                    </button>
                    <button
                      onClick={() =>
                        void run(() => memxAction({ action: "stale" }))
                      }
                    >
                      鮮度を確認
                    </button>
                  </div>
                  <form
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      void run(() => memxAction({ action: "search", query }));
                    }}
                  >
                    <Field
                      label="知識を検索"
                      value={query}
                      onChange={setQuery}
                    />
                    <button>検索</button>
                  </form>
                  {p.sources.map((s) => (
                    <div className="memx-source" key={s.id}>
                      <span>{s.title}</span>
                      <button
                        onClick={() =>
                          void run(() =>
                            memxAction({ action: "chunks", sourceId: s.id }),
                          )
                        }
                      >
                        参照
                      </button>
                      <button
                        onClick={() =>
                          void run(() =>
                            memxAction({ action: "ack", sourceId: s.id }),
                          )
                        }
                      >
                        読了を記録
                      </button>
                    </div>
                  ))}
                  {memxResult && <pre>{memxResult}</pre>}
                </>
              )}
            </section>
          </div>
        )}
      </>
    );
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="ホーム">
          <span className="brand-mark">W</span>
          <span>
            RESEARCH
            <br />
            <b>WORKBENCH</b>
          </span>
        </a>
        <div className="sidebar-heading">
          PROJECTS{" "}
          <button
            aria-label="新しいプロジェクト"
            disabled={busy}
            onClick={() => {
              setCreating(true);
              setError("");
            }}
          >
            ＋
          </button>
        </div>
        <nav aria-label="プロジェクト">
          {projects.map((project) => (
            <button
              key={project.id}
              disabled={busy}
              className={p?.id === project.id && !creating ? "selected" : ""}
              onClick={() => void run(() => select(project.id))}
            >
              <span>◇</span>
              {project.title}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="dot" /> LOCAL WORKSPACE
          <p>
            資料から、判断へ。
            <br />
            判断から、実装へ。
          </p>
          <small>v0.1.0 · Open source</small>
        </div>
      </aside>
      <main>
        <div className="topline">
          <span>SECURITY RESEARCH / DEVELOPMENT</span>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await refresh();
                if (p) setP(await request(`/projects/${p.id}`));
                setNotice("最新の状態を読み込みました");
              })
            }
          >
            再読込 ↻
          </button>
        </div>
        {error && (
          <div role="alert" className="alert">
            <strong>操作を完了できませんでした</strong>
            <pre>{error}</pre>
            <button onClick={() => setError("")}>閉じる</button>
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            ✓ {notice}
          </div>
        )}
        <fieldset disabled={busy} className="workspace">
          {content}
        </fieldset>
        {busy && (
          <div role="status" className="working">
            処理中…
          </div>
        )}
        <footer>
          Security Research Workbench{" "}
          <span>根拠と判断を、あなたの手元に。</span>
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
