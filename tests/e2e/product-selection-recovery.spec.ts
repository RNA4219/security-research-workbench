import { test, expect } from "./fixtures.js";
import type { APIRequestContext } from "@playwright/test";
import type {
  Product,
  DiagnosticRun,
} from "../../src/shared/product-diagnostics.js";

const headers = { "X-Workbench": "1" };
async function createProduct(
  request: APIRequestContext,
  title: string,
  delayed = false,
) {
  const response = await request.post("/api/products", {
    headers,
    data: {
      title,
      repositoryId: "fixture",
      ref: "baseline",
      specification: delayed
        ? "UI_DELAY_MODEL: TLS証明書検証を必須とする。"
        : "TLS証明書検証を必須とする。",
      modelReview: {
        enabled: delayed,
        providerId: "local",
        cloudConsent: false,
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Product;
}

test("製品切替後に古い進行応答が届いても、表示と診断対象を戻さない", async ({
  page,
  request,
}) => {
  const next = await createProduct(request, "切替先の製品");
  const previous = await createProduct(request, "進行応答が遅れる製品", true);
  const started = await request.post(`/api/products/${previous.id}/runs`, {
    headers,
    data: { trigger: "manual" },
  });
  expect(started.ok()).toBeTruthy();
  let calls = 0;
  let release!: () => void;
  let fulfilled!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    fulfilled = resolve;
  });
  await page.route(`**/api/products/${previous.id}`, async (route) => {
    calls++;
    const response = await route.fetch();
    if (calls === 2) {
      await gate;
      await route.fulfill({ response });
      fulfilled();
    } else {
      await route.fulfill({ response });
    }
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: previous.title, exact: true }),
  ).toBeVisible();
  await expect.poll(() => calls).toBeGreaterThanOrEqual(2);
  await page
    .getByRole("navigation", { name: "登録済み製品" })
    .getByRole("button", { name: new RegExp(next.title) })
    .click();
  await expect(
    page.getByRole("heading", { name: next.title, exact: true }),
  ).toBeVisible();
  release();
  await delivered;
  // Let the delivered fetch and its React update finish before inspecting the view.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(
    page.getByRole("heading", { name: previous.title, exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: next.title, exact: true }),
  ).toBeVisible();
  const starting = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().endsWith(`/api/products/${next.id}/runs`),
  );
  await page
    .getByRole("button", { name: "この版を診断する", exact: true })
    .click();
  await starting;
});

test("切替先の読込失敗時に前の製品の操作欄を残さない", async ({
  page,
  request,
}) => {
  const unavailable = await createProduct(request, "取得できない切替先");
  const previous = await createProduct(request, "切替前の製品");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: previous.title, exact: true }),
  ).toBeVisible();
  await page.route(`**/api/products/${unavailable.id}`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "切替先の情報を取得できません" },
    }),
  );
  await page
    .getByRole("navigation", { name: "登録済み製品" })
    .getByRole("button", { name: new RegExp(unavailable.title) })
    .click();
  await expect(
    page.getByText("切替先の情報を取得できません", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: previous.title, exact: true }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "この版を診断する", exact: true }),
  ).not.toBeVisible();
});

test("診断結果の取得失敗を表示し、同じ実行を再読込して回復できる", async ({
  page,
  request,
}) => {
  const product = await createProduct(request, "診断結果の再読込");
  const started = await request.post(`/api/products/${product.id}/runs`, {
    headers,
    data: { trigger: "manual" },
  });
  const run = (await started.json()) as DiagnosticRun;
  const path = `/api/products/${product.id}/runs/${run.id}`;
  await expect
    .poll(
      async () => (await (await request.get(path, { headers })).json()).status,
    )
    .toBe("partial");
  await page.route(`**${path}`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: "診断結果を一時的に取得できません" },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("診断結果を一時的に取得できません", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "TLS証明書検証が無効です", exact: true }),
  ).not.toBeVisible();
  await page.unroute(`**${path}`);
  await page
    .getByRole("button", { name: "最新状態を再読込", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "TLS証明書検証が無効です", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("診断結果を一時的に取得できません", { exact: true }),
  ).not.toBeVisible();
});
