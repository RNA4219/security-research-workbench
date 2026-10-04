import { test, expect } from "./fixtures.js";
import { randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import type { WorkflowCommand } from "../../src/shared/workflow.js";

async function createCase(page: Page, openWorkflow = true) {
  const projectTitle = `仕様確認ケース-${randomUUID().slice(0, 8)}`;
  await page.goto("/");
  await page.getByRole("button", { name: "プロジェクトを作成 →" }).click();
  await page.getByLabel("プロジェクト名", { exact: true }).fill(projectTitle);
  await page
    .getByLabel("目的", { exact: true })
    .fill("製品仕様を根拠付きで確認する");
  await page.getByLabel("対象利用者").fill("開発・保守担当者");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/projects") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "作成する", exact: true }).click();
  const project = (await (await createdResponse).json()) as { id: string };
  if (openWorkflow) {
    await page.getByRole("button", { name: /調査・判断・修正/ }).click();
    await expect(
      page.getByRole("heading", { name: "次の調査と修正につなぐ" }),
    ).toBeVisible();
  }
  return { projectId: project.id, projectTitle };
}

test("初回表示で対象フォームが見え、根拠なし状態を明示する", async ({
  page,
  request,
}) => {
  const { projectId, projectTitle } = await createCase(page);
  await sendWorkflowCommand(request, projectId, {
    type: "scope",
    value: {
      target: "https://example.org/product",
      version: "1.2.0",
      purpose: "設定権限を確認する",
      ownership: "example.org 管理チーム",
      allowedProviderIds: ["manual"],
      allowedMethods: ["manual-review"],
    },
  });
  await openCase(page, projectTitle);
  await expect(page.locator("main main")).toHaveCount(0);
  const target = page.getByLabel("調査対象");
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThan(page.viewportSize()!.height);

  await page.getByLabel("資料名").fill("公開仕様");
  await page.getByLabel("公開区分").selectOption("public");
  await page
    .getByLabel("原文", { exact: true })
    .fill("管理者だけが設定できる。");
  await page.getByRole("button", { name: "資料を保存" }).click();
  await expect
    .poll(async () =>
      (await readWorkflow(request, projectId)).documents.some(
        (item) => item.title === "公開仕様",
      ),
    )
    .toBe(true);
  const referenceSelect = page.getByLabel("根拠資料").first();
  await expect(referenceSelect).toContainText("公開仕様 · v1 · public");
  await referenceSelect.selectOption({ label: "公開仕様 · v1 · public" });
  await expect(page.getByLabel("原文からの引用").first()).not.toHaveValue("");
  await referenceSelect.selectOption("");
  await expect(page.getByLabel("原文からの引用").first()).toHaveValue("");

  await page.getByLabel("指摘の識別子").fill("no-source-observation");
  await page.getByLabel("観測内容").fill("出典がまだ登録されていない観測");
  await page.getByRole("button", { name: "未確認の観測を記録" }).click();
  const finding = page.getByRole("article", {
    name: "指摘 no-source-observation",
  });
  await expect(finding.getByText("根拠資料はまだありません。")).toBeVisible();
  await openCase(page, projectTitle);
  await expect(
    page.getByRole("article", {
      name: "指摘 no-source-observation",
    }),
  ).toBeVisible();
  expect(projectId).toMatch(/.+/u);
});

const headers = { "X-Workbench": "1" };
async function readWorkflow(request: APIRequestContext, projectId: string) {
  return (
    await request.get(`/api/projects/${projectId}/workflow`, { headers })
  ).json() as Promise<import("../../src/shared/workflow.js").WorkflowState>;
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
  return response.json() as Promise<
    import("../../src/shared/workflow.js").WorkflowState
  >;
}
async function seedManualKnowledge(
  request: APIRequestContext,
  projectId: string,
) {
  await sendWorkflowCommand(request, projectId, {
    type: "scope",
    value: {
      target: "https://example.org/product",
      version: "1.2.0",
      purpose: "設定権限を確認する",
      ownership: "example.org 管理チーム",
      allowedProviderIds: ["manual"],
      allowedMethods: ["manual-review", "regression-test"],
    },
  });
  await sendWorkflowCommand(request, projectId, {
    type: "document",
    value: {
      title: "管理者向け仕様",
      url: "https://example.org/spec",
      classification: "public",
      body: "管理者だけが設定を変更できる。",
    },
  });
  const state = await readWorkflow(request, projectId);
  const doc = state.documents[0]!;
  await sendWorkflowCommand(request, projectId, {
    type: "knowledge-draft",
    purpose: state.scope.purpose,
    content: "設定変更は管理者だけが行う。",
    origin: "manual",
    sourceRefs: [{ docId: doc.id, revision: doc.revision, excerpt: doc.body }],
  });
  const draft = (await readWorkflow(request, projectId)).knowledge[0]!;
  await sendWorkflowCommand(request, projectId, {
    type: "knowledge-review",
    knowledgeId: draft.id,
    decision: "active",
    actor: "佐藤",
    reason: "仕様書と一致",
  });
  const activeState = await readWorkflow(request, projectId);
  const activeDoc = activeState.documents[0]!;
  await sendWorkflowCommand(request, projectId, {
    type: "rule-draft",
    purpose: activeState.scope.purpose,
    content: "権限の違いは設計仕様と照合する。",
    applicability: "設定画面の表示範囲を判断する場合",
    sourceRefs: [
      {
        docId: activeDoc.id,
        revision: activeDoc.revision,
        excerpt: activeDoc.body,
      },
    ],
  });
  const ruleDraft = (await readWorkflow(request, projectId)).rules[0]!;
  await sendWorkflowCommand(request, projectId, {
    type: "rule-review",
    ruleId: ruleDraft.id,
    decision: "active",
    actor: "佐藤",
    reason: "レビュー基準として利用する",
  });
}
async function openCase(page: Page, projectTitle: string) {
  await page.goto("/");
  await page.getByRole("button", { name: new RegExp(projectTitle) }).click();
  await page.getByRole("button", { name: /調査・判断・修正/ }).click();
}

test("読み込み中と読み込み失敗を表示する", async ({ page }) => {
  const first = await createCase(page, false);
  const workflowUrl = `**/api/projects/${first.projectId}/workflow`;
  await page.route(workflowUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
  });
  await page.getByRole("button", { name: /調査・判断・修正/ }).click();
  await expect(
    page.getByText("案件の範囲と保存状態を読み込んでいます…"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "次の調査と修正につなぐ" }),
  ).toBeVisible();
  await page.unroute(workflowUrl);

  const second = await createCase(page, false);
  await page.route(`**/api/projects/${second.projectId}/workflow`, (route) =>
    route.fulfill({ status: 503, json: { error: "一時的に読み込めません" } }),
  );
  await page
    .getByRole("button", { name: new RegExp(second.projectTitle) })
    .click();
  await page.getByRole("button", { name: /調査・判断・修正/ }).click();
  await expect(page.getByRole("alert")).toContainText("一時的に読み込めません");
});

