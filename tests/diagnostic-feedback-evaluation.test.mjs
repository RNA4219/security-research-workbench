import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import {
  referenceData,
  runDiagnosticFeedbackEvaluation,
  validateFeedbackPhase as validatePhase,
} from "../scripts/diagnostic-feedback-evaluation.mjs";

describe("feedback evidence gate", () => {
  const commit = "a".repeat(40);
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const content = "fixture source";
  const specification = "fixture specification";
  const file = {
    path: "src/example.ts",
    hash: hash(content),
    lines: [{ line: 1, text: content }],
  };
  const expectedIdentity = {
    specification,
    source: { files: [{ path: file.path, sha256: file.hash, content }] },
  };
  const validateFeedbackPhase = (run, entries, expectedCommit) =>
    validatePhase(run, entries, expectedCommit, expectedIdentity);
  const completed = () => ({
    status: "completed",
    commit,
    manifestHash: "c".repeat(64),
    specificationRevision: 1,
    snapshotFiles: [{ path: file.path, hash: file.hash }],
    modelReview: {
      coverage: {
        status: "complete",
        batchCount: 1,
        completedBatchCount: 1,
        omitted: [],
      },
      record: { status: "completed" },
    },
  });
  const invocation = () => ({
    response: "{}",
    error: null,
    reference: {
      targetVersion: commit,
      pinnedSnapshot: {
        commit,
        manifestHash: "c".repeat(64),
        files: [structuredClone(file)],
      },
      specificationRefs: [
        {
          id: "product-specification",
          excerpt: specification,
          version: "1",
          hash: hash(specification),
        },
      ],
    },
  });

  it.each(["partial", "failed", "stopped"])(
    "候補があっても%s runを合格にしない",
    (status) => {
      const run = {
        ...completed(),
        status,
        findings: [{ engine: "model", presentInAnalysis: true }],
      };
      expect(validateFeedbackPhase(run, [invocation()], commit)).toContain(
        "診断runが完了していません",
      );
    },
  );

  it("欠けたモデル範囲・古いcommit・証跡エラー・呼出し欠落を合格にしない", () => {
    const run = completed();
    run.modelReview.coverage.completedBatchCount = 0;
    expect(validateFeedbackPhase(run, [invocation()], commit)).not.toEqual([]);
    expect(
      validateFeedbackPhase(completed(), [invocation()], "b".repeat(40)),
    ).not.toEqual([]);
    expect(
      validateFeedbackPhase(
        completed(),
        [{ ...invocation(), error: "参照資料が不正" }],
        commit,
      ),
    ).not.toEqual([]);
    expect(
      validateFeedbackPhase(
        completed(),
        [{ ...invocation(), reference: null }],
        commit,
      ),
    ).not.toEqual([]);
    expect(validateFeedbackPhase(completed(), [], commit)).not.toEqual([]);
    expect(validateFeedbackPhase(completed(), [invocation()], commit)).toEqual(
      [],
    );
  });

  it("prompt内の固定参照資料が欠けていたら抽出成功にしない", () => {
    const payload = {
      targetVersion: commit,
      pinnedSnapshot: { commit, manifestHash: "c".repeat(64), files: [file] },
      specificationRefs: [{ id: "spec" }],
      matchingPastJudgments: [],
    };
    const prompt = (value) =>
      `BEGIN_REFERENCE_DATA_JSON\n${JSON.stringify(value)}\nEND_REFERENCE_DATA_JSON`;
    expect(referenceData(prompt(payload))).toEqual(payload);
    expect(() => referenceData("missing markers")).toThrow();
    expect(() =>
      referenceData(prompt({ ...payload, matchingPastJudgments: undefined })),
    ).toThrow();
    expect(() =>
      referenceData(prompt({ ...payload, specificationRefs: null })),
    ).toThrow();
    expect(() =>
      referenceData(prompt({ ...payload, targetVersion: "b".repeat(40) })),
    ).toThrow();
    expect(() =>
      referenceData(
        prompt({
          ...payload,
          pinnedSnapshot: { ...payload.pinnedSnapshot, files: [{}] },
        }),
      ),
    ).toThrow();
  });

  it("同一commitを名乗る別snapshot・改変原文・旧仕様を合格にしない", () => {
    const changedSnapshot = invocation();
    changedSnapshot.reference.pinnedSnapshot.manifestHash = "d".repeat(64);
    expect(
      validateFeedbackPhase(completed(), [changedSnapshot], commit),
    ).toContain("モデル入力と診断runのsnapshotが一致しません");
    const changedSource = invocation();
    changedSource.reference.pinnedSnapshot.files[0].lines[0].text =
      "different source";
    expect(
      validateFeedbackPhase(completed(), [changedSource], commit),
    ).toContain("モデル入力のファイルhash・原文がfixtureと一致しません");
    const changedSpec = invocation();
    changedSpec.reference.specificationRefs[0].version = "0";
    expect(validateFeedbackPhase(completed(), [changedSpec], commit)).toContain(
      "モデル入力の製品仕様・版・hashが一致しません",
    );
  });
});

