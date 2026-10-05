import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), "..");
const terminalStatuses = new Set([
  "completed",
  "partial",
  "failed",
  "stopped",
  "interrupted",
]);
const LIVE_MODE = "live";
const headers = {
  host: "127.0.0.1:4317",
  "x-workbench": "1",
  "content-type": "application/json",
};
const CONTRACT_MODE = "contract";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const EVALUATION_MODEL_REVIEW_TIMEOUT_MS = 120_000;
const EVALUATION_MODEL_REVIEW_POSTPROCESS_GRACE_MS = 15_000;
const EVALUATION_MODEL_REVIEW_POLL_INTERVAL_MS = 200;
const EVALUATION_CONTRACT_POLL_INTERVAL_MS = 10;
const EVALUATION_MODEL_REVIEW_BUDGET = Object.freeze({
  maxBatches: 100,
  maxFiles: 500,
  maxInputChars: 10_000_000,
  maxBatchChars: 12_000,
  maxPromptChars: 20_000,
  maxOutputTokens: 2_048,
});

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runWaitTimeoutError(runId, lastRun) {
  const error = new Error(`診断runの待機期限を超えました: ${runId}`);
  error.runId = runId;
  error.lastRun = lastRun;
  error.runWaitTimedOut = true;
  return error;
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeProvider(provider) {
  return {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    model: provider.model,
    available: provider.available,
    costKnown: provider.costKnown,
    configVersion: provider.configVersion,
    endpointConfigured: Boolean(provider.endpoint),
    endpointFingerprint: provider.endpoint ? sha256(provider.endpoint) : null,
    disableThinking: provider.disableThinking ?? false,
    maxOutputTokens: provider.maxOutputTokens ?? 2048,
  };
}

function isLoopbackEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return (
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) &&
      (url.protocol === "http:" || url.protocol === "https:")
    );
  } catch {
    return false;
  }
}

async function prepareOutput(output) {
  await mkdir(output, { recursive: true });
  const entries = await readdir(output);
  assert(
    entries.length === 0,
    `出力先が空ではありません。既存のDBや証跡を上書きしないため中止します: ${output}`,
  );
}

async function git(root, ...args) {
  const result = await exec(
    "git",
    ["-c", "core.hooksPath=", "-C", root, ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return String(result.stdout).trim();
}

/**
 * Create a harmless, managed fixture.  The source is never executed; Git is
 * used only to pin the commit consumed by ProductDiagnosticsService.
 */
async function createFixture(root) {
  await mkdir(join(root, "src"), { recursive: true });
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Workbench feedback contract fixture");
  await git(root, "config", "user.email", "feedback-fixture@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await writeFile(
    join(root, "src", "client.ts"),
    [
      'import https from "node:https";',
      "export const client = new https.Agent({ rejectUnauthorized: false });",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "diagnostic-feedback-contract-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "diagnostic-feedback-contract-fixture",
          version: "1.0.0",
        },
      },
    }),
  );
  await git(root, "add", "--", ".");
  await git(root, "commit", "--quiet", "-m", "feedback contract fixture");
  const commit = await git(root, "rev-parse", "HEAD");
  await git(root, "branch", "baseline", commit);
  return commit;
}

