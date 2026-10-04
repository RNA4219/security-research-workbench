import { test, expect } from "./fixtures.js";
import type { APIRequestContext } from "@playwright/test";
import type {
  DiagnosticRepository,
  DiagnosticRun,
  Product,
  ProductRunSummary,
} from "../../src/shared/product-diagnostics.js";

const headers = { "X-Workbench": "1" };

async function openRegistration(page: import("@playwright/test").Page) {
  await expect(
    page.getByRole("heading", { name: "製品の診断状況" }),
  ).toBeVisible();
  const titleField = page.getByLabel("製品名");
  await expect
    .poll(
      async () =>
        (await titleField.isVisible()) ||
        (await page
          .getByRole("button", { name: "製品を登録する" })
          .isVisible()),
    )
    .toBe(true);
  if (!(await titleField.isVisible())) {
    await page.getByRole("button", { name: "製品を登録する" }).click();
  }
}

async function runById(
  request: APIRequestContext,
  productId: string,
  runId: string,
) {
  const response = await request.get(
    `/api/products/${productId}/runs/${runId}`,
    { headers },
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as DiagnosticRun;
}

test("製品を直接登録し、Git版ごとの差分・修正後の要確認・手動照会をつなぐ", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "製品の診断状況" }),
  ).toBeVisible();
  await openRegistration(page);
  await page.getByLabel("製品名").fill("診断fixture製品");
  await page.getByLabel("管理下のリポジトリ").selectOption("fixture");
  await page.getByLabel("初回診断の対象版").fill("baseline");
  await page
    .getByLabel("製品の用途・仕様")
    .fill("TLS接続を行うクライアント。証明書検証は必須。");
  await expect(
    page.getByLabel("依存関係の公開情報照合を許可する"),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "製品と知識案件を作成" }).click();

  const productResponse = await request.get("/api/products", { headers });
  expect(productResponse.ok()).toBeTruthy();
  const products = (await productResponse.json()) as Product[];
  const product = products.find((item) => item.title === "診断fixture製品");
  expect(product).toBeDefined();
  expect(product!.linkedProjectId).toBeTruthy();

  await page.getByLabel("次の診断の対象版").fill("baseline");
  const firstRunResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/products/${product!.id}/runs`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "この版を診断する" }).click();
  const firstRun = (await (await firstRunResponse).json()) as DiagnosticRun;
  await expect
    .poll(async () => (await runById(request, product!.id, firstRun.id)).status)
    .toBe("partial");
  await expect(
    page.getByRole("heading", {
      name: "TLS証明書検証が無効です",
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("新しい指摘候補", { exact: true })).toBeVisible();
  await expect(
    page.getByText("src/client.ts:2", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".diagnostic-coverage").getByText("README.md", {
      exact: false,
    }),
  ).toBeVisible();

  const baseline = await runById(request, product!.id, firstRun.id);
  const initialFinding = baseline.findings.find(
    (finding) => finding.ruleId === "tls.reject-unauthorized-disabled",
  );
  expect(initialFinding).toBeDefined();
  expect(baseline.commit).toMatch(/^[a-f0-9]{40}$/u);
  expect(baseline.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(baseline)).not.toContain("new https.Agent");

  await page.getByLabel("次の診断の対象版").fill("updated");
  const updatedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/products/${product!.id}/runs`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "この版を診断する" }).click();
  const updatedRun = (await (await updatedResponse).json()) as DiagnosticRun;
  await expect
    .poll(
      async () => (await runById(request, product!.id, updatedRun.id)).status,
    )
    .toBe("partial");
  const continuing = await runById(request, product!.id, updatedRun.id);
  expect(continuing.previousRunId).toBe(firstRun.id);
  expect(
    continuing.findings.some(
      (finding) =>
        finding.fingerprint === initialFinding!.fingerprint &&
        finding.delta === "continuing",
    ),
  ).toBe(true);
  await expect(page.getByText("継続中の指摘", { exact: true })).toBeVisible();
  const runHistory = page.locator(".diagnostics-history");
  const baselineRunButton = runHistory.getByRole("button", {
    name: new RegExp(baseline.commit!.slice(0, 12), "u"),
  });
  await expect(baselineRunButton).toBeVisible();
  await baselineRunButton.click();
  await expect(
    page.locator(".diagnostic-run .diagnostic-metadata").first(),
  ).toContainText("初回");
  await runHistory
    .getByRole("button", {
      name: new RegExp(updatedRun.commit!.slice(0, 12), "u"),
    })
    .click();
  await expect(page.getByText("継続中の指摘", { exact: true })).toBeVisible();

  await page.getByLabel("次の診断の対象版").fill("fixed");
  const fixedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/products/${product!.id}/runs`) &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "この版を診断する" }).click();
  const fixedRun = (await (await fixedResponse).json()) as DiagnosticRun;
  await expect
    .poll(async () => (await runById(request, product!.id, fixedRun.id)).status)
    .toBe("partial");
  const fixed = await runById(request, product!.id, fixedRun.id);
  expect(fixed.previousRunId).toBe(updatedRun.id);
  expect(
    fixed.findings.some(
      (finding) =>
        finding.fingerprint === initialFinding!.fingerprint &&
        finding.delta === "not_observed",
    ),
  ).toBe(true);
  await expect(
    page.getByText("今回未検出・要確認", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("修正版であることや解決済みであることを自動確定しません。"),
  ).toBeVisible();
  const diagnosticScreenshot = testInfo.outputPath("product-diagnostics.png");
  await page.screenshot({ path: diagnosticScreenshot, fullPage: true });
  await testInfo.attach("product-diagnostics", {
    path: diagnosticScreenshot,
    contentType: "image/png",
  });
  await page
    .getByRole("button", { name: "根拠付きの質問を手動で確認する" })
    .click();
  await expect(page.getByLabel("実行内容")).toHaveValue(/src\/client\.ts/u);
  await expect(page.getByLabel("調査内容の区分")).toHaveValue("local");
  await expect(page.getByLabel("実行方式")).toHaveValue("manual");
  await expect(page.getByLabel("実行内容")).toHaveValue(/rejectUnauthorized/u);
  await expect(page.getByLabel("実行内容")).toHaveValue(
    new RegExp(fixed.commit!, "u"),
  );
  await page.getByRole("button", { name: /調査資料/ }).click();
  await page.getByRole("button", { name: /調査・判断・修正/ }).click();
  await expect(page.getByLabel("実行内容")).toHaveValue("");
});

test("定期診断は任意で、設定版を使って有効化・解除できる", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await openRegistration(page);
  await page.getByLabel("製品名").fill("定期設定fixture");
  await page.getByLabel("管理下のリポジトリ").selectOption("fixture");
  await page.getByLabel("初回診断の対象版").fill("baseline");
  await page.getByLabel("製品の用途・仕様").fill("定期診断設定を確認する");
  await page.getByRole("button", { name: "製品と知識案件を作成" }).click();
  let products = (await (
    await request.get("/api/products", { headers })
  ).json()) as Product[];
  const product = products.find((item) => item.title === "定期設定fixture");
  expect(product).toBeDefined();
  await expect(page.getByText("まだ診断していません")).toBeVisible();
  await expect(
    page.getByText("診断履歴はありません。", { exact: true }),
  ).toBeVisible();
  await page.getByText("製品の対象・診断設定").click();
  const concurrentUpdate = await request.post(
    `/api/products/${product!.id}/settings`,
    {
      headers,
      data: {
        revision: product!.revision,
        specification: "別画面で同時に更新した仕様",
      },
    },
  );
  expect(concurrentUpdate.ok()).toBeTruthy();
  await page.getByLabel("用途・仕様").fill("古い画面から上書きしない仕様");
  await page.getByRole("button", { name: "設定を保存する" }).click();
  await expect(page.getByRole("alert")).toContainText("設定が更新されました");
  await page.getByRole("button", { name: "最新状態を再読込" }).click();
  await expect(page.getByLabel("用途・仕様")).toHaveValue(
    "別画面で同時に更新した仕様",
  );
  await page.getByLabel("次回診断の対象版設定").fill("updated");
  await page.getByLabel("定期実行を有効にする").check();
  await page.getByLabel("実行間隔（5〜43200分）").fill("30");
  await page.getByRole("button", { name: "設定を保存する" }).click();
  products = (await (
    await request.get("/api/products", { headers })
  ).json()) as Product[];
  const updatedProduct = products.find((item) => item.id === product!.id);
  expect(updatedProduct?.schedule).toEqual({
    enabled: true,
    intervalMinutes: 30,
  });
  expect(updatedProduct?.ref).toBe("updated");
  const expectedNextRun = new Date(
    Date.parse(
      updatedProduct!.latestRun?.startedAt ?? updatedProduct!.updatedAt,
    ) +
      30 * 60_000,
  ).toLocaleString("ja-JP");
  await expect(page.getByRole("note")).toContainText(
    `次回の目安: ${expectedNextRun}`,
  );
  await expect(page.getByRole("note")).toContainText(
    "サーバー起動中に約1分ごとに確認します",
  );

  await page.getByLabel("実行間隔（5〜43200分）").fill("4");
  await expect(page.getByRole("note")).toContainText(
    "有効な実行間隔を入力してください",
  );
  await page.getByRole("button", { name: "設定を保存する" }).click();
  await expect(page.getByRole("note")).toContainText(
    "有効な実行間隔を入力してください",
  );
  const unchangedProducts = (await (
    await request.get("/api/products", { headers })
  ).json()) as Product[];
  expect(
    unchangedProducts.find((item) => item.id === product!.id)?.schedule,
  ).toEqual({ enabled: true, intervalMinutes: 30 });

  await page.getByLabel("実行間隔（5〜43200分）").fill("30");
  await page.getByLabel("定期実行を有効にする").uncheck();
  await expect(page.getByRole("note")).toHaveCount(0);
  await page.getByRole("button", { name: "設定を保存する" }).click();
  const updated = (await (
    await request.get("/api/products", { headers })
  ).json()) as Product[];
  expect(updated.find((item) => item.id === product!.id)?.schedule).toEqual({
    enabled: false,
    intervalMinutes: null,
  });
});

test("repo設定なしと初回通信不達を区別し、再読込後に登録を開ける", async ({
  page,
}) => {
  let unavailable = true;
  await page.route("**/api/diagnostics/repositories", (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { error: "一時的な接続失敗" } })
      : route.fulfill({
          json: [{ id: "fixture", name: "fixture", defaultRef: "baseline" }],
        }),
  );
  await page.route("**/api/products", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: [] })
      : route.continue(),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("一時的な接続失敗");
  await expect(page.getByRole("status")).toContainText("判断できていません");
  unavailable = false;
  await page.getByRole("button", { name: "もう一度読み込む" }).click();
  await expect(page.getByLabel("製品名")).toBeVisible();
  await expect(
    page.getByLabel("管理下のリポジトリ").locator("option"),
  ).toHaveCount(1);

  await page.route("**/api/diagnostics/repositories", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.reload();
  await expect(
    page.getByText("診断対象のリポジトリが設定されていません"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "製品を登録する" }),
  ).toBeDisabled();
  await expect(page.getByLabel("管理下のリポジトリ")).toHaveCount(0);
});

test("製品登録の通信失敗は入力と送信許可の選択を保持する", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/diagnostics/repositories", (route) =>
    route.fulfill({
      json: [{ id: "fixture", name: "fixture", defaultRef: "baseline" }],
    }),
  );
  await page.route("**/api/products", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [] });
    submitted = JSON.parse(route.request().postData() ?? "{}") as Record<
      string,
      unknown
    >;
    return route.fulfill({
      status: 503,
      json: { error: "製品を保存できませんでした" },
    });
  });
  await page.goto("/");
  await openRegistration(page);
  await page.getByLabel("製品名").fill("保存失敗を確認する製品");
  await page.getByLabel("管理下のリポジトリ").selectOption("fixture");
  await page.getByLabel("初回診断の対象版").fill("baseline");
  await page.getByLabel("製品の用途・仕様").fill("通信失敗後も保持する仕様");
  await page.getByLabel("依存関係の公開情報照合を許可する").check();
  await expect(
    page.getByText(/OSVへ送るのは公開npm依存名と版だけ/u),
  ).toBeVisible();
  await page.getByRole("button", { name: "製品と知識案件を作成" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "製品を保存できませんでした",
  );
  await expect(page.getByLabel("製品名")).toHaveValue("保存失敗を確認する製品");
  await expect(page.getByLabel("製品の用途・仕様")).toHaveValue(
    "通信失敗後も保持する仕様",
  );
  await expect(
    page.getByLabel("依存関係の公開情報照合を許可する"),
  ).toBeChecked();
  expect(submitted?.allowDependencyNetwork).toBe(true);
  expect(submitted?.repositoryId).toBe("fixture");
});

test("空白の対象版と不足した必須情報では登録を送信しない", async ({ page }) => {
  let createRequests = 0;
  await page.route("**/api/diagnostics/repositories", (route) =>
    route.fulfill({
      json: [{ id: "fixture", name: "fixture", defaultRef: "baseline" }],
    }),
  );
  await page.route("**/api/products", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: [] });
    createRequests += 1;
    return route.fulfill({
      status: 500,
      json: { error: "unexpected request" },
    });
  });
  await page.goto("/");
  await openRegistration(page);
  await page.getByLabel("製品名").fill("入力境界を確認する製品");
  const refField = page.getByLabel("初回診断の対象版");
  await refField.fill("   ");
  const submit = page.getByRole("button", { name: "製品と知識案件を作成" });
  await expect(submit).toBeDisabled();
  await refField.fill("baseline");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByLabel("製品の用途・仕様")).toBeFocused();
  expect(createRequests).toBe(0);
});

test("未診断製品の空履歴を保ち、診断開始と再読込の通信失敗を示す", async ({
  page,
}) => {
  const productId = "33333333-3333-4333-8333-333333333333";
  const timestamp = new Date().toISOString();
  let detailUnavailable = false;
  const product: Product = {
    id: productId,
    title: "未診断の通信境界fixture",
    repositoryId: "removed-repository",
    ref: "main",
    specification: "まだ診断を行っていない",
    allowDependencyNetwork: false,
    schedule: { enabled: false, intervalMinutes: null },
    revision: 1,
    diagnosticRevision: 1,
    linkedProjectId: "linked-unscanned-fixture",
    createdAt: timestamp,
    updatedAt: "invalid-time-from-corrupt-service-response",
    latestRun: null,
  };
  await page.route("**/api/diagnostics/repositories", (route) =>
    route.fulfill({
      json: [
        { id: "fixture", name: "fixture", defaultRef: "baseline" },
      ] satisfies DiagnosticRepository[],
    }),
  );
  await page.route("**/api/products", (route) =>
    route.fulfill({ json: [product] }),
  );
  await page.route(`**/api/products/${productId}`, (route) =>
    detailUnavailable
      ? route.fulfill({
          status: 503,
          json: { error: "最新状態の取得に失敗しました" },
        })
      : route.fulfill({ json: { product, runs: [] } }),
  );
  await page.route(`**/api/products/${productId}/runs`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "診断を開始できませんでした" },
    }),
  );

  await page.goto("/");
  await expect(page.getByText("まだ診断していません")).toBeVisible();
  await expect(
    page.getByText("診断履歴はありません。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/removed-repository/u)).toBeVisible();
  await page.getByText("製品の対象・診断設定").click();
  await page.getByLabel("定期実行を有効にする").check();
  await expect(page.getByRole("note")).toContainText(
    "次回の目安を計算できません",
  );
  await page.getByLabel("次の診断の対象版").fill("main");
  await page.getByRole("button", { name: "この版を診断する" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "診断を開始できませんでした",
  );
  await expect(page.getByText("まだ診断していません")).toBeVisible();

  detailUnavailable = true;
  await page.getByRole("button", { name: "最新状態を再読込" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "最新状態の取得に失敗しました",
  );
  await expect(
    page.getByText("診断履歴はありません。", { exact: true }),
  ).toBeVisible();
});

test("実行中runは停止・再開でき、失敗理由を表示する", async ({ page }) => {
  const productId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const timestamp = new Date().toISOString();
  let currentRun: DiagnosticRun = {
    id: runId,
    productId,
    revision: 1,
    status: "queued",
    trigger: "ci",
    requestId: "ci:fixture",
    ref: "baseline",
    commit: null,
    previousRunId: "33333333-3333-4333-8333-333333333333",
    manifestHash: null,
    snapshotFiles: [{ path: "package.json", hash: "c".repeat(64) }],
    snapshotOmitted: [{ path: "README.md", reason: "診断対象外" }],
    engineVersion: "0.1.0",
    allowDependencyNetwork: true,
    specificationRevision: 1,
    workflowRevision: 1,
    knowledge: [
      { id: "approved-knowledge", revision: 2, contentHash: "d".repeat(64) },
    ],
    rules: [{ id: "approved-rule", revision: 3, contentHash: "e".repeat(64) }],
    progress: {
      phase: "snapshot",
      message: "",
      updatedAt: timestamp,
    },
    statusHistory: [{ status: "queued", at: timestamp, reason: null }],
    coverage: [
      {
        engine: "static",
        status: "complete",
        assessed: 1,
        omitted: [],
        limitations: [],
      },
      {
        engine: "dependency",
        status: "unsupported",
        assessed: 0,
        omitted: [{ path: "package-lock.json", reason: "未対応形式" }],
        limitations: ["UI状態遷移用の固定応答"],
      },
    ],
    findings: [
      {
        fingerprint: "f".repeat(64),
        ruleId: "dependency.example-risk",
        engine: "dependency",
        title: "依存関係の確認候補",
        severity: "medium",
        path: "package-lock.json",
        line: 1,
        evidence: "公開アドバイザリとの照合候補",
        remediation: "更新可否を確認してください",
        advisoryUrl: "https://osv.dev/vulnerability/GHSA-test-fixture",
        delta: "new",
        presentInAnalysis: true,
        comparedToRunId: null,
        workflowFindingId: null,
        workflowUrl: null,
        workflowQuestion: "依存関係の候補を人が確認してください。",
        workflowQuestionClassification: "local",
      },
    ],
    startedAt: null,
    updatedAt: timestamp,
    finishedAt: null,
    failure: null,
  };
  const summary = (): ProductRunSummary => ({
    id: runId,
    status: currentRun.status,
    trigger: currentRun.trigger,
    commit: null,
    startedAt: currentRun.startedAt,
    finishedAt: currentRun.finishedAt,
    findingCounts: { new: 1, continuing: 0, needsReview: 0, notObserved: 0 },
    progress: currentRun.progress,
    incompleteCoverage: true,
  });
  const scheduledHistory: ProductRunSummary = {
    ...summary(),
    id: "44444444-4444-4444-8444-444444444444",
    status: "partial",
    trigger: "schedule",
    commit: "b".repeat(40),
    startedAt: "invalid-time-from-corrupt-service-response",
    finishedAt: timestamp,
    progress: {
      phase: "finished",
      message: "定期診断の履歴",
      updatedAt: timestamp,
    },
  };
  const scheduledRun: DiagnosticRun = {
    ...currentRun,
    id: scheduledHistory.id,
    status: "partial",
    trigger: "schedule",
    requestId: "schedule:fixture",
    commit: "b".repeat(40),
    previousRunId: null,
    manifestHash: "e".repeat(64),
    startedAt: timestamp,
    finishedAt: timestamp,
    progress: scheduledHistory.progress,
    statusHistory: [{ status: "partial", at: timestamp, reason: null }],
  };
  const product: Product = {
    id: productId,
    title: "状態遷移の契約fixture",
    repositoryId: "fixture",
    ref: "baseline",
    specification: "状態遷移を確認する",
    allowDependencyNetwork: true,
    schedule: { enabled: false, intervalMinutes: null },
    revision: 1,
    diagnosticRevision: 1,
    linkedProjectId: "project-contract-fixture",
    createdAt: timestamp,
    updatedAt: timestamp,
    latestRun: null,
  };
  product.latestRun = summary();
  await page.route("**/api/diagnostics/repositories", (route) =>
    route.fulfill({
      json: [
        {
          id: "fixture",
          name: "fixture",
          defaultRef: "baseline",
        } satisfies DiagnosticRepository,
      ],
    }),
  );
  await page.route("**/api/products", (route) => {
    product.latestRun = summary();
    return route.fulfill({ json: [product] });
  });
  await page.route(`**/api/products/${productId}`, (route) => {
    product.latestRun = summary();
    return route.fulfill({
      json: { product, runs: [summary(), scheduledHistory] },
    });
  });
  await page.route(`**/api/products/${productId}/runs/${runId}`, (route) =>
    route.fulfill({ json: currentRun }),
  );
  await page.route(
    `**/api/products/${productId}/runs/${scheduledHistory.id}`,
    (route) => route.fulfill({ json: scheduledRun }),
  );
  await page.route(
    `**/api/products/${productId}/runs/${runId}/stop`,
    (route) => {
      currentRun = {
        ...currentRun,
        revision: currentRun.revision + 1,
        status: "stopped",
        finishedAt: timestamp,
        statusHistory: [
          ...currentRun.statusHistory,
          { status: "stopped", at: timestamp, reason: "利用者が停止しました" },
        ],
        progress: {
          phase: "finished",
          message: "利用者が停止しました",
          updatedAt: timestamp,
        },
      };
      return route.fulfill({ json: currentRun });
    },
  );
  await page.route(
    `**/api/products/${productId}/runs/${runId}/resume`,
    (route) => {
      currentRun = {
        ...currentRun,
        revision: currentRun.revision + 1,
        status: "running",
        finishedAt: null,
        failure: null,
        statusHistory: [
          ...currentRun.statusHistory,
          { status: "running", at: timestamp, reason: "明示再開" },
        ],
        progress: {
          phase: "static",
          message: "同じ固定commitで再開",
          updatedAt: timestamp,
        },
      };
      return route.fulfill({ json: currentRun });
    },
  );
  await page.goto("/");
  await expect(
    page.getByText("開始待ち", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("対象版の固定前", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.locator(".diagnostics-history").getByText(/日時不明/u),
  ).toBeVisible();
  await expect(
    page.locator(".diagnostics-history").getByRole("button", {
      name: /定期実行/u,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "対象版を固定" }),
  ).toBeVisible();
  await expect(
    page.getByText("公開npm依存名・版のみOSV送信を許可"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "依存関係の確認候補" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "公開アドバイザリを確認 ↗" }),
  ).toHaveAttribute("href", "https://osv.dev/vulnerability/GHSA-test-fixture");
  await expect(
    page.getByText("指定範囲を解析", { exact: false }),
  ).toBeVisible();
  await expect(
    page.locator(".diagnostic-coverage h5").filter({ hasText: "未対応" }),
  ).toBeVisible();
  await page.getByText("診断の固定情報と知識版").click();
  await expect(page.getByText("CI", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/approved-knowledge · revision 2/u),
  ).toBeVisible();
  await expect(page.getByText(/approved-rule · revision 3/u)).toBeVisible();
  await expect(page.getByText("前回の指摘記録", { exact: false })).toHaveCount(
    0,
  );
  const runHistory = page.locator(".diagnostics-history");
  await runHistory.getByRole("button", { name: /定期実行/u }).click();
  await expect(page.getByRole("button", { name: "診断を再開" })).toBeVisible();
  const technicalDetails = page.locator(".diagnostic-technical-details");
  if (
    !(await technicalDetails.evaluate(
      (item) => (item as HTMLDetailsElement).open,
    ))
  )
    await technicalDetails.locator("summary").click();
  await expect(technicalDetails).toContainText("定期実行");
  await runHistory.getByRole("button", { name: /CI/u }).click();
  await expect(page.getByRole("button", { name: "診断を停止" })).toBeVisible();
  await page.getByRole("button", { name: "診断を停止" }).click();
  await expect(page.getByText("停止", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "診断を再開" }).click();
  await expect(page.getByText("診断中", { exact: true })).toBeVisible();

  currentRun = {
    ...currentRun,
    revision: currentRun.revision + 1,
    status: "failed",
    finishedAt: timestamp,
    failure: "固定commitの診断に失敗しました",
    statusHistory: [
      ...currentRun.statusHistory,
      {
        status: "failed",
        at: timestamp,
        reason: "固定commitの診断に失敗しました",
      },
    ],
    progress: {
      phase: "finished",
      message: "診断に失敗しました",
      updatedAt: timestamp,
    },
  };
  await page.getByRole("button", { name: "最新状態を再読込" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "固定commitの診断に失敗しました",
  );
  await expect(page.getByRole("button", { name: "診断を停止" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "診断を再開" })).toHaveCount(0);
});
