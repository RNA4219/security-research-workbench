import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import type {
  WorkflowCommand,
  WorkflowScope,
  WorkflowState,
} from "../../src/shared/workflow.js";
import type {
  WorkflowRun,
  WorkflowRunBudgets,
} from "../../src/shared/workflow-run.js";
import { test, expect } from "./fixtures.js";

const headers = { "X-Workbench": "1" };
const workflowScope: WorkflowScope = {
  target: "https://example.org/product",
  version: "v1",
  purpose: "設定権限を確認する",
  ownership: "example.org 管理チーム",
  allowedProviderIds: ["manual"],
  allowedMethods: ["manual-review", "static-review", "regression-test"],
};

async function createCase(page: Page) {
  const projectTitle = `workflow-review-${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  await page.getByRole("button", { name: "プロジェクトを作成 →" }).click();
  await page.getByLabel("プロジェクト名", { exact: true }).fill(projectTitle);
  await page.getByLabel("目的", { exact: true }).fill("継続調査の回帰試験");
  await page.getByLabel("対象利用者").fill("開発・保守担当者");
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  const project = (await (await created).json()) as { id: string };
  await page.getByRole("button", { name: /調査・判断・修正/ }).click();
  await expect(
    page.getByRole("heading", { name: "次の調査と修正につなぐ" }),
  ).toBeVisible();
  return { projectId: project.id, projectTitle };
}

async function readWorkflow(request: APIRequestContext, projectId: string) {
  const response = await request.get(`/api/projects/${projectId}/workflow`, {
    headers,
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as WorkflowState;
}

async function sendWorkflowCommand(
  request: APIRequestContext,
  projectId: string,
  command: WorkflowCommand,
) {
  const state = await readWorkflow(request, projectId);
  const response = await request.post(
    `/api/projects/${projectId}/workflow/commands`,
    { headers, data: { revision: state.revision, command } },
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as WorkflowState;
}

async function openCase(page: Page, projectTitle: string) {
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(projectTitle) }).click();
  await page.getByRole("button", { name: /調査・判断・修正/ }).click();
  await expect(
    page.getByRole("heading", { name: "次の調査と修正につなぐ" }),
  ).toBeVisible();
}

async function seedActiveKnowledgeAndRule(
  request: APIRequestContext,
  projectId: string,
) {
  await sendWorkflowCommand(request, projectId, {
    type: "scope",
    value: workflowScope,
  });
  await sendWorkflowCommand(request, projectId, {
    type: "document",
    value: {
      title: "設定仕様",
      body: "管理者だけが設定を変更できる。",
      url: "https://example.org/settings-spec",
      classification: "public",
    },
  });
  let state = await readWorkflow(request, projectId);
  const doc = state.documents[0]!;
  const sourceRefs = [
    { docId: doc.id, revision: doc.revision, excerpt: doc.body },
  ];
  await sendWorkflowCommand(request, projectId, {
    type: "knowledge-draft",
    purpose: workflowScope.purpose,
    content: "設定変更は管理者だけが行う。",
    origin: "manual",
    sourceRefs,
  });
  state = await readWorkflow(request, projectId);
  const knowledge = state.knowledge.at(-1)!;
  await sendWorkflowCommand(request, projectId, {
    type: "knowledge-review",
    knowledgeId: knowledge.id,
    decision: "active",
    actor: "reviewer",
    reason: "仕様と照合済み",
  });
  await sendWorkflowCommand(request, projectId, {
    type: "rule-draft",
    purpose: workflowScope.purpose,
    content: "権限条件を仕様と照合する。",
    applicability: "設定変更を評価する場合",
    appliesToVersion: workflowScope.version,
    sourceRefs,
  });
  state = await readWorkflow(request, projectId);
  const rule = state.rules.at(-1)!;
  await sendWorkflowCommand(request, projectId, {
    type: "rule-review",
    ruleId: rule.id,
    decision: "active",
    actor: "reviewer",
    reason: "基準として承認",
  });
}

async function approveCard(page: Page, content: string) {
  const card = page.getByRole("article").filter({ hasText: content }).first();
  await card.getByLabel("レビュー担当").fill("reviewer");
  await card.getByLabel("判断理由").fill("対象版の根拠を確認した");
  await card.getByRole("button", { name: "承認して有効化" }).click();
  await expect(card.getByText(/承認済み/u)).toBeVisible();
}

async function makeManualRun(
  request: APIRequestContext,
  projectId: string,
  query: string,
) {
  const state = await readWorkflow(request, projectId);
  const budgets: WorkflowRunBudgets = {
    maxDurationMs: 60_000,
    maxCostUsd: 0,
    maxSteps: 3,
    maxConcurrency: 1,
    maxRetries: 0,
  };
  const createdResponse = await request.post(
    `/api/projects/${projectId}/workflow/runs`,
    {
      headers,
      data: {
        revision: state.revision,
        query,
        queryClassification: "public",
        providerId: "manual",
        budgets,
      },
    },
  );
  expect(createdResponse.ok()).toBeTruthy();
  const created = (await createdResponse.json()) as WorkflowRun;
  await expect
    .poll(async () => {
      const list = await request.get(
        `/api/projects/${projectId}/workflow/runs`,
        { headers },
      );
      const body = (await list.json()) as { runs: WorkflowRun[] };
      return body.runs.find((run) => run.id === created.id)?.status;
    })
    .toBe("waiting_response");
  const response = await request.post(
    `/api/projects/${projectId}/workflow/runs/${created.id}/response`,
    {
      headers,
      data: {
        response: {
          answer: "参照知識と一致する。",
          citedKnowledgeIds: [],
          findingReferences: [],
        },
      },
    },
  );
  expect(response.ok()).toBeTruthy();
  return created.id;
}

test("同じ知識・基準IDのrevision 1→2→3を正しい親から更新し承認できる", async ({
  page,
  request,
}) => {
  const { projectId, projectTitle } = await createCase(page);
  await seedActiveKnowledgeAndRule(request, projectId);
  await openCase(page, projectTitle);

  const knowledgeV2 = "設定変更は管理者権限が必要である。";
  await page.getByLabel("整理した知識").fill(knowledgeV2);
  await page
    .getByLabel("置き換える知識")
    .selectOption({ label: "設定変更は管理者だけが行う。 · v1" });
  await page
    .getByLabel("根拠資料")
    .first()
    .selectOption({ label: "設定仕様 · v1 · public" });
  await page.getByRole("button", { name: "知識案を保存" }).click();
  await approveCard(page, knowledgeV2);

  const knowledgeV3 = "変更操作には管理者ロールを要求する。";
  await page.getByLabel("整理した知識").fill(knowledgeV3);
  await page
    .getByLabel("置き換える知識")
    .selectOption({ label: `${knowledgeV2} · v2` });
  await page
    .getByLabel("根拠資料")
    .first()
    .selectOption({ label: "設定仕様 · v1 · public" });
  await page.getByRole("button", { name: "知識案を保存" }).click();
  await approveCard(page, knowledgeV3);

  const ruleV2 = "利用者ごとの設定変更権限を確認する。";
  await page.getByLabel("判定ルール").fill(ruleV2);
  await page.getByLabel("適用条件").fill("設定変更操作の確認時");
  await page.getByLabel("適用対象の版").fill("v1");
  await page
    .getByLabel("置き換える基準")
    .selectOption({ label: "権限条件を仕様と照合する。 · v1" });
  await page
    .getByLabel("根拠資料")
    .nth(1)
    .selectOption({ label: "設定仕様 · v1 · public" });
  await page.getByRole("button", { name: "基準案を保存" }).click();
  await approveCard(page, ruleV2);

  const ruleV3 = "管理者以外の設定変更が拒否されるか確認する。";
  await page.getByLabel("判定ルール").fill(ruleV3);
  await page.getByLabel("適用条件").fill("管理者以外の操作を評価する場合");
  await page.getByLabel("適用対象の版").fill("v1");
  await page
    .getByLabel("置き換える基準")
    .selectOption({ label: `${ruleV2} · v2` });
  await page
    .getByLabel("根拠資料")
    .nth(1)
    .selectOption({ label: "設定仕様 · v1 · public" });
  await page.getByRole("button", { name: "基準案を保存" }).click();
  await approveCard(page, ruleV3);

  const state = await readWorkflow(request, projectId);
  const knowledge = state.knowledge.filter(
    (item) => item.id === state.knowledge[0]?.id,
  );
  const rules = state.rules.filter((item) => item.id === state.rules[0]?.id);
  expect(knowledge.map((item) => [item.revision, item.status])).toEqual([
    [1, "stale"],
    [2, "stale"],
    [3, "active"],
  ]);
  expect(rules.map((item) => [item.revision, item.status])).toEqual([
    [1, "stale"],
    [2, "stale"],
    [3, "active"],
  ]);
});

test("scope v2に更新後、修正の確認待ちをv2と新commitへ移せる", async ({
  page,
  request,
}) => {
  const { projectId, projectTitle } = await createCase(page);
  await sendWorkflowCommand(request, projectId, {
    type: "scope",
    value: workflowScope,
  });
  let state = await sendWorkflowCommand(request, projectId, {
    type: "document",
    value: {
      title: "Issue",
      body: "Affected behavior",
      url: "https://example.org/issue",
      classification: "public",
    },
  });
  const doc = state.documents[0]!;
  const sourceRefs = [
    { docId: doc.id, revision: doc.revision, excerpt: doc.body },
  ];
  state = await sendWorkflowCommand(request, projectId, {
    type: "finding-observation",
    fingerprint: "issue-v1",
    targetVersion: "v1",
    observation: "設定権限を修正する",
    sourceRefs,
  });
  const findingId = state.findings[0]!.id;
  state = await sendWorkflowCommand(request, projectId, {
    type: "finding-decision",
    findingId,
    judgment: "needs_action",
    actor: "reviewer",
    reason: "要修正",
    targetVersion: "v1",
    sourceRefs,
    ruleRefs: [],
  });
  await sendWorkflowCommand(request, projectId, {
    type: "remediation-start",
    findingId,
    assignee: "dev",
    taskRef: "TASK-1",
    plan: "権限条件を修正する",
    targetVersion: "v1",
  });
  await sendWorkflowCommand(request, projectId, {
    type: "remediation-progress",
    findingId,
    status: "in_progress",
    actor: "dev",
    reason: "着手",
    targetVersion: "v1",
  });
  await sendWorkflowCommand(request, projectId, {
    type: "scope",
    value: { ...workflowScope, version: "v2" },
  });
  await openCase(page, projectTitle);

  const card = page
    .getByRole("article")
    .filter({ hasText: "設定権限を修正する" })
    .last();
  await card.getByLabel("修正対象の版").fill("v2");
  await card.getByLabel("修正commit").fill("abcdef012345");
  await card.getByRole("button", { name: "確認待ちにする" }).click();

  const updated = await readWorkflow(request, projectId);
  expect(
    updated.findings.find((item) => item.id === findingId)?.remediation,
  ).toMatchObject({
    status: "verification_pending",
    targetVersion: "v2",
    fixCommit: "abcdef012345",
  });
});

test("比較条件を変更したら前回の比較結果を表示し続けない", async ({
  page,
  request,
}) => {
  const { projectId, projectTitle } = await createCase(page);
  await seedActiveKnowledgeAndRule(request, projectId);
  const query = "同じqueryで比較する";
  const first = await makeManualRun(request, projectId, query);
  const second = await makeManualRun(request, projectId, query);
  const third = await makeManualRun(request, projectId, query);
  await openCase(page, projectTitle);

  const comparison = page.locator(".wf-comparison");
  await comparison.getByLabel("方式A", { exact: true }).selectOption(first);
  await comparison.getByLabel("方式B", { exact: true }).selectOption(second);
  await comparison.getByLabel("正解ラベルセットID").fill("labels-v1");
  await comparison.getByLabel("正解ラベル上の指摘は0件").check();
  await comparison.getByRole("button", { name: "条件を照合して比較" }).click();
  const result = page.getByTestId("workflow-comparison-result");
  await expect(result).toContainText("同条件で比較可能");
  await expect(result).toContainText(first.slice(0, 8));
  await expect(result).toContainText(second.slice(0, 8));

  await comparison.getByLabel("方式A", { exact: true }).selectOption(third);
  await expect(result).toHaveCount(0);
});
