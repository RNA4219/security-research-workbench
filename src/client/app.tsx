import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Project, type Command } from "../shared/model.js";
import { request } from "./api.js";
import { ProjectForm } from "./forms.js";
import { tabs, blankProject, type Tab } from "./constants.js";
import { SettingsPage } from "./settings-page.js";
import { HistoryPage } from "./history-page.js";
import { ExportPage } from "./export-page.js";
import { RequirementsPage } from "./requirements-page.js";
import { ComparePage } from "./compare-page.js";
import { EvidencePage } from "./evidence-page.js";
import { SourcesPage } from "./sources-page.js";
import { VulnerabilityPage } from "./vulnerability-page.js";
import { RepositoryPage } from "./repository-page.js";
import {
  exampleCandidates,
  exampleProject,
  exampleSources,
} from "../shared/example.js";

export function useWorkbench() {
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
    for (const [i, c] of exampleCandidates.entries()) {
      await cmd({
        type: "candidate",
        value: { ...c, sourceIds: [current.sources[i].id] },
      });
      await cmd({
        type: "evidence",
        value: {
          sourceId: current.sources[i].id,
          sourceType: "report",
          excerpt: exampleSources[i].body,
          verificationStatus: "unverified",
        },
      });
      const eid = current.evidence.at(-1)!.id;
      const cid = current.candidates.at(-1)!.id;
      for (const claim of current.claims.filter(
        (cl) => cl.candidateId === cid && cl.valueState === "known",
      )) {
        const { id: claimId, revision: _, ...value } = claim;
        await cmd({
          type: "claim",
          claimId,
          value: { ...value, evidenceIds: [eid] },
        });
      }
    }
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
            sourceIds: [],
            claimIds: current.claims
              .filter(
                (c) =>
                  c.field === "features" &&
                  current.candidates
                    .slice(0, 2)
                    .some((x) => x.id === c.candidateId),
              )
              .map((c) => c.id),
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
  return {
    projects,
    setProjects,
    p,
    setP,
    tab,
    setTab,
    creating,
    setCreating,
    busy,
    setBusy,
    error,
    setError,
    notice,
    setNotice,
    sourceEdit,
    setSourceEdit,
    candidateEdit,
    setCandidateEdit,
    requirementEdit,
    setRequirementEdit,
    selected,
    setSelected,
    promptText,
    setPromptText,
    raw,
    setRaw,
    memx,
    setMemx,
    query,
    setQuery,
    memxResult,
    setMemxResult,
    history,
    setHistory,
    historyContent,
    setHistoryContent,
    artifacts,
    setArtifacts,
    refresh,
    run,
    select,
    mutate,
    sample,
    openHistory,
    memxAction,
    approvalCount,
  };
}
export type Workbench = ReturnType<typeof useWorkbench>;
export type ActiveWorkbench = Workbench & { p: Project };

export function App() {
  const ctx = useWorkbench();
  const {
    projects,
    p,
    setP,
    tab,
    setTab,
    creating,
    setCreating,
    busy,
    error,
    setError,
    notice,
    setNotice,
    selected,
    history,
    refresh,
    run,
    select,
    sample,
    openHistory,
    approvalCount,
  } = ctx;
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
      <>
        <RepositoryPage />
        <section className="panel manual-workspace">
          <h2>手元の調査資料を整理する</h2>
          <p className="muted">
            調査レポートの取込、OSS比較、要件の編集はこちらから。
          </p>
          <div className="actions">
            <button onClick={() => setCreating(true)}>
              プロジェクトを作成 →
            </button>
            <button onClick={() => void run(sample)}>サンプルで試す</button>
          </div>
        </section>
      </>
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
        <SourcesPage ctx={{ ...ctx, p }} />
        <VulnerabilityPage ctx={{ ...ctx, p }} />
        <EvidencePage ctx={{ ...ctx, p }} />
        <ComparePage ctx={{ ...ctx, p }} />
        <RequirementsPage ctx={{ ...ctx, p }} />
        <ExportPage ctx={{ ...ctx, p }} />
        <HistoryPage ctx={{ ...ctx, p }} />
        <SettingsPage ctx={{ ...ctx, p }} />
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
            URLから調べる。
            <br />
            次に確認することがわかる。
          </p>
          <small>v0.2.0 · Open source</small>
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
