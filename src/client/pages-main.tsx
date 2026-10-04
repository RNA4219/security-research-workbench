import { createRoot } from "react-dom/client";
import { RepositoryPage, type ResearchClient } from "./repository-page.js";
import { DiagnosticSample } from "./diagnostic-sample.js";
import { browserHistory } from "../research/browser-storage.js";
import {
  researchRepository,
  researchMarkdown,
} from "../research/repository-research.js";
import "./style.css";
import "./pages.css";

const history = browserHistory();
const client: ResearchClient = {
  storageLabel: "このブラウザ",
  list: history.list,
  read: history.get,
  clear: history.clear,
  research: async (url) => {
    const report = await researchRepository(url);
    try {
      await history.save(report);
      return { report };
    } catch {
      return {
        report,
        warning:
          "結果は表示できましたが、ブラウザに保存できませんでした。必要な結果はダウンロードしてください。",
      };
    }
  },
  download: async (report) => {
    const url = URL.createObjectURL(
      new Blob([researchMarkdown(report)], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "repository-research.md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
createRoot(document.getElementById("root")!).render(
  <div className="public-workbench">
    <header className="public-header">
      <a href="/open/">← OPEN / 一覧</a>
      <span>Security Research Workbench</span>
      <a
        href="https://github.com/RNA4219/security-research-workbench"
        target="_blank"
        rel="noreferrer"
      >
        ソース・ローカル版 ↗
      </a>
    </header>
    <main>
      <DiagnosticSample />
      <details className="public-research">
        <summary>OSS採用前調査（実データ・補助機能）</summary>
        <p className="public-research-notice">
          ここからは実データを取得する別の機能です。URLを入力して調査するとGitHubとOSVへ問い合わせます。
          製品コードの継続診断は行いません。履歴はこのブラウザに保存します。
        </p>
        <RepositoryPage client={client} />
      </details>
    </main>
    <footer className="public-footer">
      継続診断の画面は架空データを使ったモックです。製品の診断・保存・定期実行はローカル版で利用できます。
      <br />
      補助機能のOSS採用前調査はGitHubとOSVの実データを取得します。{" "}
      <a href="./THIRD_PARTY_LICENSES.txt">ライセンス</a>
    </footer>
  </div>,
);
