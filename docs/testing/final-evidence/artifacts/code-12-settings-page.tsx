import { type FormEvent } from "react";

import { ProjectForm, Field } from "./forms.js";

import type { ActiveWorkbench } from "./app.js";
export function SettingsPage({ ctx }: { ctx: ActiveWorkbench }) {
  const { p, tab, memx, query, setQuery, memxResult, run, mutate, memxAction } =
    ctx;
  return (
    <>
      {" "}
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
                scope: p.scope,
                outOfScope: p.outOfScope,
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
                  <Field label="知識を検索" value={query} onChange={setQuery} />
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
}
