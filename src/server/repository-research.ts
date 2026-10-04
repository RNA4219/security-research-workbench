import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ResearchReport } from "../shared/repository-research.js";
import { DomainError } from "./domain.js";
import { parseRepositoryUrl, researchJson } from "./research-http.js";
import { parseLockfile, queryDependencies } from "./research-dependencies.js";

const repoSchema = z.object({
  full_name: z.string(),
  private: z.literal(false),
  description: z.string().nullable(),
  archived: z.boolean(),
  default_branch: z.string().min(1),
  license: z.object({ spdx_id: z.string() }).nullable(),
});
const commitSchema = z.object({
  sha: z.string().regex(/^[a-f\d]{40}$/),
  commit: z.object({
    committer: z.object({ date: z.iso.datetime({ offset: true }) }).nullable(),
  }),
});
const releaseSchema = z.object({ tag_name: z.string().min(1) });
const fileSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  content: z.string(),
});

export async function researchRepository(
  repoUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<ResearchReport> {
  const target = parseRepositoryUrl(repoUrl);
  const base = `https://api.github.com/repos/${target.name}`;
  const signal = AbortSignal.timeout(45_000);
  const report: ResearchReport = {
    id: randomUUID(),
    collectedAt: new Date().toISOString(),
    repository: {
      name: target.name,
      url: target.url,
      description: "",
      license: null,
      archived: false,
      defaultBranch: "",
      commit: null,
      committedAt: null,
      latestRelease: null,
      releaseStatus: "unavailable",
    },
    dependencies: {
      status: "unsupported",
      lockfile: null,
      total: 0,
      queried: 0,
      skipped: 0,
      findings: [],
      withdrawn: 0,
    },
    actions: [],
    limitations: [],
    sources: [],
  };
  const get = async (url: string, label: string) => {
    const response = await researchJson(fetcher, url, signal);
    if (response) report.sources.push({ label, url, sha256: response.sha256 });
    return response?.value;
  };
  try {
    const raw = await get(base, "GitHub リポジトリ情報");
    if (!raw)
      throw new Error(
        "公開リポジトリが見つかりません。URLと公開設定を確認してください。",
      );
    const repo = repoSchema.parse(raw);
    if (repo.full_name.toLowerCase() !== target.name.toLowerCase())
      throw new Error(
        "リポジトリ名が一致しません。現在のURLを入力してください。",
      );
    Object.assign(report.repository, {
      description: repo.description ?? "",
      license: repo.license?.spdx_id ?? null,
      archived: repo.archived,
      defaultBranch: repo.default_branch,
    });
  } catch (error) {
    throw new DomainError(
      error instanceof z.ZodError
        ? "GitHubの公開リポジトリ情報を確認できませんでした。"
        : error instanceof Error
          ? error.message
          : "公開リポジトリを取得できませんでした。",
      502,
    );
  }
  const [commit, release] = await Promise.allSettled([
    get(
      `${base}/commits/${encodeURIComponent(report.repository.defaultBranch)}`,
      "調査対象コミット",
    ),
    get(`${base}/releases/latest`, "最新の正式リリース"),
  ]);
  if (commit.status === "fulfilled") {
    const parsed = commitSchema.safeParse(commit.value);
    if (parsed.success) {
      report.repository.commit = parsed.data.sha;
      report.repository.committedAt =
        parsed.data.commit.committer?.date ?? null;
    }
  }
  if (release.status === "fulfilled") {
    if (release.value === undefined) report.repository.releaseStatus = "none";
    else {
      const parsed = releaseSchema.safeParse(release.value);
      if (parsed.success) {
        report.repository.latestRelease = parsed.data.tag_name;
        report.repository.releaseStatus = "found";
      }
    }
  }
  if (report.repository.releaseStatus === "unavailable")
    report.limitations.push("最新リリース情報を取得できませんでした。");
  if (!report.repository.commit) {
    report.dependencies.status = "unavailable";
    report.limitations.push(
      "対象コミットを確定できないため、依存関係は未照合です。",
    );
  } else {
    try {
      // npm gives shrinkwrap priority over package-lock when both exist.
      let filename = "npm-shrinkwrap.json";
      let raw = await get(
        `${base}/contents/${filename}?ref=${report.repository.commit}`,
        filename,
      );
      if (!raw) {
        filename = "package-lock.json";
        raw = await get(
          `${base}/contents/${filename}?ref=${report.repository.commit}`,
          filename,
        );
      }
      if (!raw)
        report.limitations.push(
          "ルートにnpm lockfileがありません。別の言語・形式・サブディレクトリの依存関係は未照合です。",
        );
      else {
        report.dependencies.lockfile = filename;
        const file = fileSchema.parse(raw);
        const lock = JSON.parse(
          Buffer.from(file.content, "base64").toString("utf8"),
        );
        const parsed = parseLockfile(lock);
        const queried = await queryDependencies(parsed, fetcher, signal);
        report.dependencies = { ...queried.result, lockfile: filename };
        report.sources.push(...queried.sources);
        report.limitations.push(...queried.limitations);
      }
    } catch (error) {
      report.dependencies.status = "unavailable";
      report.limitations.push(
        error instanceof Error &&
          !(error instanceof z.ZodError) &&
          !(error instanceof SyntaxError)
          ? error.message
          : "ロックファイルを読み取れませんでした。依存関係は未照合です。",
      );
    }
  }
  const add = (title: string, detail: string, sourceUrl = target.url) =>
    report.actions.push({ title, detail, sourceUrl });
  if (report.repository.archived)
    add(
      "保守を引き継げるか確認する",
      "リポジトリがarchiveされています。採用前に後継版・フォーク・自分で保守する範囲を確認してください。",
    );
  if (!report.repository.license || report.repository.license === "NOASSERTION")
    add(
      "利用・配布条件を確認する",
      "GitHubでライセンスを識別できませんでした。LICENSE原文と利用条件の確認が必要です。",
    );
  if (
    report.repository.committedAt &&
    Date.parse(report.collectedAt) - Date.parse(report.repository.committedAt) >
      365 * 86400_000
  )
    add(
      "保守状況を確認する",
      "デフォルトブランチの最新コミットから1年以上経っています。完成度や別ブランチでの活動も含めて確認してください。",
    );
  const affected = new Set(
    report.dependencies.findings.map((f) => `${f.name}@${f.version}`),
  );
  if (affected.size)
    add(
      `${affected.size}件の依存パッケージ版の更新を検討する`,
      "下の一覧から公開アドバイザリと修正境界を確認し、直接依存の更新、または間接依存を取り込む親パッケージの更新を検討してください。更新後はテストと再照合を行います。",
      batchUrlForAction,
    );
  if (report.dependencies.status !== "complete")
    add(
      "未照合の範囲を調べる",
      "依存関係の調査が完了していません。「今回の調査範囲」の未取得・未対応項目を確認してください。",
    );
  if (!report.actions.length)
    add(
      "実際の用途との適合を確認する",
      "今回取得した範囲では追加の確認事項は見つかりませんでした。READMEの使い方、運用条件、必要な機能を実際の用途と照らし合わせてください。",
    );
  report.limitations.push(
    "依存関係はルートのnpm lock v2/3のみ。製品コード、実行環境での到達可能性、他のlockfileは調査していません。OSV未掲載は安全の証明ではありません。",
  );
  return report;
}
const batchUrlForAction = "https://google.github.io/osv.dev/";

export function researchMarkdown(report: ResearchReport) {
  const safe = (v: string) =>
    v.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
  const r = report.repository,
    d = report.dependencies;
  return [
    `# ${safe(r.name)} の調査結果`,
    `取得日時: ${report.collectedAt}`,
    `リポジトリ: ${r.url}`,
    `対象コミット: ${r.commit ?? "未確認"}`,
    `ライセンス: ${safe(r.license ?? "未確認")}`,
    `archive: ${r.archived ? "あり" : "なし"}`,
    `最新正式リリース: ${safe(r.latestRelease ?? (r.releaseStatus === "none" ? "なし" : "未取得"))}`,
    "## 次に確認すること",
    ...report.actions.map(
      (a) => `- ${safe(a.title)}: ${safe(a.detail)} (${a.sourceUrl})`,
    ),
    "## 依存関係",
    `照合状態: ${d.status} / lockfile: ${d.lockfile ?? "なし"} / ${d.queried}パッケージ版を照合 / ${d.skipped}件未照合`,
    ...d.findings.map(
      (f) =>
        `- ${safe(f.name)}@${safe(f.version)} (${f.development ? "開発用" : "実行用を含む"}): ${safe(f.advisoryId)} — ${safe(f.summary)}\n  公開された修正境界: ${safe(f.fixes.join(", ") || "未確認")}\n  出典: ${f.url}\n  場所: ${safe(f.paths.join(", "))}`,
    ),
    "修正境界には複数系列を含む場合があります。更新先の互換性を確認してください。",
    "## 今回の調査範囲",
    ...(d.unassessed ?? []).map(
      (item) => `- 未照合: ${safe(item.path)} — ${safe(item.reason)}`,
    ),
    ...report.limitations.map((l) => `- ${safe(l)}`),
    "## 出典",
    ...report.sources.map(
      (s) => `- ${safe(s.label)}: ${s.url}\n  応答SHA256: ${s.sha256}`,
    ),
    "",
  ].join("\n\n");
}
