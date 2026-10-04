import { useEffect, useState } from "react";
import { download, request } from "./api.js";
import type {
  ResearchReport,
  ResearchSummary,
} from "../shared/repository-research.js";

const statusLabels = {
  complete: "対象範囲の照合完了",
  partial: "一部未調査",
  unavailable: "照合できませんでした",
  unsupported: "対応するlockfileなし",
};

export function RepositoryPage() {
  const [url, setUrl] = useState("");
  const [report, setReport] = useState<ResearchReport>();
  const [history, setHistory] = useState<ResearchSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const loadHistory = async () =>
    setHistory(await request<ResearchSummary[]>("/research"));
  useEffect(() => {
    void loadHistory().catch(() =>
      setError("調査履歴を読み込めません。再読込してください。"),
    );
  }, []);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : "調査に失敗しました。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="repository-research" aria-label="リポジトリ調査">
      <p className="eyebrow">URLを入れて、調査を任せる</p>
      <h1>
        このOSS、使う前に
        <br />
        何を確認すればいい？
      </h1>
      <p className="research-intro">
        GitHubの情報と依存関係を集め、更新を検討するパッケージや、保守・ライセンスの確認事項をまとめます。
      </p>
      <form
        className="panel research-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const next = await request<ResearchReport>("/research", {
              repoUrl: url,
            });
            setReport(next);
            setFilter("all");
            await loadHistory();
          });
        }}
      >
        <label className="field">
          <span>公開GitHubリポジトリのURL</span>
          <input
            type="url"
            required
            maxLength={250}
            placeholder="https://github.com/owner/repo"
            value={url}
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !url.trim()}
          type="submit"
        >
          {busy ? "公開情報を調査中…" : "このOSSを調べる"}
        </button>
        <p className="muted">
          APIキー不要。結果はこのPCに保存します。依存関係の照合はルートのnpm
          lockfile v2/3に対応。GitHubとOSVへ公開情報を問い合わせます。
        </p>
      </form>
      {busy && (
        <p role="status">
          GitHubの保守情報と、依存版に対応する公開アドバイザリを確認しています。最大45秒程度かかります。
        </p>
      )}
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {report && (
        <div className="research-result" aria-label="調査結果">
          <header className="section-head">
            <div>
              <h2>
                <a
                  href={report.repository.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {report.repository.name} ↗
                </a>
              </h2>
              <p>{report.repository.description}</p>
              <p className="muted">
                取得: {report.collectedAt} · ローカル保存済み
              </p>
            </div>
            <button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  download(
                    `/research/${report.id}/markdown`,
                    "repository-research.md",
                  ),
                )
              }
            >
              調査結果をダウンロード
            </button>
          </header>
          <section className="panel">
            <h2>次に確認すること</h2>
            <ol className="research-actions">
              {report.actions.map((a, i) => (
                <li key={i}>
                  <h3>{a.title}</h3>
                  <p>{a.detail}</p>
                  <a href={a.sourceUrl} target="_blank" rel="noreferrer">
                    根拠を開く ↗
                  </a>
                </li>
              ))}
            </ol>
          </section>
          <div className="research-facts">
            <article className="panel">
              <h3>保守・利用条件</h3>
              <dl>
                <dt>ライセンス</dt>
                <dd>{report.repository.license ?? "未確認"}</dd>
                <dt>archive</dt>
                <dd>{report.repository.archived ? "あり" : "なし"}</dd>
                <dt>最新の正式リリース</dt>
                <dd>
                  {report.repository.latestRelease ??
                    (report.repository.releaseStatus === "none"
                      ? "なし"
                      : "未取得")}
                </dd>
                <dt>最新コミット日時</dt>
                <dd>{report.repository.committedAt ?? "未取得"}</dd>
                <dt>調査したコミット</dt>
                <dd>
                  {report.repository.commit ? (
                    <a
                      href={`${report.repository.url}/commit/${report.repository.commit}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <code>{report.repository.commit.slice(0, 12)}</code>
                    </a>
                  ) : (
                    "未取得"
                  )}
                </dd>
              </dl>
            </article>
            <article className="panel">
              <h3>依存関係の照合</h3>
              <p
                className={`research-status ${report.dependencies.status === "complete" ? "" : "incomplete"}`}
              >
                {statusLabels[report.dependencies.status]}
              </p>
              <p>
                <strong>{report.dependencies.queried}</strong>{" "}
                パッケージ版をOSVと照合
              </p>
              <p>
                {report.dependencies.findings.length}{" "}
                件の公開アドバイザリとの一致
              </p>
              <p className="muted">
                {report.dependencies.lockfile ?? "対応lockfile未取得"} ·{" "}
                {report.dependencies.total} 依存レコード ·{" "}
                {report.dependencies.skipped} 件未照合
              </p>
              {report.dependencies.withdrawn > 0 && (
                <p>
                  撤回済み{report.dependencies.withdrawn}
                  件は対応対象から除外しました。
                </p>
              )}
            </article>
          </div>
          <section className="panel">
            <div className="section-head">
              <h2>更新を検討する依存関係</h2>
              <label>
                表示範囲{" "}
                <select
                  aria-label="依存関係の表示範囲"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">すべて</option>
                  <option value="runtime">実行用を含む</option>
                  <option value="dev">開発用</option>
                </select>
              </label>
            </div>
            <p className="muted">
              修正境界には複数の保守系列を含む場合があります。更新先の互換性を確認し、更新後にテストしてください。
            </p>
            {report.dependencies.findings.length === 0 ? (
              <p>
                {report.dependencies.status === "complete"
                  ? "照合した依存版に一致する公開アドバイザリはありませんでした。"
                  : "照合が完了していないため、依存関係に問題がないとは判断できません。"}
              </p>
            ) : (
              <div className="research-findings">
                {report.dependencies.findings
                  .filter(
                    (f) =>
                      filter === "all" ||
                      (filter === "dev" ? f.development : !f.development),
                  )
                  .map((f, i) => (
                    <article key={`${f.name}-${f.advisoryId}-${i}`}>
                      <h3>
                        {f.name} <code>{f.version}</code>{" "}
                        <small>
                          {f.development ? "開発用" : "実行用を含む"}
                        </small>
                      </h3>
                      <p>{f.summary}</p>
                      <p>
                        <b>公開された修正境界:</b>{" "}
                        {f.fixes.join(", ") ||
                          "未確認。原文で確認してください。"}
                      </p>
                      {f.detailStatus === "unavailable" && (
                        <p className="muted">詳細は取得できませんでした。</p>
                      )}
                      <a href={f.url} target="_blank" rel="noreferrer">
                        {f.advisoryId} ↗
                      </a>
                      <details>
                        <summary>ロックファイル内の場所</summary>
                        <ul>
                          {f.paths.map((path) => (
                            <li key={path}>
                              <code>{path}</code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </article>
                  ))}
              </div>
            )}
          </section>
          <section className="panel">
            <h2>今回の調査範囲</h2>
            {(report.dependencies.unassessed ?? []).length > 0 && (
              <div className="unassessed">
                <h3>照合できなかった依存（最大30件）</h3>
                <ul>
                  {report.dependencies.unassessed!.map((item) => (
                    <li key={item.path}>
                      <code>{item.path}</code>
                      <p>{item.reason}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ul>
              {report.limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            <details>
              <summary>取得元と記録</summary>
              <ul>
                {report.sources.map((s, i) => (
                  <li key={i}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      {s.label}
                    </a>
                    <small className="source-hash">SHA256: {s.sha256}</small>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        </div>
      )}
      {history.length > 0 && (
        <section className="panel research-history">
          <h2>過去の調査</h2>
          <p className="muted">
            保存した結果を開きます。最新情報を取り直すにはURLから再調査してください。
          </p>
          {history.map((item) => (
            <button
              key={item.id}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const saved = await request<ResearchReport>(
                    `/research/${item.id}`,
                  );
                  setReport(saved);
                  setUrl(saved.repository.url);
                  setFilter("all");
                })
              }
            >
              {item.name} · {item.collectedAt} · {statusLabels[item.status]}
            </button>
          ))}
        </section>
      )}
    </section>
  );
}
