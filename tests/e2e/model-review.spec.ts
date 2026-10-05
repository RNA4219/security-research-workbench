import { test, expect } from "./fixtures.js";
import type {
  DiagnosticRun,
  Product,
} from "../../src/shared/product-diagnostics.js";
import type {
  WorkflowCommand,
  WorkflowState,
} from "../../src/shared/workflow.js";

test("AIレビューを明示して開始し、固定版の根拠・モデル・参照記録を確認できる", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "製品の診断状況" }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await page.getByLabel("製品名").isVisible()) ||
        (await page
          .getByRole("button", { name: "製品を登録する" })
          .isVisible()),
    )
    .toBe(true);
  if (!(await page.getByLabel("製品名").isVisible()))
    await page.getByRole("button", { name: "製品を登録する" }).click();
  const form = page.locator(".diagnostics-create");
  await form.getByLabel("製品名").fill("AIレビュー画面の検証");
  await form.getByLabel("初回診断の対象版").fill("baseline");
  await form
    .getByLabel("製品の用途・仕様")
    .fill("TLS接続の証明書検証を必須とする製品。");
  const enable = form.getByLabel("ローカルモデルでコードをレビューする");
  await expect(enable).not.toBeChecked();
  await form.getByLabel("AIレビューのモデル").selectOption("local");
  await enable.check();
  const creating = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/products") &&
      response.request().method() === "POST",
  );
  await form.getByRole("button", { name: "製品と知識案件を作成" }).click();
  const product = (await (await creating).json()) as Product;
  const workflowUrl = `/api/projects/${product.linkedProjectId}/workflow`;
  const headers = { "X-Workbench": "1" };
  let workflow = (await (
    await request.get(workflowUrl, { headers })
  ).json()) as WorkflowState;
  const specification = workflow.documents.find(
    (document) => document.title === "製品仕様",
  )!;
  const draftResponse = await request.post(`${workflowUrl}/commands`, {
    headers,
    data: {
      revision: workflow.revision,
      command: {
        type: "knowledge-draft",
        purpose: workflow.scope.purpose,
        content:
          "TLS設定の確認では証明書検証を確認する（UI試験用の承認済み知識）。",
        sourceRefs: [
          {
            docId: specification.id,
            revision: specification.revision,
            excerpt: "証明書検証を必須",
          },
        ],
      },
    },
  });
  expect(draftResponse.ok()).toBeTruthy();
  workflow = (await draftResponse.json()) as WorkflowState;
  const knowledgeId = workflow.knowledge[0]!.id;
  const approved = await request.post(`${workflowUrl}/commands`, {
    headers,
    data: {
      revision: workflow.revision,
      command: {
        type: "knowledge-review",
        knowledgeId,
        decision: "active",
        actor: "UI試験担当者",
        reason: "原文と照合する試験用の知識。",
      },
    },
  });
  expect(approved.ok()).toBeTruthy();
  await page.getByRole("button", { name: "この版を診断する" }).click();
  await expect(
    page.getByRole("heading", { name: "製品仕様と通信設定の照合候補" }),
  ).toBeVisible({ timeout: 15000 });
  const evidence = page.getByRole("region", { name: "AIレビューの記録" });
  await expect(evidence).toContainText("UI契約試験用の固定応答");
  await expect(evidence).toContainText("123 / 45");
  await evidence.locator("summary").click();
  await expect(evidence).toContainText(knowledgeId);
  await expect(evidence).toContainText("製品仕様 revision");
  await expect(evidence).toContainText("入力ハッシュ");
  await page.getByText("AIが参照した仕様・過去の判断", { exact: true }).click();
  await expect(
    page.getByText(
      "過去の判断を参照していても、今回の指摘は人の確認が必要です。",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "診断を再開", exact: true }).click();
  await expect(evidence).toContainText("あり");
  const settings = page.locator(".diagnostics-settings");
  await settings.locator("summary").click();
  await expect(
    settings.getByLabel("ローカルモデルでコードをレビューする"),
  ).toBeChecked();
  await settings.getByLabel("ローカルモデルでコードをレビューする").uncheck();
  await settings.getByRole("button", { name: "設定を保存する" }).click();
  await expect(
    page.getByText("製品設定を保存しました。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "最新状態を再読込" }).click();
  await expect(
    settings.getByLabel("ローカルモデルでコードをレビューする"),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "製品を登録する", exact: true })
    .click();
  await expect(
    form.getByLabel("ローカルモデルでコードをレビューする"),
  ).not.toBeChecked();
});

