import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

test("サンプルから根拠・プロンプト・レビュー・実装タスクへ", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "サンプルで試す" }).click();
  await expect(
    page.getByRole("heading", { name: "防御ツールの選定調査" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Trivy / 公開概要" }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /Trivy/ }).check();
  await page
    .getByRole("button", { name: "プロンプトを作成", exact: true })
    .click();
  await expect(page.getByLabel("生成したプロンプト")).toContainText(
    "回答JSON Schema",
  );
  await page.getByRole("button", { name: /02OSS比較/ }).click();
  await expect(
    page.getByRole("cell", { name: "Apache-2.0" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /03要件とレビュー/ }).click();
  await page.getByRole("button", { name: "確認して承認" }).click();
  await expect(
    page.getByRole("button", { name: "未レビューに戻す" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /04出力/ }).click();
  const result = page.waitForEvent("download");
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "実装タスク契約" }) })
    .getByRole("button")
    .click();
  expect((await result).suggestedFilename()).toBe("workbench-contracts.json");
  await page.getByRole("button", { name: /01調査資料/ }).click();
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Trivy / 公開概要" }) })
    .getByRole("button", { name: "編集" })
    .click();
  await page.getByLabel("資料の版", { exact: true }).fill("2");
  await page.getByRole("button", { name: "資料を保存" }).click();
  await page.getByRole("button", { name: /03要件とレビュー/ }).click();
  await expect(page.getByText("再確認が必要", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /◇\s*防御ツールの選定調査/ }).click();
  await page.getByRole("button", { name: /03要件とレビュー/ }).click();
  await expect(page.getByText("再確認が必要", { exact: true })).toBeVisible();
  mkdirSync(".cache/screenshots", { recursive: true });
  await page.screenshot({
    path: ".cache/screenshots/workbench-review.png",
    fullPage: true,
  });
});

test("新規作成・資料取込・不正回答・編集・履歴を保持", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "新しいプロジェクト", exact: true })
    .click();
  await page.getByLabel("プロジェクト名", { exact: true }).fill("テスト調査");
  await page.getByLabel("目的", { exact: true }).fill("資料を整理する");
  await page.getByLabel("対象利用者").fill("開発者");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await page.getByRole("button", { name: "＋ 資料を追加" }).click();
  await page.getByLabel("資料名", { exact: true }).fill("公開資料");
  await page.getByLabel("出典URL").fill("https://example.org/source");
  await page
    .getByLabel("資料本文")
    .fill(
      "# 公開資料\n\n<b>装飾文字</b>\n\n![外部画像](https://example.org/image.png)",
    );
  await page.getByRole("button", { name: "資料を保存" }).click();
  await page.getByText("本文・出典IDを見る").click();
  await expect(page.locator(".markdown img")).toHaveCount(0);
  await expect(page.locator(".markdown b")).toHaveCount(0);
  await page.getByRole("button", { name: /03要件とレビュー/ }).click();
  await page
    .getByRole("textbox", { name: "回答JSON", exact: true })
    .fill("invalid");
  await page.getByRole("button", { name: "回答を取り込む" }).click();
  await expect(page.getByRole("alert")).toContainText("JSONを解析");
  await expect(
    page.getByRole("textbox", { name: "回答JSON", exact: true }),
  ).toHaveValue("invalid");
  await page
    .getByRole("textbox", { name: "回答JSON", exact: true })
    .fill(
      JSON.stringify({
        schemaVersion: "1.0",
        requirements: [
          {
            id: "REQ-TEST",
            title: "データ保存",
            description: "調査を保存する",
            priority: "medium",
            sourceIds: [],
            rationale: "利用者が必要と判断",
            acceptance: ["再起動後に復元できる"],
            tasks: ["保存機能を作る"],
          },
        ],
      }),
    );
  await page.getByRole("button", { name: "回答を取り込む" }).click();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("要件名").fill("永続データ保存");
  await page.getByRole("button", { name: "要件を保存" }).click();
  await expect(
    page.getByRole("heading", { name: "永続データ保存" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /↺履歴/ }).click();
  await expect(
    page.getByText("AI回答 ·", { exact: false }).first(),
  ).toBeVisible();
});

test("狭い画面で作業入口を操作できる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "プロジェクトを作成 →" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("ファイル取込と比較候補の追加・編集", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "新しいプロジェクト", exact: true })
    .click();
  await page.getByLabel("プロジェクト名", { exact: true }).fill("取込と比較");
  await page.getByLabel("目的", { exact: true }).fill("公開情報の比較");
  await page.getByLabel("対象利用者").fill("開発者");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await page.getByRole("button", { name: "＋ 資料を追加" }).click();
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "report.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 公開レポート\n資料本文"),
    });
  await expect(
    page.getByRole("textbox", { name: "資料本文", exact: true }),
  ).toHaveValue("# 公開レポート\n資料本文");
  await page.getByLabel("出典URL").fill("https://example.org/report");
  await page.getByRole("button", { name: "資料を保存" }).click();
  await page.getByRole("button", { name: "＋ 資料を追加" }).click();
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "sources.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          schemaVersion: "1.0",
          sources: [
            {
              title: "追加資料",
              url: "https://example.org/reference",
              retrievedAt: "2026-10-03T00:00:00.000Z",
              version: "1",
              body: "公開根拠",
            },
          ],
        }),
      ),
    });
  await expect(page.getByRole("heading", { name: "追加資料" })).toBeVisible();
  await page.getByRole("button", { name: /02OSS比較/ }).click();
  await page.getByRole("button", { name: "＋ 候補を追加" }).click();
  await page.getByLabel("OSS名").fill("公開サンプル");
  await page.getByLabel("リポジトリURL").fill("https://example.org/repo");
  await page.getByLabel("機能", { exact: true }).fill("資料を整理");
  await page.getByLabel("ライセンス", { exact: true }).fill("MIT");
  await page.getByLabel("採否理由").fill("小規模な導入が可能");
  await page.getByRole("checkbox", { name: /追加資料/ }).check();
  await page.getByRole("button", { name: "候補を保存" }).click();
  await expect(page.getByRole("cell", { name: /公開サンプル/ })).toBeVisible();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("採否", { exact: true }).selectOption("adopt");
  await page.getByRole("button", { name: "候補を保存" }).click();
  await expect(page.getByText("採用", { exact: true })).toBeVisible();
});
