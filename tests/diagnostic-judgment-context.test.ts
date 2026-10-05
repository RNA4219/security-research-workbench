import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import type { WorkflowProviderDefinition } from "../src/server/workflow-runner.js";
import {
  applyWorkflowCommand,
  newWorkflow,
} from "../src/server/workflow-domain.js";
import { ProductDiagnosticsService } from "../src/server/diagnostic-service.js";
import { Store } from "../src/server/store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import type { DiagnosticRun, Product } from "../src/shared/product-diagnostics.js";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";

const headers = {
  host: "127.0.0.1:4317",
  "x-workbench": "1",
  "content-type": "application/json",
};

const provider: WorkflowProviderDefinition = {
  id: "local",
  kind: "local",
  label: "判断context回帰用local model",
  model: "judgment-context-fixture-model",
  available: true,
  costKnown: true,
  configVersion: "judgment-context-v1",
  maxOutputTokens: 2048,
};

function payloadFromPrompt(prompt: string) {
  const start = "BEGIN_REFERENCE_DATA_JSON\n";
  const end = "\nEND_REFERENCE_DATA_JSON";
  const from = prompt.indexOf(start);
  const to = prompt.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error("model inputがpromptにありません");
  return JSON.parse(prompt.slice(from + start.length, to)) as {
    matchingPastJudgments: { id: string }[];
    pinnedSnapshot: {
      files: { path: string; lines: { line: number; text: string }[] }[];
    };
  };
}

function responseFor(prompt: string) {
  const payload = payloadFromPrompt(prompt);
  const file = payload.pinnedSnapshot.files.find(
    (item) => item.path === "src/client.ts",
  );
  const line = file?.lines.find((item) =>
    item.text.includes("rejectUnauthorized: false"),
  );
  return JSON.stringify({
    schemaVersion: "1",
    findings:
      file && line
        ? [
            {
              id: "judgment-context-finding",
              category: "trust-boundary",
              severity: "medium",
              title: "通信設定の仕様照合候補",
              rationale: "固定snapshotの通信設定を製品仕様と照合する。",
              path: file.path,
              line: line.line,
              originalText: line.text,
              specRefIds: ["product-specification"],
              relatedFixedFindingIds: [],
              pastJudgmentIds: [],
              remediation: {
                guidance: "担当者が用途・仕様と通信設定を確認する。",
                humanReviewRequired: true,
              },
              falsePositiveCandidate: false,
              uncertainty: { level: "medium", reasons: [] },
            },
          ]
        : [],
    omitted: [],
    limitations: [],
  });
}