test("モデルが診断結果の代わりにSchemaを返しても未診断を表示する", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/products", {
    headers: { "X-Workbench": "1" },
    data: {
      title: "モデル応答の異常を確認",
      repositoryId: "fixture",
      ref: "baseline",
      specification: "UI_BAD_RESPONSE: 画面の不正応答表示を確認する。",
      modelReview: { enabled: true, providerId: "local", cloudConsent: false },
    },
  });
  expect(created.ok()).toBeTruthy();
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "登録済み製品" })
    .getByRole("button", { name: /モデル応答の異常を確認/ })
    .click();
  await page
    .getByRole("button", { name: "この版を診断する", exact: true })
    .click();
  const evidence = page.getByRole("region", { name: "AIレビューの記録" });
  await expect(evidence).toContainText("レビューできませんでした", {
    timeout: 15000,
  });
  await expect(evidence).toContainText("model responseのJSON schemaが不正");
  await expect(
    page.getByRole("heading", { name: "TLS証明書検証が無効です" }),
  ).toBeVisible();
});

test("モデル工程を停止すると未レビューを残し、再開で結果を確認できる", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/products", {
    headers: { "X-Workbench": "1" },
    data: {
      title: "モデル工程の停止と再開",
      repositoryId: "fixture",
      ref: "baseline",
      specification: "UI_DELAY_MODEL: TLS接続の証明書検証を必須とする。",
      modelReview: { enabled: true, providerId: "local", cloudConsent: false },
    },
  });
  expect(created.ok()).toBeTruthy();
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "登録済み製品" })
    .getByRole("button", { name: /モデル工程の停止と再開/ })
    .click();
  await page
    .getByRole("button", { name: "この版を診断する", exact: true })
    .click();
  const evidence = page.getByRole("region", { name: "AIレビューの記録" });
  await expect(evidence).toContainText("レビュー待ち・実行中");
  await expect(
    page.getByRole("heading", {
      name: "製品仕様とコードをAIでレビューしています",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "診断を停止", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "診断を再開", exact: true }),
  ).toBeVisible();
  await expect(evidence).not.toContainText("指定範囲のレビュー完了");
  await page.getByRole("button", { name: "診断を再開", exact: true }).click();
  await expect(evidence).toContainText("指定範囲のレビュー完了", {
    timeout: 15000,
  });
  await expect(
    page.getByRole("heading", { name: "製品仕様と通信設定の照合候補" }),
  ).toBeVisible();
});

test("モデルが利用量を返さないときはゼロではなく未計測と表示する", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/products", {
    headers: { "X-Workbench": "1" },
    data: {
      title: "モデル利用量の欠測",
      repositoryId: "fixture",
      ref: "baseline",
      specification: "UI_NO_USAGE: TLS接続の証明書検証を必須とする。",
      modelReview: { enabled: true, providerId: "local", cloudConsent: false },
    },
  });
  expect(created.ok()).toBeTruthy();
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "登録済み製品" })
    .getByRole("button", { name: /モデル利用量の欠測/ })
    .click();
  await page
    .getByRole("button", { name: "この版を診断する", exact: true })
    .click();
  const evidence = page.getByRole("region", { name: "AIレビューの記録" });
  await expect(evidence).toContainText("指定範囲のレビュー完了", {
    timeout: 15000,
  });
  await expect(evidence).toContainText("未計測 / 未計測");
});