async function sourceSnapshot(root, commit) {
  const raw = await git(root, "ls-files", "-z");
  const paths = raw ? raw.split("\0").filter(Boolean) : [];
  const files = [];
  for (const path of paths) {
    const content = await readFile(join(root, path), "utf8");
    files.push({
      path,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: sha256(content),
      content,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    commit,
    files,
    snapshotSha256: sha256(stableJson({ commit, files })),
  };
}

export function referenceData(prompt) {
  const start = "BEGIN_REFERENCE_DATA_JSON\n";
  const end = "\nEND_REFERENCE_DATA_JSON";
  const from = prompt.indexOf(start);
  const to = prompt.indexOf(end, from + start.length);
  if (from < 0 || to < 0)
    throw new Error("model promptの固定参照資料がありません");
  const payload = JSON.parse(prompt.slice(from + start.length, to));
  assert(
    typeof payload?.targetVersion === "string" &&
      /^[a-f0-9]{40}$/.test(payload.targetVersion) &&
      payload.pinnedSnapshot?.commit === payload.targetVersion &&
      /^[a-f0-9]{64}$/.test(payload.pinnedSnapshot?.manifestHash ?? "") &&
      Array.isArray(payload.pinnedSnapshot?.files) &&
      payload.pinnedSnapshot.files.length > 0 &&
      payload.pinnedSnapshot.files.every(
        (file) =>
          typeof file?.path === "string" &&
          /^[a-f0-9]{64}$/.test(file.hash ?? "") &&
          Array.isArray(file.lines) &&
          file.lines.length > 0 &&
          file.lines.every(
            (line) =>
              Number.isInteger(line?.line) &&
              line.line > 0 &&
              typeof line.text === "string",
          ),
      ) &&
      Array.isArray(payload.specificationRefs) &&
      payload.specificationRefs.length > 0 &&
      payload.specificationRefs.every((ref) => typeof ref?.id === "string") &&
      Array.isArray(payload.matchingPastJudgments) &&
      payload.matchingPastJudgments.every(
        (item) => typeof item?.id === "string",
      ),
    "model promptの固定参照資料の版・snapshot・参照IDが不正です",
  );
  return payload;
}

export function validateFeedbackPhase(
  run,
  phaseInvocations,
  expectedCommit,
  expectedIdentity,
) {
  const errors = [];
  if (run.status !== "completed") errors.push("診断runが完了していません");
  if (run.commit !== expectedCommit)
    errors.push("診断runの固定コミットが一致しません");
  const review = run.modelReview;
  if (
    review?.coverage?.status !== "complete" ||
    review?.record?.status !== "completed" ||
    !Number.isInteger(review?.coverage?.batchCount) ||
    review?.coverage?.batchCount < 1 ||
    review?.coverage?.completedBatchCount !== review?.coverage?.batchCount ||
    review?.coverage?.omitted?.length !== 0 ||
    review?.failure
  )
    errors.push("モデルの診断範囲に未完了・失敗があります");
  if (!phaseInvocations.length)
    errors.push("実行に対応するモデル呼出しがありません");
  for (const entry of phaseInvocations) {
    if (entry.error || !entry.response || !entry.reference)
      errors.push("モデル呼出しまたは入力証跡の抽出に失敗しています");
    if (
      entry.reference?.targetVersion !== expectedCommit ||
      entry.reference?.pinnedSnapshot?.commit !== expectedCommit
    )
      errors.push("モデル入力の固定コミットを確認できません");
    if (
      !run.manifestHash ||
      entry.reference?.pinnedSnapshot?.manifestHash !== run.manifestHash
    )
      errors.push("モデル入力と診断runのsnapshotが一致しません");
    const specification = entry.reference?.specificationRefs?.find(
      (ref) => ref.id === "product-specification",
    );
    if (
      typeof expectedIdentity?.specification !== "string" ||
      specification?.excerpt !== expectedIdentity.specification ||
      specification?.hash !== sha256(expectedIdentity.specification) ||
      specification?.version !== String(run.specificationRevision)
    )
      errors.push("モデル入力の製品仕様・版・hashが一致しません");
    const files = entry.reference?.pinnedSnapshot?.files;
    if (
      !Array.isArray(files) ||
      !files.length ||
      files.some((file) => {
        const original = expectedIdentity?.source?.files?.find(
          (candidate) => candidate.path === file.path,
        );
        const recorded = run.snapshotFiles?.find(
          (candidate) => candidate.path === file.path,
        );
        return (
          !original ||
          original.sha256 !== file.hash ||
          recorded?.hash !== file.hash ||
          !Array.isArray(file.lines) ||
          !file.lines.length ||
          file.lines.some(
            (line) =>
              original.content.split(/\r?\n/)[line.line - 1] !== line.text,
          )
        );
      })
    )
      errors.push("モデル入力のファイルhash・原文がfixtureと一致しません");
  }
  return errors;
}

function contractResponse(prompt, wordingChanged = false) {
  const payload = referenceData(prompt);
  const file = payload.pinnedSnapshot?.files?.find(
    (entry) => entry.path === "src/client.ts",
  );
  const line = file?.lines?.find((entry) =>
    entry.text.includes("rejectUnauthorized: false"),
  );
  assert(file && line, "contract fake modelの対象行が固定snapshotにありません");
  return JSON.stringify({
    schemaVersion: "1",
    findings: [
      {
        id: "feedback-contract-model-finding",
        category: "trust-boundary",
        severity: "medium",
        title: wordingChanged
          ? "通信設定について製品仕様との照合が必要"
          : "製品仕様と通信設定の照合候補",
        rationale:
          "固定snapshotの通信設定と製品仕様を担当者が照合する必要があります。",
        path: file.path,
        line: line.line,
        originalText: line.text,
        specRefIds: ["product-specification"],
        relatedFixedFindingIds: [],
        pastJudgmentIds: [],
        remediation: {
          guidance: wordingChanged
            ? "担当者が通信設定を製品の用途・仕様と照合する。"
            : "担当者が用途・仕様と通信設定を確認する。",
          humanReviewRequired: true,
        },
        falsePositiveCandidate: false,
        uncertainty: {
          level: "medium",
          reasons: [
            "これはcontract modeの固定応答であり、実モデルの精度証拠ではありません。",
          ],
        },
      },
    ],
    omitted: [],
    limitations: ["contract modeの固定応答。実モデルの発見性能は評価しない。"],
  });
}

function isSuppressed(finding) {
  return Boolean(
    finding.presentInAnalysis === true &&
    finding.reviewDisposition === "suppressed_human" &&
    finding.suppression?.status === "active" &&
    finding.suppression?.reused === true,
  );
}

function summarizeRun(run, detail) {
  const modelFindings = run.findings.filter(
    (finding) => finding.engine === "model",
  );
  const modelCurrent = modelFindings.filter(
    (finding) => finding.presentInAnalysis === true,
  );
  const modelSuppressed = modelFindings.filter(isSuppressed);
  const modelQueue = modelCurrent.filter((finding) => !isSuppressed(finding));
  const detailRun = detail.runs?.find((item) => item.id === run.id);
  return {
    id: run.id,
    status: run.status,
    commit: run.commit,
    manifestHash: run.manifestHash,
    engineVersion: run.engineVersion,
    specificationRevision: run.specificationRevision,
    workflowRevision: run.workflowRevision,
    snapshotFiles: run.snapshotFiles,
    snapshotOmitted: run.snapshotOmitted,
    coverage: run.coverage,
    failure: run.failure,
    modelReview: run.modelReview
      ? {
          enabled: run.modelReview.enabled,
          providerId: run.modelReview.providerId,
          providerKind: run.modelReview.providerKind,
          model: run.modelReview.model,
          configVersion: run.modelReview.configVersion,
          inputHash: run.modelReview.inputHash,
          contextHash: run.modelReview.contextHash,
          budget: run.modelReview.budget ?? null,
          coverage: run.modelReview.coverage,
          record: run.modelReview.record,
          failure: run.modelReview.failure ?? null,
        }
      : null,
    findingCounts: detailRun?.findingCounts ?? null,
    candidates: run.findings,
    rawModelCandidates: modelFindings,
    confirmationQueueCandidates: modelQueue,
    modelCandidateCount: modelFindings.length,
    modelCurrentCount: modelCurrent.length,
    modelSuppressedCount: modelSuppressed.length,
    modelQueueRequiredCount: modelQueue.length,
  };
}

function resolveConfiguredModule(envName, fallback) {
  return process.env[envName]
    ? resolve(repoRoot, process.env[envName])
    : resolve(repoRoot, fallback);
}

async function verifiedBuildModulePath(modulePath, kind) {
  const actualPath = await realpath(modulePath);
  assert(
    insideBuildRoot(resolve(repoRoot, "dist"), actualPath),
    `${kind} moduleが許可済みbuild root外です`,
  );
  return actualPath;
}

async function loadCreateApp(createAppFactory, requireBuildRoot = false) {
  if (createAppFactory)
    return { createApp: createAppFactory, modulePath: null, injected: true };
  let modulePath = resolveConfiguredModule(
    "DIAGNOSTIC_FEEDBACK_APP_MODULE",
    "dist/server/app.js",
  );
  if (requireBuildRoot)
    modulePath = await verifiedBuildModulePath(modulePath, "app");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.createApp !== "function")
    throw new Error(`createAppがありません: ${modulePath}`);
  return { createApp: module.createApp, modulePath, injected: false };
}

async function loadLiveProviderModule() {
  let modulePath = resolveConfiguredModule(
    "DIAGNOSTIC_FEEDBACK_PROVIDER_MODULE",
    "dist/server/workflow-providers.js",
  );
  modulePath = await verifiedBuildModulePath(modulePath, "provider");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.workflowProvidersFromEnvironment !== "function")
    throw new Error(
      `workflowProvidersFromEnvironmentがありません: ${modulePath}`,
    );
  if (typeof module.invokeOpenAICompatible !== "function")
    throw new Error(`invokeOpenAICompatibleがありません: ${modulePath}`);
  return { module, modulePath };
}

