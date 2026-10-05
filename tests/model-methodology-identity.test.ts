import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { modelReviewContextHash } from "../src/server/diagnostic-service.js";
import {
  modelReviewPromptIdentityHash,
  modelReviewPromptMethodologyHash,
  ModelReviewCheckpointError,
  reviewSnapshot as reviewModelSnapshot,
} from "../src/server/model-review.js";
import type { DiagnosticSnapshot } from "../src/shared/diagnostic-engine.js";
import type {
  ModelReviewBudget,
  ModelReviewInput,
} from "../src/shared/model-review.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function snapshot(content = "export const value = 1;\n"): DiagnosticSnapshot {
  const path = "src/fixture.ts";
  const file = { path, content, hash: sha256(content) };
  return {
    commit: "a".repeat(40),
    manifestHash: sha256(
      JSON.stringify({ files: [[path, file.hash]], omitted: [] }),
    ),
    files: [file],
    omitted: [],
  };
}

function input(overrides: Partial<ModelReviewInput> = {}): ModelReviewInput {
  return {
    target: "fixture-product",
    targetVersion: "1.0.0",
    purpose: "固定snapshotの静的レビュー",
    approvedKnowledge: [],
    pastJudgments: [],
    fixedFindings: [],
    specificationRefs: [],
    ...overrides,
  };
}

const emptyResponse = JSON.stringify({ findings: [] });

const budget: ModelReviewBudget = {
  maxBatches: 1,
  maxFiles: 1,
  maxInputChars: 10_000,
  maxBatchChars: 10_000,
  maxPromptChars: 20_000,
  maxOutputTokens: 128,
};

describe("model review methodology identity", () => {
  it("keeps a completed checkpoint identity stable and reuses it without a provider call", async () => {
    let calls = 0;
    let checkpoint:
      | Parameters<
          NonNullable<Parameters<typeof reviewModelSnapshot>[2]["onCheckpoint"]>
        >[0]
      | undefined;
    const first = await reviewModelSnapshot(snapshot(), input(), {
      invoke: async () => {
        calls += 1;
        return { response: emptyResponse };
      },
      onCheckpoint: (value) => {
        checkpoint = value;
      },
    });

    const second = await reviewModelSnapshot(snapshot(), input(), {
      checkpoint,
      invoke: async () => {
        throw new Error("checkpoint reuse should not invoke the provider");
      },
    });

    expect(calls).toBe(1);
    expect(checkpoint?.identity.plan).toBe(first.report.hashes.plan);
    expect(second.report.checkpoint.reused).toBe(true);
    expect(second.report.hashes.plan).toBe(first.report.hashes.plan);
    expect(second.report.hashes.prompt).toBe(first.report.hashes.prompt);
  });

  it("changes the planned identity when rendered prompt material changes", async () => {
    const baseline = await reviewModelSnapshot(
      snapshot(),
      input({ purpose: "仕様に基づく静的レビュー" }),
      { invoke: async () => ({ response: emptyResponse }) },
    );
    const changed = await reviewModelSnapshot(
      snapshot(),
      input({ purpose: "仕様と過去判断を用いる静的レビュー" }),
      { invoke: async () => ({ response: emptyResponse }) },
    );

    expect(baseline.report.hashes.plan).not.toBe(changed.report.hashes.plan);
    expect(baseline.report.hashes.prompt).not.toBe(
      changed.report.hashes.prompt,
    );
    expect(modelReviewPromptIdentityHash(["a".repeat(64)])).not.toBe(
      modelReviewPromptIdentityHash(["b".repeat(64)]),
    );
    expect(modelReviewPromptIdentityHash(["a".repeat(64)])).toBe(
      modelReviewPromptIdentityHash(["a".repeat(64)]),
    );
    expect(modelReviewPromptMethodologyHash()).toMatch(/^[a-f0-9]{64}$/);
    expect(modelReviewPromptMethodologyHash()).toBe(
      modelReviewPromptMethodologyHash(),
    );
  });

  it("keeps diagnostic comparison identity stable while separating prompt changes", () => {
    const reviewInput = input();
    const provider = {
      id: "local",
      kind: "local" as const,
      model: "fixture-model",
      configVersion: "fixture-v1",
    };
    const promptMethodologyHash = "a".repeat(64);
    const baseline = modelReviewContextHash(reviewInput, budget, provider, {
      promptMethodologyHash,
    });

    expect(
      modelReviewContextHash(reviewInput, budget, provider, {
        promptMethodologyHash,
      }),
    ).toBe(baseline);
    expect(
      modelReviewContextHash(reviewInput, budget, provider, {
        promptMethodologyHash: "c".repeat(64),
      }),
    ).not.toBe(baseline);
  });

  it("does not silently accept a checkpoint made from changed prompt inputs", async () => {
    let checkpoint:
      | Parameters<
          NonNullable<Parameters<typeof reviewModelSnapshot>[2]["onCheckpoint"]>
        >[0]
      | undefined;
    await reviewModelSnapshot(snapshot(), input(), {
      invoke: async () => ({ response: emptyResponse }),
      onCheckpoint: (value) => {
        checkpoint = value;
      },
    });

    await expect(
      reviewModelSnapshot(snapshot(), input({ purpose: "別のレビュー条件" }), {
        checkpoint,
        invoke: async () => ({ response: emptyResponse }),
      }),
    ).rejects.toBeInstanceOf(ModelReviewCheckpointError);
  });
});
