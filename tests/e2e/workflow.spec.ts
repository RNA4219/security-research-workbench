import { test, expect } from "./fixtures.js";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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
  const projectTitle = `サンプル回帰-${randomUUID()}`;
  await page.getByRole("button", { name: /設定・連携/ }).click();
  await page.getByLabel("プロジェクト名", { exact: true }).fill(projectTitle);
  await page.getByRole("button", { name: "設定を保存" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await page.getByRole("button", { name: /01調査資料/ }).click();
  await page.getByRole("checkbox", { name: /Trivy/ }).check();
  await page
    .getByRole("button", { name: "プロンプトを作成", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("レビュー");
  await page.getByRole("button", { name: /◎根拠と主張/ }).click();
  for (const i of [0, 1]) {
    await page
      .getByRole("button", { name: "根拠を編集", exact: true })
      .nth(i)
      .click();
    await page
      .getByLabel("根拠の確認状態", { exact: true })
      .selectOption("verified");
    await page.getByRole("button", { name: "根拠を保存", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("保存しました");
  }
  await page.getByRole("button", { name: /02OSS比較/ }).click();
  for (const name of ["Trivy", "OSV-Scanner"]) {
    const candidate = page.getByRole("article", { name: `${name}の根拠` });
    for (const field of ["機能", "ライセンス", "保守状況"]) {
      const editor = candidate
        .locator(".claim-editor")
        .filter({ has: page.getByText(`${field}を編集`, { exact: true }) });
      await editor.getByText(`${field}を編集`, { exact: true }).click();
      await editor
        .getByLabel("主張の確認状態", { exact: true })
        .selectOption("verified");
      await editor.getByRole("button", { name: "主張を保存" }).click();
      await expect(page.getByRole("status")).toContainText("保存しました");
    }
    await candidate
      .getByRole("button", { name: "比較を承認", exact: true })
      .click();
    await expect(
      candidate.getByText("比較: 承認済み", { exact: true }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: /01調査資料/ }).click();
  await page
    .getByRole("button", { name: "プロンプトを作成", exact: true })
    .click();
  await expect(page.getByLabel("生成したプロンプト")).toContainText(
    "回答JSON Schema",
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "プロンプトをコピー" }).click();
  await expect(page.getByRole("status")).toContainText("コピーしました");
  expect(
    (await page.evaluate(() => navigator.clipboard.readText())).replaceAll(
      "\r\n",
      "\n",
    ),
  ).toBe(await page.getByLabel("生成したプロンプト").inputValue());
  await page.getByRole("button", { name: /02OSS比較/ }).click();
  await expect(
    page.getByRole("cell", { name: "Apache-2.0" }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /03要件とレビュー/ }).click();
  await page.getByText("レビュー状態と判断履歴", { exact: true }).click();
  for (const [status, label] of [
    ["needs_evidence", "根拠不足"],
    ["needs_revision", "修正要求"],
    ["rejected", "却下"],
  ]) {
    await page.getByLabel("レビュー状態", { exact: true }).selectOption(status);
    await page.getByLabel("判断理由", { exact: true }).fill(`${label}の確認`);
    await page.getByRole("button", { name: "レビューを記録" }).click();
    await expect(page.locator(".requirement-card .status")).toHaveText(label);
  }
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
  const downloaded = await result;
  expect(downloaded.suggestedFilename()).toBe("workbench-contracts.json");
  const contract = JSON.parse(readFileSync((await downloaded.path())!, "utf8"));
  expect(contract.kind).toBe("WorkbenchTaskContract");
  expect(contract.claims).toHaveLength(2);
  expect(contract.evidence).toHaveLength(2);
  await page.getByRole("button", { name: /01調査資料/ }).click();
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Trivy / 公開概要" }) })
    .getByRole("button", { name: "編集" })
    .click();
  await page.getByLabel("資料の版", { exact: true }).fill("2");
  await page.getByRole("button", { name: "資料を保存" }).click();
  await page.getByRole("button", { name: /03要件とレビュー/ }).click();
  await expect(page.locator(".requirement-card .status")).toHaveText(
    "再確認が必要",
  );
  await page.reload();
  await page.getByRole("button", { name: new RegExp(projectTitle) }).click();
  await page.getByRole("button", { name: /03要件とレビュー/ }).click();
  await expect(page.locator(".requirement-card .status")).toHaveText(
    "再確認が必要",
  );
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
  await page.getByRole("textbox", { name: "回答JSON", exact: true }).fill(
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
  await page.locator("input[type=file]").setInputFiles({
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
  await page.locator("input[type=file]").setInputFiles({
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
  await expect(page.locator(".status.adopt")).toHaveText("採用");
});

test("比較値の未確認・値なし、複数Evidence、逆参照とオフライン操作", async ({
  page,
  context,
}) => {
  const outbound: string[] = [];
  await context.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1")
      return route.continue();
    outbound.push(route.request().url());
    return route.abort();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "サンプルで試す" }).click();
  await page.getByRole("button", { name: /◎根拠と主張/ }).click();
  await expect(page.getByText(/参照する要件: REQ-001/).first()).toBeVisible();
  await page.getByRole("button", { name: /02OSS比較/ }).click();
  const candidate = page.getByRole("article", { name: "Trivyの根拠" });
  const release = candidate
    .locator(".claim-row")
    .filter({ has: page.getByText("リリースを編集", { exact: true }) });
  await release.getByText("リリースを編集", { exact: true }).click();
  await release.getByLabel("値の状態").selectOption("unknown");
  await release.getByRole("button", { name: "主張を保存" }).click();
  await expect(release.locator(".trace summary")).toContainText("未確認");
  await release.getByLabel("値の状態").selectOption("empty");
  await release.getByRole("button", { name: "主張を保存" }).click();
  await expect(release.locator(".trace summary")).toContainText("値なし");
  const feature = candidate
    .locator(".claim-row")
    .filter({ has: page.getByText("機能を編集", { exact: true }) });
  await feature.getByText("機能を編集", { exact: true }).click();
  await feature.getByRole("checkbox").nth(1).check();
  await feature.getByRole("button", { name: "主張を保存" }).click();
  await feature.locator(".trace summary").click();
  await expect(feature.locator(".trace a")).toHaveCount(2);
  await page.getByRole("button", { name: /04出力/ }).click();
  const result = page.waitForEvent("download");
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "要件定義 Markdown" }) })
    .getByRole("button")
    .click();
  const md = readFileSync((await (await result).path())!, "utf8");
  expect(md).toContain("https://github.com/aquasecurity/trivy");
  expect(md).toContain("https://github.com/google/osv-scanner");
  expect(md).toContain("値なし");
  expect(outbound).toEqual([]);
  await page.getByRole("button", { name: /02OSS比較/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: ".cache/screenshots/provenance-comparison.png",
    fullPage: true,
  });
});