test("案件範囲から根拠付き知識、人の判定、修正確認までつなぐ", async ({
  page,
}) => {
  await createCase(page);
  await page
    .getByLabel("調査対象", { exact: true })
    .fill("https://example.org/product");
  await page.getByLabel("対象の版", { exact: true }).fill("1.2.0");
  await page.getByLabel("調査目的", { exact: true }).fill("設定権限を確認する");
  await page
    .getByLabel("所有・管理範囲")
    .fill("example.org の管理チームが保守する製品");
  await page
    .locator(".wf-choice")
    .nth(1)
    .locator("input[type=checkbox]")
    .first()
    .check();
  await page
    .locator(".wf-choice")
    .first()
    .locator("input[type=checkbox]")
    .last()
    .check();
  await page.getByRole("button", { name: "範囲を保存" }).click();
  await expect(page.getByRole("status")).toContainText("保存しました");

  await page.getByLabel("資料名", { exact: true }).fill("管理者向け仕様");
  await page.getByLabel("資料URL").fill("https://example.org/spec");
  await page.getByLabel("公開区分").selectOption("public");
  await page
    .getByLabel("原文", { exact: true })
    .fill(
      "管理者だけが製品設定を変更できます。通常利用者には設定画面を表示しません。",
    );
  await page.getByRole("button", { name: "資料を保存" }).click();
  await expect(
    page.getByRole("heading", { name: "管理者向け仕様" }),
  ).toBeVisible();

  await page.getByLabel("知識の目的").fill("設定権限を確認する");
  await page
    .getByLabel("整理した知識")
    .fill("設定変更の権限は管理者に限定される。");
  await page
    .getByLabel("根拠資料")
    .first()
    .selectOption({ label: "管理者向け仕様 · v1 · public" });
  await page.getByRole("button", { name: "知識案を保存" }).click();
  const draft = page
    .getByRole("article")
    .filter({ hasText: "設定変更の権限は管理者に限定される。" });
  await expect(draft.getByText("レビュー待ち")).toBeVisible();
  await draft.getByLabel("レビュー担当").fill("佐藤");
  await draft.getByLabel("判断理由").fill("原文の権限説明と一致する");
  await draft.getByRole("button", { name: "承認して有効化" }).click();
  await expect(draft.getByText(/承認済み/)).toBeVisible();

  await page
    .getByLabel("照会内容")
    .fill("利用者権限に関する前提を説明してください。");
  await page
    .getByRole("checkbox", { name: /設定変更の権限は管理者に限定される/ })
    .check();
  await page.getByLabel("回答").fill("設定変更は管理者のみ可能です。");
  await page.getByLabel("確実性").selectOption("none");
  await page.getByRole("button", { name: "照会と参照版を保存" }).click();
  await expect(
    page.locator(".wf-card p").filter({
      hasText: "設定変更は管理者のみ可能です。",
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "照会結果から知識更新案を作る" })
    .click();
  await expect(page.getByLabel("整理した知識")).toHaveValue(
    "設定変更は管理者のみ可能です。",
  );

  await page.getByLabel("指摘の識別子").fill("permission-observation");
  await page
    .getByLabel("観測内容")
    .fill("設定画面が通常利用者にも表示されたという観測");
  await page.getByRole("button", { name: "未確認の観測を記録" }).click();
  const finding = page.getByRole("article", {
    name: "指摘 permission-observation",
  });
  await expect(finding.getByText("未確認", { exact: true })).toBeVisible();
  await finding.getByLabel("人の判定").selectOption("needs_action");
  await finding.getByLabel("判断担当").fill("佐藤");
  await finding.getByLabel("判断理由").fill("権限仕様に反するため修正が必要");
  await finding.getByRole("button", { name: "人の判定を記録" }).click();
  await expect(finding.getByText("対応必要", { exact: true })).toBeVisible();

  const remediation = page
    .getByRole("region", { name: "修正と確認" })
    .getByRole("article");
  await remediation.getByLabel("修正担当者").fill("高橋");
  await remediation.getByLabel("TaskContract参照").fill("task:permission-fix");
  await remediation.getByLabel("修正計画").fill("設定権限の照合処理を更新する");
  await remediation.getByRole("button", { name: "修正タスクを開始" }).click();
  await remediation.getByRole("button", { name: "修正中にする" }).click();
  await remediation.getByLabel("修正commit").fill("abcdef0123");
  await remediation
    .getByLabel("変更理由")
    .fill("通常利用者の設定画面を非表示にした");
  await remediation.getByRole("button", { name: "確認待ちにする" }).click();
  await remediation.getByLabel("確認方法").selectOption("manual-review");
  await remediation.getByLabel("確認理由").fill("権限別に画面表示を確認する");
  await remediation.getByLabel("確認範囲").fill("通常利用者と管理者の設定画面");
  await remediation.getByLabel("確認結果").selectOption("failed");
  await remediation.getByLabel("確認担当").fill("佐藤");
  await remediation
    .getByRole("button", { name: "確認結果と証跡を記録" })
    .click();
  await remediation
    .getByLabel("完了判断理由")
    .fill("失敗した最新確認を再実施する");
  await expect(
    remediation.getByRole("button", { name: "証跡を確認して完了" }),
  ).toBeDisabled();
  await remediation.getByLabel("確認結果").selectOption("passed");
  await remediation
    .getByRole("button", { name: "確認結果と証跡を記録" })
    .click();
  await remediation
    .getByLabel("完了判断理由")
    .fill("対象版1.2.0で証跡を確認した");
  await remediation.getByRole("button", { name: "証跡を確認して完了" }).click();
  await expect(
    remediation.getByText("completed", { exact: true }),
  ).toBeVisible();
});

test("承認されていない知識では照会を開始できない", async ({ page }) => {
  await createCase(page);
  await page.getByLabel("照会内容").fill("未承認知識を使った照会");
  await expect(
    page.getByText("この目的で使える承認済み知識がありません。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "照会と参照版を保存" }),
  ).toBeDisabled();
});

test("利用不可資料を根拠にした承認済み知識も照会から除外する", async ({
  page,
  request,
}) => {
  const { projectId, projectTitle } = await createCase(page);
  await sendWorkflowCommand(request, projectId, {
    type: "scope",
    value: {
      target: "https://example.org/product",
      version: "1.2.0",
      purpose: "設定権限を確認する",
      ownership: "example.org 管理チーム",
      allowedProviderIds: ["manual"],
      allowedMethods: ["manual-review"],
    },
  });
  let state = await sendWorkflowCommand(request, projectId, {
    type: "document",
    value: {
      title: "利用不可資料",
      url: "https://example.org/private",
      classification: "blocked",
      body: "非公開の設定仕様",
    },
  });
  const doc = state.documents[0]!;
  const sourceRefs = [
    { docId: doc.id, revision: doc.revision, excerpt: doc.body },
  ];
  state = await sendWorkflowCommand(request, projectId, {
    type: "knowledge-draft",
    purpose: "設定権限を確認する",
    content: "非公開資料を根拠にした知識",
    origin: "manual",
    sourceRefs,
  });
  const knowledge = state.knowledge[0]!;
  await sendWorkflowCommand(request, projectId, {
    type: "knowledge-review",
    knowledgeId: knowledge.id,
    decision: "active",
    actor: "reviewer",
    reason: "この資料区分で照会対象外になることを確認する",
  });
  await openCase(page, projectTitle);
  await expect(
    page.getByText("この目的で使える承認済み知識がありません。"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "非公開資料を根拠にした知識" }),
  ).toBeVisible();
});

test("manual runの停止・再開・回答と同条件比較を保存する", async ({
  page,
  request,
}) => {
  const { projectId, projectTitle } = await createCase(page);
  await seedManualKnowledge(request, projectId);
  const approvedKnowledge = (
    await readWorkflow(request, projectId)
  ).knowledge.find((item) => item.status === "active")!;
  await openCase(page, projectTitle);
  const query = "通常利用者の設定権限を確認する";
  await page.getByLabel("実行内容").fill(query);
  await page.getByRole("button", { name: "この条件で調査を開始" }).click();
  const getRuns = async () => {
    const response = await request.get(
      `/api/projects/${projectId}/workflow/runs`,
      { headers },
    );
    return (await response.json()) as {
      runs: { id: string; status: string }[];
    };
  };
  const firstRun = async () => (await getRuns()).runs[0]!;
  await expect
    .poll(async () => (await firstRun()).status)
    .toBe("waiting_response");
  await openCase(page, projectTitle);
  await expect(
    page.getByRole("heading", { name: "手動モデルの受渡し" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".wf-card")
      .filter({ hasText: "通常利用者の設定権限を確認する" }),
  ).toContainText("未取得");
  await page.getByRole("button", { name: "停止", exact: true }).click();
  const stopped = await firstRun();
  await expect.poll(async () => (await firstRun()).status).toBe("stopped");
  await openCase(page, projectTitle);
  const stoppedRun = page.getByRole("article").filter({ hasText: stopped.id });
  await stoppedRun.getByRole("button", { name: "未完了工程から再開" }).click();
  await expect
    .poll(async () => (await firstRun()).status)
    .toBe("waiting_response");
  await openCase(page, projectTitle);
  await page.getByLabel("モデル応答").fill(
    JSON.stringify({
      answer: "設定は管理者のみが変更できます。",
      citedKnowledgeIds: [approvedKnowledge.id],
      findingReferences: [],
    }),
  );
  await page.getByRole("button", { name: "応答を取り込み" }).click();
  await expect.poll(async () => (await firstRun()).status).toBe("completed");
  await openCase(page, projectTitle);
  const completedCard = page
    .getByRole("article")
    .filter({ hasText: query })
    .first();
  await expect(
    completedCard.getByRole("region", { name: "照会への回答" }),
  ).toContainText("照会への回答（提案）");
  await expect(
    completedCard.getByRole("region", { name: "照会への回答" }),
  ).toContainText("設定変更は管理者だけが行う。");
  await expect(
    completedCard.getByRole("region", { name: "照会への回答" }),
  ).toContainText("判定は担当者が別途確認");

  await page.getByLabel("実行内容").fill(query);
  await page.getByRole("button", { name: "この条件で調査を開始" }).click();
  await expect
    .poll(async () => (await getRuns()).runs[0]!.status)
    .toBe("waiting_response");
  await openCase(page, projectTitle);
  await page.getByLabel("モデル応答").fill(
    JSON.stringify({
      answer: "設定は管理者のみが変更できます。",
      citedKnowledgeIds: [approvedKnowledge.id],
      findingReferences: [],
    }),
  );
  await page.getByRole("button", { name: "応答を取り込み" }).click();
  await expect
    .poll(async () => (await getRuns()).runs[0]!.status)
    .toBe("completed");
  const completed = (await getRuns()).runs;
  await openCase(page, projectTitle);
  const comparison = page.locator(".wf-comparison");
  await comparison
    .getByLabel("方式A", { exact: true })
    .selectOption(completed[1]!.id);
  await comparison
    .getByLabel("方式B", { exact: true })
    .selectOption(completed[0]!.id);
  await comparison.getByLabel("正解ラベルセットID").fill("permissions-v1");
  await expect(
    comparison.getByRole("button", { name: "条件を照合して比較" }),
  ).toBeDisabled();
  await comparison.getByLabel("正解ラベル上の指摘は0件").check();
  await comparison.getByRole("button", { name: "条件を照合して比較" }).click();
  await expect(comparison.getByText("同条件で比較可能")).toBeVisible();
  await expect(comparison.getByText("未測定").first()).toBeVisible();
});

test("資料改版で知識・基準を失効し、却下と更新案を区別する", async ({
  page,
  request,
}) => {
  const { projectId, projectTitle } = await createCase(page);
  await seedManualKnowledge(request, projectId);
  await openCase(page, projectTitle);
  const docCard = page
    .getByRole("article")
    .filter({ hasText: "管理者向け仕様" })
    .first();
  await docCard.getByRole("button", { name: "新しい版を編集" }).click();
  const updatedSource =
    "管理者だけが設定を変更できます。利用者画面の表示仕様を明記しました。";
  await page.getByLabel("原文", { exact: true }).fill(updatedSource);
  await page.route("**/api/projects/*/workflow/commands", (route) =>
    route.fulfill({ status: 503, json: { error: "一時的な保存失敗" } }),
  );
  await page.getByRole("button", { name: "資料の新しい版を保存" }).click();
  await expect(page.getByRole("alert")).toContainText("一時的な保存失敗");
  await expect(page.getByLabel("原文", { exact: true })).toHaveValue(
    updatedSource,
  );
  await page.unroute("**/api/projects/*/workflow/commands");
  await page.getByRole("button", { name: "資料の新しい版を保存" }).click();
  await expect(page.getByText(/失効・再確認 · v\d+/u).first()).toBeVisible();

  await page
    .getByLabel("判定ルール")
    .fill("設定表示は利用者ごとに分けて確認する。");
  await page.getByLabel("適用条件").fill("権限の変更があった場合");
  await page.getByLabel("適用対象の版").fill("1.2.0");
  await page.getByLabel("置き換える基準").selectOption({
    label: "権限の違いは設計仕様と照合する。 · v1",
  });
  await page
    .getByLabel("根拠資料")
    .nth(1)
    .selectOption({ label: "管理者向け仕様 · v2 · public" });
  await page.getByRole("button", { name: "基準案を保存" }).click();
  const proposedRule = page
    .getByRole("article")
    .filter({ hasText: "設定表示は利用者ごとに分けて確認する。" });
  await proposedRule.getByLabel("レビュー担当").fill("佐藤");
  await proposedRule.getByLabel("判断理由").fill("適用条件が不足している");
  await proposedRule.getByRole("button", { name: "却下" }).click();
  await expect(proposedRule.getByText("却下 · v2")).toBeVisible();

  await page
    .getByLabel("整理した知識")
    .fill("更新後の仕様には利用者画面の表示条件も含まれる。");
  await page.getByLabel("置き換える知識").selectOption({
    label: "設定変更は管理者だけが行う。 · v1",
  });
  await page
    .getByLabel("根拠資料")
    .first()
    .selectOption({ label: "管理者向け仕様 · v2 · public" });
  await page.getByRole("button", { name: "知識案を保存" }).click();
  const newKnowledge = page
    .getByRole("article")
    .filter({ hasText: "更新後の仕様には利用者画面の表示条件も含まれる。" });
  await newKnowledge.getByLabel("レビュー担当").fill("佐藤");
  await newKnowledge.getByLabel("判断理由").fill("新版の引用を確認した");
  await newKnowledge.getByRole("button", { name: "承認して有効化" }).click();
  await expect(newKnowledge.getByText("承認済み · v2")).toBeVisible();
});

test("保存済みURL調査を重複なく案件へ取り込む", async ({ page, request }) => {
  const { projectId, projectTitle } = await createCase(page);
  const reportResponse = await request.post("/api/research", {
    headers,
    data: { repoUrl: "https://github.com/example/research-fixture" },
  });
  expect(reportResponse.ok()).toBeTruthy();
  const report = (await reportResponse.json()) as {
    id: string;
    repository: { url: string; commit: string };
  };
  await sendWorkflowCommand(request, projectId, {
    type: "scope",
    value: {
      target: report.repository.url,
      version: report.repository.commit,
      purpose: "OSSの採用前確認",
      ownership: "公開リポジトリの利用候補",
      allowedProviderIds: ["manual"],
      allowedMethods: ["manual-review"],
    },
  });
  await openCase(page, projectTitle);
  await page.getByLabel("保存済みOSS調査").selectOption(report.id);
  await page.getByRole("button", { name: "案件へ取込" }).click();
  await page.getByRole("button", { name: "案件へ取込" }).click();
  const state = await readWorkflow(request, projectId);
  expect(state.imports).toHaveLength(1);
  expect(state.imports[0]?.reportId).toBe(report.id);
  expect(state.findings.every((item) => item.judgment === "unconfirmed")).toBe(
    true,
  );
});

test("期限付き抑止は対象版が変わると再確認へ戻る", async ({
  page,
  request,
}) => {
  const { projectId, projectTitle } = await createCase(page);
  await seedManualKnowledge(request, projectId);
  await openCase(page, projectTitle);
  const findingRegion = page.getByRole("region", { name: "観測と人の判定" });
  await findingRegion.getByLabel("指摘の識別子").fill("known-permission-note");
  await findingRegion.getByLabel("観測対象版").fill("1.2.0");
  await findingRegion
    .getByLabel("観測内容")
    .fill("設定権限の範囲を観測しました。");
  await findingRegion
    .getByLabel("根拠資料")
    .selectOption({ label: "管理者向け仕様 · v1 · public" });
  await findingRegion
    .getByRole("button", { name: "未確認の観測を記録" })
    .click();
  const card = findingRegion
    .getByRole("article")
    .filter({ hasText: "known-permission-note" });
  await card.getByLabel("人の判定").selectOption("accepted_known");
  await card.getByLabel("判断担当").fill("佐藤");
  await card.getByLabel("判断理由").fill("この製品版では意図した仕様");
  await card.getByRole("button", { name: "人の判定を記録" }).click();
  await card.getByLabel("抑止理由").fill("同じ仕様の再提示を一時的に抑える");
  await card.getByLabel("抑止期限").fill("2099-01-01T00:00");
  await card.getByRole("button", { name: "期限付きで再提示を抑止" }).click();
  await expect(card.getByText(/抑止 有効/)).toBeVisible();

  const scope = page.getByRole("region", { name: "対象と許可範囲" });
  await scope.getByLabel("対象の版").fill("1.3.0");
  await scope.getByRole("button", { name: "範囲を保存" }).click();
  await expect(card.getByText(/抑止 失効・再確認/)).toBeVisible();
  await expect(card.getByText("未確認", { exact: true })).toBeVisible();
  await findingRegion.getByLabel("指摘の識別子").fill("known-permission-note");
  await findingRegion.getByLabel("観測対象版").fill("1.2.0");
  await findingRegion
    .getByLabel("観測内容")
    .fill("対象版を更新した後に再観測しました。");
  await findingRegion
    .getByRole("button", { name: "未確認の観測を記録" })
    .click();
  await expect(card.getByText("再観測履歴（2件）")).toBeVisible();
  await expect(card.getByText("未確認", { exact: true })).toBeVisible();
});
