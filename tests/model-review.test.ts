import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DiagnosticSnapshot } from "../src/shared/diagnostic-engine.js";
import {
  ModelReviewCheckpointError,
  ModelReviewError,
  reviewSnapshot,
} from "../src/server/model-review.js";
import type {
  ModelReviewFinding,
  ModelReviewInput,
  ModelReviewInvocation,
} from "../src/shared/model-review.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function makeSnapshot(files: Record<string, string>): DiagnosticSnapshot {
  const entries = Object.entries(files)
    .map(([path, content]) => ({ path, content, hash: sha256(content) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const omitted: DiagnosticSnapshot["omitted"] = [];
  return {
    commit: "a".repeat(40),
    manifestHash: sha256(
      JSON.stringify({
        files: entries.map(({ path, hash }) => [path, hash]),
        omitted,
      }),
    ),
    files: entries,
    omitted,
  };
}

const knowledge = {
  id: "product-spec",
  version: "2026.10",
  hash: "b".repeat(64),
  content: "認証済み利用者ごとにテナントデータを分離する。",
  sourceRefs: [
    {
      id: "logos-article",
      version: "2026.10",
      hash: "c".repeat(64),
      excerpt: "テナント境界を検証する。",
    },
  ],
  status: "active" as const,
};

function input(overrides: Partial<ModelReviewInput> = {}): ModelReviewInput {
  return {
    target: "fixture-product",
    targetVersion: "2.0.0",
    purpose: "固定source snapshotの静的レビュー",
    approvedKnowledge: [knowledge],
    pastJudgments: [],
    fixedFindings: [],
    specificationRefs: [],
    ...overrides,
  };
}

function responseFor(
  finding: Partial<ModelReviewFinding> &
    Pick<ModelReviewFinding, "id" | "path" | "line" | "originalText">,
): string {
  const value: ModelReviewFinding = {
    id: finding.id,
    category: finding.category ?? "authorization",
    severity: finding.severity ?? "medium",
    title: finding.title ?? "テナント境界の確認が必要",
    rationale:
      finding.rationale ??
      "認可条件とデータ分離の関係を独立に確認する必要がある。",
    path: finding.path,
    line: finding.line,
    originalText: finding.originalText,
    specRefIds: finding.specRefIds ?? ["product-spec"],
    relatedFixedFindingIds: finding.relatedFixedFindingIds ?? [],
    pastJudgmentIds: finding.pastJudgmentIds ?? [],
    remediation: finding.remediation ?? {
      guidance: "認可条件とテナント識別子の検証方針を人が確認する。",
      humanReviewRequired: true,
    },
    falsePositiveCandidate: finding.falsePositiveCandidate ?? true,
    uncertainty: finding.uncertainty ?? {
      level: "medium",
      reasons: ["呼び出し元の境界は別moduleにある可能性がある。"],
    },
  };
  return JSON.stringify({ schemaVersion: "1", findings: [value] });
}

function invocation(response: string): ModelReviewInvocation {
  return {
    response,
    model: "fixture-model",
    configVersion: "fixture-v1",
    promptTokens: 20,
    completionTokens: 30,
    actualCostUsd: 0.01,
  };
}

describe("model review contract", () => {
  it("reviews several fixed batches and validates exact source plus approved references", async () => {
    const snapshot = makeSnapshot({
      "src/a.ts": "export const a = true;\n",
      "src/b.ts": "export const b = false;\n",
    });
    const prompts: string[] = [];
    const result = await reviewSnapshot(snapshot, input(), {
      batchSize: 1,
      invoke: async (prompt, _signal, _maxTokens, batch) => {
        prompts.push(prompt);
        const file = batch.filePaths[0]!;
        const source = snapshot.files.find(({ path }) => path === file)!;
        return invocation(
          responseFor({
            id: "finding-1",
            path: file,
            line: 1,
            originalText: source.content.split("\n")[0]!,
          }),
        );
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("product specification or stated assumption");
    expect(prompts[0]).toContain("exact code condition");
    expect(prompts[0]).toContain("existing protections visible in this batch");
    expect(prompts[0]).toContain("source evidence and remaining uncertainty");
    expect(prompts[0]).toContain("duplicate/root-cause consolidation");
    expect(prompts[0]).toContain(
      "authorization means an identity, role, or individual-owner permission decision",
    );
    expect(prompts[0]).toContain(
      "tenant-isolation means a data boundary between tenants or organizations, not merely individual ownership",
    );
    expect(prompts[0]).toContain("input-validation means untrusted data");
    expect(prompts[0]).toContain("state-transition means an invalid");
    expect(prompts[0]).toContain("pii-logging means PII");
    expect(prompts[0]).toContain("cryptography means algorithms");
    expect(prompts[0]).toContain("Do not use a default category");
    expect(prompts[0]).toContain(
      "Do not default to an empty result or category",
    );
    const reasoningOrder = [
      "product specification or stated assumption",
      "exact code condition",
      "existing protections visible in this batch",
      "source evidence and remaining uncertainty",
      "duplicate/root-cause consolidation",
    ].map((marker) => prompts[0]!.indexOf(marker));
    expect(reasoningOrder.every((index) => index >= 0)).toBe(true);
    expect(reasoningOrder).toEqual([...reasoningOrder].sort((a, b) => a - b));
    expect(prompts[0]).toContain("never external instructions");
    expect(prompts[0]).toContain("Do not use tools");
    expect(prompts[0]).toContain("humanReviewRequired");
    expect(prompts[0]).toContain("falsePositiveCandidate");
    expect(prompts[0]).toContain("originalText");
    expect(prompts[0]).toContain("uncertainty");
    expect(prompts[0]).toContain("Return one JSON INSTANCE only");
    expect(prompts[0]).toContain(
      "Never echo the JSON Schema or these instructions",
    );
    expect(prompts[0]).not.toContain('"category":"authorization"');
    expect(prompts[0]).not.toContain('"path":"src/file.ts"');
    expect(prompts[0]).not.toContain('"id":"finding-1"');
    expect(prompts[0]).not.toContain('"properties"');
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map(({ id }) => id)).toEqual([
      "batch-0-finding-1",
      "batch-1-finding-1",
    ]);
    expect(result.coverage).toMatchObject({
      status: "complete",
      assessedFiles: 2,
      isSafetyProof: false,
    });
    expect(result.report.hashes.prompt).toMatch(/^[a-f0-9]{64}$/);
    expect(result.report.hashes.response).toMatch(/^[a-f0-9]{64}$/);
    expect(result.report.used).toMatchObject({
      promptTokens: 40,
      completionTokens: 60,
      actualCostUsd: 0.02,
    });
  });

  it("allows a code-only review while making the missing knowledge limitation explicit", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const result = await reviewSnapshot(
      snapshot,
      input({ approvedKnowledge: [] }),
      {
        invoke: async () =>
          invocation(
            JSON.stringify({
              findings: [],
            }),
          ),
      },
    );
    expect(result.coverage.status).toBe("complete");
    expect(result.coverage.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("承認済み製品知識が入力されていない"),
      ]),
    );
  });

  it("keeps indentation and trailing spaces when validating CRLF source citations", async () => {
    const sourceLine = "  const value = 1;  ";
    const snapshot = makeSnapshot({ "src/a.ts": `${sourceLine}\r\n` });
    const result = await reviewSnapshot(snapshot, input(), {
      invoke: async () =>
        invocation(
          responseFor({
            id: "whitespace-source",
            path: "src/a.ts",
            line: 1,
            originalText: sourceLine,
            specRefIds: [],
          }),
        ),
    });
    expect(result.findings[0]?.originalText).toBe(sourceLine);
  });

  it("records an oversized source file as omitted without truncating it", async () => {
    const snapshot = makeSnapshot({ "src/large.ts": "x".repeat(12_001) });
    let invoked = false;
    const result = await reviewSnapshot(snapshot, input(), {
      invoke: async () => {
        invoked = true;
        return invocation(JSON.stringify({ findings: [] }));
      },
    });
    expect(invoked).toBe(false);
    expect(result.coverage.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/large.ts",
          reason: expect.stringContaining("sourceを切り捨てません"),
        }),
      ]),
    );
    expect(result.report.stopReason).toBe("max_budgets");
  });

  it("does not send a prompt that exceeds the combined prompt budget", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    let invoked = false;
    const result = await reviewSnapshot(snapshot, input(), {
      maxBudget: { maxPromptChars: 100 },
      invoke: async () => {
        invoked = true;
        return invocation(JSON.stringify({ findings: [] }));
      },
    });
    expect(invoked).toBe(false);
    expect(result.report.stopReason).toBe("max_budgets");
    expect(result.report.hashes.prompt).not.toBe("0".repeat(64));
  });

  it("rejects source citations and specification IDs that do not match the pinned input", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () =>
          invocation(
            responseFor({
              id: "bad-source",
              path: "src/a.ts",
              line: 1,
              originalText: "const value = 2;",
            }).replace("product-spec", "unknown-spec"),
          ),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);
  });

  it("reuses a matching checkpoint and rejects knowledge, provider, or source changes", async () => {
    const snapshot = makeSnapshot({
      "src/a.ts": "const a = 1;\n",
      "src/b.ts": "const b = 2;\n",
    });
    let calls = 0;
    let checkpoint:
      | Parameters<
          NonNullable<Parameters<typeof reviewSnapshot>[2]["onCheckpoint"]>
        >[0]
      | undefined;
    const first = await reviewSnapshot(snapshot, input(), {
      batchSize: 1,
      invoke: async (_prompt, _signal, _maxTokens, batch) => {
        calls += 1;
        const file = snapshot.files.find(
          ({ path }) => path === batch.filePaths[0],
        )!;
        return invocation(
          responseFor({
            id: `finding-${batch.index}`,
            path: file.path,
            line: 1,
            originalText: file.content.split("\n")[0]!,
          }),
        );
      },
      onCheckpoint: (value) => {
        checkpoint = value;
      },
    });
    expect(first.report.checkpoint.savedBatchCount).toBe(2);
    expect(calls).toBe(2);
    const reused = await reviewSnapshot(snapshot, input(), {
      batchSize: 1,
      checkpoint,
      invoke: async () => {
        throw new Error("checkpoint should avoid provider call");
      },
    });
    expect(reused.report.checkpoint.reused).toBe(true);
    expect(reused.findings).toHaveLength(2);

    const promptChangedCheckpoint = {
      ...checkpoint!,
      batches: checkpoint!.batches.map((batch, index) =>
        index === 0 ? { ...batch, promptHash: "f".repeat(64) } : batch,
      ),
    };
    await expect(
      reviewSnapshot(snapshot, input(), {
        batchSize: 1,
        checkpoint: promptChangedCheckpoint,
        invoke: async () => {
          throw new Error("prompt mismatch must reject before provider call");
        },
      }),
    ).rejects.toBeInstanceOf(ModelReviewCheckpointError);

    await expect(
      reviewSnapshot(
        snapshot,
        input({ approvedKnowledge: [{ ...knowledge, hash: "d".repeat(64) }] }),
        {
          batchSize: 1,
          checkpoint,
          invoke: async () => invocation(JSON.stringify({ findings: [] })),
        },
      ),
    ).rejects.toBeInstanceOf(ModelReviewCheckpointError);
    await expect(
      reviewSnapshot(snapshot, input(), {
        batchSize: 1,
        checkpoint,
        provider: {
          id: "changed-provider",
          kind: "injected",
          model: "different-model",
          configVersion: "different-v1",
          maxOutputTokens: 2048,
        },
        invoke: async () => invocation(JSON.stringify({ findings: [] })),
      }),
    ).rejects.toBeInstanceOf(ModelReviewCheckpointError);
    await expect(
      reviewSnapshot(
        makeSnapshot({
          "src/a.ts": "const a = 99;\n",
          "src/b.ts": "const b = 2;\n",
        }),
        input(),
        {
          batchSize: 1,
          checkpoint,
          invoke: async () => invocation(JSON.stringify({ findings: [] })),
        },
      ),
    ).rejects.toBeInstanceOf(ModelReviewCheckpointError);
  });

  it("records a bounded partial range and preserves a stop checkpoint", async () => {
    const snapshot = makeSnapshot({
      "src/a.ts": "const a = 1;\n",
      "src/b.ts": "const b = 2;\n",
    });
    let saved = 0;
    const result = await reviewSnapshot(snapshot, input(), {
      batchSize: 1,
      maxBudget: { maxBatches: 1 },
      invoke: async (_prompt, _signal, _maxTokens, batch) => {
        const file = snapshot.files.find(
          ({ path }) => path === batch.filePaths[0],
        )!;
        return invocation(
          JSON.stringify({
            findings: [],
            limitations: ["one batch only"],
          }),
        );
      },
      onCheckpoint: () => {
        saved += 1;
      },
    });
    expect(saved).toBe(1);
    expect(result.coverage.status).toBe("partial");
    expect(result.coverage.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/b.ts",
          reason: "maxBatches budgetにより未診断",
        }),
      ]),
    );
    expect(result.report.stopReason).toBe("max_budgets");
  });

  it("treats an already stopped review as stopped coverage without invoking the provider", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const controller = new AbortController();
    controller.abort();
    let invoked = false;
    const result = await reviewSnapshot(snapshot, input(), {
      signal: controller.signal,
      invoke: async () => {
        invoked = true;
        return invocation(JSON.stringify({ findings: [] }));
      },
    });

    expect(invoked).toBe(false);
    expect(result.coverage).toMatchObject({
      status: "stopped",
      completedBatchCount: 0,
      assessedFiles: 0,
      isSafetyProof: false,
    });
    expect(result.report).toMatchObject({
      status: "stopped",
      stopReason: "aborted",
      checkpoint: { savedBatchCount: 0 },
    });
  });

  it("rejects negative or non-integral provider token usage instead of producing a report", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => ({
          ...invocation(JSON.stringify({ findings: [] })),
          promptTokens: -1,
        }),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);

    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => ({
          ...invocation(JSON.stringify({ findings: [] })),
          completionTokens: 1.5,
        }),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);
  });

  it("rejects omission ranges outside the exact batch source", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () =>
          invocation(
            JSON.stringify({
              findings: [],
              omitted: [
                {
                  path: "src/a.ts",
                  startLine: 3,
                  endLine: 3,
                  reason: "range is outside this source batch",
                },
              ],
            }),
          ),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);
  });

  it("retains completed batches after a later provider failure so explicit resume can reuse them", async () => {
    const snapshot = makeSnapshot({
      "src/a.ts": "const a = 1;\n",
      "src/b.ts": "const b = 2;\n",
    });
    let calls = 0;
    let checkpoint:
      | Parameters<
          NonNullable<Parameters<typeof reviewSnapshot>[2]["onCheckpoint"]>
        >[0]
      | undefined;

    await expect(
      reviewSnapshot(snapshot, input(), {
        batchSize: 1,
        invoke: async () => {
          calls += 1;
          if (calls === 2) throw new Error("provider connection dropped");
          return invocation(JSON.stringify({ findings: [] }));
        },
        onCheckpoint: (value) => {
          checkpoint = value;
        },
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);
    expect(calls).toBe(2);
    expect(checkpoint?.batches).toHaveLength(1);
    expect(checkpoint?.batches[0]?.index).toBe(0);

    let resumedCalls = 0;
    const resumed = await reviewSnapshot(snapshot, input(), {
      batchSize: 1,
      checkpoint,
      invoke: async (_prompt, _signal, _maxTokens, batch) => {
        resumedCalls += 1;
        expect(batch.index).toBe(1);
        return invocation(JSON.stringify({ findings: [] }));
      },
    });
    expect(resumedCalls).toBe(1);
    expect(resumed.coverage.status).toBe("complete");
    expect(resumed.report.checkpoint.reused).toBe(true);
    expect(resumed.report.checkpoint.savedBatchCount).toBe(2);
  });

  it("does not invoke a provider when no source files are available", async () => {
    const snapshot = makeSnapshot({});
    let invoked = false;
    const result = await reviewSnapshot(snapshot, input(), {
      invoke: async () => {
        invoked = true;
        return invocation(JSON.stringify({ findings: [] }));
      },
    });

    expect(invoked).toBe(false);
    expect(result.coverage).toMatchObject({
      status: "unavailable",
      batchCount: 0,
      completedBatchCount: 0,
      assessedFiles: 0,
      isSafetyProof: false,
    });
    expect(result.report).toMatchObject({
      status: "partial",
      stopReason: "no_source",
    });
  });

  it("records maxFiles and maxInputChars omissions without silently selecting extra source", async () => {
    const snapshot = makeSnapshot({
      "src/a.ts": "const a = 1;\n",
      "src/b.ts": "const b = 2;\n",
    });
    let calls = 0;
    const maxFiles = await reviewSnapshot(snapshot, input(), {
      maxBudget: { maxFiles: 1 },
      invoke: async () => {
        calls += 1;
        return invocation(JSON.stringify({ findings: [] }));
      },
    });
    expect(calls).toBe(1);
    expect(maxFiles.coverage.status).toBe("partial");
    expect(maxFiles.coverage.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/b.ts",
          reason: "maxFiles budgetにより未診断",
        }),
      ]),
    );

    calls = 0;
    const maxInput = await reviewSnapshot(snapshot, input(), {
      maxBudget: { maxInputChars: 1 },
      invoke: async () => {
        calls += 1;
        return invocation(JSON.stringify({ findings: [] }));
      },
    });
    expect(calls).toBe(0);
    expect(maxInput.coverage.status).toBe("partial");
    expect(maxInput.coverage.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/a.ts",
          reason: "maxInputChars budgetにより未診断",
        }),
      ]),
    );
  });

  it("rejects an invalid batch size before any model call", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    await expect(
      reviewSnapshot(snapshot, input(), {
        batchSize: 0,
        invoke: async () => invocation(JSON.stringify({ findings: [] })),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);
  });

  it("stops after a known cost budget and records the unreviewed batch", async () => {
    const snapshot = makeSnapshot({
      "src/a.ts": "const a = 1;\n",
      "src/b.ts": "const b = 2;\n",
    });
    let saved = 0;
    const result = await reviewSnapshot(snapshot, input(), {
      batchSize: 1,
      maxBudget: { maxCostUsd: 0.01 },
      invoke: async () => invocation(JSON.stringify({ findings: [] })),
      onCheckpoint: () => {
        saved += 1;
      },
    });

    expect(saved).toBe(2);
    expect(result.coverage).toMatchObject({
      status: "stopped",
      completedBatchCount: 1,
      assessedFiles: 1,
    });
    expect(result.report).toMatchObject({
      status: "stopped",
      stopReason: "max_budgets",
      used: { actualCostUsd: 0.01 },
    });
  });

  it("derives cost only when both token counts and provider rates are known", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const result = await reviewSnapshot(snapshot, input(), {
      provider: {
        id: "priced-provider",
        kind: "injected",
        model: "priced-model",
        configVersion: "priced-v1",
        maxOutputTokens: 2048,
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 3,
      },
      invoke: async () => ({
        response: JSON.stringify({ findings: [] }),
        promptTokens: 100,
        completionTokens: 50,
      }),
    });

    expect(result.report.used.actualCostUsd).toBe(0.00035);

    const unknownUsage = await reviewSnapshot(snapshot, input(), {
      invoke: async () => ({
        response: JSON.stringify({ findings: [] }),
      }),
    });
    expect(unknownUsage.report.used.promptTokens).toBeUndefined();
    expect(unknownUsage.report.used.completionTokens).toBeUndefined();
    expect(unknownUsage.report.used.actualCostUsd).toBeNull();
  });

  it("passes only target and condition-matching prior judgments to the batch prompt", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const conditionHash = "e".repeat(64);
    const sourceRef = knowledge.sourceRefs[0]!;
    const judgment = (id: string, targetVersion: string, hash?: string) => ({
      id,
      revision: 1,
      targetVersion,
      ...(hash ? { conditionHash: hash } : {}),
      judgment: "accepted_known" as const,
      reason: `reason-${id}`,
      sourceRefs: [sourceRef],
    });
    const prompts: string[] = [];
    const result = await reviewSnapshot(
      snapshot,
      input({
        conditionHash,
        pastJudgments: [
          judgment("matching", "2.0.0", conditionHash),
          judgment("wrong-version", "1.0.0", conditionHash),
          judgment("wrong-condition", "2.0.0", "f".repeat(64)),
          judgment("no-condition", "2.0.0"),
        ],
      }),
      {
        invoke: async (prompt) => {
          prompts.push(prompt);
          return invocation(JSON.stringify({ findings: [] }));
        },
      },
    );

    expect(result.coverage.status).toBe("complete");
    expect(prompts[0]).toContain('"id":"matching"');
    expect(prompts[0]).toContain('"id":"no-condition"');
    expect(prompts[0]).not.toContain('"id":"wrong-version"');
    expect(prompts[0]).not.toContain('"id":"wrong-condition"');
  });

  it("rejects malformed model JSON and schema instances instead of treating them as empty findings", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => invocation("not-json"),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => invocation(JSON.stringify({ findings: [{}] })),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);
  });

  it("rejects duplicate IDs, unknown references, and remediation without human review", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const base = responseFor({
      id: "finding-1",
      path: "src/a.ts",
      line: 1,
      originalText: "const value = 1;",
    });
    const duplicate = JSON.parse(base) as {
      findings: ModelReviewFinding[];
    };
    duplicate.findings.push({ ...duplicate.findings[0]! });
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => invocation(JSON.stringify(duplicate)),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);

    const unknownSpec = JSON.parse(base) as {
      findings: ModelReviewFinding[];
    };
    unknownSpec.findings[0]!.specRefIds = ["unknown-spec"];
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => invocation(JSON.stringify(unknownSpec)),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);

    const noHumanReview = JSON.parse(base) as {
      findings: ModelReviewFinding[];
    };
    (
      noHumanReview.findings[0]!.remediation as { humanReviewRequired: boolean }
    ).humanReviewRequired = false;
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => invocation(JSON.stringify(noHumanReview)),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);

    const unknownPast = JSON.parse(base) as {
      findings: ModelReviewFinding[];
    };
    unknownPast.findings[0]!.pastJudgmentIds = ["unknown-past"];
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => invocation(JSON.stringify(unknownPast)),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);

    const unknownFixed = JSON.parse(base) as {
      findings: ModelReviewFinding[];
    };
    unknownFixed.findings[0]!.relatedFixedFindingIds = ["unknown-fixed"];
    await expect(
      reviewSnapshot(
        snapshot,
        input({
          fixedFindings: [
            {
              id: "fixed-1",
              ruleId: "rule-1",
              path: "src/a.ts",
              line: 1,
              evidence: "fixed evidence",
              title: "fixed context",
            },
          ],
        }),
        {
          invoke: async () => invocation(JSON.stringify(unknownFixed)),
        },
      ),
    ).rejects.toBeInstanceOf(ModelReviewError);

    const outsideBatch = JSON.parse(base) as {
      findings: ModelReviewFinding[];
    };
    outsideBatch.findings[0]!.path = "src/other.ts";
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => invocation(JSON.stringify(outsideBatch)),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);

    const wrongSource = JSON.parse(base) as {
      findings: ModelReviewFinding[];
    };
    wrongSource.findings[0]!.originalText = "const value = 2;";
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => invocation(JSON.stringify(wrongSource)),
      }),
    ).rejects.toBeInstanceOf(ModelReviewError);

    const longId = await reviewSnapshot(snapshot, input(), {
      invoke: async () =>
        invocation(
          responseFor({
            id: "x".repeat(80),
            path: "src/a.ts",
            line: 1,
            originalText: "const value = 1;",
          }),
        ),
    });
    expect(longId.findings[0]?.id).toMatch(/^batch-0-/);
    expect(longId.findings[0]?.id.length).toBeLessThanOrEqual(80);
  });

  it("rejects a checkpoint containing a duplicated completed batch", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    let checkpoint:
      | Parameters<
          NonNullable<Parameters<typeof reviewSnapshot>[2]["onCheckpoint"]>
        >[0]
      | undefined;
    await reviewSnapshot(snapshot, input(), {
      invoke: async () => invocation(JSON.stringify({ findings: [] })),
      onCheckpoint: (value) => {
        checkpoint = value;
      },
    });
    const duplicated = {
      ...checkpoint!,
      batches: [...checkpoint!.batches, checkpoint!.batches[0]!],
    };
    await expect(
      reviewSnapshot(snapshot, input(), {
        checkpoint: duplicated,
        invoke: async () => invocation(JSON.stringify({ findings: [] })),
      }),
    ).rejects.toBeInstanceOf(ModelReviewCheckpointError);

    const sourceMismatch = {
      ...checkpoint!,
      batches: checkpoint!.batches.map((batch) => ({
        ...batch,
        fileHashes: ["d".repeat(64)],
      })),
    };
    await expect(
      reviewSnapshot(snapshot, input(), {
        checkpoint: sourceMismatch,
        invoke: async () => invocation(JSON.stringify({ findings: [] })),
      }),
    ).rejects.toBeInstanceOf(ModelReviewCheckpointError);
  });

  it("keeps a stop that races with provider completion as stopped coverage", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const controller = new AbortController();
    const result = await reviewSnapshot(snapshot, input(), {
      signal: controller.signal,
      invoke: async () => {
        controller.abort();
        return invocation(JSON.stringify({ findings: [] }));
      },
    });

    expect(result.coverage.status).toBe("stopped");
    expect(result.report.stopReason).toBe("aborted");
    expect(result.findings).toEqual([]);
  });

  it("preserves a model contract error without relabeling it as a provider transport error", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => {
          throw new ModelReviewError("known model contract failure");
        },
      }),
    ).rejects.toThrow("known model contract failure");
  });

  it("rejects ambiguous source and reference identities before invoking a model", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const duplicateSnapshot = {
      ...snapshot,
      files: [...snapshot.files, { ...snapshot.files[0]! }],
    };
    const invoke = async () => invocation(JSON.stringify({ findings: [] }));
    await expect(
      reviewSnapshot(duplicateSnapshot, input(), { invoke }),
    ).rejects.toThrow("snapshotのpathが重複しています");
    await expect(
      reviewSnapshot(
        snapshot,
        input({ approvedKnowledge: [knowledge, { ...knowledge }] }),
        { invoke },
      ),
    ).rejects.toThrow("approvedKnowledgeのIDが重複しています");
    const pastJudgment = {
      id: "same-judgment",
      revision: 1,
      targetVersion: "2.0.0",
      judgment: "accepted_known" as const,
      reason: "同一IDの判断は区別できない。",
      sourceRefs: [knowledge.sourceRefs[0]!],
    };
    await expect(
      reviewSnapshot(
        snapshot,
        input({ pastJudgments: [pastJudgment, { ...pastJudgment }] }),
        { invoke },
      ),
    ).rejects.toThrow("pastJudgmentsのIDが重複しています");
    const fixedFinding = {
      id: "same-fixed",
      ruleId: "rule-1",
      path: "src/a.ts",
      line: 1,
      evidence: "fixed evidence",
      title: "fixed finding",
    };
    await expect(
      reviewSnapshot(
        snapshot,
        input({ fixedFindings: [fixedFinding, { ...fixedFinding }] }),
        { invoke },
      ),
    ).rejects.toThrow("fixedFindingsのIDが重複しています");
  });

  it("rejects invalid injected provider response contracts and non-Error failures", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const cases: unknown[] = [
      null,
      { response: 42 },
      { response: "x".repeat(100_001) },
      { response: "{}", promptTokens: Number.POSITIVE_INFINITY },
      { response: "{}", completionTokens: -1 },
      { response: "{}", actualCostUsd: Number.NaN },
      { response: "{}", actualCostUsd: -0.1 },
    ];
    for (const value of cases) {
      await expect(
        reviewSnapshot(snapshot, input(), {
          invoke: async () => value as ModelReviewInvocation,
        }),
      ).rejects.toBeInstanceOf(ModelReviewError);
    }
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () => {
          throw "provider returned a non-Error failure";
        },
      }),
    ).rejects.toThrow("providerの呼出しに失敗しました");
  });

  it("records an abort that arrives while the provider invocation is rejecting", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const controller = new AbortController();
    const result = await reviewSnapshot(snapshot, input(), {
      signal: controller.signal,
      invoke: async () => {
        controller.abort();
        throw new Error("provider aborted");
      },
    });
    expect(result.coverage).toMatchObject({
      status: "stopped",
      completedBatchCount: 0,
    });
    expect(result.report.stopReason).toBe("aborted");
  });

  it("validates omission end bounds and inverted ranges against the pinned source", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const omissionResponse = (omitted: unknown) =>
      JSON.stringify({ findings: [], omitted: [omitted] });
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () =>
          invocation(
            omissionResponse({
              path: "src/a.ts",
              startLine: 1,
              endLine: 3,
              reason: "end line is outside the source",
            }),
          ),
      }),
    ).rejects.toThrow("endLineがsnapshot範囲外");
    await expect(
      reviewSnapshot(snapshot, input(), {
        invoke: async () =>
          invocation(
            omissionResponse({
              path: "src/a.ts",
              startLine: 2,
              endLine: 1,
              reason: "range is inverted",
            }),
          ),
      }),
    ).rejects.toThrow("line範囲が不正");
  });

  it("rejects a malformed checkpoint before accepting any saved batch", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    await expect(
      reviewSnapshot(snapshot, input(), {
        checkpoint: {} as never,
        invoke: async () => invocation(JSON.stringify({ findings: [] })),
      }),
    ).rejects.toBeInstanceOf(ModelReviewCheckpointError);
  });

  it("reuses a checkpoint with usage at the cost ceiling and skips the remaining batch", async () => {
    const snapshot = makeSnapshot({
      "src/a.ts": "const a = 1;\n",
      "src/b.ts": "const b = 2;\n",
    });
    let checkpoint:
      | Parameters<
          NonNullable<Parameters<typeof reviewSnapshot>[2]["onCheckpoint"]>
        >[0]
      | undefined;
    const first = await reviewSnapshot(snapshot, input(), {
      batchSize: 1,
      maxBudget: { maxCostUsd: 0.01 },
      invoke: async () => ({
        response: JSON.stringify({ findings: [] }),
        promptTokens: 1,
        completionTokens: 1,
        actualCostUsd: 0.01,
      }),
      onCheckpoint: (value) => {
        checkpoint = value;
      },
    });
    expect(first.coverage.completedBatchCount).toBe(1);
    const resumed = await reviewSnapshot(snapshot, input(), {
      batchSize: 1,
      checkpoint,
      maxBudget: { maxCostUsd: 0.01 },
      invoke: async () => {
        throw new Error("cost ceiling should skip this batch");
      },
    });
    expect(resumed.coverage).toMatchObject({
      status: "stopped",
      completedBatchCount: 1,
      assessedFiles: 1,
    });
    expect(resumed.report).toMatchObject({
      stopReason: "max_budgets",
      checkpoint: { reused: true, savedBatchCount: 1 },
    });
  });

  it("keeps a completed one-batch review completed when cost reaches the ceiling at the end", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const result = await reviewSnapshot(snapshot, input(), {
      maxBudget: { maxCostUsd: 0.01 },
      invoke: async () => invocation(JSON.stringify({ findings: [] })),
    });
    expect(result.coverage.status).toBe("complete");
    expect(result.report.status).toBe("completed");
    expect(result.report.stopReason).toBe("max_budgets");
  });

  it("uses the provider output cap when a budget override explicitly leaves it undefined", async () => {
    const snapshot = makeSnapshot({ "src/a.ts": "const value = 1;\n" });
    const result = await reviewSnapshot(snapshot, input(), {
      provider: {
        id: "capped-provider",
        kind: "injected",
        model: "capped-model",
        configVersion: "capped-v1",
        maxOutputTokens: 321,
      },
      maxBudget: { maxOutputTokens: undefined },
      invoke: async () => invocation(JSON.stringify({ findings: [] })),
    });
    expect(result.report.budget.maxOutputTokens).toBe(321);
  });
});
