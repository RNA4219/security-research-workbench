import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import type {
  DiagnosticRun,
  Product,
} from "../src/shared/product-diagnostics.js";
import type { ModelReviewBudget } from "../src/shared/model-review.js";
import type {
  WorkflowProviderDefinition,
  WorkflowProviderResult,
  WorkflowRunDependencies,
} from "../src/server/workflow-runner.js";
import { createDiagnosticFixture } from "./diagnostic-fixture.mjs";

const headers = {
  host: "127.0.0.1:4317",
  "x-workbench": "1",
  "content-type": "application/json",
};
type App = Awaited<ReturnType<typeof createApp>>;
type InvokeModel = WorkflowRunDependencies["invokeModel"];

let fixture: Awaited<ReturnType<typeof createDiagnosticFixture>>;

const baseProvider: WorkflowProviderDefinition = {
  id: "model-failure-local",
  kind: "local",
  label: "モデル異常系テスト用local provider",
  model: "fixture-model",
  available: true,
  costKnown: true,
  configVersion: "fixture-model-v1",
  maxOutputTokens: 2048,
};

function emptyResponse() {
  return JSON.stringify({
    schemaVersion: "1",
    findings: [],
    omitted: [],
    limitations: [],
  });
}

function providerWith(
  changes: Partial<WorkflowProviderDefinition> = {},
): WorkflowProviderDefinition {
  return { ...baseProvider, ...changes };
}

async function createModelApp(
  options: {
    provider?: WorkflowProviderDefinition;
    invoke?: InvokeModel;
    diagnosticsFetch?: typeof fetch;
    modelReviewBudget?: Partial<ModelReviewBudget>;
    modelReviewBatchSize?: number;
    modelReviewTimeoutMs?: number;
    dbPath?: string;
  } = {},
) {
  const provider = options.provider ?? baseProvider;
  return createApp({
    dbPath: options.dbPath ?? ":memory:",
    diagnosticsRepositories: { fixture: fixture.directory },
    diagnosticsFetch:
      options.diagnosticsFetch ??
      (async () => {
        throw new Error("外部依存照会はこの試験では許可しません");
      }),
    workflowProviders: [provider],
    ...(options.invoke ? { workflowInvokeModel: options.invoke } : {}),
    ...(options.modelReviewBudget
      ? { modelReviewBudget: options.modelReviewBudget }
      : {}),
    ...(options.modelReviewBatchSize === undefined
      ? {}
      : { modelReviewBatchSize: options.modelReviewBatchSize }),
    ...(options.modelReviewTimeoutMs === undefined
      ? {}
      : { modelReviewTimeoutMs: options.modelReviewTimeoutMs }),
  });
}

