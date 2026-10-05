import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReviewInput,
  calculateMetrics,
  captureSourceBundle,
  corpusDatasetHash,
  createReviewSnapshotEngine,
  loadCorpus,
  matchFindings,
  preflightManifest,
  runEvaluation,
  resolveUsage,
  sha256Text,
  SOURCE_BUNDLE_ENTRIES,
} from "../scripts/model-review-evaluation.mjs";
import { writePostrunEvidence } from "../scripts/model-review-postrun.mjs";

const corpus = await loadCorpus();
const manifest = JSON.parse(
  await readFile("evaluations/model-review/manifest.json", "utf8"),
);
const testManifest = structuredClone(manifest);
testManifest.identity.runner.sha256 = `sha256:${sha256Text(
  await readFile("scripts/model-review-evaluation.mjs", "utf8"),
)}`;
for (const identityName of ["legacy", "candidate", "engine", "adapter", "provider"]) {
  const identity = testManifest.identity[identityName];
  if (identity?.source_path) {
    identity.source_sha256 = `sha256:${sha256Text(
      await readFile(identity.source_path, "utf8"),
    )}`;
  }
}
const fixtureManifest = structuredClone(testManifest);
fixtureManifest.evaluation.configuration.repetitions = 2;

it("keeps missing and invalid token counts unknown while preserving an actual zero", () => {
  expect(
    resolveUsage({ inputTokens: null, outputTokens: null, totalTokens: null }),
  ).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  expect(resolveUsage({ promptTokens: 0, completionTokens: 5 })).toEqual({
    inputTokens: 0,
    outputTokens: 5,
    totalTokens: null,
  });
  expect(
    resolveUsage({ inputTokens: "", outputTokens: -1, totalTokens: 1.5 }),
  ).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
});

describe("model review evaluation corpus", () => {
  it("keeps a product corpus split into development and holdout with six categories", () => {
    expect(corpus.cases.development).toHaveLength(9);
    expect(corpus.cases.holdout).toHaveLength(8);
    expect(corpus.goldBySplit.development.size).toBe(9);
    expect(corpus.goldBySplit.holdout.size).toBe(8);
    const categories = new Set(
      [
        ...corpus.goldBySplit.development.values(),
        ...corpus.goldBySplit.holdout.values(),
      ].flatMap((gold) => gold.findings.map((finding) => finding.category)),
    );
    expect(categories).toEqual(
      new Set([
        "authorization",
        "tenant-isolation",
        "input-validation",
        "state-transition",
        "pii-logging",
        "cryptography",
      ]),
    );
    expect(corpusDatasetHash(corpus)).toBe(manifest.evaluation.dataset_sha256);
  });

  it("exposes only the intended context for A, B, and C", () => {
    const testCase = corpus.cases.development.find(({ id }) => id === "a08");
    expect(testCase).toBeDefined();
    const a = buildReviewInput(testCase, "A", corpus.product);
    const b = buildReviewInput(testCase, "B", corpus.product);
    const c = buildReviewInput(testCase, "C", corpus.product);
    expect(a).not.toHaveProperty("specification");
    expect(a).not.toHaveProperty("approvedKnowledge");
    expect(a).not.toHaveProperty("approvedDecisionHistory");
    expect(b).toHaveProperty("specification");
    expect(b).toHaveProperty("approvedKnowledge");
    expect(b).not.toHaveProperty("approvedDecisionHistory");
    expect(c).toHaveProperty("approvedDecisionHistory");
    expect(c.approvedDecisionHistory).toHaveLength(1);
    expect(c.approvedDecisionHistory[0]).toHaveProperty("reason");
  });
});

