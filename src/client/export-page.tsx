import Markdown from "react-markdown";

import { download } from "./api.js";

import type { ActiveWorkbench } from "./app.js";
export function ExportPage({ ctx }: { ctx: ActiveWorkbench }) {
  const { projects, p, tab, run, approvalCount } = ctx;
  return (
    <>
      {" "}
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
                "承認済み要件・受入条件・主張・根拠を含む独立した版付き契約",
                "json",
              ],
              [
                "agent-protocols",
                "agent-protocols変換（任意）",
                "導入済みの場合にv2契約へ変換。未導入でも内部契約は利用できます。",
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
    </>
  );
}
