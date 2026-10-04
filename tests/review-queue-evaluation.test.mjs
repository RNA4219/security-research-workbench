import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateQueueMetrics,
  loadQueueCorpus,
  preflightQueueManifest,
  queueCorpusHash,
  runQueueEvaluation,
  sha256Text,
  writeQueuePostrunEvidence,
} from "../scripts/review-queue-evaluation.mjs";

const corpus = await loadQueueCorpus();
const manifest = JSON.parse(
  await readFile("evaluations/review-queue/manifest.json", "utf8"),
);
const manifestForCurrentRunner = structuredClone(manifest);
manifestForCurrentRunner.identity.runner.sha256 = `sha256:${sha256Text(
  await readFile("scripts/review-queue-evaluation.mjs", "utf8"),
)}`;
const currentProductionHelperSha256 = `sha256:${sha256Text(
  await readFile(
    manifest.identity.production_helper.source_path,
    "utf8",
  ),
)}`;
manifestForCurrentRunner.identity.production_helper.source_sha256 =
  currentProductionHelperSha256;
const corpusV2 = await loadQueueCorpus("evaluations/review-queue/v2");
const manifestV2 = JSON.parse(
  await readFile("evaluations/review-queue/v2/manifest.json", "utf8"),
);
const manifestV2ForCurrentRunner = structuredClone(manifestV2);
manifestV2ForCurrentRunner.identity.runner.sha256 =
  manifestForCurrentRunner.identity.runner.sha256;
manifestV2ForCurrentRunner.identity.production_helper.source_sha256 =
  currentProductionHelperSha256;

describe("production review queue evaluation", () => {
  it("keeps opaque cases, gold controls, and a frozen production identity", () => {
    expect(corpus.cases).toHaveLength(14);
    expect(corpus.goldByCase.size).toBe(14);
    expect(queueCorpusHash(corpus)).toBe(manifest.evaluation.dataset_sha256);
    expect(manifest.evaluation.model_version).toBe(
      "not_used:production-workflow-helper",
    );
    expect(() =>
      preflightQueueManifest(manifestForCurrentRunner, corpus),
    ).not.toThrow();
  });

  it("freezes queue03 as a new dataset with the other-finding judgment control", () => {
    expect(corpusV2.cases).toHaveLength(15);
    expect(corpusV2.goldByCase.size).toBe(15);
    expect(corpusV2.cases.find((item) => item.caseId === "q15")).toEqual({
      caseId: "q15",
      variant: "s15",
      controlType: "other-judgment-negative",
    });
    expect(corpusV2.goldByCase.get("q15").expectedC).toEqual({
      reusable: false,
      status: "invalidated",
      reason: "context_changed",
    });
    expect(queueCorpusHash(corpusV2)).toBe(
      manifestV2.evaluation.dataset_sha256,
    );
    expect(() =>
      preflightQueueManifest(manifestV2ForCurrentRunner, corpusV2),
    ).not.toThrow();
  });

  it("counts queue state from production helper output and retains raw candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-queue-evaluation-"));
    const output = join(root, "run");
    try {
      const result = await runQueueEvaluation({
        corpus,
        manifest: manifestForCurrentRunner,
        outputDir: output,
        runId: "fixture-queue-run",
      });
      expect(result.status).toBe("completed");
      expect(result.evaluation_decision).toBe("pass");
      expect(result.records).toHaveLength(28);
      expect(result.metrics.queueRequiredB).toBe(14);
      expect(result.metrics.queueRequiredC).toBe(13);
      expect(result.metrics.queueReductionCount).toBe(1);
      expect(result.metrics.queueReductionRate).toBe(1 / 14);
      expect(result.metrics.negativeControlLeakageCount).toBe(0);
      expect(result.metrics.goldMismatchCount).toBe(0);
      expect(result.metrics.byCondition.B.queueRequiredCount).toBe(14);
      expect(result.metrics.byCondition.C.reusableCount).toBe(1);
      expect(result.records.every((record) => record.rawCandidate)).toBe(true);
      expect(result.records.find((record) => record.caseId === "q01" && record.condition === "C"))
        .toMatchObject({
          status: "completed",
          queueRequired: false,
          productionResult: { reusable: true, status: "active", reason: "active" },
        });
      expect(result.records.find((record) => record.caseId === "q08" && record.condition === "C"))
        .toMatchObject({
          queueRequired: true,
          productionResult: {
            reusable: false,
            status: "unknown",
            reason: "legacy_context_unknown",
          },
        });
      const postrun = await writeQueuePostrunEvidence(output);
      expect(postrun.check).toEqual({ status: "ok", stage: "postrun", errors: [] });
      expect(postrun.postrunManifest.status).toBe("completed");
      expect(postrun.postrunManifest.outcome.metrics.queue_reduction_rate).toBe(1 / 14);
      expect(postrun.postrunManifest.postrun_evidence.rawCandidateCount).toBe(28);
      expect(JSON.parse(await readFile(join(output, "postrun-check.json")))).toEqual(
        postrun.check,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not turn a production helper error into a reusable queue result", () => {
    const goldByCase = new Map([
      [
        "q",
        {
          caseId: "q",
          expectedB: { reusable: false, status: "missing", reason: "no_active_suppression" },
          expectedC: { reusable: true, status: "active", reason: "active" },
        },
      ],
    ]);
    const records = [
      {
        caseId: "q",
        condition: "B",
        status: "error",
        queueRequired: null,
        productionResult: null,
      },
      {
        caseId: "q",
        condition: "C",
        status: "completed",
        queueRequired: false,
        productionResult: { reusable: true, status: "active", reason: "active" },
      },
    ];
    const metrics = calculateQueueMetrics(records, goldByCase);
    expect(metrics.errorCount).toBe(1);
    expect(metrics.queueRequiredB).toBe(0);
    expect(metrics.queueRequiredC).toBe(0);
    expect(metrics.goldMismatchCount).toBe(0);
  });
});
