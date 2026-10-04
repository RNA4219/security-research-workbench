import { Trace, ReviewControl } from "./provenance.js";

import { RequirementEditor, Field } from "./forms.js";
import { labels } from "./constants.js";
import type { ActiveWorkbench } from "./app.js";
export function RequirementsPage({ ctx }: { ctx: ActiveWorkbench }) {
  const {
    p,
    tab,
    requirementEdit,
    setRequirementEdit,
    raw,
    setRaw,
    run,
    mutate,
    approvalCount,
  } = ctx;
  return (
    <>
      {" "}
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
              project={p}
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
              <Trace p={p} claimIds={r.claimIds} />
              <ReviewControl
                p={p}
                entity="requirement"
                entityId={r.id}
                submit={(c) => run(() => mutate(c))}
              />
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
                        status: r.status === "approved" ? "draft" : "approved",
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
    </>
  );
}
