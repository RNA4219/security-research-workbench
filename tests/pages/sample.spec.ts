import { test, expect } from "../e2e/fixtures.js";

test("モックと明示し、外部通信なしで比較・再評価・人の確認を体験できる", async ({
  page,
}) => {
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" || url.pathname.startsWith("/api/")) {
      unexpected.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("./");
  await expect(page).toHaveTitle(/継続的な脆弱性診断のモック/);
  await expect(page.getByRole("note")).toContainText("モック / サンプル");
  await expect(page.getByRole("note")).toContainText(
    "実際の診断・保存・定期実行を行いません",
  );
  await expect(page.getByLabel("公開GitHubリポジトリのURL")).not.toBeVisible();
  await expect(
    page.getByText("新規の指摘 · 人の確認待ち", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "02 更新後の比較" }).click();
  await expect(
    page.getByText("継続中 · 対応が必要", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("行番号が変わっても", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "03 修正後の再評価" }).click();
  await expect(
    page.getByText("今回未検出 · 修正確認待ち", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".sample-metrics > div").filter({ hasText: "未解決の指摘" }),
  ).toHaveText("未解決の指摘1件");
  const confirm = page.getByRole("button", { name: "04 人の確認・知識承認" });
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(confirm).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator(".sample-metrics > div").filter({ hasText: "未解決の指摘" }),
  ).toHaveText("未解決の指摘0件");
  await expect(
    page.getByText("承認済み: 商品カタログとの外部通信", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("製品全体の安全性を保証する判定ではありません", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "01 初回診断" }).click();
  await expect(
    page.getByText("新規の指摘 · 人の確認待ち", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "01 初回診断" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test("390px幅で全場面とモック表記が読み取れ、補助機能の区別も明確", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  for (const label of [
    "01 初回診断",
    "02 更新後の比較",
    "03 修正後の再評価",
    "04 人の確認・知識承認",
  ]) {
    await page.getByRole("button", { name: label }).click();
    await expect(page.getByRole("note")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page
    .getByText("OSS採用前調査（実データ・補助機能）", { exact: true })
    .click();
  await expect(
    page.getByText("ここからは実データを取得する別の機能です", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("公開GitHubリポジトリのURL")).toBeVisible();
  await page
    .getByText("OSS採用前調査（実データ・補助機能）", { exact: true })
    .click();
  await expect(page.getByLabel("公開GitHubリポジトリのURL")).not.toBeVisible();
});