function insideBuildRoot(buildRoot, filePath) {
  const relativePath = relative(buildRoot, filePath);
  return (
    relativePath &&
    relativePath !== ".." &&
    !relativePath.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) &&
    !isAbsolute(relativePath)
  );
}

async function resolveBuildImport(fromPath, specifier, buildRoot) {
  if (!specifier.startsWith(".")) return null;
  const requested = resolve(dirname(fromPath), specifier);
  const candidates = requested.endsWith(".js")
    ? [requested]
    : [requested, `${requested}.js`, join(requested, "index.js")];
  for (const candidate of candidates) {
    if (!insideBuildRoot(buildRoot, candidate) || !candidate.endsWith(".js"))
      continue;
    const relativePath = relative(buildRoot, candidate).replace(/\\/g, "/");
    if (!["server", "shared", "research"].includes(relativePath.split("/")[0]))
      continue;
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // A dynamic optional import may not be present in this build.
    }
  }
  return null;
}

function relativeImportSpecifiers(content) {
  const specifiers = new Set();
  const staticImports =
    /\b(?:import|export)\s+(?:[^"'`]*?\sfrom\s+)?["']([^"']+)["']/g;
  const dynamicImports = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(staticImports)) specifiers.add(match[1]);
  for (const match of content.matchAll(dynamicImports))
    specifiers.add(match[1]);
  return [...specifiers].filter((specifier) => specifier.startsWith("."));
}

