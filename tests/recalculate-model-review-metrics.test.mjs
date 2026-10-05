import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRecalculationReport,
  writeRecalculationReport,
} from "../scripts/recalculate-model-review-metrics.mjs";
import { calculateMetrics } from "../scripts/model-review-evaluation.mjs";

function fixture() {
  const finding = {
    path: "src/a.js",
    category: "authorization",
    lineStart: 2,
    lineEnd: 2,
    anchor: "return value;",
  };
  const gold = {
    split: "development",
    cases: [
      {
        caseId: "positive",
        controlType: "changed-assumption",
        expectedReview: {
          requiresHumanConfirmation: true,
          recheckPriorDecision: true,
        },
        findings: [finding],
      },
    ],
  };
  const records = [
    {
      caseId: "positive",
      split: "development",
      condition: "B",
      status: "completed",
      normalized: {
        valid: true,
        findings: [finding],
        requiresHumanConfirmation: true,
        recheckPriorDecision: null,
      },
    },
  ];
  const measuredMetrics = calculateMetrics(
    records,
    new Map(gold.cases.map((goldCase) => [goldCase.caseId, goldCase])),
  );
  const originalMetrics = structuredClone(measuredMetrics);
  originalMetrics.recheckPriorDecisionOverreach = -1;
  originalMetrics.changedAssumptionMissRate = 1;
  originalMetrics.byCategory.authorization.successfulRecords = 0;
  originalMetrics.byCategory.authorization.evaluationRate = 0;
  originalMetrics.byCategory.authorization.evaluatedRecordRate = 0;
  originalMetrics.byCondition.B.byCategory.authorization.successfulRecords = 0;
  originalMetrics.byCondition.B.byCategory.authorization.evaluationRate = 0;
  originalMetrics.byCondition.B.byCategory.authorization.evaluatedRecordRate = 0;
  return {
    gold,
    records,
    originalSummary: {
      runId: "fixture-run",
      status: "completed",
      split: "development",
      metrics: originalMetrics,
    },
    input: {
      records: { path: "records.jsonl", sha256: "records-hash", recordCount: 1 },
      gold: { path: "gold.json", sha256: "gold-hash", split: "development", caseCount: 1 },
      originalSummary: {
        path: "summary.json",
        sha256: "summary-hash",
        runId: "fixture-run",
        status: "completed",
        split: "development",
      },
    },
    implementation: {
      path: "scripts/model-review-evaluation.mjs",
      sha256: "runner-hash",
    },
  };
}

describe("recalculate model review metrics", () => {
  it("preserves confusion counts while correcting category and unavailable recheck metrics", () => {
    const data = fixture();
    const report = buildRecalculationReport(data);

    expect(report.invariance.confusionCountsUnchanged).toBe(true);
    expect(report.invariance.original.overall).toEqual({
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
    });
    expect(report.correctedMetrics.byCategory.authorization).toMatchObject({
      records: 1,
      successfulRecords: 1,
      evaluationRate: 1,
      goldEvaluationRate: 1,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
    });
    expect(report.correctedMetrics.recheckUnavailableCount).toBe(1);
    expect(report.correctedMetrics.recheckPriorDecisionOverreach).toBeNull();
    expect(report.correctedMetrics.changedAssumptionMisses).toBe(0);
    expect(report.correctedMetrics.changedAssumptionMissRate).toBeNull();
    expect(report.input.records.sha256).toBe("records-hash");
    expect(report.source.implementation.sha256).toBe("runner-hash");
  });

  it("refuses to overwrite an existing sidecar", async () => {
    const data = fixture();
    const report = buildRecalculationReport(data);
    const root = await mkdtemp(join(tmpdir(), "model-review-recalculate-"));
    const output = join(root, "corrected-metrics.json");
    try {
      await writeFile(output, "existing\n", "utf8");
      await expect(writeRecalculationReport(output, report)).rejects.toThrow(
        "上書きしません",
      );
      expect(await readFile(output, "utf8")).toBe("existing\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
