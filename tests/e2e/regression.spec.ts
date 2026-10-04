import { test, expect } from "./fixtures.js";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

async function newProject(page: Page) {
  const title = `回帰-${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  await page.getByRole("button", { name: "プロジェクトを作成 →" }).click();
  await page.getByLabel("プロジェクト名", { exact: true }).fill(title);
  await page.getByLabel("目的", { exact: true }).fill("保存と根拠を検証");
  await page.getByLabel("対象利用者").fill("開発者");
  await page.getByLabel("対象範囲", { exact: true }).fill("ローカル");
  await page.getByLabel("対象外", { exact: true }).fill("自動実行");
  await page.getByLabel("制約・対象外").fill("公開資料");
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  return title;
}
async function sourceForm(page: Page) {
  await page.getByRole("button", { name: "＋ 資料を追加" }).click();
  await page.getByLabel("資料名", { exact: true }).fill("回帰の資料");
  await page.getByLabel("出典URL").fill("https://example.org/regression");
  await page.getByLabel("取得日時（UTC）").fill("2026-10-03T00:00:00.000Z");
  await page
    .getByLabel("資料本文")
    .fill("# 一次資料\n[説明](https://example.org/docs)\n根拠を確認する");
}

test("接続失敗でも入力を保持し、自動再送せず手動再試行で1件保存", async ({
  page,
}) => {
  const title = await newProject(page);
  await sourceForm(page);
  let posts = 0;
  await page.route("**/api/projects/*/commands", (route) => {
    posts++;
    return route.abort("connectionfailed");
  });
  await page.getByRole("button", { name: "資料を保存" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "ローカルサーバーに接続できません",
  );
  await expect(page.getByLabel("資料名", { exact: true })).toHaveValue(
    "回帰の資料",
  );
  await expect(page.getByLabel("資料本文")).toContainText("一次資料");
  await page.getByRole("alert").getByRole("button", { name: "閉じる" }).click();
  expect(posts).toBe(1);
  await page.unroute("**/api/projects/*/commands");
  await page.getByRole("button", { name: "資料を保存" }).click();
  await expect(page.getByRole("heading", { name: "回帰の資料" })).toHaveCount(
    1,
  );
  await page.getByText("本文・出典IDを見る").click();
  await expect(page.locator(".markdown a")).toHaveAttribute(
    "rel",
    "noreferrer",
  );
  await page.reload();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.getByRole("heading", { name: "回帰の資料" })).toHaveCount(
    1,
  );
});

test("2画面の保存競合は上書きせず、編集内容を残す", async ({
  page,
  context,
}) => {
  const title = await newProject(page),
    other = await context.newPage();
  await other.goto("/");
  await other.getByRole("button", { name: new RegExp(title) }).click();
  for (const p of [page, other])
    await p.getByRole("button", { name: /設定・連携/ }).click();
  await page.getByLabel("目的", { exact: true }).fill("先に保存した目的");
  await page.getByRole("button", { name: "設定を保存" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");
  await other.getByLabel("目的", { exact: true }).fill("競合する入力");
  await other.getByRole("button", { name: "設定を保存" }).click();
  await expect(other.getByRole("alert")).toContainText("別の画面");
  await expect(other.getByLabel("目的", { exact: true })).toHaveValue(
    "競合する入力",
  );
  await page.reload();
  await page.getByRole("button", { name: new RegExp(title) }).click();
  await expect(page.locator(".project-head")).toContainText("先に保存した目的");
});

test("ファイル上限・不正JSON・API入力エラーから修正して保存できる", async ({
  page,
}) => {
  await newProject(page);
  await sourceForm(page);
  const upload = page.locator("input[type=file]");
  await upload.setInputFiles([]);
  await upload.setInputFiles({
    name: "too-big.md",
    mimeType: "text/markdown",
    buffer: Buffer.alloc(1_500_001, "x"),
  });
  await expect(page.getByRole("alert")).toContainText("1.5MB以下");
  await upload.setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("broken"),
  });
  await expect(page.locator(".alert")).toBeVisible();
  await page.locator(".alert").getByRole("button", { name: "閉じる" }).click();
  await page.getByLabel("取得日時（UTC）").fill("invalid-date");
  await page.getByRole("button", { name: "資料を保存" }).click();
  await expect(page.locator(".alert")).toContainText(
    "command.value.retrievedAt",
  );
  await page.getByLabel("取得日時（UTC）").fill("2026-10-03T00:00:00.000Z");
  await page.getByRole("button", { name: "資料を保存" }).click();
  await expect(page.getByRole("heading", { name: "回帰の資料" })).toBeVisible();
  await page.getByRole("button", { name: "＋ 資料を追加" }).click();
  await page
    .locator(".panel")
    .filter({ has: page.getByRole("heading", { name: "資料を取り込む" }) })
    .getByRole("button", { name: "閉じる" })
    .click();
  await expect(page.getByLabel("資料本文")).toHaveCount(0);
});

test("根拠を新規登録・編集し、比較レビューと要件編集へ反映する", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "サンプルで試す" }).click();
  await page.getByRole("button", { name: /◎根拠と主張/ }).click();
  await page
    .getByLabel("根拠の資料")
    .selectOption({ label: "OSV-Scanner / 公開概要" });
  await page.getByLabel("資料種別").selectOption("report");
  await page.getByLabel("根拠の抜粋・要約").fill("追加した確認根拠");
  await page.getByLabel("根拠の確認状態").selectOption("verified");
  await page.getByRole("button", { name: "根拠を保存" }).click();
  await expect(
    page.getByRole("heading", { name: "追加した確認根拠" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新しい根拠" }).click();
  await expect(page.getByLabel("根拠の抜粋・要約")).toHaveValue("");
  await page.getByRole("button", { name: /02OSS比較/ }).click();
  const candidate = page.getByRole("article", { name: "Trivyの根拠" });
  await candidate.getByText("レビュー状態と判断履歴", { exact: true }).click();
  await candidate
    .getByLabel("レビュー状態", { exact: true })
    .selectOption("needs_revision");
  await candidate
    .getByLabel("判断理由", { exact: true })
    .fill("追加根拠を確認する");
  await candidate.getByRole("button", { name: "レビューを記録" }).click();
  await expect(
    candidate.getByText("比較: 修正要求", { exact: true }),
  ).toBeVisible();
  const editor = candidate
    .locator(".claim-editor")
    .filter({ has: page.getByText("機能を編集", { exact: true }) });
  await editor.getByText("機能を編集", { exact: true }).click();
  await editor.getByLabel("比較値").fill("資料を比較する機能");
  await editor.getByRole("checkbox").first().uncheck();
  await editor.getByRole("checkbox", { name: /追加した確認根拠/ }).check();
  await editor.getByRole("button", { name: "主張を保存" }).click();
  await expect(candidate).toContainText("資料を比較する機能");
  await page.getByRole("button", { name: /03要件とレビュー/ }).click();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByLabel("要件の説明").fill("根拠の比較結果を保存");
  await page.getByLabel("優先度", { exact: true }).selectOption("critical");
  const choices = page.getByRole("group", { name: "根拠となる主張" });
  const selected = choices.locator("input:checked");
  while (await selected.count()) await selected.first().uncheck();
  await choices.getByRole("checkbox").first().check();
  await choices.getByRole("checkbox").first().uncheck();
  await page.getByLabel("利用者判断・補足理由").fill("利用者の要望");
  await page.getByLabel("受入条件（1行に1件）").fill("保存できる\n復元できる");
  await page.getByLabel("実装タスク（1行に1件）").fill("保存処理\n復元処理");
  await page.getByRole("button", { name: "要件を保存" }).click();
  await expect(page.locator(".requirement-card")).toContainText("critical");
  await page.getByRole("button", { name: "確認して承認" }).click();
  await expect(
    page.getByRole("button", { name: "未レビューに戻す" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "未レビューに戻す" }).click();
  await expect(page.locator(".requirement-card .status")).toHaveText(
    "未レビュー",
  );
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page
    .locator(".panel")
    .filter({ has: page.getByRole("heading", { name: /REQ-001 を編集/ }) })
    .getByRole("button", { name: "閉じる" })
    .click();
});

test("未設定連携・出力失敗・全データ出力と履歴閲覧", async ({ page }) => {
  const title = await newProject(page);
  await page.getByRole("button", { name: /◎根拠と主張/ }).click();
  await expect(page.getByRole("button", { name: "根拠を保存" })).toBeDisabled();
  await page.getByRole("button", { name: /02OSS比較/ }).click();
  await page.getByRole("button", { name: "＋ 候補を追加" }).click();
  await expect(page.getByText("資料を登録すると選択できます。")).toBeVisible();
  await page
    .locator(".panel")
    .filter({ has: page.getByRole("heading", { name: "OSS候補を編集" }) })
    .getByRole("button", { name: "閉じる" })
    .click();
  await page.getByRole("button", { name: /設定・連携/ }).click();
  await expect(
    page.getByText("起動時に MEMX_URL を設定すると利用できます。"),
  ).toBeVisible();
  await page.getByRole("button", { name: /04出力/ }).click();
  const adapter = page.getByRole("article").filter({
    has: page.getByRole("heading", {
      name: "agent-protocols変換（任意）",
      exact: true,
    }),
  });
  await adapter.getByRole("button").click();
  await expect(page.getByRole("alert")).toContainText(
    "承認済み要件がありません",
  );
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "プロジェクト JSON" }) })
    .getByRole("button")
    .click();
  expect(
    JSON.parse(readFileSync((await (await downloaded).path())!, "utf8")).title,
  ).toBe(title);
  await page.getByRole("button", { name: /↺履歴/ }).click();
  await page.getByRole("button", { name: "REV 1", exact: true }).click();
  await expect(page.locator("pre.panel")).toContainText(title);
  await page.getByText(/出力記録 ·/).click();
  await expect(page.locator("details[open] pre")).toContainText(title);
});

test("memxの画面操作契約と失敗表示（依存APIをスタブ）", async ({ page }) => {
  const actions: string[] = [];
  await page.route("**/api/config", (route) =>
    route.fulfill({ json: { memx: true } }),
  );
  await page.route("**/api/projects/*/memx", (route) => {
    const { action } = route.request().postDataJSON();
    actions.push(action);
    return action === "ack"
      ? route.fulfill({
          status: 502,
          json: { error: "連携先を確認してください" },
        })
      : route.fulfill({ json: { action, status: "fresh" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "サンプルで試す" }).click();
  await page.getByRole("button", { name: /設定・連携/ }).click();
  for (const name of ["資料を同期", "鮮度を確認"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".workspace pre")).toContainText("fresh");
  }
  await page.getByLabel("知識を検索").fill("依存関係");
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.locator(".workspace pre")).toContainText("search");
  await page.getByRole("button", { name: "参照", exact: true }).first().click();
  await expect(page.locator(".workspace pre")).toContainText("chunks");
  await page.getByRole("button", { name: "読了を記録" }).first().click();
  await expect(page.getByRole("alert")).toContainText(
    "連携先を確認してください",
  );
  expect(actions).toEqual(["sync", "stale", "search", "chunks", "ack"]);
});

test("初期読込失敗を表示し、再読込で復帰する", async ({ page }) => {
  await page.route("**/api/projects", (route) =>
    route.abort("connectionfailed"),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("接続できません");
  await page.unroute("**/api/projects");
  await page.getByRole("button", { name: "再読込 ↻" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "サンプルで試す" }),
  ).toBeVisible();
});

test("回答ファイルの上限と修正取込、保存済みプロジェクトの再読込", async ({
  page,
}) => {
  const title = await newProject(page);
  await page.getByRole("button", { name: "再読込 ↻" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("最新の状態");
  await page.getByRole("button", { name: /03要件とレビュー/ }).click();
  const file = page.getByLabel("回答JSONファイル");
  await file.setInputFiles({
    name: "large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(1_500_001, "a"),
  });
  await expect(page.getByRole("alert")).toContainText("1.5MB以下");
  await expect(page.getByLabel("回答JSON", { exact: true })).toHaveValue("");
  await file.setInputFiles([]);
  const raw = JSON.stringify({
    schemaVersion: "1.0",
    requirements: [
      {
        id: "REQ-FILE",
        title: "回答ファイル",
        description: "正常な回答の保存",
        priority: "high",
        sourceIds: [],
        claimIds: [],
        rationale: "利用者判断",
        acceptance: ["保存できる"],
        tasks: ["確認する"],
      },
    ],
  });
  await file.setInputFiles({
    name: "reply.json",
    mimeType: "application/json",
    buffer: Buffer.from(raw),
  });
  await expect(page.getByLabel("回答JSON", { exact: true })).toHaveValue(raw);
  await page.getByRole("button", { name: "回答を取り込む" }).click();
  await expect(
    page.getByRole("heading", { name: "回答ファイル", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".requirement-card .status")).toHaveText(
    "未レビュー",
  );
});
