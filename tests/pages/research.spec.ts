import { readFile } from "node:fs/promises";
import { test, expect } from "../e2e/fixtures.js";
import { researchFetcher } from "../research-fixtures.js";
import { storageKey } from "../../src/research/browser-storage.js";
const repo = "https://github.com/example/research-fixture";
test.beforeEach(async ({ page }) => {
  const provider = researchFetcher();
  for (const origin of [
    "https://api.github.com/**",
    "https://api.osv.dev/**",
  ]) {
    await page.route(origin, async (route) => {
      const request = route.request();
      const response = await provider(request.url(), {
        body: request.postData(),
      });
      await route.fulfill({
        status: response.status,
        body: await response.text(),
        contentType: "application/json",
      });
    });
  }
});
test("静的サブパスだけで調査・履歴・再読込・Markdown・履歴削除が使える", async ({
  page,
}) => {
  const errors: string[] = [],
    api: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) api.push(r.url());
  });
  await page.goto("./");
  await page
    .getByText("OSS採用前調査（実データ・補助機能）", { exact: true })
    .click();
  await expect(
    page.getByText("結果はこのブラウザに保存します。", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "← OPEN / 一覧" }),
  ).toHaveAttribute("href", "/open/");
  await page.getByLabel("公開GitHubリポジトリのURL").fill(repo);
  await page.getByRole("button", { name: "このOSSを調べる" }).click();
  await expect(page.locator(".research-findings")).toContainText("4.17.21");
  await page.reload();
  await page
    .getByText("OSS採用前調査（実データ・補助機能）", { exact: true })
    .click();
  await page
    .getByRole("button", { name: /example\/research-fixture ·/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "次に確認すること" }),
  ).toBeVisible();
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "調査結果をダウンロード" }).click();
  const download = await saved;
  expect(download.suggestedFilename()).toBe("repository-research.md");
  expect(await readFile((await download.path())!, "utf8")).toContain("4.17.21");
  await page.getByText("このブラウザの保存について", { exact: true }).click();
  await page.getByRole("button", { name: "このブラウザの履歴を削除" }).click();
  await expect(page.getByRole("heading", { name: "過去の調査" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("alert")).toContainText("履歴を削除しました");
  await page.reload();
  await page
    .getByText("OSS採用前調査（実データ・補助機能）", { exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "過去の調査" })).toHaveCount(
    0,
  );
  expect(api).toEqual([]);
  expect(errors).toEqual([]);
});
test("保存不能でも調査結果を失わず、ダウンロードできる", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("quota", "QuotaExceededError");
    };
  });
  await page.goto("./");
  await page
    .getByText("OSS採用前調査（実データ・補助機能）", { exact: true })
    .click();
  await page.getByLabel("公開GitHubリポジトリのURL").fill(repo);
  await page.getByRole("button", { name: "このOSSを調べる" }).click();
  await expect(page.getByRole("alert")).toContainText("保存できませんでした");
  await expect(page.getByText("取得:", { exact: false })).toContainText(
    "未保存",
  );
  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "調査結果をダウンロード" }).click();
  expect((await saved).suggestedFilename()).toBe("repository-research.md");
});
test("破損した履歴を削除して復帰し、API制限や未取得を画面に示す", async ({
  page,
}) => {
  await page.goto("./");
  await page.evaluate((key) => localStorage.setItem(key, "broken"), storageKey);
  await page.reload();
  await page
    .getByText("OSS採用前調査（実データ・補助機能）", { exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("履歴を読み込めません");
  await page.getByText("このブラウザの保存について", { exact: true }).click();
  await page.getByRole("button", { name: "このブラウザの履歴を削除" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.route(
    "https://api.github.com/repos/example/research-fixture",
    (r) => r.fulfill({ status: 403, json: {} }),
  );
  await page.getByLabel("公開GitHubリポジトリのURL").fill(repo);
  await page.getByRole("button", { name: "このOSSを調べる" }).click();
  await expect(page.getByRole("alert")).toContainText("利用上限");
  await page.unroute("https://api.github.com/repos/example/research-fixture");
  await page.route("https://api.osv.dev/**", (r) => r.abort());
  await page.getByRole("button", { name: "このOSSを調べる" }).click();
  await expect(
    page.getByText("照合できませんでした", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("照合が完了していないため", { exact: false }),
  ).toBeVisible();
});
test("スマートフォン幅で横にはみ出さずに入力できる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  await page
    .getByText("OSS採用前調査（実データ・補助機能）", { exact: true })
    .click();
  await page.getByLabel("公開GitHubリポジトリのURL").fill(repo);
  await page.getByRole("button", { name: "このOSSを調べる" }).click();
  await expect(
    page.getByRole("heading", { name: "次に確認すること" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
