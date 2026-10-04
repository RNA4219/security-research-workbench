import { test, expect } from "./fixtures.js";
import type {
  DiagnosticRun,
  Product,
} from "../../src/shared/product-diagnostics.js";

test("保存済み結果の上限停止・対象なし・不完全な抑止情報を成功や確認不要にしない", async ({
  page,
  request,
}) => {
  const headers = { "X-Workbench": "1" };
  const created = await request.post("/api/products", {
    headers,
    data: {
      title: "保存済みAI結果の表示契約",
      repositoryId: "fixture",
      ref: "baseline",
      specification: "TLSの証明書検証を必須とする。",
      modelReview: { enabled: true, providerId: "local", cloudConsent: false },
    },
  });
  expect(created.ok()).toBeTruthy();
  const product = (await created.json()) as Product;
  const started = await request.post(`/api/products/${product.id}/runs`, {
    headers,
    data: { trigger: "manual", ref: "baseline" },
  });
  expect(started.ok()).toBeTruthy();
  let stored = (await started.json()) as DiagnosticRun;
  const runPath = `/api/products/${product.id}/runs/${stored.id}`;
  await expect
    .poll(async () => {
      stored = (await (
        await request.get(runPath, { headers })
      ).json()) as DiagnosticRun;
      return stored.status;
    })
    .toBe("partial");
  expect(stored.modelReview?.record).toBeTruthy();

  // Use a real persisted result as the base, then simulate old/partial API
  // records. This tests UI interpretation, not model accuracy or the engine.
  let displayed = structuredClone(stored);
  displayed.modelReview!.record!.stopReason = "max_budgets";
  displayed.modelReview!.coverage.status = "partial";
  const modelFinding = displayed.findings.find(
    (finding) => finding.engine === "model",
  )!;
  modelFinding.reviewDisposition = "suppressed_human";
  delete modelFinding.suppression;
  await page.route(`**${runPath}`, (route) =>
    route.fulfill({ json: displayed }),
  );
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "登録済み製品" })
    .getByRole("button", { name: /保存済みAI結果の表示契約/ })
    .click();
  const evidence = page.getByRole("region", { name: "AIレビューの記録" });
  await expect(evidence).toContainText(
    "設定した処理量または費用の上限に達しました",
  );
  await expect(evidence).toContainText("一部または全部が未レビュー");
  await expect(page.locator(".diagnostic-suppressed")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "製品仕様と通信設定の照合候補" }),
  ).toBeVisible();

  displayed = structuredClone(stored);
  displayed.findings = [];
  displayed.modelReview!.record!.stopReason = "no_source";
  displayed.modelReview!.coverage = {
    ...displayed.modelReview!.coverage,
    status: "unavailable",
    assessedFiles: 0,
    assessedLines: 0,
    batchCount: 0,
    completedBatchCount: 0,
  };
  await page.getByRole("button", { name: "最新状態を再読込" }).click();
  await expect(evidence).toContainText("レビュー対象のソースがありません");
  await expect(evidence).not.toContainText("指定範囲のレビュー完了");

  displayed.modelReview!.record = null;
  displayed.modelReview!.model = null;
  displayed.modelReview!.inputHash = null;
  displayed.modelReview!.contextHash = null;
  await page.getByRole("button", { name: "最新状態を再読込" }).click();
  await expect(evidence).toContainText("モデル未確定");
  await evidence.locator("summary").click();
  await expect(evidence).toContainText("未固定");

  displayed = structuredClone(stored);
  const expiredFinding = displayed.findings.find(
    (finding) => finding.engine === "model",
  )!;
  expiredFinding.reviewDisposition = "confirmation_required";
  expiredFinding.modelReviewEvidence!.specRefIds = [];
  expiredFinding.suppression = {
    status: "expired",
    reason: "expired",
    decisionRevision: 1,
    judgment: "false_positive",
    expiresAt: "2020-01-01T00:00:00.000Z",
    reused: false,
  };
  await page.getByRole("button", { name: "最新状態を再読込" }).click();
  await expect(page.getByText(/期限が切れています。/)).toBeVisible();
  await expect(page.locator(".diagnostic-suppressed")).toHaveCount(0);
  await page.getByText("AIが参照した仕様・過去の判断", { exact: true }).click();
  await expect(
    page.getByText("仕様・知識の参照: 参照なし", { exact: true }),
  ).toBeVisible();
  expiredFinding.suppression.status = "invalidated";
  expiredFinding.suppression.reason = "context_changed";
  await page.getByRole("button", { name: "最新状態を再読込" }).click();
  await expect(
    page.getByText(/判断・根拠または適用条件が変わっています。/),
  ).toBeVisible();
  await expect(page.locator(".diagnostic-suppressed")).toHaveCount(0);
});

test("対象リポジトリとモデルが未設定なら登録・AI有効化を案内付きで止める", async ({
  page,
}) => {
  await page.route("**/api/diagnostics/repositories", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route("**/api/model-review/providers", async (route) => {
    const providers = await (await route.fetch()).json();
    await route.fulfill({
      json: providers.map((provider: Record<string, unknown>) => ({
        ...provider,
        available: false,
      })),
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "診断対象のリポジトリが設定されていません",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "製品を登録する", exact: true }),
  ).toBeDisabled();
  await page.unroute("**/api/diagnostics/repositories");
  await page.reload();
  await page
    .getByRole("button", { name: "製品を登録する", exact: true })
    .click();
  const form = page.locator(".diagnostics-create");
  await expect(
    form.getByLabel("ローカルモデルでコードをレビューする"),
  ).toBeDisabled();
  await expect(
    form.getByLabel("AIレビューのモデル").locator("option"),
  ).toContainText("未設定");
  await expect(form.getByText(/モデル接続が未設定です/)).toBeVisible();
});