async function runToCompletion(
  app: Awaited<ReturnType<typeof createApp>>,
  productId: string,
  runId: string,
) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const response = await app.inject({
      url: `/api/products/${productId}/runs/${runId}`,
      method: "GET",
      headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json<DiagnosticRun>();
    if (
      ["completed", "partial", "failed", "stopped", "interrupted"].includes(
        run.status,
      )
    )
      return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("diagnostic run did not finish in time");
}

describe("診断判断の適用条件 provenance", () => {
  it("decisionへ観測時contextを保存し、旧形式の判断は保存しても未知のままにする", () => {
    let state = newWorkflow("context-project", {
      target: "localrepo://fixture",
      version: "baseline",
      purpose: "静的レビュー",
      ownership: "fixture",
      allowedProviderIds: ["manual"],
      allowedMethods: ["static-review"],
    });
    state = applyWorkflowCommand(state, {
      type: "document",
      value: {
        title: "仕様",
        body: "TLS証明書検証を必須とする。",
        classification: "local",
      },
    });
    const ref = state.documents[0]!;
    state = applyWorkflowCommand(state, {
      type: "finding-observation",
      findingId: "known-context-finding",
      fingerprint: "known-context-fingerprint",
      targetVersion: "baseline",
      observation: "hash付き観測",
      sourceRefs: [{ docId: ref.id, revision: ref.revision, excerpt: "TLS" }],
      contextHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
    });
    state = applyWorkflowCommand(state, {
      type: "finding-decision",
      findingId: "known-context-finding",
      judgment: "accepted_known",
      actor: "test-subject",
      reason: "テスト用の判断",
      targetVersion: "baseline",
      sourceRefs: [{ docId: ref.id, revision: ref.revision, excerpt: "TLS" }],
      ruleRefs: [],
    });
    expect(state.findings[0]?.decisions.at(-1)).toMatchObject({
      contextHash: "a".repeat(64),
      evidenceHash: "b".repeat(64),
    });

    state = applyWorkflowCommand(state, {
      type: "finding-observation",
      findingId: "legacy-context-finding",
      fingerprint: "legacy-context-fingerprint",
      targetVersion: "baseline",
      observation: "hashなし旧観測",
      sourceRefs: [{ docId: ref.id, revision: ref.revision, excerpt: "TLS" }],
    });
    state = applyWorkflowCommand(state, {
      type: "finding-decision",
      findingId: "legacy-context-finding",
      judgment: "accepted_known",
      actor: "test-subject",
      reason: "旧形式のテスト判断",
      targetVersion: "baseline",
      sourceRefs: [{ docId: ref.id, revision: ref.revision, excerpt: "TLS" }],
      ruleRefs: [],
    });
    expect(state.findings[1]?.decisions.at(-1)).not.toHaveProperty(
      "contextHash",
    );
    expect(state.findings[1]?.decisions.at(-1)).not.toHaveProperty(
      "evidenceHash",
    );
  });

  it("仕様revision変更後に旧判断をmodel入力へ残さず、同条件では再利用する", async () => {
    const fixtureRoot = await mkdtemp(
      resolve(".cache", "diagnostic-judgment-context-"),
    );
    const fixture = await createDiagnosticFixture(fixtureRoot);
    const prompts: string[] = [];
    const app = await createApp({
      dbPath: ":memory:",
      diagnosticsRepositories: { fixture: fixture.directory },
      diagnosticsFetch: async () => {
        throw new Error("外部依存照会はこの試験では許可しません");
      },
      workflowProviders: [provider],
      workflowInvokeModel: async (_provider, prompt) => {
        prompts.push(prompt);
        return {
          response: responseFor(prompt),
          model: provider.model,
          configVersion: provider.configVersion,
          actualCostUsd: 0,
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    });
    const call = async (url: string, body?: unknown) =>
      app.inject({
        url,
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    try {
      const created = await call("/api/products", {
        title: "判断contextの仕様変更回帰",
        repositoryId: "fixture",
        ref: "baseline",
        specification: "TLS接続の証明書検証を必須とする。",
        allowDependencyNetwork: false,
        modelReview: {
          enabled: true,
          providerId: "local",
          cloudConsent: false,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const product = created.json<Product>();
      const startRun = async () => {
        const started = await call(`/api/products/${product.id}/runs`, {
          trigger: "manual",
          ref: "baseline",
        });
        expect(started.statusCode, started.body).toBe(202);
        return runToCompletion(
          app,
          product.id,
          started.json<DiagnosticRun>().id,
        );
      };

      const first = await startRun();
      const firstModel = first.findings.find((item) => item.engine === "model");
      expect(firstModel).toBeTruthy();
      const workflowUrl = `/api/projects/${product.linkedProjectId}/workflow`;
      let workflowResponse = await call(workflowUrl);
      let workflow = workflowResponse.json<{
        revision: number;
        findings: {
          id: string;
          fingerprint: string;
          targetVersion: string;
          sourceRefs: { docId: string; revision: number; excerpt: string }[];
          observationHistory: {
            contextHash?: string;
            evidenceHash?: string;
          }[];
        }[];
      }>();
      const linked = workflow.findings.find(
        (item) => item.id === firstModel!.workflowFindingId,
      );
      expect(linked).toBeTruthy();
      if (!linked) throw new Error("model findingのworkflow linkがありません");
      const legacyObservation = await call(`${workflowUrl}/commands`, {
        revision: workflow.revision,
        command: {
          type: "finding-observation",
          findingId: "legacy-input-judgment",
          fingerprint: "legacy-input-fingerprint",
          targetVersion: linked.targetVersion,
          observation: "hashなし旧判断",
          sourceRefs: linked.sourceRefs,
        },
      });
      expect(legacyObservation.statusCode, legacyObservation.body).toBe(200);
      workflow = legacyObservation.json();
      const legacyDecision = await call(`${workflowUrl}/commands`, {
        revision: workflow.revision,
        command: {
          type: "finding-decision",
          findingId: "legacy-input-judgment",
          judgment: "accepted_known",
          actor: "legacy-fixture",
          reason: "旧形式のテスト判断",
          targetVersion: linked.targetVersion,
          sourceRefs: linked.sourceRefs,
          ruleRefs: [],
        },
      });
      expect(legacyDecision.statusCode, legacyDecision.body).toBe(200);
      workflow = legacyDecision.json();
      const decisionBody = {
        revision: workflow.revision,
        command: {
          type: "finding-decision",
          findingId: linked.id,
          judgment: "accepted_known",
          actor: "contract-test-subject",
          reason: "テスト用の判断であり、実利用者の判定ではない。",
          targetVersion: linked.targetVersion,
          sourceRefs: linked.sourceRefs,
          ruleRefs: [],
        },
      };
      workflowResponse = await call(`${workflowUrl}/commands`, decisionBody);
      expect(workflowResponse.statusCode, workflowResponse.body).toBe(200);
      workflow = workflowResponse.json();
      const suppression = await call(`${workflowUrl}/commands`, {
        revision: workflow.revision,
        command: {
          type: "suppression",
          findingId: linked.id,
          actor: "contract-test-subject",
          reason: "同条件の試験用判断を再利用する",
          targetVersion: linked.targetVersion,
          fingerprint: linked.fingerprint,
          ruleRefs: [],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      });
      expect(suppression.statusCode, suppression.body).toBe(200);

      const reused = await startRun();
      expect(
        reused.findings.find(
          (finding) => finding.workflowFindingId === linked.id,
        ),
      ).toMatchObject({
        reviewDisposition: "suppressed_human",
        suppression: { status: "active", reused: true },
      });
      expect(payloadFromPrompt(prompts[1]!).matchingPastJudgments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: expect.stringContaining(`${linked.id}-decision-`) }),
        ]),
      );
      expect(payloadFromPrompt(prompts[1]!).matchingPastJudgments).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "legacy-input-judgment-decision-2" }),
        ]),
      );

      // Simulate a persisted partial-migration/corruption row: the latest
      // observation keeps the evidence hash but carries a context hash that
      // was not captured by the decision.  Such a decision must be excluded
      // before both model input and suppression evaluation can reuse it.
      workflow = (await call(workflowUrl)).json();
      const latestObservation = workflow.findings
        .find((item) => item.id === linked.id)
        ?.observationHistory.at(-1);
      expect(latestObservation?.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
      const corruptedObservation = await call(`${workflowUrl}/commands`, {
        revision: workflow.revision,
        command: {
          type: "finding-observation",
          findingId: linked.id,
          fingerprint: linked.fingerprint,
          targetVersion: linked.targetVersion,
          observation: "不整合なcontext hashを持つ旧観測",
          sourceRefs: linked.sourceRefs,
          contextHash: "f".repeat(64),
          evidenceHash: latestObservation!.evidenceHash,
        },
      });
      expect(corruptedObservation.statusCode, corruptedObservation.body).toBe(
        200,
      );
      const corrupted = await startRun();
      expect(payloadFromPrompt(prompts[2]!).matchingPastJudgments).toEqual([]);
      expect(
        corrupted.findings.find(
          (finding) => finding.workflowFindingId === linked.id,
        ),
      ).toMatchObject({
        reviewDisposition: "confirmation_required",
        suppression: expect.objectContaining({
          status: "invalidated",
          reused: false,
        }),
      });

      const current = (await call(`/api/products/${product.id}`)).json<{
        product: Product;
      }>().product;
      const changed = await call(`/api/products/${product.id}/settings`, {
        revision: current.revision,
        specification: "TLS接続の証明書検証と監査ログを必須とする。",
      });
      expect(changed.statusCode, changed.body).toBe(200);
      await startRun();
      expect(payloadFromPrompt(prompts[3]!).matchingPastJudgments).toEqual([]);
    } finally {
      await app.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("source_scopeは文言変更を再利用し、根拠資料の公開改版後は再確認へ戻す", async () => {
    const fixtureRoot = await mkdtemp(
      resolve(".cache", "diagnostic-source-scope-history-"),
    );
    const fixture = await createDiagnosticFixture(fixtureRoot);
    const prompts: string[] = [];
    let runNumber = 0;
    let wording = "固定snapshotの通信設定を製品仕様と照合する。";
    const app = await createApp({
      dbPath: ":memory:",
      diagnosticsRepositories: { fixture: fixture.directory },
      diagnosticsFetch: async () => {
        throw new Error("外部依存照会はこの試験では許可しません");
      },
      workflowProviders: [provider],
      workflowInvokeModel: async (_provider, prompt) => {
        prompts.push(prompt);
        const response = responseFor(prompt)
          .replace(
            "固定snapshotの通信設定を製品仕様と照合する。",
            wording,
          )
          .replace(
            "担当者が用途・仕様と通信設定を確認する。",
            runNumber === 0
              ? "担当者が用途・仕様と通信設定を確認する。"
              : "担当者が監査用途と通信設定を再確認する。",
          );
        return {
          response,
          model: provider.model,
          configVersion: provider.configVersion,
          actualCostUsd: 0,
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    });
    const call = async (url: string, body?: unknown) =>
      app.inject({
        url,
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    type SourceRef = { docId: string; revision: number; excerpt: string };
    type WorkflowView = {
      revision: number;
      documents: {
        id: string;
        title: string;
        body: string;
        url?: string;
        classification: string;
        revision: number;
      }[];
      findings: {
        id: string;
        fingerprint: string;
        targetVersion: string;
        sourceRefs: SourceRef[];
        judgment: string;
        decisions: { revision: number }[];
        suppressions: { active: boolean; matchPolicy?: string }[];
      }[];
    };
    try {
      const created = await call("/api/products", {
        title: "source_scopeの根拠履歴回帰",
        repositoryId: "fixture",
        ref: "baseline",
        specification: "TLS接続の証明書検証を必須とする。",
        allowDependencyNetwork: false,
        modelReview: {
          enabled: true,
          providerId: "local",
          cloudConsent: false,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const product = created.json<Product>();
      const workflowUrl = `/api/projects/${product.linkedProjectId}/workflow`;
      const startRun = async () => {
        wording =
          runNumber === 0
            ? "固定snapshotの通信設定を製品仕様と照合する。"
            : "固定snapshotの通信設定を監査用途と照合する。";
        const started = await call(`/api/products/${product.id}/runs`, {
          trigger: "manual",
          ref: "baseline",
        });
        expect(started.statusCode, started.body).toBe(202);
        const completed = await runToCompletion(
          app,
          product.id,
          started.json<DiagnosticRun>().id,
        );
        runNumber += 1;
        return completed;
      };

      const first = await startRun();
      expect(prompts).toHaveLength(1);
      const firstModel = first.findings.find((item) => item.engine === "model");
      expect(firstModel?.workflowFindingId).toBeTruthy();
      const firstWorkflowResponse = await call(workflowUrl);
      let workflow = firstWorkflowResponse.json<WorkflowView>();
      const linked = workflow.findings.find(
        (finding) => finding.id === firstModel!.workflowFindingId,
      );
      expect(linked).toBeTruthy();
      if (!linked) throw new Error("model findingのworkflow linkがありません");
      const initialEvidenceRef = linked.sourceRefs[0]!;

      const command = async (value: unknown) => {
        const response = await call(`${workflowUrl}/commands`, {
          revision: workflow.revision,
          command: value,
        });
        expect(response.statusCode, response.body).toBe(200);
        workflow = response.json<WorkflowView>();
        return workflow;
      };
      await command({
        type: "finding-decision",
        findingId: linked.id,
        judgment: "accepted_known",
        actor: "contract-test-subject",
        reason: "同じ固定範囲の試験用判断を記録する。",
        targetVersion: linked.targetVersion,
        sourceRefs: linked.sourceRefs,
        ruleRefs: [],
      });
      await command({
        type: "suppression",
        findingId: linked.id,
        actor: "contract-test-subject",
        reason: "同じsource bindingの範囲だけ再利用する。",
        targetVersion: linked.targetVersion,
        fingerprint: linked.fingerprint,
        ruleRefs: [],
        matchPolicy: "source_scope",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(workflow.findings.find((item) => item.id === linked.id)).toMatchObject({
        judgment: "accepted_known",
        suppressions: [{ active: true, matchPolicy: "source_scope" }],
      });

      const second = await startRun();
      expect(prompts).toHaveLength(2);
      const secondModel = second.findings.find((item) => item.engine === "model");
      expect(secondModel).toMatchObject({
        workflowFindingId: linked.id,
        reviewDisposition: "suppressed_human",
        suppression: {
          status: "active",
          reused: true,
          matchPolicy: "source_scope",
        },
      });
      expect(secondModel?.evidence).not.toBe(firstModel?.evidence);
      expect(payloadFromPrompt(prompts[1]!).matchingPastJudgments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringContaining(`${linked.id}-decision-`),
          }),
        ]),
      );

      // Keep the same source binding and wording for one more real run.  The
      // prior decision must remain eligible, and the raw model candidate must
      // remain present while the source-scope suppression is reused.
      const third = await startRun();
      expect(prompts).toHaveLength(3);
      const thirdModel = third.findings.find((item) => item.engine === "model");
      expect(thirdModel).toMatchObject({
        workflowFindingId: linked.id,
        reviewDisposition: "suppressed_human",
        suppression: {
          status: "active",
          reused: true,
          matchPolicy: "source_scope",
        },
      });
      expect(thirdModel?.presentInAnalysis).toBe(true);
      expect(payloadFromPrompt(prompts[2]!).matchingPastJudgments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringContaining(`${linked.id}-decision-`),
          }),
        ]),
      );

      // Revise the actual evidence document through the public workflow API.
      // The domain must retain its audit history but immediately invalidate
      // the old judgment/suppression before the next diagnostic.
      workflow = (await call(workflowUrl)).json<WorkflowView>();
      const evidenceDocument = workflow.documents.find(
        (document) => document.id === initialEvidenceRef.docId,
      );
      expect(evidenceDocument).toBeTruthy();
      if (!evidenceDocument) throw new Error("診断根拠資料がありません");
      await command({
        type: "document",
        documentId: evidenceDocument.id,
        value: {
          title: evidenceDocument.title,
          body: `${evidenceDocument.body}\n根拠資料の改版を記録する。`,
          ...(evidenceDocument.url ? { url: evidenceDocument.url } : {}),
          classification: evidenceDocument.classification,
        },
      });
      const invalidated = workflow.findings.find(
        (finding) => finding.id === linked.id,
      );
      expect(invalidated).toMatchObject({
        judgment: "unconfirmed",
        suppressions: [{ active: false }],
      });
      expect(invalidated?.decisions).toHaveLength(1);

      const fourth = await startRun();
      expect(prompts).toHaveLength(4);
      expect(payloadFromPrompt(prompts[3]!).matchingPastJudgments).toEqual([]);
      expect(
        fourth.findings.find((item) => item.workflowFindingId === linked.id),
      ).toMatchObject({
        reviewDisposition: "confirmation_required",
        suppression: { reused: false },
      });
    } finally {
      await app.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("旧source_scopeの出典revisionはhistoryを検証し、欠損資料は再利用しない", async () => {
    const fixtureRoot = await mkdtemp(
      resolve(".cache", "diagnostic-source-scope-legacy-"),
    );
    const fixture = await createDiagnosticFixture(fixtureRoot);
    const store = new Store(":memory:");
    const prompts: string[] = [];
    const service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
      workflowProviders: [provider],
      workflowInvokeModel: async (_provider, prompt) => {
        prompts.push(prompt);
        return {
          response: responseFor(prompt),
          model: provider.model,
          configVersion: provider.configVersion,
          actualCostUsd: 0,
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    });
    const waitForRun = async (productId: string, runId: string) => {
      let run = service.getRun(productId, runId);
      for (let attempt = 0; attempt < 500; attempt++) {
        if (
          ["completed", "partial", "failed", "stopped", "interrupted"].includes(
            run.status,
          )
        )
          return run;
        await new Promise((resolve) => setTimeout(resolve, 10));
        run = service.getRun(productId, runId);
      }
      throw new Error("diagnostic run did not finish in time");
    };
    try {
      const product = service.createProduct({
        title: "旧source_scope出典履歴の回帰",
        repositoryId: "fixture",
        ref: "baseline",
        specification: "TLS接続の証明書検証を必須とする。",
        modelReview: {
          enabled: true,
          providerId: "local",
          cloudConsent: false,
        },
      });
      const firstStarted = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const first = await waitForRun(product.id, firstStarted.id);
      const firstModel = first.findings.find((item) => item.engine === "model");
      expect(firstModel?.workflowFindingId).toBeTruthy();
      const workflows = new WorkflowStore(store);
      let state = workflows.get(product.linkedProjectId);
      const finding = state.findings.find(
        (item) => item.id === firstModel!.workflowFindingId,
      );
      expect(finding).toBeDefined();
      if (!finding) throw new Error("model findingのworkflow linkがありません");
      const sourceRef = finding.sourceRefs[0]!;
      state = workflows.command(product.linkedProjectId, state.revision, {
        type: "finding-decision",
        findingId: finding.id,
        judgment: "accepted_known",
        actor: "contract-test-subject",
        reason: "旧source_scopeの保存境界を確認する。",
        targetVersion: finding.targetVersion,
        sourceRefs: finding.sourceRefs,
        ruleRefs: [],
      });
      state = workflows.command(product.linkedProjectId, state.revision, {
        type: "suppression",
        findingId: finding.id,
        actor: "contract-test-subject",
        reason: "検証済みsource bindingの範囲だけ再利用する。",
        targetVersion: finding.targetVersion,
        fingerprint: finding.fingerprint,
        ruleRefs: [],
        matchPolicy: "source_scope",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      const evidenceDocument = state.documents.find(
        (document) => document.id === sourceRef.docId,
      );
      expect(evidenceDocument).toBeDefined();
      if (!evidenceDocument) throw new Error("診断根拠資料がありません");

      // Reproduce a pre-migration persisted row: the document revision and
      // history are valid, but the old active source-scope review was not
      // reopened when the document changed.  This is a meaningful recovery
      // boundary for the service's positive history check.
      const revised = applyWorkflowCommand(state, {
        type: "document",
        documentId: evidenceDocument.id,
        value: {
          title: evidenceDocument.title,
          body: `${evidenceDocument.body}\n保存済み根拠の文言を改版する。`,
          ...(evidenceDocument.url ? { url: evidenceDocument.url } : {}),
          classification: evidenceDocument.classification,
        },
      });
      const preservedReviewState = structuredClone(state.findings);
      state = workflows.update(product.linkedProjectId, state.revision, () => ({
        ...revised,
        findings: preservedReviewState,
      }));
      const currentDocument = state.documents.find(
        (document) => document.id === evidenceDocument.id,
      )!;
      expect(currentDocument.revision).toBe(sourceRef.revision + 1);
      expect(currentDocument.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            revision: sourceRef.revision,
            body: evidenceDocument.body,
          }),
        ]),
      );

      const historyStarted = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const historyRun = await waitForRun(product.id, historyStarted.id);
      expect(prompts).toHaveLength(2);
      expect(payloadFromPrompt(prompts[1]!).matchingPastJudgments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringContaining(`${finding.id}-decision-`),
          }),
        ]),
      );
      expect(
        historyRun.findings.find(
          (item) => item.workflowFindingId === finding.id,
        ),
      ).toMatchObject({
        presentInAnalysis: true,
        reviewDisposition: "suppressed_human",
        suppression: { reused: true, matchPolicy: "source_scope" },
      });

      // A missing source document is an old/corrupt persisted boundary.  It
      // must remove the judgment from model context rather than trusting the
      // source-scope policy merely because its binding still matches.
      state = workflows.get(product.linkedProjectId);
      state = workflows.update(product.linkedProjectId, state.revision, (current) => ({
        ...current,
        documents: current.documents.filter(
          (document) => document.id !== evidenceDocument.id,
        ),
      }));
      const missingStarted = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const missingRun = await waitForRun(product.id, missingStarted.id);
      expect(prompts).toHaveLength(3);
      expect(payloadFromPrompt(prompts[2]!).matchingPastJudgments).toEqual([]);
      expect(
        missingRun.findings.find(
          (item) => item.workflowFindingId === finding.id,
        ),
      ).toMatchObject({
        presentInAnalysis: true,
        reviewDisposition: "confirmation_required",
        suppression: { reused: false },
      });
    } finally {
      await service.close();
      store.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
