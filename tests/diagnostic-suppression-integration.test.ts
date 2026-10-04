import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";
import { ProductDiagnosticsService } from "../src/server/diagnostic-service.js";
import { Store } from "../src/server/store.js";
import { WorkflowStore } from "../src/server/workflow-store.js";
import { isDiagnosticFindingSuppressed } from "../src/shared/product-diagnostics.js";
import type { WorkflowProviderDefinition } from "../src/server/workflow-runner.js";

const payload = (title: string) => ({
  title,
  repositoryId: "fixture",
  ref: "baseline",
  specification: `${title} の要件`,
});

const modelFindingResponse = () =>
  JSON.stringify({
    schemaVersion: "1",
    findings: [
      {
        id: "methodology-bound-model-finding",
        category: "trust-boundary",
        severity: "medium",
        title: "通信設定の仕様照合候補",
        rationale:
          "固定snapshotの通信設定を担当者が仕様と照合する必要があります。",
        path: "src/client.ts",
        line: 2,
        originalText:
          "export const client = new https.Agent({ rejectUnauthorized: false });",
        specRefIds: ["product-specification"],
        relatedFixedFindingIds: [],
        pastJudgmentIds: [],
        remediation: {
          guidance: "担当者が用途・仕様と通信設定を確認する。",
          humanReviewRequired: true,
        },
        falsePositiveCandidate: false,
        uncertainty: {
          level: "medium",
          reasons: ["モデル出力は候補であり安全性の証明ではありません。"],
        },
      },
    ],
    omitted: [],
    limitations: [],
  });

const methodologyProvider = (
  configVersion: string,
): WorkflowProviderDefinition => ({
  id: "local",
  kind: "local",
  label: "抑止methodology test local",
  model: "methodology-test-model",
  available: true,
  costKnown: true,
  configVersion,
  maxOutputTokens: 2048,
});

async function terminalRun(
  service: ProductDiagnosticsService,
  productId: string,
  runId: string,
) {
  let run = service.getRun(productId, runId);
  for (
    let index = 0;
    index < 300 && ["queued", "running"].includes(run.status);
    index++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = service.getRun(productId, runId);
  }
  return run;
}

