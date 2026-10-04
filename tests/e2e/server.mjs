import { researchFetcher } from "../research-fixtures.ts";
import { createDiagnosticFixture } from "../diagnostic-fixture.mjs";
import { setTimeout as delay } from "node:timers/promises";
// テスト専用の起動入口。利用者の4317番ポート・DB・製品ビルドは変更しない。
const serverRoot =
  process.env.WORKBENCH_COVERAGE === "1"
    ? "../../.cache/coverage-build/server/"
    : "../../dist/server/";
const { createApp } = await import(
  new URL(`${serverRoot}app.js`, import.meta.url).href
);
const { workflowProvidersFromEnvironment } = await import(
  new URL(`${serverRoot}workflow-providers.js`, import.meta.url).href
);
const diagnosticFixture = await createDiagnosticFixture();
const app = await createApp({
  port: 4318,
  dbPath: process.env.DATA_PATH,
  researchFetch: researchFetcher(),
  diagnosticsRepositories: { fixture: diagnosticFixture.directory },
  // 画面・保存の契約試験用。実モデルの発見能力の証拠には使わない。
  workflowProviders: workflowProvidersFromEnvironment({
    WORKFLOW_LOCAL_URL: "http://127.0.0.1:8089",
    WORKFLOW_LOCAL_MODEL: "UI契約試験用の固定応答",
  }),
  workflowInvokeModel: async (provider, prompt, signal) => {
    const payload = JSON.parse(
      prompt
        .split("BEGIN_REFERENCE_DATA_JSON\n")[1]
        .split("\nEND_REFERENCE_DATA_JSON")[0],
    );
    const file = payload.pinnedSnapshot.files.find(
      (entry) => entry.path === "src/client.ts",
    );
    const line = file?.lines.find((entry) =>
      entry.text.includes("rejectUnauthorized: false"),
    );
    if (
      payload.approvedKnowledge.some((entry) =>
        entry.content.includes("UI_DELAY_MODEL"),
      )
    ) {
      await delay(5000, undefined, { signal });
    }
    if (
      payload.approvedKnowledge.some((entry) =>
        entry.content.includes("UI_BAD_RESPONSE"),
      )
    ) {
      return {
        response: '{"type":"object"}',
        actualCostUsd: 0,
        model: provider.model,
        configVersion: provider.configVersion,
      };
    }
    return {
      response: JSON.stringify({
        schemaVersion: "1",
        findings: line
          ? [
              {
                id: "ui-model-observation",
                category: "trust-boundary",
                severity: "medium",
                title: "製品仕様と通信設定の照合候補",
                rationale:
                  "製品仕様の証明書検証要件と、固定版の通信設定を確認してください。画面契約用の固定応答です。",
                path: file.path,
                line: line.line,
                originalText: line.text,
                specRefIds: payload.approvedKnowledge.map((entry) => entry.id),
                relatedFixedFindingIds: [],
                pastJudgmentIds: [],
                remediation: {
                  guidance: "担当者が用途・仕様と通信設定を確認する。",
                  humanReviewRequired: true,
                },
                falsePositiveCandidate: false,
                uncertainty: {
                  level: "medium",
                  reasons: ["実モデルの応答ではありません。"],
                },
              },
            ]
          : [],
        omitted: [],
        limitations: ["UI契約試験の固定応答。診断性能は評価しません。"],
      }),
      actualCostUsd: 0,
      model: provider.model,
      configVersion: provider.configVersion,
      ...(payload.approvedKnowledge.some((entry) =>
        entry.content.includes("UI_NO_USAGE"),
      )
        ? {}
        : { promptTokens: 123, completionTokens: 45 }),
    };
  },
  staticRoot:
    process.env.WORKBENCH_COVERAGE === "1"
      ? ".cache/coverage-build/client"
      : "dist/client",
});
await app.listen({ port: 4318, host: "127.0.0.1" });
