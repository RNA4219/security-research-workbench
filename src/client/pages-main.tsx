import { createRoot } from "react-dom/client";
import { RepositoryPage, type ResearchClient } from "./repository-page.js";
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
      <RepositoryPage client={client} />
    </main>
    <footer className="public-footer">
      公開版はURLからのOSS調査に対応しています。資料の整理・要件レビューはローカル版で利用できます。
      <br />
      通信先はGitHubとOSVです。認証情報は使いません。{" "}
      <a href="./THIRD_PARTY_LICENSES.txt">ライセンス</a>
    </footer>
  </div>,
);