describe("診断とworkflow抑止の統合", () => {
  let service: ProductDiagnosticsService | undefined;
  let store: Store | undefined;

  afterEach(async () => {
    await service?.close();
    store?.close();
    service = undefined;
    store = undefined;
  });

  it("明示的人判断の同一context/evidenceだけを別枠抑止し、raw候補と履歴を残す", async () => {
    const fixture = await createDiagnosticFixture();
    store = new Store(":memory:");
    service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
    });
    const product = service.createProduct(payload("suppression integration"));
    const first = await service.startRun(product.id, {
      trigger: "manual",
      ref: "baseline",
    });
    const completedFirst = await terminalRun(service, product.id, first.id);
    expect(
      ["partial", "completed"],
      completedFirst.failure ?? completedFirst.status,
    ).toContain(completedFirst.status);
    const candidate = completedFirst.findings.find(
      (finding) => finding.presentInAnalysis,
    );
    expect(candidate).toBeDefined();

    const workflows = new WorkflowStore(store);
    let state = workflows.get(product.linkedProjectId);
    const workflowFinding = state.findings.find(
      (finding) => finding.id === candidate!.workflowFindingId,
    );
    expect(workflowFinding).toBeDefined();
    expect(workflowFinding!.sourceRefs.length).toBeGreaterThan(0);
    state = workflows.command(product.linkedProjectId, state.revision, {
      type: "finding-decision",
      findingId: workflowFinding!.id,
      judgment: "accepted_known",
      actor: "reviewer",
      reason: "現行仕様と根拠を確認済み",
      targetVersion: completedFirst.commit!,
      sourceRefs: workflowFinding!.sourceRefs,
      ruleRefs: [],
    });
    state = workflows.command(product.linkedProjectId, state.revision, {
      type: "suppression",
      findingId: workflowFinding!.id,
      actor: "reviewer",
      reason: "同一commitと現行contextに限り再確認不要",
      targetVersion: completedFirst.commit!,
      fingerprint: workflowFinding!.fingerprint,
      ruleRefs: [],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(state.findings[0]!.suppressions[0]!.contextHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(state.findings[0]!.suppressions[0]!.evidenceHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const observationsBefore = state.findings.find(
      (finding) => finding.id === workflowFinding!.id,
    )!.observationHistory.length;

    const second = await service.startRun(product.id, {
      trigger: "manual",
      ref: "baseline",
    });
    const completedSecond = await terminalRun(service, product.id, second.id);
    expect(
      ["partial", "completed"],
      completedSecond.failure ?? completedSecond.status,
    ).toContain(completedSecond.status);
    const linked = completedSecond.findings.find(
      (finding) => finding.fingerprint === candidate!.fingerprint,
    );
    expect(linked).toMatchObject({
      presentInAnalysis: true,
      reviewDisposition: "suppressed_human",
      suppression: {
        status: "active",
        reused: true,
        decisionRevision: 2,
        judgment: "accepted_known",
      },
    });
    expect(linked?.workflowFindingId).toBe(workflowFinding!.id);
    expect(linked?.evidence).toBe(candidate!.evidence);
    expect(isDiagnosticFindingSuppressed(linked!)).toBe(true);
    expect(
      isDiagnosticFindingSuppressed({
        ...linked!,
        presentInAnalysis: false,
      }),
    ).toBe(false);
    expect(
      isDiagnosticFindingSuppressed({
        ...linked!,
        suppression: {
          ...linked!.suppression!,
          status: "unknown",
          reused: false,
        },
      }),
    ).toBe(false);
    const after = workflows.get(product.linkedProjectId);
    expect(
      after.findings.find((finding) => finding.id === workflowFinding!.id)!
        .observationHistory,
    ).toHaveLength(observationsBefore);
    expect(service.detail(product.id).runs[0]!.findingCounts).toMatchObject({
      suppressed: 1,
      needsReview: 0,
    });
    // A separate, currently applicable human judgment is part of the model
    // and diagnostic review context.  Changing it must invalidate the first
    // finding's reuse, while the first finding's own decision remains the
    // revision checked by the strict suppression helper.
    state = workflows.get(product.linkedProjectId);
    state = workflows.command(product.linkedProjectId, state.revision, {
      type: "finding-observation",
      findingId: "other-context-finding",
      fingerprint: "other-context-fingerprint",
      targetVersion: completedFirst.commit!,
      observation: "別findingの現行観測",
      sourceRefs: workflowFinding!.sourceRefs,
    });
    state = workflows.command(product.linkedProjectId, state.revision, {
      type: "finding-decision",
      findingId: "other-context-finding",
      judgment: "accepted_known",
      actor: "reviewer",
      reason: "別findingの条件を確認済み",
      targetVersion: completedFirst.commit!,
      sourceRefs: workflowFinding!.sourceRefs,
      ruleRefs: [],
    });
    const contextChangedRun = await service.startRun(product.id, {
      trigger: "manual",
      ref: "baseline",
    });
    const completedContextChanged = await terminalRun(
      service,
      product.id,
      contextChangedRun.id,
    );
    const contextChanged = completedContextChanged.findings.find(
      (finding) => finding.fingerprint === candidate!.fingerprint,
    );
    expect(contextChanged).toMatchObject({
      presentInAnalysis: true,
      reviewDisposition: "confirmation_required",
      suppression: {
        status: "invalidated",
        reason: "context_changed",
        reused: false,
      },
    });
    const updatedProduct = await service.updateProduct(
      product.id,
      product.revision,
      {
        ref: "fixed",
      },
    );
    const third = await service.startRun(updatedProduct.id, {
      trigger: "manual",
      ref: "fixed",
    });
    const completedThird = await terminalRun(
      service,
      updatedProduct.id,
      third.id,
    );
    const historical = completedThird.findings.find(
      (finding) => finding.fingerprint === candidate!.fingerprint,
    );
    expect(historical).toMatchObject({
      presentInAnalysis: false,
      reviewDisposition: "confirmation_required",
      suppression: { status: "unknown", reused: false, reason: "not_observed" },
    });
  });

  it("人判断がcheckpoint作成後に変わったresumeを拒否する", async () => {
    const fixture = await createDiagnosticFixture();
    store = new Store(":memory:");
    let aborted = false;
    service = new ProductDiagnosticsService(store, {
      repositories: { fixture: fixture.directory },
      scheduleIntervalMs: 0,
      workflowProviders: [
        {
          id: "local",
          kind: "local",
          label: "resume test local",
          model: "resume-test",
          available: true,
          costKnown: true,
          configVersion: "resume-test-v1",
          maxOutputTokens: 256,
        },
      ],
      workflowInvokeModel: async (_provider, _prompt, signal) =>
        await new Promise<never>((_resolve, reject) => {
          const stop = () => {
            aborted = true;
            reject(new Error("resume test aborted"));
          };
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
        }),
    });
    const product = service.createProduct({
      ...payload("resume decision change"),
      modelReview: {
        enabled: true,
        providerId: "local",
        cloudConsent: false,
      },
    });
    const workflows = new WorkflowStore(store);
    let state = workflows.get(product.linkedProjectId);
    state = workflows.command(product.linkedProjectId, state.revision, {
      type: "scope",
      value: { ...state.scope, version: fixture.commits.baseline },
    });
    const specification = state.documents.find(
      (document) => document.title === "製品仕様",
    )!;
    const sourceRef = {
      docId: specification.id,
      revision: specification.revision,
      excerpt: product.title,
    };
    state = workflows.command(product.linkedProjectId, state.revision, {
      type: "finding-observation",
      findingId: "resume-judgment",
      fingerprint: "resume-judgment-finding",
      targetVersion: fixture.commits.baseline,
      observation: "resume前の観測",
      sourceRefs: [sourceRef],
    });
    state = workflows.command(product.linkedProjectId, state.revision, {
      type: "finding-decision",
      findingId: "resume-judgment",
      judgment: "accepted_known",
      actor: "reviewer",
      reason: "resume前の判断",
      targetVersion: fixture.commits.baseline,
      sourceRefs: [sourceRef],
      ruleRefs: [],
    });
    const started = await service.startRun(product.id, {
      trigger: "manual",
      ref: "baseline",
    });
    let running = service.getRun(product.id, started.id);
    for (let attempt = 0; attempt < 300; attempt++) {
      if (running.progress.phase === "model_review") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
      running = service.getRun(product.id, started.id);
    }
    expect(running.progress.phase).toBe("model_review");
    const stopped = await service.stop(product.id, started.id);
    expect(aborted).toBe(true);
    expect(["stopped", "interrupted", "partial"]).toContain(stopped.status);
    state = workflows.get(product.linkedProjectId);
    state = workflows.command(product.linkedProjectId, state.revision, {
      type: "finding-decision",
      findingId: "resume-judgment",
      judgment: "needs_action",
      actor: "reviewer",
      reason: "resume後に再評価",
      targetVersion: fixture.commits.baseline,
      sourceRefs: [sourceRef],
      ruleRefs: [],
    });
    await expect(service.resume(product.id, started.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("model provider条件が変わったrunでは同じ抑止を再利用しない", async () => {
    const fixture = await createDiagnosticFixture();
    const dbDirectory = await mkdtemp(
      join(".cache", "diagnostic-methodology-"),
    );
    const dbPath = join(dbDirectory, "diagnostics.sqlite");
    const invokeModel = async (selected: WorkflowProviderDefinition) => ({
      response: modelFindingResponse(),
      model: selected.model,
      configVersion: selected.configVersion,
      actualCostUsd: 0,
    });
    try {
      store = new Store(dbPath);
      service = new ProductDiagnosticsService(store, {
        repositories: { fixture: fixture.directory },
        scheduleIntervalMs: 0,
        workflowProviders: [methodologyProvider("methodology-v1")],
        workflowInvokeModel: invokeModel,
      });
      const product = service.createProduct({
        ...payload("provider methodologyの抑止境界"),
        modelReview: {
          enabled: true,
          providerId: "local",
          cloudConsent: false,
        },
      });
      const first = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const completedFirst = await terminalRun(service, product.id, first.id);
      expect(completedFirst.modelReview?.coverage.status).toBe("complete");
      const candidate = completedFirst.findings.find(
        (finding) => finding.engine === "model" && finding.presentInAnalysis,
      );
      expect(candidate).toBeDefined();

      const workflows = new WorkflowStore(store);
      let state = workflows.get(product.linkedProjectId);
      const workflowFinding = state.findings.find(
        (finding) => finding.id === candidate!.workflowFindingId,
      );
      expect(workflowFinding).toBeDefined();
      state = workflows.command(product.linkedProjectId, state.revision, {
        type: "finding-decision",
        findingId: workflowFinding!.id,
        judgment: "accepted_known",
        actor: "reviewer",
        reason: "provider条件変更前の現行判断",
        targetVersion: completedFirst.commit!,
        sourceRefs: workflowFinding!.sourceRefs,
        ruleRefs: [],
      });
      workflows.command(product.linkedProjectId, state.revision, {
        type: "suppression",
        findingId: workflowFinding!.id,
        actor: "reviewer",
        reason: "同じ診断methodologyの再確認不要",
        targetVersion: completedFirst.commit!,
        fingerprint: workflowFinding!.fingerprint,
        ruleRefs: [],
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

      await service.close();
      service = undefined;
      store.close();
      store = undefined;
      store = new Store(dbPath);
      service = new ProductDiagnosticsService(store, {
        repositories: { fixture: fixture.directory },
        scheduleIntervalMs: 0,
        workflowProviders: [methodologyProvider("methodology-v2")],
        workflowInvokeModel: invokeModel,
      });

      const second = await service.startRun(product.id, {
        trigger: "manual",
        ref: "baseline",
      });
      const completedSecond = await terminalRun(service, product.id, second.id);
      const changed = completedSecond.findings.find(
        (finding) => finding.fingerprint === candidate!.fingerprint,
      );
      expect(changed).toMatchObject({
        presentInAnalysis: true,
        delta: "needs_review",
        reviewDisposition: "confirmation_required",
        suppression: {
          status: "invalidated",
          reason: "context_changed",
          reused: false,
        },
      });
    } finally {
      await service?.close();
      store?.close();
      service = undefined;
      store = undefined;
      await rm(dbDirectory, { recursive: true, force: true });
    }
  });
});