test("人が確認した同条件の指摘は折りたたみ、対象版変更で確認待ちに戻す", async ({
  page,
  request,
}, testInfo) => {
  const headers = { "X-Workbench": "1" };
  const created = await request.post("/api/products", {
    headers,
    data: {
      title: "人の判断を使う継続診断",
      repositoryId: "fixture",
      ref: "baseline",
      specification: "TLS接続の証明書検証を必須とする。UI契約試験用。",
      modelReview: { enabled: true, providerId: "local", cloudConsent: false },
    },
  });
  expect(created.ok()).toBeTruthy();
  const product = (await created.json()) as Product;
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "登録済み製品" })
    .getByRole("button", { name: /人の判断を使う継続診断/ })
    .click();
  async function diagnose() {
    const response = page.waitForResponse(
      (value) =>
        value.url().endsWith(`/api/products/${product.id}/runs`) &&
        value.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "この版を診断する", exact: true })
      .click();
    const started = (await (await response).json()) as DiagnosticRun;
    let run = started;
    await expect
      .poll(async () => {
        run = (await (
          await request.get(`/api/products/${product.id}/runs/${started.id}`, {
            headers,
          })
        ).json()) as DiagnosticRun;
        return run.status;
      })
      .toBe("partial");
    await page
      .getByRole("button", { name: "最新状態を再読込", exact: true })
      .click();
    return run;
  }
  const first = await diagnose();
  const candidate = first.findings.find((item) => item.engine === "model")!;
  expect(candidate.workflowFindingId).toBeTruthy();
  const workflowUrl = `/api/projects/${product.linkedProjectId}/workflow`;
  let state = (await (
    await request.get(workflowUrl, { headers })
  ).json()) as WorkflowState;
  async function command(command: WorkflowCommand) {
    const result = await request.post(`${workflowUrl}/commands`, {
      headers,
      data: { revision: state.revision, command },
    });
    expect(result.ok(), await result.text()).toBeTruthy();
    state = (await result.json()) as WorkflowState;
  }
  const finding = state.findings.find(
    (item) => item.id === candidate.workflowFindingId,
  )!;
  await command({
    type: "finding-decision",
    findingId: finding.id,
    judgment: "false_positive",
    actor: "UI試験担当者",
    reason:
      "固定応答による人工候補であることを確認した。実製品の判断ではない。",
    targetVersion: first.commit!,
    sourceRefs: finding.sourceRefs,
    ruleRefs: [],
  });
  await command({
    type: "suppression",
    findingId: finding.id,
    actor: "UI試験担当者",
    reason: "同じ条件の人工候補をこの試験期間のみ再確認不要とする。",
    targetVersion: first.commit!,
    fingerprint: finding.fingerprint,
    ruleRefs: [],
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const repeated = await diagnose();
  expect(
    repeated.findings.find((item) => item.engine === "model")
      ?.reviewDisposition,
  ).toBe("suppressed_human");
  const collapsed = page.locator(".diagnostic-suppressed");
  await expect(collapsed).toHaveCount(1);
  await expect(
    collapsed.getByRole("heading", { name: "製品仕様と通信設定の照合候補" }),
  ).not.toBeVisible();
  await collapsed.locator(":scope > summary").click();
  await expect(collapsed).toContainText("この診断では人の判断を再利用しました");
  await collapsed.locator(":scope > summary").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("human-judgment-reuse.png"),
    fullPage: true,
  });
  await page.getByLabel("次の診断の対象版").fill("updated");
  const changed = await diagnose();
  expect(
    changed.findings.find((item) => item.engine === "model")?.reviewDisposition,
  ).toBe("confirmation_required");
  await expect(page.locator(".diagnostic-suppressed")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "製品仕様と通信設定の照合候補" }),
  ).toBeVisible();
});

test("モデル情報の取得失敗時も製品画面を使え、有効化を誤表示しない", async ({
  page,
}) => {
  await page.route("**/api/model-review/providers", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"message":"unavailable"}',
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "製品の診断状況" }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await page.getByLabel("製品名").isVisible()) ||
        (await page
          .getByRole("button", { name: "製品を登録する" })
          .isVisible()),
    )
    .toBe(true);
  if (!(await page.getByLabel("製品名").isVisible()))
    await page.getByRole("button", { name: "製品を登録する" }).click();
  const form = page.locator(".diagnostics-create");
  await expect(form).toContainText("AIモデルの接続情報を取得できませんでした");
  await expect(
    form.getByLabel("ローカルモデルでコードをレビューする"),
  ).toBeDisabled();
  await expect(form).toContainText("WORKFLOW_LOCAL_URL");
});
