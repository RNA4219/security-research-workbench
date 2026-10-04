import { test, expect } from "./fixtures.js";

test("URL調査から採用判断へ進み、案件を開き直しても原文と対象版を保持する", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByText("OSS採用前調査（補助機能）").click();
  await page
    .getByLabel("公開GitHubリポジトリのURL")
    .fill("https://github.com/example/research-fixture");
  await page
    .getByRole("button", { name: "このOSSを調べる", exact: true })
    .click();
  const adopt = page.getByRole("button", {
    name: "この結果から採用判断を続ける",
  });
  await expect(adopt).toBeEnabled();
  // 失敗時は調査結果を残し、同じ結果から再試行できる。
  await page.route("**/api/research/*/adopt", (route) =>
    route.fulfill({ status: 503, json: { error: "案件保存に失敗しました" } }),
  );
  await adopt.click();
  await expect(page.getByRole("alert")).toContainText("案件保存に失敗しました");
  await expect(
    page.getByRole("heading", { name: "次に確認すること" }),
  ).toBeVisible();
  await page.unroute("**/api/research/*/adopt");
  await adopt.click();
  await expect(
    page.getByRole("heading", { name: "次の調査と修正につなぐ" }),
  ).toBeVisible();
  await expect(page.getByLabel("調査対象", { exact: true })).toHaveValue(
    "https://github.com/example/research-fixture",
  );
  await expect(page.getByLabel("対象の版", { exact: true })).toHaveValue(
    "a".repeat(40),
  );
  await expect(
    page.getByRole("heading", { name: /GHSA-test-fixture/ }).first(),
  ).toBeVisible();
  const projects = await (
    await request.get("/api/projects", { headers: { "X-Workbench": "1" } })
  ).json();
  const selected = projects.find(
    (p: { title: string }) => p.title === "example/research-fixture の採用判断",
  );
  const workflow = await (
    await request.get(`/api/projects/${selected.id}/workflow`, {
      headers: { "X-Workbench": "1" },
    })
  ).json();
  expect(workflow.imports).toHaveLength(1);
  expect(
    workflow.findings.every(
      (f: { judgment: string }) => f.judgment === "unconfirmed",
    ),
  ).toBe(true);
  expect(workflow.documents[0].hash).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: /調査資料/ }).click();
  await page.getByRole("button", { name: /調査・判断・修正/ }).click();
  await expect(page.getByLabel("対象の版", { exact: true })).toHaveValue(
    "a".repeat(40),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "次の調査と修正につなぐ" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
