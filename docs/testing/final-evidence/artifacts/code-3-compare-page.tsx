import { ComparisonClaims } from "./provenance.js";

import { CandidateEditor } from "./forms.js";
import { labels, blankCandidate } from "./constants.js";
import type { ActiveWorkbench } from "./app.js";
export function ComparePage({ ctx }: { ctx: ActiveWorkbench }) {
  const { p, tab, candidateEdit, setCandidateEdit, run, mutate } = ctx;
  return (
    <>
      {" "}
      {tab === "compare" && (
        <>
          <div className="section-head">
            <div>
              <h2>OSSを比較する</h2>
              <p className="muted">
                確認した事実と採否の判断を分けて記録します。
              </p>
            </div>
            <button className="primary" onClick={() => setCandidateEdit("new")}>
              ＋ 候補を追加
            </button>
          </div>
          {candidateEdit !== null && (
            <CandidateEditor
              key={candidateEdit}
              value={(() => {
                const c = p.candidates.find((c) => c.id === candidateEdit);
                if (!c) return blankCandidate;
                const { id: _, status: __, ...rest } = c;
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
      {tab === "compare" && (
        <ComparisonClaims p={p} submit={(c) => run(() => mutate(c))} />
      )}
    </>
  );
}