describe("product diagnostic feedback evaluation", () => {
  it("contract modeで候補保持・同条件抑止・仕様変更再確認を公開API経由で検証する", async () => {
    const output = await mkdtemp(join(".cache", "diagnostic-feedback-test-"));
    try {
      const artifact = await runDiagnosticFeedbackEvaluation({
        mode: "contract",
        outputDir: output,
        createApp,
      });
      expect(artifact.gate).toMatchObject({
        status: "pass",
        realModelUsed: false,
        humanTimeMeasured: false,
        recheckPriorDecisionProvidedByModel: false,
      });
      expect(artifact.mode).toBe("contract");
      expect(artifact.execution).toMatchObject({
        modelReviewTimeoutMs: 120_000,
        pollIntervalMs: 10,
        runWaitTimeoutMs: 30_000,
        modelReviewBudget: {
          maxOutputTokens: 2048,
        },
      });
      expect(
        artifact.execution.actualModelReviewBudgets.every(
          (item) => item.budget?.maxOutputTokens === 2048,
        ),
      ).toBe(true);
      expect(artifact.phases).toHaveLength(3);
      expect(artifact.invocations.count).toBe(3);
      expect(artifact.phases[0].run.modelCandidateCount).toBeGreaterThan(0);
      expect(artifact.phases[0].run.modelQueueRequiredCount).toBeGreaterThan(0);
      expect(artifact.phases[1].run.modelSuppressedCount).toBe(1);
      expect(artifact.phases[1].run.modelQueueRequiredCount).toBe(0);
      expect(artifact.phases[2].run.modelSuppressedCount).toBe(0);
      expect(artifact.phases[2].run.modelQueueRequiredCount).toBeGreaterThan(0);
      expect(artifact.phases[0].run.rawModelCandidates.length).toBeGreaterThan(
        0,
      );
      expect(artifact.phases[1].run.confirmationQueueCandidates).toHaveLength(
        0,
      );
      expect(artifact.humanJudgments).toHaveLength(2);
      expect(artifact.humanJudgments[1].command.expiresAt).toBe(
        "2099-01-01T00:00:00.000Z",
      );
      expect(artifact.feedbackChecks).toMatchObject({
        sameConditionSuppression: {
          status: "pass",
          suppressionReused: true,
        },
        specificationReconfirmation: {
          status: "pass",
          suppressionReused: false,
          reviewDisposition: "confirmation_required",
        },
      });
      expect(
        artifact.invocations.modelInputReferences[1].matchingPastJudgmentIds
          .length,
      ).toBeGreaterThan(0);
      expect(
        artifact.invocations.modelInputReferences[2].matchingPastJudgmentIds,
      ).toEqual([]);
      expect(artifact.fixture.sourceSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
      const raw = JSON.parse(
        await readFile(join(output, "raw-invocations.json"), "utf8"),
      );
      expect(raw).toHaveLength(3);
      expect(raw.every((entry) => entry.prompt && entry.response)).toBe(true);
      const source = JSON.parse(
        await readFile(join(output, "source-snapshot.json"), "utf8"),
      );
      expect(source.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "src/client.ts",
            sha256: expect.any(String),
          }),
        ]),
      );
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 30_000);

  it("既定の厳密比較では文章が変わると確認待ちのまま失敗証跡を残す", async () => {
    const output = await mkdtemp(join(".cache", "diagnostic-feedback-strict-"));
    try {
      await expect(
        runDiagnosticFeedbackEvaluation({
          mode: "contract",
          contractWordingVariation: true,
          outputDir: output,
          createApp,
        }),
      ).rejects.toThrow(/抑止が再利用されませんでした/);
      const artifact = JSON.parse(
        await readFile(join(output, "artifact.json"), "utf8"),
      );
      expect(artifact.matchPolicy).toBe("exact_evidence");
      expect(artifact.gate.status).toBe("fail");
      expect(artifact.invocations.count).toBe(2);
      expect(artifact.phases[1].run.modelQueueRequiredCount).toBe(1);
      expect(artifact.phases[1].run.modelSuppressedCount).toBe(0);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 30_000);

  it("人が明示したコード範囲なら文章変更を含めて再利用し、仕様変更は再確認する", async () => {
    const output = await mkdtemp(join(".cache", "diagnostic-feedback-scope-"));
    try {
      const artifact = await runDiagnosticFeedbackEvaluation({
        mode: "contract",
        matchPolicy: "source_scope",
        contractWordingVariation: true,
        outputDir: output,
        createApp,
      });
      expect(artifact.matchPolicy).toBe("source_scope");
      expect(artifact.gate).toMatchObject({
        status: "pass",
        realModelUsed: false,
      });
      expect(artifact.invocations.count).toBe(3);
      expect(artifact.phases[1].run.modelCurrentCount).toBe(1);
      expect(artifact.phases[1].run.modelSuppressedCount).toBe(1);
      expect(artifact.phases[1].run.modelQueueRequiredCount).toBe(0);
      expect(artifact.phases[2].run.modelSuppressedCount).toBe(0);
      expect(artifact.phases[2].run.modelQueueRequiredCount).toBe(1);
      expect(artifact.humanJudgments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: expect.objectContaining({
              type: "suppression",
              matchPolicy: "source_scope",
            }),
          }),
        ]),
      );
      const raw = JSON.parse(
        await readFile(join(output, "raw-invocations.json"), "utf8"),
      );
      expect(JSON.parse(raw[0].response).findings[0].title).not.toBe(
        JSON.parse(raw[1].response).findings[0].title,
      );
      expect(
        artifact.invocations.modelInputReferences[2].matchingPastJudgmentIds,
      ).toEqual([]);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 30_000);

  it("live modeはlocal provider設定がなければ固定応答へfallbackせず停止する", async () => {
    const output = await mkdtemp(
      join(".cache", "diagnostic-feedback-live-test-"),
    );
    const previousLocalUrl = process.env.WORKFLOW_LOCAL_URL;
    delete process.env.WORKFLOW_LOCAL_URL;
    try {
      await expect(
        runDiagnosticFeedbackEvaluation({ mode: "live", outputDir: output }),
      ).rejects.toThrow(/local provider|endpoint設定/);
      expect(await readdir(output)).toEqual(
        expect.arrayContaining(["artifact.json", "raw-invocations.json"]),
      );
      const artifact = JSON.parse(
        await readFile(join(output, "artifact.json"), "utf8"),
      );
      expect(artifact.gate).toMatchObject({
        status: "fail",
        realModelUsed: false,
      });
      expect(artifact.invocations.count).toBe(0);
    } finally {
      if (previousLocalUrl === undefined) delete process.env.WORKFLOW_LOCAL_URL;
      else process.env.WORKFLOW_LOCAL_URL = previousLocalUrl;
      await rm(output, { recursive: true, force: true });
    }
  }, 30_000);

  it("既存の出力先をDBや証跡ごと上書きしない", async () => {
    const output = await mkdtemp(
      join(".cache", "diagnostic-feedback-output-test-"),
    );
    const marker = join(output, "existing-marker.txt");
    await writeFile(marker, "preserve", "utf8");
    try {
      await expect(
        runDiagnosticFeedbackEvaluation({
          mode: "contract",
          outputDir: output,
          createApp,
        }),
      ).rejects.toThrow(/出力先が空ではありません/);
      await expect(readFile(marker, "utf8")).resolves.toBe("preserve");
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
