import { mkdirSync } from "node:fs";
import type { APIRequestContext, Page } from "@playwright/test";
import type {
  DiagnosticRun,
  Product,
} from "../../src/shared/product-diagnostics.js";
import type { WorkflowState } from "../../src/shared/workflow.js";
import { test, expect } from "./fixtures.js";

const headers = { "X-Workbench": "1" };

async function openWorkflow(page: Page, projectTitle: string) {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "プロジェクト" })
    .getByRole("button", { name: new RegExp(projectTitle) })
    .click();
  await page.getByRole("button", { name: /調査・判断・修正/ }).click();
  await expect(
    page.getByRole("heading", { name: "次の調査と修正につなぐ" }),
  ).toBeVisible();
}

async function readWorkflow(request: APIRequestContext, projectId: string) {
  const response = await request.get(`/api/projects/${projectId}/workflow`, {
    headers,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as WorkflowState;
}

async function sendCommand(
  request: APIRequestContext,
  projectId: string,
  command: Record<string, unknown>,
) {
  const state = await readWorkflow(request, projectId);
  const response = await request.post(
    `/api/projects/${projectId}/workflow/commands`,
    { headers, data: { revision: state.revision, command } },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as WorkflowState;
}

async function createCase(request: APIRequestContext) {
  const productTitle = `source-scope-${Date.now()}`;
  const created = await request.post("/api/products", {
    headers,
    data: {
      title: productTitle,
      repositoryId: "fixture",
      ref: "baseline",
      specification:
        "TLS接続の証明書検証を必須とする。固定版コードの通信設定を確認する。",
      modelReview: { enabled: true, providerId: "local", cloudConsent: false },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const product = (await created.json()) as Product;
  const startedResponse = await request.post(
    `/api/products/${product.id}/runs`,
    { headers, data: { trigger: "manual" } },
  );
  expect(startedResponse.ok(), await startedResponse.text()).toBeTruthy();
  const started = (await startedResponse.json()) as DiagnosticRun;
  let run = started;
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/api/products/${product.id}/runs/${started.id}`,
          { headers },
        );
        expect(response.ok()).toBeTruthy();
        run = (await response.json()) as DiagnosticRun;
        return run.status;
      },
      { timeout: 15_000 },
    )
    .toBe("partial");
  const candidate = run.findings.find((item) => item.engine === "model");
  expect(candidate?.workflowFindingId).toBeTruthy();
  expect(run.commit).toMatch(/^[a-f0-9]{40}$/);
  const state = await readWorkflow(request, product.linkedProjectId);
  const finding = state.findings.find(
    (item) => item.id === candidate?.workflowFindingId,
  );
  expect(finding).toBeDefined();
  const observation = finding!.observationHistory.at(-1);
  expect(observation?.modelSourceBinding).toBeDefined();
  expect(observation?.contextHash).toMatch(/^[a-f0-9]{64}$/);
  expect(observation?.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  const specification = state.documents.find(
    (document) => document.title === "製品仕様",
  );
  expect(specification).toBeDefined();
  return {
    projectId: product.linkedProjectId,
    projectTitle: `${productTitle} の継続診断`,
    targetVersion: run.commit!,
    finding: finding!,
    specification: specification!,
  };
}

test("抑止範囲は厳密比較を既定にし、bindingがない古い観測では広げられない", async ({
  page,
  request,
}) => {
  const { projectId, projectTitle, targetVersion, finding, specification } =
    await createCase(request);
  const sourceRefs = [
    {
      docId: specification.id,
      revision: specification.revision,
      excerpt: specification.body,
    },
  ];
  await sendCommand(request, projectId, {
    type: "finding-observation",
    fingerprint: "legacy-finding",
    targetVersion,
    observation: "bindingのない旧形式の指摘",
    sourceRefs,
  });

  // The fixture commands run through the API while the workflow page still
  // holds its initial state; reopen the project before locating findings.
  await openWorkflow(page, projectTitle);
  const sourceScopeCard = page.getByRole("article", {
    name: `指摘 ${finding.fingerprint}`,
  });
  await sourceScopeCard.getByLabel("人の判定").selectOption("accepted_known");
  await sourceScopeCard.getByLabel("判断担当").fill("reviewer");
  await sourceScopeCard.getByLabel("判断理由").fill("仕様と根拠を確認した");
  await sourceScopeCard.getByLabel("根拠資料").selectOption({
    label: `製品仕様 · v${specification.revision} · ${specification.classification}`,
  });
  await sourceScopeCard.getByRole("button", { name: "人の判定を記録" }).click();
  await expect(
    sourceScopeCard.getByText("既知の許容事項", { exact: true }),
  ).toBeVisible();

  const legacyCard = page.getByRole("article", {
    name: "指摘 legacy-finding",
  });
  await legacyCard.getByLabel("人の判定").selectOption("accepted_known");
  await legacyCard.getByLabel("判断担当").fill("reviewer");
  await legacyCard.getByLabel("判断理由").fill("旧形式の確認");
  await legacyCard.getByLabel("根拠資料").selectOption({
    label: `製品仕様 · v${specification.revision} · ${specification.classification}`,
  });
  await legacyCard.getByRole("button", { name: "人の判定を記録" }).click();
  await expect(
    legacyCard.getByText("既知の許容事項", { exact: true }),
  ).toBeVisible();

  const sourceScopeSelect = sourceScopeCard.getByLabel("抑止範囲");
  await expect(sourceScopeSelect).toHaveValue("exact_evidence");
  await expect(
    sourceScopeSelect.locator("option[value=source_scope]"),
  ).toBeEnabled();
  await sourceScopeSelect.selectOption("source_scope");
  await sourceScopeCard.getByLabel("抑止理由").fill("同じコード範囲を確認済み");
  await sourceScopeCard.getByLabel("抑止期限").fill("2099-01-01T00:00");
  const suppressionRequest = page.waitForRequest((requestValue) => {
    if (
      !requestValue.url().endsWith("/workflow/commands") ||
      requestValue.method() !== "POST"
    ) {
      return false;
    }
    try {
      const body = requestValue.postDataJSON() as {
        command?: { type?: string };
      };
      return body.command?.type === "suppression";
    } catch {
      return false;
    }
  });
  const suppressionResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/workflow/commands") &&
      response.request().method() === "POST",
  );
  await sourceScopeCard
    .getByRole("button", { name: "期限付きで再提示を抑止" })
    .click();
  const suppressionPayload = (await suppressionRequest).postDataJSON() as {
    command: { matchPolicy?: string };
  };
  expect(suppressionPayload.command.matchPolicy).toBe("source_scope");
  expect((await suppressionResponse).ok()).toBeTruthy();

  const persistedState = await readWorkflow(request, projectId);
  const persistedFinding = persistedState.findings.find(
    (candidate) => candidate.id === finding.id,
  );
  const persistedSuppression = persistedFinding?.suppressions.at(-1);
  expect(persistedSuppression).toMatchObject({
    active: true,
    matchPolicy: "source_scope",
    targetVersion,
  });

  await openWorkflow(page, projectTitle);
  await expect(sourceScopeCard).toBeVisible();
  await expect(sourceScopeCard).toContainText("指定したコード範囲の指摘");
  if (process.env.WORKBENCH_COVERAGE === "1") {
    mkdirSync(".cache/quality", { recursive: true });
    await sourceScopeCard.screenshot({
      path: ".cache/quality/source-scope-suppression.png",
    });
  }

  const legacyScopeSelect = legacyCard.getByLabel("抑止範囲");
  await expect(legacyScopeSelect).toHaveValue("exact_evidence");
  await expect(
    legacyScopeSelect.locator("option[value=source_scope]"),
  ).toHaveAttribute("disabled", "");
  await expect(legacyCard).toContainText(
    "現行の観測に固定版とコード根拠の条件がある場合だけ選べます",
  );
});