describe("deterministic matching and metrics", () => {
  const finding = {
    path: "src/a.js",
    category: "authorization",
    lineStart: 2,
    lineEnd: 2,
    anchor: "return value;",
    requiresHumanConfirmation: true,
  };

  it("counts duplicate re-output as a false positive while reporting it separately", () => {
    const matched = matchFindings([finding, { ...finding }], [finding]);
    expect(matched.truePositiveCount).toBe(1);
    expect(matched.falsePositiveCount).toBe(1);
    expect(matched.falseNegativeCount).toBe(0);
    expect(matched.duplicateCount).toBe(1);
  });

  it("keeps human confirmation and assumption-control counts in the metrics", () => {
    const gold = new Map([
      [
        "a",
        {
          caseId: "a",
          controlType: "changed-assumption",
          expectedReview: {
            requiresHumanConfirmation: true,
            recheckPriorDecision: true,
          },
          findings: [finding],
        },
      ],
      [
        "b",
        {
          caseId: "b",
          controlType: "hard-negative",
          expectedReview: {
            requiresHumanConfirmation: false,
            recheckPriorDecision: false,
          },
          findings: [],
        },
      ],
    ]);
    const metrics = calculateMetrics(
      [
        {
          caseId: "a",
          status: "completed",
          normalized: {
            valid: true,
            findings: [finding],
            requiresHumanConfirmation: true,
            recheckPriorDecision: true,
          },
        },
        {
          caseId: "b",
          status: "completed",
          normalized: {
            valid: true,
            findings: [finding],
            requiresHumanConfirmation: true,
            recheckPriorDecision: false,
          },
        },
      ],
      gold,
    );
    expect(metrics.truePositives).toBe(1);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.falseNegatives).toBe(0);
    expect(metrics.negativeControlFalseAlarms).toBe(1);
    expect(metrics.changedAssumptionMisses).toBe(0);
    expect(metrics.humanConfirmationOverreach).toBe(1);
  });

  it("keeps category evaluation rates honest for mixed and fully unscored records", () => {
    const gold = new Map([
      [
        "category-boundary",
        {
          caseId: "category-boundary",
          findings: [
            {
              path: "src/a.js",
              category: "authorization",
              lineStart: 2,
              lineEnd: 2,
              anchor: "return value;",
            },
          ],
        },
      ],
    ]);
    const completed = {
      caseId: "category-boundary",
      condition: "A",
      status: "completed",
      normalized: {
        valid: true,
        findings: [
          {
            path: "src/a.js",
            category: "authorization",
            lineStart: 2,
            lineEnd: 2,
            anchor: "return value;",
          },
        ],
        requiresHumanConfirmation: false,
        recheckPriorDecision: null,
      },
    };
    const error = {
      caseId: "category-boundary",
      condition: "A",
      status: "error",
      normalized: null,
    };
    const mixed = calculateMetrics([completed, error], gold);
    expect(mixed.truePositives).toBe(1);
    expect(mixed.falsePositives).toBe(0);
    expect(mixed.falseNegatives).toBe(0);
    expect(mixed.byCondition.A.byCategory.authorization).toMatchObject({
      records: 2,
      successfulRecords: 1,
      unscoredTaskCount: 1,
      goldFindingCount: 2,
      unscoredGoldFindingCount: 1,
      evaluationRate: 0.5,
      goldEvaluationRate: 0.5,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
    });

    const allError = calculateMetrics([error], gold);
    expect(allError.truePositives).toBe(0);
    expect(allError.falsePositives).toBe(0);
    expect(allError.falseNegatives).toBe(0);
    expect(allError.byCondition.A.byCategory.authorization).toMatchObject({
      records: 1,
      successfulRecords: 0,
      unscoredTaskCount: 1,
      goldFindingCount: 1,
      unscoredGoldFindingCount: 1,
      evaluationRate: 0,
      goldEvaluationRate: 0,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
    });
  });

  it("uses only measured boolean recheck values for misses and overreach", () => {
    const gold = new Map(
      ["true", "false", "null"].map((caseId) => [
        caseId,
        {
          caseId,
          controlType: "changed-assumption",
          expectedReview: { recheckPriorDecision: true },
          findings: [],
        },
      ]),
    );
    const base = (caseId, recheckPriorDecision) => ({
      caseId,
      condition: "A",
      status: "completed",
      normalized: {
        valid: true,
        findings: [],
        requiresHumanConfirmation: false,
        recheckPriorDecision,
      },
    });
    const mixed = calculateMetrics(
      [base("true", true), base("false", false), base("null", null)],
      gold,
    );
    expect(mixed.recheckUnavailableCount).toBe(1);
    expect(mixed.recheckMeasuredCount).toBe(2);
    expect(mixed.goldRecheckCount).toBe(3);
    expect(mixed.measuredGoldRecheckCount).toBe(2);
    expect(mixed.predictedRecheckCount).toBe(1);
    expect(mixed.changedAssumptionRecords).toBe(3);
    expect(mixed.changedAssumptionMeasuredRecords).toBe(2);
    expect(mixed.changedAssumptionMisses).toBe(1);
    expect(mixed.changedAssumptionMissRate).toBe(0.5);
    expect(mixed.recheckPriorDecisionOverreach).toBe(-1);

    const allUnavailable = calculateMetrics(
      [base("null", null)],
      new Map([[
        "null",
        {
          caseId: "null",
          controlType: "changed-assumption",
          expectedReview: { recheckPriorDecision: true },
          findings: [],
        },
      ]]),
    );
    expect(allUnavailable.recheckUnavailableCount).toBe(1);
    expect(allUnavailable.recheckMeasuredCount).toBe(0);
    expect(allUnavailable.measuredGoldRecheckCount).toBe(0);
    expect(allUnavailable.changedAssumptionRecords).toBe(1);
    expect(allUnavailable.changedAssumptionMeasuredRecords).toBe(0);
    expect(allUnavailable.changedAssumptionMisses).toBe(0);
    expect(allUnavailable.changedAssumptionMissRate).toBeNull();
    expect(allUnavailable.recheckPriorDecisionOverreach).toBeNull();
  });

  it("does not inflate failed tasks into false negatives and reports the evaluated rate", () => {
    const gold = new Map([
      [
        "failed",
        {
          caseId: "failed",
          findings: [finding],
          expectedReview: { requiresHumanConfirmation: true },
        },
      ],
    ]);
    const metrics = calculateMetrics(
      [{ caseId: "failed", condition: "B", status: "error", normalized: null }],
      gold,
    );
    expect(metrics.falseNegatives).toBe(0);
    expect(metrics.errorCount).toBe(1);
    expect(metrics.unscoredTaskCount).toBe(1);
    expect(metrics.unscoredGoldFindingCount).toBe(1);
    expect(metrics.evaluationRate).toBe(0);
    expect(metrics.goldEvaluationRate).toBe(0);
    expect(metrics.byCondition.B.unscoredGoldFindingCount).toBe(1);
  });

  it("treats partial, stopped, and unavailable coverage as unscored", () => {
    const gold = new Map([
      ["partial", { caseId: "partial", findings: [finding] }],
      ["stopped", { caseId: "stopped", findings: [finding] }],
      ["unavailable", { caseId: "unavailable", findings: [finding] }],
    ]);
    const metrics = calculateMetrics(
      [
        { caseId: "partial", condition: "A", status: "partial" },
        { caseId: "stopped", condition: "A", status: "stopped" },
        { caseId: "unavailable", condition: "A", status: "unavailable" },
      ],
      gold,
    );
    expect(metrics.partialCount).toBe(3);
    expect(metrics.unscoredTaskCount).toBe(3);
    expect(metrics.unscoredGoldFindingCount).toBe(3);
    expect(metrics.falseNegatives).toBe(0);
    expect(metrics.byCondition.A.evaluationRate).toBe(0);
  });
});