async function call(app: App, url: string, body?: unknown) {
  return app.inject({
    url,
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function createProduct(
  app: App,
  provider: WorkflowProviderDefinition,
  title: string,
  cloudConsent = false,
) {
  const response = await call(app, "/api/products", {
    title,
    repositoryId: "fixture",
    ref: "baseline",
    specification: "TLS接続の証明書検証を必須とする製品。",
    allowDependencyNetwork: false,
    modelReview: {
      enabled: true,
      providerId: provider.id,
      cloudConsent,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<Product>();
}

async function waitForRun(app: App, productId: string, runId: string) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const response = await call(
      app,
      `/api/products/${productId}/runs/${runId}`,
    );
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

async function runWithModel(options: {
  provider?: WorkflowProviderDefinition;
  invoke?: InvokeModel;
  diagnosticsFetch?: typeof fetch;
  modelReviewBudget?: Partial<ModelReviewBudget>;
  modelReviewBatchSize?: number;
  modelReviewTimeoutMs?: number;
}) {
  const app = await createModelApp(options);
  try {
    const provider = options.provider ?? baseProvider;
    const product = await createProduct(
      app,
      provider,
      `モデル異常境界 ${Date.now()}-${Math.random()}`,
    );
    const started = await call(app, `/api/products/${product.id}/runs`, {
      trigger: "manual",
      ref: "baseline",
    });
    expect(started.statusCode, started.body).toBe(202);
    const startedRun = started.json<DiagnosticRun>();
    return await waitForRun(app, product.id, startedRun.id);
  } finally {
    await app.close();
  }
}

beforeAll(async () => {
  fixture = await createDiagnosticFixture();
});

afterAll(async () => {
  // The fixture helper intentionally keeps its Git repository for other
  // diagnostics tests; this suite only owns any temporary database below.
});

describe("診断serviceのmodel provider異常・予算境界", () => {
  it("利用できないlocal providerではrunを作らず開始を拒否する", async () => {
    const provider = providerWith({
      id: "unavailable-local",
      available: false,
    });
    const app = await createModelApp({ provider });
    try {
      const product = await createProduct(app, provider, "利用不可provider");
      const response = await call(app, `/api/products/${product.id}/runs`, {
        trigger: "manual",
        ref: "baseline",
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toContain(
        "利用できません",
      );
      const runs = await call(app, `/api/products/${product.id}/runs`);
      expect(runs.statusCode).toBe(200);
      expect(runs.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("cloud同意なし・同意後の未提供状態をそれぞれ拒否する", async () => {
    const provider = providerWith({
      id: "cloud-provider",
      kind: "cloud",
      endpoint: "https://model.invalid/v1",
    });
    const app = await createModelApp({ provider });
    try {
      const withoutConsent = await createProduct(
        app,
        provider,
        "cloud同意なし",
        false,
      );
      const blocked = await call(
        app,
        `/api/products/${withoutConsent.id}/runs`,
        { trigger: "manual", ref: "baseline" },
      );
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json<{ error: string }>().error).toContain("明示同意");

      const withConsent = await createProduct(
        app,
        provider,
        "cloud同意あり",
        true,
      );
      const unsupported = await call(
        app,
        `/api/products/${withConsent.id}/runs`,
        { trigger: "manual", ref: "baseline" },
      );
      expect(unsupported.statusCode).toBe(409);
      expect(unsupported.json<{ error: string }>().error).toContain(
        "外部送信をまだ提供していません",
      );
    } finally {
      await app.close();
    }
  });

  it("案件scopeからproviderを外したrunを拒否する", async () => {
    const app = await createModelApp({
      invoke: async () => ({
        response: emptyResponse(),
        model: baseProvider.model,
        configVersion: baseProvider.configVersion,
        actualCostUsd: 0,
      }),
    });
    try {
      const product = await createProduct(app, baseProvider, "scope外provider");
      const workflowResponse = await call(
        app,
        `/api/projects/${product.linkedProjectId}/workflow`,
      );
      expect(workflowResponse.statusCode).toBe(200);
      const workflow = workflowResponse.json<{
        revision: number;
        scope: Record<string, unknown>;
      }>();
      const changed = await call(
        app,
        `/api/projects/${product.linkedProjectId}/workflow/commands`,
        {
          revision: workflow.revision,
          command: {
            type: "scope",
            value: { ...workflow.scope, allowedProviderIds: ["manual"] },
          },
        },
      );
      expect(changed.statusCode, changed.body).toBe(200);
      const response = await call(app, `/api/products/${product.id}/runs`, {
        trigger: "manual",
        ref: "baseline",
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toContain(
        "許可されていないmodel provider",
      );
    } finally {
      await app.close();
    }
  });

  it("local以外のprovider kindをモデル診断に使わせない", async () => {
    const provider = providerWith({
      id: "manual-provider",
      kind: "manual",
    });
    const app = await createModelApp({ provider });
    try {
      const product = await createProduct(app, provider, "manual provider");
      const response = await call(app, `/api/products/${product.id}/runs`, {
        trigger: "manual",
        ref: "baseline",
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toContain(
        "local providerだけ",
      );
    } finally {
      await app.close();
    }
  });

  it("modelのJSON不正応答を成功扱いせず、モデルcoverageをunavailableにする", async () => {
    const run = await runWithModel({
      invoke: async () =>
        ({
          response: "これはJSONではありません",
          model: baseProvider.model,
          configVersion: baseProvider.configVersion,
          actualCostUsd: 0,
        }) satisfies WorkflowProviderResult,
    });
    expect(run.status).toBe("partial");
    expect(run.modelReview?.record).toBeNull();
    expect(run.modelReview?.failure).toContain("JSONではありません");
    expect(run.modelReview?.coverage).toMatchObject({
      status: "unavailable",
      completedBatchCount: 0,
      isSafetyProof: false,
    });
    expect(run.findings.some((finding) => finding.engine === "model")).toBe(
      false,
    );
  });

  it("負のtoken usageをprovider応答不正として記録する", async () => {
    const run = await runWithModel({
      invoke: async () =>
        ({
          response: emptyResponse(),
          model: baseProvider.model,
          configVersion: baseProvider.configVersion,
          actualCostUsd: 0,
          promptTokens: -1,
        }) as unknown as WorkflowProviderResult,
    });
    expect(run.status).toBe("partial");
    expect(run.modelReview?.record).toBeNull();
    expect(run.modelReview?.failure).toContain("token usageが不正");
    expect(run.modelReview?.coverage.status).toBe("unavailable");
  });

  it("非有限costをprovider応答不正として記録する", async () => {
    const run = await runWithModel({
      invoke: async () =>
        ({
          response: emptyResponse(),
          model: baseProvider.model,
          configVersion: baseProvider.configVersion,
          actualCostUsd: Number.NaN,
        }) as unknown as WorkflowProviderResult,
    });
    expect(run.status).toBe("partial");
    expect(run.modelReview?.record).toBeNull();
    expect(run.modelReview?.failure).toContain("costが不正");
    expect(run.modelReview?.coverage.status).toBe("unavailable");
  });

  it("注入adapterなしでもendpointのOpenAI互換応答をモデル診断へ接続する", async () => {
    const provider = providerWith({
      id: "endpoint-local-provider",
      endpoint: "http://127.0.0.1:54321/v1",
      apiKey: "must-not-be-recorded",
    });
    const requests: { url: string; body: string }[] = [];
    const diagnosticsFetch: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : String(init?.body),
      });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: emptyResponse() } }],
          model: provider.model,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const run = await runWithModel({ provider, diagnosticsFetch });
    expect(run.modelReview?.record).toMatchObject({
      status: "completed",
      providerId: provider.id,
      model: provider.model,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://127.0.0.1:54321/v1/chat/completions");
    const requestBody = JSON.parse(requests[0]!.body) as {
      model: string;
      max_tokens: number;
      messages: { role: string; content: string }[];
    };
    expect(requestBody).toMatchObject({
      model: provider.model,
      max_tokens: provider.maxOutputTokens,
    });
    expect(requestBody.messages[0]?.content).toContain(
      "MODEL_REVIEW_CONTRACT v1",
    );
    expect(JSON.stringify(run)).not.toContain(provider.apiKey!);
  });

  it("model timeoutを部分成功やcompletedにせずinterruptedとして記録する", async () => {
    const run = await runWithModel({
      modelReviewTimeoutMs: 1_000,
      invoke: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_250));
        return {
          response: emptyResponse(),
          model: baseProvider.model,
          configVersion: baseProvider.configVersion,
          actualCostUsd: 0,
        };
      },
    });
    expect(run.status).toBe("interrupted");
    expect(run.failure).toContain("local model診断の実行時間上限");
    expect(run.modelReview?.record).toMatchObject({
      status: "stopped",
      stopReason: "aborted",
    });
    expect(run.modelReview?.coverage.status).toBe("stopped");
  }, 10_000);

  it("maxPromptChars超過時はpromptを送らず停止記録だけを残す", async () => {
    let invocations = 0;
    const run = await runWithModel({
      modelReviewBatchSize: 1,
      modelReviewBudget: { maxPromptChars: 1 },
      invoke: async () => {
        invocations += 1;
        return {
          response: emptyResponse(),
          model: baseProvider.model,
          configVersion: baseProvider.configVersion,
          actualCostUsd: 0,
        };
      },
    });
    expect(invocations).toBe(0);
    expect(run.status).toBe("partial");
    expect(run.modelReview?.record).toMatchObject({
      status: "stopped",
      stopReason: "max_budgets",
      used: { batches: 0 },
    });
    expect(run.modelReview?.coverage).toMatchObject({
      status: "stopped",
      completedBatchCount: 0,
      isSafetyProof: false,
    });
    expect(run.modelReview?.coverage.omitted.length).toBeGreaterThan(0);
  });

  it("maxCostUsdに達した後は次batchを呼ばず、部分coverageを残す", async () => {
    let invocations = 0;
    const run = await runWithModel({
      modelReviewBatchSize: 1,
      modelReviewBudget: { maxCostUsd: 0 },
      invoke: async () => {
        invocations += 1;
        return {
          response: emptyResponse(),
          model: baseProvider.model,
          configVersion: baseProvider.configVersion,
          actualCostUsd: 0,
        };
      },
    });
    expect(invocations).toBe(1);
    expect(run.status).toBe("partial");
    expect(run.modelReview?.record).toMatchObject({
      status: "stopped",
      stopReason: "max_budgets",
      used: { batches: 1, actualCostUsd: 0 },
    });
    expect(run.modelReview?.coverage.completedBatchCount).toBe(1);
    expect(run.modelReview?.coverage.batchCount).toBeGreaterThan(1);
  });

  it("providerのmaxOutputTokensを有効budgetとinvoke引数に反映する", async () => {
    const provider = providerWith({
      id: "capped-output-provider",
      maxOutputTokens: 32,
    });
    const requested: number[] = [];
    const run = await runWithModel({
      provider,
      invoke: async (_provider, _prompt, _signal, maxOutputTokens) => {
        requested.push(maxOutputTokens);
        return {
          response: emptyResponse(),
          model: provider.model,
          configVersion: provider.configVersion,
          actualCostUsd: 0,
        };
      },
    });
    expect(run.modelReview?.record).toMatchObject({
      status: "completed",
      budget: { maxOutputTokens: 32 },
    });
    expect(requested.length).toBeGreaterThan(0);
    expect(new Set(requested)).toEqual(new Set([32]));
  });

  it("保存済みmodel checkpointのbudget変更を再開時に拒否する", async () => {
    const dbDirectory = await mkdtemp(join(".cache", "model-failure-db-"));
    const dbPath = join(dbDirectory, "diagnostics.sqlite");
    let firstInvocations = 0;
    const firstApp = await createModelApp({
      dbPath,
      modelReviewBatchSize: 1,
      modelReviewBudget: { maxBatches: 2 },
      invoke: async () => {
        firstInvocations += 1;
        if (firstInvocations > 1) throw new Error("モデル停止");
        return {
          response: emptyResponse(),
          model: baseProvider.model,
          configVersion: baseProvider.configVersion,
          actualCostUsd: 0,
        };
      },
    });
    let product: Product;
    let partialRun: DiagnosticRun;
    try {
      product = await createProduct(
        firstApp,
        baseProvider,
        "budget checkpoint",
      );
      const started = await call(firstApp, `/api/products/${product.id}/runs`, {
        trigger: "manual",
        ref: "baseline",
      });
      expect(started.statusCode, started.body).toBe(202);
      partialRun = await waitForRun(
        firstApp,
        product.id,
        started.json<DiagnosticRun>().id,
      );
      expect(partialRun.status).toBe("partial");
      expect(partialRun.modelReview?.budget?.maxBatches).toBe(2);
    } finally {
      await firstApp.close();
    }

    let secondInvocations = 0;
    const secondApp = await createModelApp({
      dbPath,
      modelReviewBatchSize: 1,
      modelReviewBudget: { maxBatches: 1 },
      invoke: async () => {
        secondInvocations += 1;
        return {
          response: emptyResponse(),
          model: baseProvider.model,
          configVersion: baseProvider.configVersion,
          actualCostUsd: 0,
        };
      },
    });
    try {
      const resumed = await call(
        secondApp,
        `/api/products/${product!.id}/runs/${partialRun!.id}/resume`,
        {},
      );
      expect(resumed.statusCode).toBe(409);
      expect(resumed.json<{ error: string }>().error).toContain(
        "予算設定がcheckpoint作成時から変わっています",
      );
      expect(secondInvocations).toBe(0);
    } finally {
      await secondApp.close();
      await rm(dbDirectory, { recursive: true, force: true });
    }
  }, 15_000);
});
