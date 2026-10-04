import { request } from "./api.js";

import { SourceEditor, SafeMarkdown, SourcesChoice } from "./forms.js";

import type { ActiveWorkbench } from "./app.js";
export function SourcesPage({ ctx }: { ctx: ActiveWorkbench }) {
  const {
    projects,
    p,
    tab,
    setNotice,
    sourceEdit,
    setSourceEdit,
    selected,
    setSelected,
    promptText,
    setPromptText,
    history,
    run,
    mutate,
  } = ctx;
  return (
    <>
      {" "}
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
                    取得: {s.retrievedAt.slice(0, 10)} · 履歴 {s.history.length}{" "}
                    件
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
    </>
  );
}