describe("runEvaluation preflight and raw evidence", () => {
  it("rejects stale identity input hashes even when evaluation dataset hash matches", async () => {
    const stale = structuredClone(testManifest);
    stale.identity.engine.input_sha256 = `sha256:${"0".repeat(64)}`;
    await expect(preflightManifest(stale, corpus)).rejects.toThrow(
      "engine input hash",
    );
  });

  it("rejects missing engine files instead of skipping source identity checks", async () => {
    const missing = structuredClone(testManifest);
    missing.identity.engine.source_path =
      "dist/server/absent-evaluation-engine.js";
    await expect(preflightManifest(missing, corpus)).rejects.toThrow(
      "engine source file",
    );
  });

  it("rejects a missing source-bundle input before any review invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-review-source-bundle-"));
    let invoked = 0;
    try {
      await expect(
        captureSourceBundle({
          outputDir: join(root, "run"),
          manifest: fixtureManifest,
          entries: [
            ...SOURCE_BUNDLE_ENTRIES,
            {
              role: "missing-shared-input",
              sourcePath: "dist/shared/missing-model-review-input.js",
              bundlePath: "missing-model-review-input.js",
            },
          ],
        }),
      ).rejects.toThrow("source bundleの実ファイルがありません");
      expect(invoked).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a source identity mismatch before invoking the engine", async () => {
    const mismatched = structuredClone(fixtureManifest);
    mismatched.identity.engine.source_sha256 = `sha256:${"0".repeat(64)}`;
    const root = await mkdtemp(join(tmpdir(), "model-review-source-identity-"));
    const output = join(root, "run");
    let invoked = 0;
    try {
      await expect(
        runEvaluation({
          corpus,
          manifest: mismatched,
          engine: {
            review: async () => {
              invoked += 1;
              return { findings: [] };
            },
          },
          outputDir: output,
          conditions: ["A"],
          repetitions: 2,
        }),
      ).rejects.toThrow("manifestのengine hash");
      expect(invoked).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires repetitions to match the frozen manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-review-repetitions-"));
    const output = join(root, "run");
    const manifestWithThreeRepetitions = structuredClone(fixtureManifest);
    manifestWithThreeRepetitions.evaluation.configuration.repetitions = 3;
    let invoked = 0;
    try {
      await expect(
        runEvaluation({
          corpus,
          manifest: manifestWithThreeRepetitions,
          engine: {
            review: async () => {
              invoked += 1;
              return { findings: [] };
            },
          },
          outputDir: output,
          conditions: ["A"],
          repetitions: 2,
        }),
      ).rejects.toThrow("repetitionsはmanifestの固定値と一致");
      expect(invoked).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires non-empty unique conditions within the manifest allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-review-conditions-"));
    const invalidConditions = [
      { conditions: [], message: "conditionsは1件以上" },
      { conditions: ["A", "A"], message: "conditionsに重複" },
      {
        conditions: ["unknown"],
        message: "manifestで許可されていないcondition",
      },
    ];
    try {
      for (const [index, { conditions, message }] of invalidConditions.entries()) {
        let invoked = 0;
        await expect(
          runEvaluation({
            corpus,
            manifest: fixtureManifest,
            engine: {
              review: async () => {
                invoked += 1;
                return { findings: [] };
              },
            },
            outputDir: join(root, `run-${index}`),
            conditions,
            repetitions: 2,
          }),
        ).rejects.toThrow(message);
        expect(invoked).toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adapts the production reviewSnapshot contract and leaves queue status unavailable", async () => {
    const testCase = corpus.cases.holdout.find(({ id }) => id === "b07");
    const input = buildReviewInput(testCase, "C", corpus.product);
    const calls = [];
    const engine = createReviewSnapshotEngine({
      provider: { model: "fixture-model", maxOutputTokens: 128 },
      invoke: async (prompt) => {
        calls.push(prompt);
        return {
          response: '{"findings":[]}',
          model: "fixture-model",
          promptTokens: 7,
          completionTokens: 8,
        };
      },
      reviewSnapshot: async (snapshot, modelInput, options) => {
        expect(snapshot.files[0].path).toBe(testCase.source.path);
        expect(modelInput.pastJudgments).toHaveLength(1);
        await options.invoke(
          "production prompt",
          new AbortController().signal,
          128,
          {
            index: 0,
            filePaths: [testCase.source.path],
          },
        );
        return {
          findings: [],
          coverage: {},
          report: {
            model: "fixture-model",
            used: { promptTokens: 7, completionTokens: 8 },
          },
        };
      },
    });
    const result = await engine.review(input, {
      condition: "C",
      budget: { maxOutputTokens: 128 },
    });
    expect(calls).toEqual(["production prompt"]);
    expect(result.recheckPriorDecision).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 8 });
  });

  it("keeps production prompt and raw invocation evidence when schema validation throws", async () => {
    const testCase = corpus.cases.holdout.find(({ id }) => id === "b01");
    const input = buildReviewInput(testCase, "B", corpus.product);
    const engine = createReviewSnapshotEngine({
      provider: { model: "fixture-model", maxOutputTokens: 128 },
      invoke: async () => ({
        response: "{invalid-json}",
        model: "fixture-model",
        promptTokens: 11,
        completionTokens: 13,
      }),
      reviewSnapshot: async (_snapshot, _modelInput, options) => {
        await options.invoke(
          "production prompt that must be retained",
          new AbortController().signal,
          128,
          { index: 0, filePaths: [testCase.source.path] },
        );
        throw new Error("model responseのJSON schemaが不正です");
      },
    });
    await expect(
      engine.review(input, { condition: "B" }),
    ).rejects.toMatchObject({
      message: "model responseのJSON schemaが不正です",
      prompt: "production prompt that must be retained",
      rawResponse: [
        expect.objectContaining({
          response: "{invalid-json}",
          promptTokens: 11,
        }),
      ],
      usage: { inputTokens: 11, outputTokens: 13 },
    });

    const root = await mkdtemp(
      join(tmpdir(), "model-review-failure-evidence-"),
    );
    const output = join(root, "run");
    try {
      const result = await runEvaluation({
        corpus,
        manifest: fixtureManifest,
        engine,
        outputDir: output,
        conditions: ["B"],
        repetitions: 2,
      });
      expect(result.status).toBe("failed");
      expect(result.records[0]).toMatchObject({
        status: "error",
        prompt: "production prompt that must be retained",
        rawResponse: [expect.objectContaining({ response: "{invalid-json}" })],
        usage: { inputTokens: 11, outputTokens: 13 },
        failure: { type: "engine-error" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-frozen manifest before invoking the engine", async () => {
    let invoked = 0;
    const root = await mkdtemp(join(tmpdir(), "model-review-preflight-"));
    const output = join(root, "run");
    try {
      await expect(
        runEvaluation({
          corpus,
          manifest: { ...fixtureManifest, status: "draft" },
          engine: {
            review: async () => {
              invoked += 1;
              return { findings: [] };
            },
          },
          outputDir: output,
          conditions: ["A"],
          repetitions: 2,
        }),
      ).rejects.toThrow("status=frozen");
      expect(invoked).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves every prompt, raw response, measured time, model, and usage value", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-review-raw-"));
    const output = join(root, "run");
    try {
      const result = await runEvaluation({
        corpus,
        manifest: fixtureManifest,
        engine: {
          model: "fixture-model",
          review: async () => ({
            prompt: "actual prompt from fixture engine",
            rawResponse: "actual raw response",
            model: "fixture-model",
            usage: { inputTokens: 3, outputTokens: 4 },
            findings: [],
          }),
        },
        outputDir: output,
        conditions: ["A"],
        repetitions: 2,
      });
      expect(result.status).toBe("completed");
      expect(result.records).toHaveLength(16);
      expect(
        result.records.every((record) => record.status === "completed"),
      ).toBe(true);
      expect(result.records.every((record) => record.elapsedMs >= 0)).toBe(
        true,
      );
      expect(result.metrics.byCondition.A.records).toBe(16);
      expect(result.metrics.byCondition.A.evaluationRate).toBe(1);
      expect(result.metrics.byCondition.A.unscoredGoldFindingCount).toBe(0);
      const lines = (await readFile(join(output, "records.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(16);
      expect(lines[0]).toMatchObject({
        prompt: "actual prompt from fixture engine",
        rawResponse: "actual raw response",
        model: "fixture-model",
        usage: { inputTokens: 3, outputTokens: 4 },
      });
      expect(
        JSON.parse(await readFile(join(output, "summary.json"), "utf8")),
      ).toMatchObject({
        status: "completed",
        records: 16,
        error_count: 0,
        timeout_count: 0,
      });
      const sourceBundle = JSON.parse(
        await readFile(join(output, "source-bundle", "hashes.json"), "utf8"),
      );
      expect(sourceBundle.files.map(({ role }) => role)).toEqual([
        "runner",
        "adapter",
        "engine",
        "provider",
        "shared-diagnostic-engine",
        "shared-model-review",
        "shared-model",
        "shared-domain-error",
        "package-lock",
      ]);
      expect(
        sourceBundle.files.every(
          ({ source_sha256: sourceHash, bundle_sha256: bundleHash }) =>
            sourceHash === bundleHash,
        ),
      ).toBe(true);
      expect(result.artifact.source).toMatchObject({
        sourceBundlePath: "source-bundle",
        sourceBundleHashesPath: "source-bundle/hashes.json",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails records whose measured usage exceeds the frozen budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-review-budget-"));
    const output = join(root, "run");
    try {
      const result = await runEvaluation({
        corpus,
        manifest: fixtureManifest,
        engine: {
          model: "fixture-model",
          review: async () => ({
            rawResponse: "actual raw response",
            model: "fixture-model",
            usage: { inputTokens: 12_001, outputTokens: 2_048 },
            findings: [],
          }),
        },
        outputDir: output,
        conditions: ["A"],
        repetitions: 2,
      });
      expect(result.status).toBe("failed");
      expect(result.artifact.budget_violation_count).toBe(16);
      expect(
        result.records.every(
          (record) => record.failure?.type === "budget-exceeded",
        ),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists coverage/report and treats partial reviews as unscored", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-review-partial-"));
    const output = join(root, "run");
    try {
      const result = await runEvaluation({
        corpus,
        manifest: fixtureManifest,
        engine: {
          model: "fixture-model",
          review: async () => ({
            findings: [],
            coverage: { status: "partial", reason: "fixture-stop" },
            report: { status: "partial", completedFiles: 0 },
          }),
        },
        outputDir: output,
        conditions: ["A"],
        repetitions: 2,
      });
      expect(result.status).toBe("failed");
      expect(result.artifact.partial_count).toBe(16);
      expect(result.metrics.partialCount).toBe(16);
      expect(result.metrics.unscoredTaskCount).toBe(16);
      expect(result.metrics.falseNegatives).toBe(0);
      expect(
        result.records.every((record) => record.status === "partial"),
      ).toBe(true);
      expect(result.records[0].coverage).toEqual({
        status: "partial",
        reason: "fixture-stop",
      });
      expect(result.records[0].report).toEqual({
        status: "partial",
        completedFiles: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("model review postrun evidence", () => {
  it("writes a failed checker record without changing the source run files", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-review-postrun-"));
    try {
      const runDir = join(root, "run");
      await mkdir(runDir, { recursive: true });
      const record = {
        runId: "fixture-run",
        caseId: "a05",
        condition: "B",
        status: "error",
        normalized: null,
      };
      const artifact = {
        artifactVersion: "model-review-evaluation/v1",
        runId: "fixture-run",
        manifestId: "fixture-manifest",
        status: "failed",
        split: "development",
        conditions: ["B"],
        records: 1,
        error_count: 1,
        timeout_count: 0,
        partial_count: 0,
      };
      const summary = { ...artifact };
      const manifest = { manifest_id: "fixture-manifest" };
      await writeFile(
        join(runDir, "records.jsonl"),
        `${JSON.stringify(record)}\n`,
      );
      await writeFile(
        join(runDir, "artifact.json"),
        `${JSON.stringify(artifact)}\n`,
      );
      await writeFile(
        join(runDir, "summary.json"),
        `${JSON.stringify(summary)}\n`,
      );
      await writeFile(
        join(runDir, "manifest.json"),
        `${JSON.stringify(manifest)}\n`,
      );
      const evidence = await writePostrunEvidence(runDir);
      expect(evidence.check.status).toBe("failed");
      expect(evidence.check.errors).toEqual([
        "outcome.error_count must be zero",
        "status must be completed for postrun",
      ]);
      expect(evidence.postrunManifest.outcome.error_count).toBe(1);
      expect(
        evidence.postrunManifest.postrun_evidence.unscoredGoldFindingCount,
      ).toBe(1);
      expect(evidence.postrunManifest.postrun_evidence.holdout).toBe("not_run");
      expect(evidence.postrunManifest.outcome.decision).toBe("unmeasured");
      expect(
        JSON.parse(await readFile(join(runDir, "artifact.json"))).status,
      ).toBe("failed");
      expect(
        JSON.parse(await readFile(join(runDir, "summary.json"))).status,
      ).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("separates measurement completion from the effect decision and infers the split gold", async () => {
    const root = await mkdtemp(join(tmpdir(), "model-review-postrun-splits-"));
    try {
      const cases = [
        {
          name: "development",
          caseId: "a05",
          evaluationDecision: "fail",
          artifactStatus: "failed",
          expectedGold: "evaluations/model-review/gold/development.json",
          expectedHoldout: "not_run",
          expectedDecision: "fail",
        },
        {
          name: "holdout",
          caseId: "b01",
          evaluationDecision: undefined,
          artifactStatus: "completed",
          expectedGold: "evaluations/model-review/gold/holdout.json",
          expectedHoldout: "run",
          expectedDecision: "unmeasured",
        },
      ];
      for (const item of cases) {
        const runDir = join(root, item.name);
        await mkdir(runDir, { recursive: true });
        const split = item.name;
        const record = {
          runId: `fixture-${split}`,
          caseId: item.caseId,
          condition: "B",
          status: "completed",
          normalized: { valid: true, findings: [] },
        };
        const artifact = {
          artifactVersion: "model-review-evaluation/v1",
          runId: record.runId,
          manifestId: "fixture-manifest",
          status: item.artifactStatus,
          split,
          conditions: ["B"],
          records: 1,
          error_count: 0,
          timeout_count: 0,
          partial_count: 0,
          ...(item.evaluationDecision
            ? { evaluation_decision: item.evaluationDecision }
            : {}),
        };
        await writeFile(
          join(runDir, "records.jsonl"),
          `${JSON.stringify(record)}\n`,
        );
        await writeFile(join(runDir, "artifact.json"), `${JSON.stringify(artifact)}\n`);
        await writeFile(join(runDir, "summary.json"), `${JSON.stringify(artifact)}\n`);
        await writeFile(
          join(runDir, "manifest.json"),
          `${JSON.stringify({ manifest_id: "fixture-manifest" })}\n`,
        );

        const evidence = await writePostrunEvidence(runDir);
        expect(evidence.postrunManifest.status).toBe("completed");
        expect(evidence.check.status).toBe("ok");
        expect(evidence.postrunManifest.outcome.decision).toBe(
          item.expectedDecision,
        );
        expect(evidence.postrunManifest.postrun_evidence.measurementStatus).toBe(
          "completed",
        );
        expect(
          evidence.postrunManifest.postrun_evidence.evaluationDecision,
        ).toBe(item.evaluationDecision ?? null);
        expect(evidence.postrunManifest.postrun_evidence.holdout).toBe(
          item.expectedHoldout,
        );
        expect(evidence.postrunManifest.source.goldPath).toBe(item.expectedGold);
        expect(evidence.postrunManifest.source.goldDevelopmentPath).toBe(
          item.expectedGold,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