async function buildDependencySnapshot(entries, buildRoot) {
  const pending = [...entries];
  const visited = new Set();
  const files = [];
  while (pending.length) {
    const item = pending.shift();
    const filePath = await resolveBuildImport(
      item.fromPath ?? item.modulePath,
      item.specifier ??
        `./${relative(dirname(item.modulePath), item.modulePath)}`,
      buildRoot,
    );
    if (!filePath || visited.has(filePath)) continue;
    visited.add(filePath);
    const bytes = await readFile(filePath);
    files.push({
      kind: item.kind,
      path: relative(repoRoot, filePath),
      bytes: bytes.byteLength,
      sha256: sha256Bytes(bytes),
      content: bytes.toString("utf8"),
    });
    for (const specifier of relativeImportSpecifiers(bytes.toString("utf8")))
      pending.push({
        fromPath: filePath,
        specifier,
        kind: "build-dependency",
      });
  }
  return files;
}

async function runtimeSourceSnapshot({ modules, scriptPath, packageLockPath }) {
  const buildRoot = resolve(repoRoot, "dist");
  for (const item of modules) {
    assert(
      item?.modulePath,
      `${item?.kind ?? "runtime"} module pathがありません`,
    );
    assert(
      insideBuildRoot(buildRoot, item.modulePath),
      `${item.kind} moduleが許可済みbuild root外です`,
    );
  }
  const files = await buildDependencySnapshot(
    modules.map((item) => ({
      modulePath: item.modulePath,
      fromPath: item.modulePath,
      specifier: `./${relative(dirname(item.modulePath), item.modulePath)}`,
      kind: item.kind,
    })),
    buildRoot,
  );
  for (const item of [
    { kind: "evaluation-script", path: scriptPath },
    { kind: "package-lock", path: packageLockPath },
  ]) {
    const bytes = await readFile(item.path);
    files.push({
      kind: item.kind,
      path: relative(repoRoot, item.path),
      bytes: bytes.byteLength,
      sha256: sha256Bytes(bytes),
      content: bytes.toString("utf8"),
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const identity = files.map(({ kind, path, bytes, sha256: hash }) => ({
    kind,
    path,
    bytes,
    sha256: hash,
  }));
  return {
    files,
    snapshotSha256: sha256(stableJson({ files })),
    buildIdentity: sha256(stableJson(identity)),
  };
}

function runtimeIdentityEntry(files, kind) {
  const item = files.find((candidate) => candidate.kind === kind);
  return item
    ? {
        kind: item.kind,
        path: item.path,
        bytes: item.bytes,
        sha256: item.sha256,
      }
    : null;
}

/**
 * Run the product-level feedback evaluation against the public app routes.
 * `contract` uses only the injected deterministic response. `live` loads the
 * production app/provider modules and invokes the configured local loopback
 * OpenAI-compatible provider; it never falls back to the contract response.
 */
export async function runDiagnosticFeedbackEvaluation({
  mode = CONTRACT_MODE,
  matchPolicy = "exact_evidence",
  contractWordingVariation = false,
  outputDir,
  createApp: createAppFactory,
} = {}) {
  if (mode !== CONTRACT_MODE && mode !== LIVE_MODE)
    throw new Error(`未対応の評価modeです: ${mode}`);
  if (!["exact_evidence", "source_scope"].includes(matchPolicy))
    throw new Error(`未対応の抑止範囲です: ${matchPolicy}`);
  if (mode === LIVE_MODE && contractWordingVariation)
    throw new Error("固定応答の文章変更はcontract modeだけで使用できます");
  if (mode === LIVE_MODE && createAppFactory)
    throw new Error(
      "live評価ではテスト用createApp注入を許可せず、production app moduleを使います",
    );
  const output = resolve(
    outputDir ??
      join(
        repoRoot,
        ".cache",
        "diagnostic-feedback-evaluation",
        new Date().toISOString().replace(/[:.]/g, "-"),
      ),
  );
  await prepareOutput(output);
  const fixtureRoot = join(output, "fixture");
  const dbPath = join(output, "diagnostics.sqlite");
  const invocations = [];
  const phases = [];
  const workflowCommands = [];
  const workflowSnapshots = [];
  const humanJudgments = [];
  const feedbackChecks = {
    sameConditionSuppression: null,
    specificationReconfirmation: null,
  };
  let fixtureCommit = null;
  let source = null;
  let app;
  let product = null;
  let failure = null;
  let activePhase = "setup";
  let provider = null;
  let providerRuntime = null;
  let appRuntime = null;
  let runtimeSource = null;
  const modelReviewBudget = { ...EVALUATION_MODEL_REVIEW_BUDGET };
  const modelReviewTimeoutMs = EVALUATION_MODEL_REVIEW_TIMEOUT_MS;
  const pollIntervalMs =
    mode === LIVE_MODE
      ? EVALUATION_MODEL_REVIEW_POLL_INTERVAL_MS
      : EVALUATION_CONTRACT_POLL_INTERVAL_MS;
  const runWaitTimeoutMs =
    mode === LIVE_MODE
      ? modelReviewTimeoutMs + EVALUATION_MODEL_REVIEW_POSTPROCESS_GRACE_MS
      : 30_000;

  const invokeModel = async (selected, prompt, _signal, maxOutputTokens) => {
    const startedAt = new Date().toISOString();
    let response = null;
    let error = null;
    let result = null;
    try {
      if (mode === CONTRACT_MODE) {
        response = contractResponse(
          prompt,
          contractWordingVariation && activePhase !== "initial",
        );
        result = {
          response,
          model: selected.model,
          configVersion: selected.configVersion,
          actualCostUsd: 0,
          promptTokens: 1,
          completionTokens: 1,
        };
      } else {
        assert(
          selected.id === provider.id &&
            selected.kind === "local" &&
            isLoopbackEndpoint(selected.endpoint ?? ""),
          "live評価はloopback endpointのlocal providerだけを許可します",
        );
        result = await providerRuntime.module.invokeOpenAICompatible(
          selected,
          prompt,
          _signal,
          maxOutputTokens,
        );
        response = result.response;
      }
      return result;
    } catch (caught) {
      error = safeError(caught);
      throw caught;
    } finally {
      let reference = null;
      try {
        const payload = referenceData(prompt);
        reference = {
          targetVersion: payload.targetVersion ?? null,
          purpose: payload.purpose ?? null,
          matchingPastJudgmentIds: Array.isArray(payload.matchingPastJudgments)
            ? payload.matchingPastJudgments.map((item) => item.id)
            : [],
          matchingPastJudgments: payload.matchingPastJudgments ?? [],
          specificationRefs: payload.specificationRefs ?? [],
          conditionHash: payload.conditionHash ?? null,
          pinnedSnapshot: payload.pinnedSnapshot ?? null,
        };
      } catch (caught) {
        error ??= safeError(caught);
      }
      invocations.push({
        phase: activePhase,
        startedAt,
        completedAt: new Date().toISOString(),
        provider: safeProvider(selected),
        maxOutputTokens,
        prompt,
        response,
        responseHash: response === null ? null : sha256(response),
        promptHash: sha256(prompt),
        result: result
          ? {
              model: result.model ?? null,
              configVersion: result.configVersion ?? null,
              promptTokens: result.promptTokens ?? null,
              completionTokens: result.completionTokens ?? null,
              actualCostUsd: result.actualCostUsd ?? null,
            }
          : null,
        reference,
        error,
      });
    }
  };

  const request = async (url, body) => {
    const response = await app.inject({
      url,
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new Error(`API responseがJSONではありません: ${url}`);
    }
    if (response.statusCode >= 400)
      throw new Error(parsed.error ?? `API ${response.statusCode}: ${url}`);
    return parsed;
  };

  const waitForRun = async (productId, runId) => {
    const deadline = Date.now() + runWaitTimeoutMs;
    let lastRun = null;
    while (Date.now() < deadline) {
      const run = await request(
        `/api/products/${encodeURIComponent(productId)}/runs/${encodeURIComponent(runId)}`,
      );
      lastRun = run;
      if (terminalStatuses.has(run.status)) return run;
      await delay(pollIntervalMs);
    }
    throw runWaitTimeoutError(runId, lastRun);
  };

  try {
    if (mode === CONTRACT_MODE) {
      provider = {
        id: "local",
        kind: "local",
        label: "feedback contract fake local provider",
        model: "feedback-contract-fake-model",
        available: true,
        costKnown: true,
        configVersion: "feedback-contract-v1",
        maxOutputTokens: 2048,
      };
    } else {
      providerRuntime = await loadLiveProviderModule();
      const providers = providerRuntime.module.workflowProvidersFromEnvironment(
        process.env,
      );
      provider = providers.find((item) => item.id === "local");
      assert(provider, "live評価用のlocal provider設定がありません");
      assert(
        provider.kind === "local",
        "live評価用providerがlocalではありません",
      );
      assert(
        provider.available && provider.endpoint,
        "live評価用local providerのendpoint設定がありません",
      );
      assert(
        isLoopbackEndpoint(provider.endpoint),
        "live評価はloopback endpointのlocal providerだけを許可します",
      );
    }
    fixtureCommit = await createFixture(fixtureRoot);
    source = await sourceSnapshot(fixtureRoot, fixtureCommit);
    appRuntime = await loadCreateApp(createAppFactory, mode === LIVE_MODE);
    if (mode === LIVE_MODE)
      runtimeSource = await runtimeSourceSnapshot({
        modules: [
          { kind: "app", modulePath: appRuntime.modulePath },
          { kind: "provider", modulePath: providerRuntime.modulePath },
        ],
        scriptPath: thisFile,
        packageLockPath: join(repoRoot, "package-lock.json"),
      });
    app = await appRuntime.createApp({
      dbPath,
      diagnosticsRepositories: { fixture: fixtureRoot },
      diagnosticsScheduleIntervalMs: 0,
      diagnosticsFetch: async () => {
        throw new Error(`${mode}評価では外部依存照会を許可しません`);
      },
      workflowProviders: [provider],
      workflowInvokeModel: invokeModel,
      modelReviewBudget,
      modelReviewTimeoutMs,
    });

    product = await request("/api/products", {
      title: `AI feedback ${mode} evaluation`,
      repositoryId: "fixture",
      ref: "baseline",
      specification: `TLS接続の証明書検証を必須とする。${mode} mode評価用。`,
      allowDependencyNetwork: false,
      modelReview: {
        enabled: true,
        providerId: "local",
        cloudConsent: false,
      },
    });

    const runPhase = async (name, expectedProduct = product) => {
      activePhase = name;
      const invocationStart = invocations.length;
      const started = await request(`/api/products/${product.id}/runs`, {
        trigger: "manual",
        ref: "baseline",
      });
      let run;
      try {
        run = await waitForRun(product.id, started.id);
      } catch (error) {
        if (!error?.runWaitTimedOut) throw error;
        let stoppedRun = error.lastRun;
        let stopError = null;
        if (stoppedRun?.id) {
          try {
            stoppedRun = await request(
              `/api/products/${encodeURIComponent(product.id)}/runs/${encodeURIComponent(stoppedRun.id)}/stop`,
              {},
            );
          } catch (caught) {
            stopError = safeError(caught);
          }
        }
        let stoppedDetail = { runs: [] };
        try {
          stoppedDetail = await request(`/api/products/${product.id}`);
        } catch (caught) {
          stopError ??= `停止後のrun detail取得に失敗しました: ${safeError(caught)}`;
        }
        if (stoppedRun) {
          phases.push({
            name,
            startedRunId: started.id,
            run: summarizeRun(stoppedRun, stoppedDetail),
            invocationRange: [invocationStart, invocations.length],
            validation: {
              status: "fail",
              errors: [
                `polling timeout (${runWaitTimeoutMs}ms)`,
                ...(stopError
                  ? [`対象runの停止または証跡取得に失敗: ${stopError}`]
                  : []),
              ],
              timedOut: true,
              stopRequested: true,
            },
          });
        }
        const timeout = new Error(
          `${name}: 診断runの待機期限を超えたため対象runを停止しました`,
        );
        timeout.cause = error;
        throw timeout;
      }
      const detail = await request(`/api/products/${product.id}`);
      const summary = summarizeRun(run, detail);
      const invocationEnd = invocations.length;
      const modelRaw = run.findings.filter(
        (finding) => finding.engine === "model",
      );
      const modelCurrent = run.findings.filter(
        (finding) => finding.engine === "model" && finding.presentInAnalysis,
      );
      const validationErrors = validateFeedbackPhase(
        run,
        invocations.slice(invocationStart, invocationEnd),
        fixtureCommit,
        { source, specification: expectedProduct.specification },
      );
      if (!modelRaw.length || !modelCurrent.length)
        validationErrors.push("モデルが候補を返さず、成功扱いできません");
      if (modelRaw.some((finding) => finding.presentInAnalysis !== true))
        validationErrors.push("モデル候補が診断結果から消えています");
      phases.push({
        name,
        startedRunId: started.id,
        run: summary,
        invocationRange: [invocationStart, invocationEnd],
        validation: {
          status: validationErrors.length ? "fail" : "pass",
          errors: validationErrors,
        },
      });
      if (validationErrors.length)
        throw new Error(`${name}: ${validationErrors.join("; ")}`);
      return run;
    };

    const first = await runPhase("initial");
    const firstCandidate = first.findings.find(
      (finding) => finding.engine === "model" && finding.presentInAnalysis,
    );
    assert(
      firstCandidate?.workflowFindingId,
      "初回モデル候補にworkflow findingがありません",
    );
    const workflowUrl = `/api/projects/${encodeURIComponent(product.linkedProjectId)}/workflow`;
    let workflow = await request(workflowUrl);
    const workflowFinding = workflow.findings.find(
      (finding) => finding.id === firstCandidate.workflowFindingId,
    );
    assert(workflowFinding, "初回モデル候補のworkflow findingがありません");
    const humanJudgment = {
      actor: "contract-test-subject",
      reason:
        "テスト用の判断であり、実利用者の判定ではない。固定fixtureの根拠と期限を確認した。",
      judgment: "accepted_known",
      targetVersion: first.commit,
      sourceRefs: workflowFinding.sourceRefs,
      ruleRefs: [],
    };
    const decisionBody = {
      revision: workflow.revision,
      command: {
        type: "finding-decision",
        findingId: workflowFinding.id,
        ...humanJudgment,
      },
    };
    workflow = await request(`${workflowUrl}/commands`, decisionBody);
    workflowCommands.push({ phase: "human-judgment", request: decisionBody });
    humanJudgments.push({
      phase: "human-judgment",
      command: decisionBody.command,
    });
    const suppressionBody = {
      revision: workflow.revision,
      command: {
        type: "suppression",
        findingId: workflowFinding.id,
        actor: humanJudgment.actor,
        reason:
          matchPolicy === "source_scope"
            ? "テスト主体が明示選択した範囲。同じ固定版・コード箇所・種類・重大度・仕様参照の指摘を、説明や修正案の文章が変わっても期限まで対象にする。意味が同一という自動判定ではない。"
            : "テスト用の判断。同一固定版・同一根拠・同一条件に限り再確認不要とする。",
        targetVersion: first.commit,
        fingerprint: workflowFinding.fingerprint,
        ruleRefs: [],
        expiresAt: "2099-01-01T00:00:00.000Z",
        ...(matchPolicy === "source_scope" ? { matchPolicy } : {}),
      },
    };
    workflow = await request(`${workflowUrl}/commands`, suppressionBody);
    workflowCommands.push({
      phase: "human-suppression",
      request: suppressionBody,
    });
    humanJudgments.push({
      phase: "human-suppression",
      command: suppressionBody.command,
    });
    workflowSnapshots.push({
      phase: "after-human-judgment",
      revision: workflow.revision,
      finding: workflow.findings.find(
        (finding) => finding.id === workflowFinding.id,
      ),
    });

    const repeated = await runPhase("same-condition-reuse");
    const repeatedCandidate = repeated.findings.find(
      (finding) => finding.fingerprint === firstCandidate.fingerprint,
    );
    assert(repeatedCandidate, "同条件runでrawモデル候補が消えています");
    assert(
      repeatedCandidate.reviewDisposition === "suppressed_human" &&
        isSuppressed(repeatedCandidate),
      "同条件runで明示的人判断の抑止が再利用されませんでした",
    );
    const secondReferences = invocations
      .slice(phases[0].invocationRange[1])
      .flatMap((item) => item.reference?.matchingPastJudgmentIds ?? []);
    assert(
      secondReferences.length > 0,
      "同条件runのモデル入力に現行の人判断が記録されませんでした",
    );
    feedbackChecks.sameConditionSuppression = {
      status: "pass",
      fingerprint: firstCandidate.fingerprint,
      rawCandidatePresent: repeatedCandidate.presentInAnalysis === true,
      suppressionReused: isSuppressed(repeatedCandidate),
      confirmationQueueCount:
        phases.at(-1)?.run.modelQueueRequiredCount ?? null,
      matchingPastJudgmentIds: [...new Set(secondReferences)],
    };

    const productDetail = await request(`/api/products/${product.id}`);
    const settingsBody = {
      revision: productDetail.product.revision,
      specification:
        "TLS接続の証明書検証と監査ログの確認を必須とする。仕様変更の再確認用。",
    };
    const updatedProduct = await request(
      `/api/products/${product.id}/settings`,
      settingsBody,
    );
    workflowCommands.push({
      phase: "specification-change",
      request: settingsBody,
    });
    const changed = await runPhase("specification-changed", updatedProduct);
    const changedCandidate = changed.findings.find(
      (finding) => finding.fingerprint === firstCandidate.fingerprint,
    );
    assert(changedCandidate, "仕様変更runでrawモデル候補が消えています");
    assert(
      changedCandidate.reviewDisposition === "confirmation_required" &&
        !isSuppressed(changedCandidate),
      "仕様変更後も旧抑止が再利用され、再確認に戻りませんでした",
    );
    const thirdReferences = invocations
      .slice(phases[1].invocationRange[1])
      .flatMap((item) => item.reference?.matchingPastJudgmentIds ?? []);
    const secondJudgmentIds = new Set(secondReferences);
    assert(
      thirdReferences.every((id) => !secondJudgmentIds.has(id)),
      "仕様変更後のモデル入力へ旧判断が同条件として残っています",
    );
    feedbackChecks.specificationReconfirmation = {
      status: "pass",
      fingerprint: changedCandidate.fingerprint,
      rawCandidatePresent: changedCandidate.presentInAnalysis === true,
      reviewDisposition: changedCandidate.reviewDisposition,
      suppressionReused: isSuppressed(changedCandidate),
      matchingPastJudgmentIds: [...new Set(thirdReferences)],
    };
    workflowSnapshots.push({
      phase: "after-specification-change",
      product: updatedProduct,
      revision: workflow.revision,
      candidate: changedCandidate,
    });
  } catch (error) {
    failure = safeError(error);
  } finally {
    await app?.close();
    if (source)
      await writeFile(
        join(output, "source-snapshot.json"),
        JSON.stringify(source, null, 2),
      );
    if (runtimeSource)
      await writeFile(
        join(output, "runtime-source-snapshot.json"),
        JSON.stringify(runtimeSource, null, 2),
      );
    await writeFile(
      join(output, "raw-invocations.json"),
      JSON.stringify(invocations, null, 2),
    );
  }

  const artifact = {
    artifactVersion: "diagnostic-feedback-evaluation/v1",
    mode,
    matchPolicy,
    contractWordingVariation,
    gate: {
      status: failure ? "fail" : "pass",
      failure,
      modelCandidateRequired: true,
      rawCandidatesRequired: true,
      humanTimeMeasured: false,
      realModelUsed:
        mode === LIVE_MODE &&
        invocations.some((invocation) => invocation.response !== null),
      recheckPriorDecisionProvidedByModel: false,
    },
    scope: {
      purpose: `本番ProductDiagnosticsServiceの保存済みhuman suppressionが同一条件だけで確認待ちを別枠化する${mode}評価`,
      interpretation:
        "確認待ち件数はproxyであり、人の所要時間短縮・モデル精度改善・幅広さの証拠へ読み替えない。固定ruleとモデル候補が重なるためworkflow効果だけを測定する。",
      humanJudgmentNotice:
        "workflowへ記録した判断はテスト用の判断であり、実利用者の判定ではない。",
    },
    fixture: {
      repositoryId: "fixture",
      commit: fixtureCommit,
      root: relative(output, fixtureRoot),
      sourceSnapshot: source ? "source-snapshot.json" : null,
      sourceSnapshotSha256: source?.snapshotSha256 ?? null,
    },
    database: relative(output, dbPath),
    productId: product?.id ?? null,
    execution: {
      modelReviewBudget,
      modelReviewTimeoutMs,
      pollIntervalMs,
      runWaitTimeoutMs,
      actualModelReviewBudgets: phases.map((phase) => ({
        name: phase.name,
        budget: phase.run.modelReview?.budget ?? null,
      })),
    },
    provider: provider ? safeProvider(provider) : null,
    runtime: runtimeSource
      ? {
          nodeVersion: process.version,
          appModule: runtimeIdentityEntry(runtimeSource.files, "app"),
          providerModule: runtimeIdentityEntry(runtimeSource.files, "provider"),
          sourceSnapshot: "runtime-source-snapshot.json",
          sourceSnapshotSha256: runtimeSource.snapshotSha256,
          buildIdentity: runtimeSource.buildIdentity,
          appFactoryInjected: appRuntime?.injected ?? null,
        }
      : null,
    phases,
    workflowCommands,
    humanJudgments,
    workflowSnapshots,
    feedbackChecks,
    invocations: {
      count: invocations.length,
      path: "raw-invocations.json",
      promptHashes: invocations.map((item) => item.promptHash),
      responseHashes: invocations.map((item) => item.responseHash),
      modelInputReferences: invocations.map((item) => ({
        phase: item.phase,
        matchingPastJudgmentIds: item.reference?.matchingPastJudgmentIds ?? [],
        conditionHash: item.reference?.conditionHash ?? null,
        targetVersion: item.reference?.targetVersion ?? null,
      })),
    },
  };
  await writeFile(
    join(output, "artifact.json"),
    JSON.stringify(artifact, null, 2),
  );
  if (failure) {
    const error = new Error(failure);
    error.artifactPath = join(output, "artifact.json");
    throw error;
  }
  return artifact;
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: CONTRACT_MODE },
      "match-policy": { type: "string", default: "exact_evidence" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/diagnostic-feedback-evaluation.mjs --mode contract|live [--match-policy exact_evidence|source_scope] [--output .cache/diagnostic-feedback-evaluation/<run>]",
    );
    return;
  }
  try {
    const artifact = await runDiagnosticFeedbackEvaluation({
      mode: values.mode,
      matchPolicy: values["match-policy"],
      outputDir: values.output,
    });
    console.log(JSON.stringify(artifact, null, 2));
  } catch (error) {
    console.error(safeError(error));
    if (error?.artifactPath) console.error(`artifact: ${error.artifactPath}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
