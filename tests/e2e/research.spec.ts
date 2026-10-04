import { test, expect } from "./fixtures.js";
import type { ResearchReport } from "../../src/shared/repository-research.js";

test("未取得・部分照合・0件を区別し、外部文字列をHTMLとして実行しない", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/research", {
    headers: { "X-Workbench": "1" },
    data: { repoUrl: "https://github.com/example/research-fixture" },
  });
  const partial: ResearchReport = await response.json();
  Object.assign(partial.repository, {
    archived: true,
    license: null,
    latestRelease: null,
    releaseStatus: "unavailable",
    commit: null,
    committedAt: null,
    description: "<script>unsafe()</script>",
  });
  Object.assign(partial.dependencies, {
    status: "partial",
    withdrawn: 2,
    unassessed: [
      {
        path: "node_modules/local-package",
        reason: "ローカルファイルのため未照合",
      },
    ],
  });
  Object.assign(partial.dependencies.findings[0], {
    development: true,
    fixes: [],
    detailStatus: "unavailable",
  });
  let result = partial;
  await page.route("**/api/research", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ json: result })
      : route.continue(),
  );
  await page.goto("/");
  await page
    .getByLabel("公開GitHubリポジトリのURL")
    .fill("https://github.com/example/research-fixture");
  await page.getByRole("button", { name: "このOSSを調べる" }).click();
  await expect(page.getByText("一部未調査", { exact: true })).toBeVisible();
  await expect(page.getByText("詳細は取得できませんでした。")).toBeVisible();
  await expect(
    page.getByText("node_modules/local-package", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("撤回済み2件は対応対象から除外しました。"),
  ).toBeVisible();
  await expect(
    page.getByText("<script>unsafe()</script>", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".research-result script")).toHaveCount(0);
  await page.getByLabel("依存関係の表示範囲").selectOption("dev");
  await expect(
    page.getByRole("link", { name: "GHSA-test-fixture ↗", exact: true }),
  ).toBeVisible();
  for (const state of ["unsupported", "unavailable", "complete"] as const) {
    result = structuredClone(partial);
    Object.assign(result.dependencies, {
      status: state,
      findings: [],
      withdrawn: 0,
      lockfile: null,
    });
    result.repository.releaseStatus = "none";
    await page.getByRole("button", { name: "このOSSを調べる" }).click();
    await expect(
      page.getByText(
        state === "complete"
          ? "照合した依存版に一致する公開アドバイザリはありませんでした。"
          : "照合が完了していないため、依存関係に問題がないとは判断できません。",
      ),
    ).toBeVisible();
  }
});

test("履歴の初期読込失敗を表示し、ページ再読込で復帰する", async ({ page }) => {
  await page.route("**/api/research", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "調査履歴を読み込めません",
  );
  await page.unroute("**/api/research");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "このOSSを調べる" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("URL入力だけで調査し、根拠・修正版・履歴・ファイルを取得する", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("公開GitHubリポジトリのURL")
    .fill("https://github.com/example/research-fixture");
  await page.getByRole("button", { name: "このOSSを調べる" }).click();
  await expect(
    page.getByRole("heading", { name: "次に確認すること" }),
  ).toBeVisible();
  await expect(
    page.getByText("1件の依存パッケージ版の更新を検討する"),
  ).toBeVisible();
  await expect(page.getByText("公開された修正境界:")).toBeVisible();
  await expect(page.getByText("4.17.21", { exact: false })).toBeVisible();
  await page.getByLabel("依存関係の表示範囲").selectOption("dev");
  await expect(
    page.getByRole("link", { name: "GHSA-test-fixture" }),
  ).toHaveCount(0);
  await page.getByLabel("依存関係の表示範囲").selectOption("runtime");
  await expect(
    page.getByRole("link", { name: "GHSA-test-fixture ↗", exact: true }),
  ).toBeVisible();
  await page.getByText("ロックファイル内の場所").click();
  await expect(
    page.getByText("node_modules/lodash", { exact: true }),
  ).toBeVisible();
  await page.getByText("取得元と記録").click();
  await expect(
    page.getByText("SHA256:", { exact: false }).first(),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "調査結果をダウンロード" }).click();
  expect((await downloaded).suggestedFilename()).toBe("repository-research.md");
  await page.reload();
  await page
    .getByRole("button", { name: /example\/research-fixture ·/ })
    .first()
    .click();
  await expect(page.getByText("4.17.21", { exact: false })).toBeVisible();
});

test("失敗してもURLと前の結果を保ち、手動で再試行できる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByLabel("公開GitHubリポジトリのURL")
    .fill("https://github.com/example/research-fixture");
  await page.getByRole("button", { name: "このOSSを調べる" }).click();
  await expect(
    page.getByRole("heading", { name: "次に確認すること" }),
  ).toBeVisible();
  await page
    .getByLabel("公開GitHubリポジトリのURL")
    .fill("https://example.org/other");
  await page.getByRole("button", { name: "このOSSを調べる" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "公開GitHubリポジトリのURL",
  );
  await expect(page.getByLabel("公開GitHubリポジトリのURL")).toHaveValue(
    "https://example.org/other",
  );
  await expect(
    page.getByRole("heading", { name: "次に確認すること" }),
  ).toBeVisible();
});
