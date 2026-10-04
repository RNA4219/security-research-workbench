import { request } from "./api.js";

import type { ActiveWorkbench } from "./app.js";
export function HistoryPage({ ctx }: { ctx: ActiveWorkbench }) {
  const {
    projects,
    p,
    tab,
    history,
    historyContent,
    setHistoryContent,
    artifacts,
    run,
  } = ctx;
  return (
    <>
      {" "}
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
                    {a.kind === "prompt"
                      ? "プロンプト"
                      : a.kind === "ai-response"
                        ? "AI回答"
                        : a.kind === "source-import"
                          ? "取込原文"
                          : "出力記録"}{" "}
                    · {a.created_at}
                  </summary>
                  <pre>{a.body}</pre>
                </details>
              ))}
            </section>
          </div>
          {historyContent && <pre className="panel">{historyContent}</pre>}
        </>
      )}
    </>
  );
}
