import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError } from "../shared/domain-error.js";
import {
  ENGINE_VERSION,
  diagnosticAnalysisSchema,
  diagnosticSnapshotSchema,
  type DiagnosticCoverage,
  type DiagnosticFinding,
  type DiagnosticAnalysis,
  type DiagnosticEngineName,
} from "../shared/diagnostic-engine.js";
import {
  modelReviewStatusSchema,
  diagnosticFindingCounts,
  diagnosticRunSchema,
  type DiagnosticModelReview,
  type DiagnosticRun,
  type DiagnosticRunFinding,
  type DiagnosticRepository,
  type Product,
  type RunInput,
} from "../shared/product-diagnostics.js";
import {
  MODEL_REVIEW_SCHEMA_VERSION,
  modelReviewBudgetSchema,
  modelReviewInputSchema,
  type ModelReviewCheckpoint,
  type ModelReviewCoverage,
  type ModelReviewFinding,
  type ModelReviewInput,
  type ModelReviewReport,
  type ModelReviewBudget,
} from "../shared/model-review.js";
import type {
  FindingReviewContext,
  WorkflowContext,
  WorkflowSourceRef,
  WorkflowState,
} from "../shared/workflow.js";
import {
  applyWorkflowCommand,
  evaluateFindingSuppression,
  hashFindingEvidence,
  hashFindingReviewContext,
  pinInitialScopeVersion,
  workflowContext,
} from "./workflow-domain.js";
import { WorkflowStore } from "./workflow-store.js";
import type { Store } from "./store.js";
import { DiagnosticStore } from "./diagnostic-store.js";
import {
  analyzeSnapshot,
  resolveRepositoryCommit,
  snapshotRepository,
} from "./diagnostic-engine.js";
import {
  ModelReviewCheckpointError,
  createOpenAICompatibleModelReviewInvoker,
  modelReviewProviderFromWorkflowProvider,
  plannedModelReviewBatchCount,
  reviewSnapshot,
} from "./model-review.js";
import {
  invokeOpenAICompatible,
  workflowProvidersFromEnvironment,
} from "./workflow-providers.js";
import type {
  WorkflowProviderDefinition,
  WorkflowRunDependencies,
} from "./workflow-runner.js";

type RepositoryEntry = DiagnosticRepository & { root: string };
export type DiagnosticServiceOptions = {
  repositories?: Record<string, string>;
  fetcher?: typeof fetch;
  scheduleIntervalMs?: number;
  workflowProviders?: WorkflowProviderDefinition[];
  workflowInvokeModel?: WorkflowRunDependencies["invokeModel"];
  modelReviewBudget?: Partial<ModelReviewBudget>;
  modelReviewBatchSize?: number;
  modelReviewTimeoutMs?: number;
};

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const clock = () => new Date().toISOString();
const DEFAULT_MODEL_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL_REVIEW_BUDGET: ModelReviewBudget = {
  maxBatches: 100,
  maxFiles: 500,
  maxInputChars: 10_000_000,
  maxBatchChars: 12_000,
  maxPromptChars: 20_000,
  maxOutputTokens: 2_048,
};
const MODEL_REVIEW_CONTRACT_VERSION = "MODEL_REVIEW_CONTRACT v1";
// The built-in analyzer owns these two deterministic stages.  The model
// review stage is executed separately so a provider timeout never masquerades
// as deterministic static/dependency coverage.
const diagnosticEngines: Extract<
  DiagnosticEngineName,
  "static" | "dependency"
>[] = ["static", "dependency"];

/**
 * Hash the model context that is meaningful when comparing two diagnostic
 * runs.  The complete model input hash also contains the target snapshot and
 * fixed findings, which naturally change between commits; those are already
 * represented by the ordinary diagnostic comparison.  This stable context
 * hash covers the approved references, eligible past judgments, and the
 * effective model budget so a change to review conditions cannot be shown as
 * an unchanged model method.
 */
const modelReviewContextHash = (
  input: ModelReviewInput,
  budget: ModelReviewBudget,
  provider: Pick<
    WorkflowProviderDefinition,
    "id" | "kind" | "model" | "configVersion" | "disableThinking"
  >,
) =>
  digest(
    JSON.stringify({
      purpose: input.purpose,
      conditionHash: input.conditionHash ?? null,
      approvedKnowledge: [...input.approvedKnowledge]
        .map((item) => ({
          id: item.id,
          revision: item.revision ?? null,
          version: item.version,
          hash: item.hash,
          sourceRefs: [...item.sourceRefs].sort(
            (left, right) =>
              left.id.localeCompare(right.id) ||
              left.version.localeCompare(right.version) ||
              left.hash.localeCompare(right.hash) ||
              left.excerpt.localeCompare(right.excerpt),
          ),
          status: item.status,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      pastJudgments: [...input.pastJudgments]
        .map((item) => ({
          id: item.id,
          revision: item.revision,
          targetVersion: item.targetVersion,
          conditionHash: item.conditionHash ?? null,
          judgment: item.judgment,
          reason: item.reason,
          sourceRefs: [...item.sourceRefs].sort(
            (left, right) =>
              left.id.localeCompare(right.id) ||
              left.version.localeCompare(right.version) ||
              left.hash.localeCompare(right.hash) ||
              left.excerpt.localeCompare(right.excerpt),
          ),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      specificationRefs: [...input.specificationRefs].sort(
        (left, right) =>
          left.id.localeCompare(right.id) ||
          left.version.localeCompare(right.version) ||
          left.hash.localeCompare(right.hash) ||
          left.excerpt.localeCompare(right.excerpt),
      ),
      provider: {
        id: provider.id,
        kind: provider.kind,
        model: provider.model,
        configVersion: provider.configVersion,
        disableThinking: provider.disableThinking ?? false,
      },
      budget,
    }),
  );
const isForbiddenRepository = (id: string, root: string) =>
  /^rsi(?:[-_ ].*)?$/i.test(id) ||
  root.split(/[\\/]+/).some((part) => /^rsi(?:[-_ ].*)?$/i.test(part));
const cleanGit = (root: string, args: string[]) =>
  execFileSync(
    "git",
    ["--no-optional-locks", "--no-replace-objects", "-C", root, ...args],
    {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
        ),
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  ).trim();

function repositoryEntries(
  configured?: Record<string, string>,
): RepositoryEntry[] {
  const source =
    configured ??
    (() => {
      try {
        const root = realpathSync(process.cwd());
        const workbenchRoot = realpathSync(
          resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
        );
        if (root !== workbenchRoot) return {};
        const pkg = JSON.parse(
          readFileSync(join(root, "package.json"), "utf8"),
        ) as { name?: string };
        return pkg.name === "security-research-workbench"
          ? { workbench: root }
          : {};
      } catch {
        return {};
      }
    })();
  if (Object.keys(source).length > 100)
    throw new DomainError("登録できるリポジトリ数の上限を超えました");
  return Object.entries(source).map(([id, configuredPath]) => {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
      typeof configuredPath !== "string" ||
      isForbiddenRepository(id, configuredPath)
    )
      throw new DomainError("診断リポジトリ設定が不正です");
    let root: string;
    try {
      root = realpathSync(configuredPath);
      if (!statSync(root).isDirectory()) throw new Error("not directory");
      if (isForbiddenRepository(id, root)) throw new Error("forbidden path");
      const gitRoot = realpathSync(
        cleanGit(root, ["rev-parse", "--show-toplevel"]),
      );
      if (gitRoot !== root) throw new Error("not canonical repository root");
    } catch {
      throw new DomainError(
        "診断リポジトリ設定は有効な管理下Git rootではありません",
      );
    }
    let name = basename(root);
    try {
      const parsed = JSON.parse(
        readFileSync(join(root, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.trim())
        name = parsed.name.trim().slice(0, 200);
    } catch {
      /* The directory name is a safe display fallback. */
    }
    let defaultRef: string | null = null;
    try {
      const branch = cleanGit(root, ["symbolic-ref", "--short", "HEAD"]);
      if (branch && branch.length <= 250) defaultRef = branch;
    } catch {
      /* A detached HEAD has no default branch. */
    }
    return { id, name, defaultRef, root };
  });
}

function contentHash(value: string) {
  return digest(value);
}

export class ProductDiagnosticsService {
  readonly products: DiagnosticStore;
  private readonly workflows: WorkflowStore;
  private readonly repositories = new Map<string, RepositoryEntry>();
  private readonly modelProviders: readonly WorkflowProviderDefinition[];
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly stopReasons = new Map<
    string,
    "user" | "shutdown" | "configuration" | "timeout" | "model-timeout"
  >();
  private readonly changingProducts = new Set<string>();
  private readonly scheduleTasks = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private closing = false;

  constructor(
    private readonly store: Store,
    private readonly options: DiagnosticServiceOptions = {},
  ) {
    this.products = new DiagnosticStore(store);
    this.workflows = new WorkflowStore(store);
    this.modelProviders =
      options.workflowProviders ?? workflowProvidersFromEnvironment();
    for (const entry of repositoryEntries(options.repositories))
      this.repositories.set(entry.id, entry);
    this.products.recoverInterrupted();
    const scheduleIntervalMs = options.scheduleIntervalMs ?? 60_000;
    if (scheduleIntervalMs > 0) {
      this.timer = setInterval(() => {
        if (this.closing) return;
        const tick = this.scheduleTick();
        this.scheduleTasks.add(tick);
        void tick.then(
          () => this.scheduleTasks.delete(tick),
          () => this.scheduleTasks.delete(tick),
        );
      }, scheduleIntervalMs);
      this.timer.unref();
    }
  }

  listRepositories(): DiagnosticRepository[] {
    return [...this.repositories.values()].map(({ id, name, defaultRef }) => ({
      id,
      name,
      defaultRef,
    }));
  }

  /** endpoint/API keyを含まないprovider一覧をUIへ返す。 */
  listModelReviewProviders() {
    return this.modelProviders
      .filter(
        (provider) => provider.kind === "local" || provider.kind === "cloud",
      )
      .map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        label: provider.label,
        model: provider.model,
        // Test/embedded callers may inject the same provider through the
        // existing workflowInvokeModel adapter, so an endpoint is not
        // required in that case.  Never expose the endpoint itself.
        available: Boolean(
          provider.available &&
          (provider.endpoint || this.options.workflowInvokeModel),
        ),
        costKnown: provider.costKnown,
        configVersion: provider.configVersion,
        maxOutputTokens: provider.maxOutputTokens ?? 2048,
      }));
  }

  private repository(id: string): RepositoryEntry {
    const entry = this.repositories.get(id);
    if (!entry)
      throw new DomainError("登録済み診断リポジトリがありません", 404);
    return entry;
  }

  listProducts() {
    return this.products.list();
  }
  getProduct(id: string) {
    return this.products.get(id);
  }

  private checkpointIdentity(
    run: DiagnosticRun,
    product: Product,
    scope: WorkflowState["scope"],
  ) {
    const modelReview = product.modelReview ?? {
      enabled: false,
      providerId: "local",
      cloudConsent: false,
    };
    const provider = this.modelProviders.find(
      (candidate) => candidate.id === modelReview.providerId,
    );
    return digest(
      JSON.stringify({
        productId: product.id,
        repositoryId: product.repositoryId,
        commit: run.commit,
        engineVersion: run.engineVersion,
        specificationRevision: run.specificationRevision,
        allowDependencyNetwork: run.allowDependencyNetwork,
        scope,
        knowledge: run.knowledge,
        rules: run.rules,
        modelReview,
        provider: provider
          ? {
              id: provider.id,
              kind: provider.kind,
              model: provider.model,
              configVersion: provider.configVersion,
              disableThinking: provider.disableThinking ?? false,
              budget: modelReview.enabled
                ? this.modelReviewBudgetFor(provider)
                : null,
            }
          : null,
      }),
    );
  }

  private modelProvider(product: Product): WorkflowProviderDefinition {
    const providerId = product.modelReview?.providerId ?? "local";
    const provider = this.modelProviders.find(
      (candidate) => candidate.id === providerId,
    );
    if (!provider)
      throw new DomainError("選択したmodel providerがありません", 409);
    return provider;
  }

  private modelReviewConfig(product: Product) {
    return (
      product.modelReview ?? {
        enabled: false,
        providerId: "local",
        cloudConsent: false,
      }
    );
  }

  /**
   * Keep the effective budget beside the persisted run metadata.  The model
   * worker also normalizes these values, but the service needs the same
   * identity when a checkpoint is resumed before a report exists.
   */
  private modelReviewBudgetFor(provider: WorkflowProviderDefinition) {
    const providerMaxOutputTokens =
      provider.maxOutputTokens ?? DEFAULT_MODEL_REVIEW_BUDGET.maxOutputTokens;
    const requested = {
      ...DEFAULT_MODEL_REVIEW_BUDGET,
      maxOutputTokens: Math.min(
        DEFAULT_MODEL_REVIEW_BUDGET.maxOutputTokens,
        providerMaxOutputTokens,
      ),
      ...this.options.modelReviewBudget,
    };
    return modelReviewBudgetSchema.parse({
      ...requested,
      maxOutputTokens: Math.min(
        requested.maxOutputTokens ??
          DEFAULT_MODEL_REVIEW_BUDGET.maxOutputTokens,
        providerMaxOutputTokens,
      ),
    });
  }

  private assertModelReviewCheckpointCompatibility(run: DiagnosticRun) {
    const recorded = run.modelReview?.budget ?? run.modelReview?.record?.budget;
    const configured = this.options.modelReviewBudget;
    if (!recorded || !configured) return;
    for (const key of Object.keys(configured) as (keyof ModelReviewBudget)[]) {
      const value = configured[key];
      if (value !== undefined && value !== recorded[key])
        throw new DomainError(
          "モデル診断の予算設定がcheckpoint作成時から変わっています。現在の設定で新しいrunを開始してください",
          409,
        );
    }
  }

  private assertModelReviewConfiguration(
    product: Product,
    state: WorkflowState,
  ): WorkflowProviderDefinition | null {
    const config = this.modelReviewConfig(product);
    if (!config.enabled) return null;
    const provider = this.modelProvider(product);
    if (provider.kind === "cloud") {
      if (!config.cloudConsent)
        throw new DomainError(
          "cloud model reviewは案件の明示同意が必要です",
          409,
        );
      throw new DomainError(
        "cloud model reviewは固定snapshotの外部送信をまだ提供していません",
        409,
      );
    }
    if (provider.kind !== "local")
      throw new DomainError(
        "model reviewはlocal providerだけ利用できます",
        409,
      );
    if (!state.scope.allowedProviderIds.includes(provider.id))
      throw new DomainError("案件で許可されていないmodel providerです", 409);
    if (
      !provider.available ||
      (!provider.endpoint && !this.options.workflowInvokeModel)
    )
      throw new DomainError(
        "設定済みlocal model providerが利用できません",
        409,
      );
    return provider;
  }

  private modelSourceRef(source: WorkflowSourceRef) {
    return {
      id: source.docId,
      version: String(source.revision),
      hash: digest(source.excerpt),
      excerpt: source.excerpt.slice(0, 4000),
    };
  }

  private modelReviewInput(
    run: DiagnosticRun,
    product: Product,
    context: WorkflowContext,
    state: WorkflowState,
    snapshot: Awaited<ReturnType<typeof snapshotRepository>>,
    fixedFindings: DiagnosticFinding[],
  ): ModelReviewInput {
    const specificationRef = {
      id: "product-specification",
      version: String(run.specificationRevision),
      hash: digest(product.specification),
      excerpt: product.specification.slice(0, 4000),
    };
    const approvedKnowledge = context.knowledge.map((item) => ({
      id: item.id,
      revision: item.revision,
      version: String(item.revision),
      hash: digest(item.content),
      content: item.content,
      sourceRefs: item.sourceRefs.map((source) => this.modelSourceRef(source)),
      status: "active" as const,
    }));
    // The current product specification is always an approved local
    // reference.  It must remain in the full model input even when additional
    // approved knowledge exists; the source-ref excerpt alone is not enough to
    // preserve the registered specification.
    if (
      product.specification.trim() &&
      !approvedKnowledge.some((item) => item.id === specificationRef.id)
    )
      approvedKnowledge.unshift({
        id: specificationRef.id,
        revision: run.specificationRevision,
        version: specificationRef.version,
        hash: specificationRef.hash,
        content: product.specification,
        sourceRefs: [specificationRef],
        status: "active" as const,
      });

    const currentRules = new Map(
      context.rules.map((rule) => [
        rule.id,
        `${rule.revision}:${digest(rule.content)}:${rule.appliesToVersion}`,
      ]),
    );
    // A past decision does not carry a separately persisted condition hash in
    // the workflow contract.  Its source refs are therefore the conservative
    // compatibility boundary: every cited document revision and excerpt must
    // still match the current immutable workflow document.  This prevents a
    // decision made against an earlier specification from being reused after
    // that specification changed.
    const currentDocuments = new Map(
      state.documents.map((document) => [document.id, document]),
    );
    const sourceRefsAllowedForLocal = (refs: readonly WorkflowSourceRef[]) =>
      refs.every((source) => {
        const document = currentDocuments.get(source.docId);
        return Boolean(
          document &&
          (document.classification === "public" ||
            document.classification === "local"),
        );
      });
    const sourceRefsStillCurrent = (refs: readonly WorkflowSourceRef[]) =>
      refs.every((source) => {
        const document = currentDocuments.get(source.docId);
        return Boolean(
          document &&
          document.revision === source.revision &&
          document.body.includes(source.excerpt),
        );
      });
    const conditionsChangedAfter = (at: string) =>
      state.events.some(
        (event) =>
          event.at > at &&
          (event.type === "scope-changed" ||
            event.type.startsWith("knowledge-") ||
            event.type.startsWith("rule-")),
      );
    const conditionHash = digest(
      JSON.stringify({
        targetVersion: run.commit,
        purpose: context.purpose,
        specification: specificationRef.hash,
        knowledge: approvedKnowledge.map(({ id, revision, hash }) => [
          id,
          revision,
          hash,
        ]),
        rules: [...currentRules.entries()],
      }),
    );
    const pastJudgments = state.findings.flatMap((finding) => {
      // Only the current, still-confirmed human decision is eligible.  Older
      // decisions remain in workflow history for audit, but feeding all of
      // them to the model would let a later retraction be bypassed.
      if (finding.judgment === "unconfirmed") return [];
      const decision = finding.decisions.at(-1);
      if (!decision) return [];
      return [decision].flatMap((currentDecision) => {
        if (
          currentDecision.targetVersion !== run.commit ||
          !currentDecision.sourceRefs.length ||
          !sourceRefsAllowedForLocal(currentDecision.sourceRefs) ||
          !sourceRefsStillCurrent(currentDecision.sourceRefs) ||
          conditionsChangedAfter(currentDecision.at) ||
          currentDecision.ruleRefs.some(
            (ref) =>
              !currentRules.has(ref.id) ||
              currentRules.get(ref.id) !==
                `${ref.revision}:${digest(
                  context.rules.find((rule) => rule.id === ref.id)?.content ??
                    "",
                )}:${context.rules.find((rule) => rule.id === ref.id)?.appliesToVersion ?? ""}`,
          )
        )
          return [];
        return [
          {
            id: `${finding.id}-decision-${currentDecision.revision}`.slice(
              0,
              80,
            ),
            revision: currentDecision.revision,
            targetVersion: currentDecision.targetVersion,
            conditionHash,
            judgment: currentDecision.judgment,
            reason: currentDecision.reason,
            sourceRefs: currentDecision.sourceRefs.map((source) =>
              this.modelSourceRef(source),
            ),
          },
        ];
      });
    });
    const fixed = fixedFindings.map((finding) => ({
      id: `fixed-${finding.fingerprint.slice(0, 64)}`.slice(0, 80),
      ruleId: `rule-${finding.ruleId.replace(/[^a-zA-Z0-9_-]/g, "-")}`.slice(
        0,
        80,
      ),
      path: finding.path,
      line: finding.line,
      evidence: finding.evidence,
      title: finding.title,
    }));
    return modelReviewInputSchema.parse({
      target: context.target,
      targetVersion: run.commit,
      purpose: context.purpose,
      conditionHash,
      approvedKnowledge,
      pastJudgments,
      fixedFindings: fixed,
      specificationRefs: [specificationRef],
    });
  }

  private modelReviewCoverageToDiagnostic(
    coverage: ModelReviewCoverage,
  ): DiagnosticCoverage {
    return {
      engine: "model",
      status:
        coverage.status === "complete"
          ? "complete"
          : coverage.status === "unavailable"
            ? "unavailable"
            : coverage.status === "stopped"
              ? "partial"
              : "partial",
      assessed: coverage.assessedFiles,
      omitted: coverage.omitted.slice(0, 500).map((item) => ({
        path: item.path,
        reason: item.reason,
      })),
      limitations: coverage.limitations.slice(0, 100),
    };
  }

  private modelReviewCheckpointCoverage(
    checkpoint: ModelReviewCheckpoint,
    snapshot: Awaited<ReturnType<typeof snapshotRepository>>,
    plannedBatchCount = Math.max(
      0,
      ...checkpoint.batches.map((batch) => batch.index + 1),
    ),
  ): ModelReviewCoverage {
    const files = new Map(snapshot.files.map((file) => [file.path, file]));
    const assessedPaths = new Set(
      checkpoint.batches.flatMap((batch) => batch.filePaths),
    );
    const assessedLines = [...assessedPaths].reduce(
      (total, path) =>
        total + (files.get(path)?.content.split("\n").length ?? 0),
      0,
    );
    const omitted = checkpoint.batches
      .flatMap((batch) => batch.omitted)
      .filter(
        (item, index, all) =>
          all.findIndex(
            (other) =>
              other.path === item.path &&
              other.startLine === item.startLine &&
              other.endLine === item.endLine &&
              other.reason === item.reason,
          ) === index,
      )
      .slice(0, 1000);
    const limitations = [
      "モデル診断は中断され、完了batchのcoverageだけを保存しています。",
      ...checkpoint.batches.flatMap((batch) => batch.limitations),
    ]
      .filter((item, index, all) => all.indexOf(item) === index)
      .slice(0, 200);
    return {
      status: checkpoint.batches.length ? "partial" : "unavailable",
      batchCount: Math.max(plannedBatchCount, checkpoint.batches.length),
      completedBatchCount: checkpoint.batches.length,
      assessedFiles: assessedPaths.size,
      assessedLines,
      omitted,
      limitations,
      isSafetyProof: false,
    };
  }

  private modelFindingToDiagnostic(
    finding: ModelReviewFinding,
    occurrence = 0,
  ): DiagnosticFinding {
    const evidence = [
      finding.rationale,
      `固定snapshot原文: ${finding.originalText}`,
      finding.uncertainty.reasons.length
        ? `不確実性: ${finding.uncertainty.reasons.join("; ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 4000);
    return {
      fingerprint: digest(
        [
          "model",
          finding.path.replace(/\\/g, "/"),
          finding.category,
          // Keep the exact line in evidence, but normalize whitespace for the
          // identity so a harmless line move or indentation change does not
          // turn the same model observation into a new finding.  Duplicate
          // source identities receive an ordinal so their workflow links do
          // not overwrite one another.
          finding.originalText.replace(/\s+/g, " ").trim(),
          ...(occurrence ? [String(occurrence)] : []),
        ].join("\0"),
      ),
      ruleId: `model-review.${finding.category}`.slice(0, 120),
      engine: "model",
      title: finding.title,
      severity:
        finding.severity === "high" || finding.severity === "medium"
          ? finding.severity
          : "low",
      path: finding.path,
      line: finding.line,
      evidence,
      remediation: finding.remediation.guidance.slice(0, 4000),
      modelReviewEvidence: {
        specRefIds: [...finding.specRefIds],
        pastJudgmentIds: [...finding.pastJudgmentIds],
        // Model output can cite a matching judgment, but the service does not
        // have a structured proof that its code evidence is the same finding.
        // Keep the citation visible and require a human recheck until that
        // evidence relationship is explicitly verified.
        requiresHumanConfirmation: true,
        recheckPriorDecision: true,
      },
    };
  }

  private unavailableModelReview(
    product: Product,
    provider: WorkflowProviderDefinition | null,
    reason: string,
    pending = false,
    budget?: ModelReviewBudget,
  ): DiagnosticModelReview {
    const coverage: ModelReviewCoverage = {
      status: "unavailable",
      batchCount: 0,
      completedBatchCount: 0,
      assessedFiles: 0,
      assessedLines: 0,
      omitted: [],
      limitations: [reason],
      isSafetyProof: false,
    };
    return {
      enabled: product.modelReview?.enabled ?? false,
      providerId: provider?.id ?? product.modelReview?.providerId ?? null,
      providerKind:
        provider?.kind === "local" || provider?.kind === "cloud"
          ? provider.kind
          : null,
      model: provider?.model ?? null,
      configVersion: provider?.configVersion ?? null,
      inputHash: null,
      contextHash: null,
      ...(budget ? { budget } : {}),
      coverage,
      record: null,
      failure: pending ? null : reason.slice(0, 1000),
    };
  }

  createProduct(input: Parameters<DiagnosticStore["create"]>[0]) {
    const repository = this.repository(input.repositoryId);
    return this.products.create(input, repository.name);
  }

  async updateProduct(
    id: string,
    revision: number,
    change: Parameters<DiagnosticStore["update"]>[2],
  ) {
    const current = this.products.get(id);
    this.repository(current.repositoryId);
    if (current.revision !== revision)
      throw new DomainError(
        "製品設定が更新されました。再読込してください。",
        409,
      );
    const configChanged =
      (change.ref !== undefined && change.ref !== current.ref) ||
      (change.specification !== undefined &&
        change.specification !== current.specification) ||
      (change.allowDependencyNetwork !== undefined &&
        change.allowDependencyNetwork !== current.allowDependencyNetwork) ||
      (change.modelReview !== undefined &&
        JSON.stringify(change.modelReview) !==
          JSON.stringify(
            current.modelReview ?? {
              enabled: false,
              providerId: "local",
              cloudConsent: false,
            },
          ));
    if (!configChanged) return this.products.update(id, revision, change);
    if (this.changingProducts.has(id))
      throw new DomainError("製品設定を更新中です", 409);
    this.changingProducts.add(id);
    try {
      const active = this.products
        .listRuns(id)
        .filter((run) => run.status === "queued" || run.status === "running");
      for (const run of active) {
        this.stopReasons.set(run.id, "configuration");
        this.controllers.get(run.id)?.abort();
      }
      await Promise.all(
        active
          .map((run) => this.tasks.get(run.id))
          .filter((task): task is Promise<void> => Boolean(task)),
      );
      return this.products.update(id, revision, change);
    } finally {
      this.changingProducts.delete(id);
    }
  }

  detail(id: string) {
    return {
      product: this.products.get(id),
      runs: this.products
        .listRuns(id)
        .slice(0, 100)
        .map((run) => ({
          id: run.id,
          status: run.status,
          trigger: run.trigger,
          commit: run.commit,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          findingCounts: diagnosticFindingCounts(run.findings),
          progress: run.progress,
          incompleteCoverage: run.coverage.some(
            (coverage) => coverage.status !== "complete",
          ),
          ...(run.modelReview
            ? {
                modelReview: {
                  enabled: run.modelReview.enabled,
                  providerId: run.modelReview.providerId,
                  status:
                    run.modelReview.record?.status ??
                    (run.modelReview.failure
                      ? run.modelReview.coverage.status === "unavailable"
                        ? "unavailable"
                        : "failed"
                      : run.modelReview.enabled
                        ? "queued"
                        : "disabled"),
                  coverage: run.modelReview.coverage,
                },
              }
            : {}),
        })),
    };
  }

  listRuns(id: string) {
    return this.products.listRuns(id);
  }
  getRun(productId: string, runId: string) {
    return this.products.getRun(productId, runId);
  }

  async startRun(productId: string, input: RunInput): Promise<DiagnosticRun> {
    if (this.closing) throw new DomainError("診断serviceを終了しています", 409);
    if (this.changingProducts.has(productId))
      throw new DomainError("製品設定を更新中です", 409);
    const product = this.products.get(productId);
    const repository = this.repository(product.repositoryId);
    const ref = input.ref ?? product.ref;
    const configuredModelProvider = this.modelProviders.find(
      (provider) =>
        provider.id === (product.modelReview?.providerId ?? "local"),
    );
    const requestFingerprint = DiagnosticStore.requestFingerprint({
      trigger: input.trigger,
      ref,
      diagnosticRevision: product.diagnosticRevision,
      modelReview: product.modelReview ?? {
        enabled: false,
        providerId: "local",
        cloudConsent: false,
      },
      provider: configuredModelProvider
        ? {
            kind: configuredModelProvider.kind,
            model: configuredModelProvider.model,
            configVersion: configuredModelProvider.configVersion,
            disableThinking: configuredModelProvider.disableThinking ?? false,
          }
        : null,
    });
    if (input.requestId) {
      const previous = this.products.findRequest(productId, input.requestId);
      if (previous) {
        if (previous.fingerprint !== requestFingerprint)
          throw new DomainError(
            "同じrequestIdが異なる入力で使われています",
            409,
          );
        return previous.run;
      }
    }
    if (
      this.products
        .listRuns(productId)
        .some((run) => run.status === "queued" || run.status === "running")
    )
      throw new DomainError("この製品の診断は既に実行中です", 409);
    let commit: string;
    try {
      commit = await resolveRepositoryCommit(repository.root, ref);
    } catch {
      throw new DomainError(
        "登録リポジトリで対象refを固定commitへ解決できません",
        400,
      );
    }
    if (this.closing) throw new DomainError("診断serviceを終了しています", 409);
    if (this.changingProducts.has(productId))
      throw new DomainError("製品設定を更新中です", 409);
    const latestProduct = this.products.get(productId);
    if (latestProduct.diagnosticRevision !== product.diagnosticRevision)
      throw new DomainError("製品設定が実行開始前に変更されました", 409);
    let state = this.workflows.get(product.linkedProjectId);
    if (
      !state.scope.allowedMethods.includes("static-review") ||
      !state.scope.allowedMethods.includes("known-issue-match")
    )
      throw new DomainError(
        "案件で静的レビューと既知依存照合の両方が許可されていません",
        409,
      );
    if (state.scope.version !== commit) {
      const initialRefPin =
        ref === product.ref &&
        state.scope.version === ref &&
        !this.products.listRuns(productId).length &&
        !state.events.some((event) => event.type === "scope-changed");
      state = initialRefPin
        ? this.workflows.update(
            product.linkedProjectId,
            state.revision,
            (current) => pinInitialScopeVersion(current, commit),
          )
        : this.workflows.command(product.linkedProjectId, state.revision, {
            type: "scope",
            value: { ...state.scope, version: commit },
          });
    }
    const modelProvider = this.assertModelReviewConfiguration(product, state);
    const initialModelBudget = modelProvider
      ? this.modelReviewBudgetFor(modelProvider)
      : undefined;
    const question = `${product.title} の固定commit ${commit} を診断します。製品仕様: ${product.specification}`;
    const context = workflowContext(state, question.slice(0, 10_000), "manual");
    const timestamp = clock();
    const previousRun = this.products
      .listRuns(productId)
      .find((run) => ["completed", "partial"].includes(run.status));
    const run = diagnosticRunSchema.parse({
      id: randomUUID(),
      productId,
      revision: 1,
      status: "queued",
      trigger: input.trigger,
      requestId: input.requestId ?? null,
      ref,
      commit,
      previousRunId: previousRun?.id ?? null,
      manifestHash: null,
      snapshotFiles: [],
      snapshotOmitted: [],
      engineVersion: ENGINE_VERSION,
      allowDependencyNetwork: product.allowDependencyNetwork,
      specificationRevision: product.diagnosticRevision,
      workflowRevision: state.revision,
      knowledge: context.knowledge.map((item) => ({
        id: item.id,
        revision: item.revision,
        contentHash: contentHash(item.content),
      })),
      rules: context.rules.map((item) => ({
        id: item.id,
        revision: item.revision,
        contentHash: contentHash(item.content),
      })),
      progress: { phase: "queued", message: "診断待ち", updatedAt: timestamp },
      statusHistory: [{ status: "queued", at: timestamp, reason: null }],
      coverage: ["static", "dependency"].map((engine) => ({
        engine,
        status: "unavailable",
        assessed: 0,
        omitted: [],
        limitations: ["診断はまだ開始されていません"],
      })),
      modelReview: this.unavailableModelReview(
        product,
        modelProvider,
        product.modelReview?.enabled
          ? "モデル診断はまだ開始されていません"
          : "製品設定でモデル診断が無効です",
        true,
        initialModelBudget,
      ),
      findings: [],
      startedAt: null,
      updatedAt: timestamp,
      finishedAt: null,
      failure: null,
    });
    let created: { run: DiagnosticRun; created: boolean };
    try {
      created = this.products.createRun(
        run,
        requestFingerprint,
        this.checkpointIdentity(run, product, state.scope),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed/.test(error.message)
      )
        throw new DomainError("この製品の診断は既に実行中です", 409);
      throw error;
    }
    if (!created.created) return created.run;
    const saved = created.run;
    const task = this.execute(saved, repository, product).finally(() => {
      this.tasks.delete(saved.id);
      this.controllers.delete(saved.id);
      this.stopReasons.delete(saved.id);
    });
    this.tasks.set(saved.id, task);
    return saved;
  }

  async stop(productId: string, runId: string): Promise<DiagnosticRun> {
    const run = this.products.getRun(productId, runId);
    if (run.status !== "queued" && run.status !== "running") return run;
    this.stopReasons.set(run.id, "user");
    this.controllers.get(run.id)?.abort();
    await this.tasks.get(run.id);
    return this.products.getRun(productId, runId);
  }

  async resume(productId: string, runId: string): Promise<DiagnosticRun> {
    if (this.closing) throw new DomainError("診断serviceを終了しています", 409);
    if (this.changingProducts.has(productId))
      throw new DomainError("製品設定を更新中です", 409);
    const run = this.products.getRun(productId, runId);
    if (run.engineVersion !== ENGINE_VERSION)
      throw new DomainError(
        "診断engineの版が変わっています。現在のengineで新しいrunを開始してください",
        409,
      );
    if (!["interrupted", "stopped", "partial"].includes(run.status))
      throw new DomainError("中断または部分診断のrunだけ再開できます", 409);
    const product = this.products.get(productId);
    if (product.diagnosticRevision !== run.specificationRevision)
      throw new DomainError(
        "製品の診断設定が変更されているため、現在設定で新しいrunを開始してください",
        409,
      );
    const state = this.workflows.get(product.linkedProjectId);
    const runStartedAt = run.startedAt ?? run.updatedAt;
    if (
      state.events.some(
        (event) => event.type === "finding-decided" && event.at > runStartedAt,
      )
    )
      throw new DomainError(
        "案件指摘の人判断がcheckpoint作成後に変わっています。現在の判断で新しいrunを開始してください",
        409,
      );
    if (
      !state.scope.allowedMethods.includes("static-review") ||
      !state.scope.allowedMethods.includes("known-issue-match")
    )
      throw new DomainError(
        "案件で静的レビューと既知依存照合の両方が許可されていません",
        409,
      );
    this.assertModelReviewConfiguration(product, state);
    const question =
      `${product.title} の固定commit ${run.commit} を診断します。製品仕様: ${product.specification}`.slice(
        0,
        10_000,
      );
    const context = workflowContext(state, question, "manual");
    const currentKnowledge = context.knowledge.map((item) => ({
      id: item.id,
      revision: item.revision,
      contentHash: contentHash(item.content),
    }));
    const currentRules = context.rules.map((item) => ({
      id: item.id,
      revision: item.revision,
      contentHash: contentHash(item.content),
    }));
    if (
      JSON.stringify(currentKnowledge) !== JSON.stringify(run.knowledge) ||
      JSON.stringify(currentRules) !== JSON.stringify(run.rules)
    )
      throw new DomainError(
        "案件の承認済み知識・基準が変わっています。現在のcontextで新しいrunを開始してください",
        409,
      );
    const checkpoint = this.products.getCheckpoint(runId);
    this.assertModelReviewCheckpointCompatibility(run);
    const checkpointIdentity = this.checkpointIdentity(
      run,
      product,
      state.scope,
    );
    if (checkpoint && checkpoint.identity !== checkpointIdentity)
      throw new DomainError(
        "診断のscopeまたは固定入力が変わっています。現在の入力で新しいrunを開始してください",
        409,
      );
    if (!checkpoint) this.products.ensureCheckpoint(runId, checkpointIdentity);
    const repository = this.repository(product.repositoryId);
    const queued = diagnosticRunSchema.parse({
      ...run,
      revision: run.revision + 1,
      workflowRevision: state.revision,
      status: "queued",
      statusHistory: [
        ...run.statusHistory,
        {
          status: "queued",
          at: clock(),
          reason: "利用者が同じ固定commitを明示再開",
        },
      ].slice(-100),
      progress: {
        phase: "queued",
        message: "同じ固定commitで明示再開",
        updatedAt: clock(),
      },
      startedAt: null,
      finishedAt: null,
      failure: null,
      updatedAt: clock(),
    });
    this.products.saveRun(queued, run.revision);
    const task = this.execute(queued, repository, product).finally(() => {
      this.tasks.delete(queued.id);
      this.controllers.delete(queued.id);
      this.stopReasons.delete(queued.id);
    });
    this.tasks.set(queued.id, task);
    return queued;
  }

  private save(
    run: DiagnosticRun,
    patch: Partial<DiagnosticRun>,
  ): DiagnosticRun {
    const next = { ...run, ...patch, revision: run.revision + 1 };
    if (next.status !== run.status) {
      next.statusHistory = [
        ...run.statusHistory,
        {
          status: next.status,
          at: next.updatedAt,
          reason: next.failure,
        },
      ].slice(-100);
    }
    return this.products.saveRun(diagnosticRunSchema.parse(next), run.revision);
  }

  private async execute(
    initial: DiagnosticRun,
    repository: RepositoryEntry,
    product: Product,
  ) {
    const controller = new AbortController();
    this.controllers.set(initial.id, controller);
    let timeout = setTimeout(() => {
      this.stopReasons.set(initial.id, "timeout");
      controller.abort();
    }, 45_000);
    timeout.unref();
    let modelReviewTimeout: NodeJS.Timeout | undefined;
    let run = initial;
    try {
      run = this.save(run, {
        status: "running",
        startedAt: clock(),
        progress: {
          phase: "snapshot",
          message: "固定commitから対象ファイルを読み取っています",
          updatedAt: clock(),
        },
        updatedAt: clock(),
      });
      const state = this.workflows.get(product.linkedProjectId);
      const checkpointIdentity = this.checkpointIdentity(
        run,
        product,
        state.scope,
      );
      const existingCheckpoint = this.products.getCheckpoint(run.id);
      if (
        existingCheckpoint &&
        existingCheckpoint.identity !== checkpointIdentity
      ) {
        this.stopReasons.set(run.id, "configuration");
        throw new Error("diagnostic checkpoint identity mismatch");
      }
      const checkpoint =
        existingCheckpoint ??
        this.products.ensureCheckpoint(run.id, checkpointIdentity);
      let snapshot = checkpoint?.snapshot ?? null;
      if (!snapshot) {
        snapshot = diagnosticSnapshotSchema.parse(
          await snapshotRepository(
            repository.root,
            run.commit!,
            controller.signal,
          ),
        );
        this.products.saveSnapshotCheckpoint(
          run.id,
          checkpointIdentity,
          snapshot,
        );
      }
      if (snapshot.commit !== run.commit)
        throw new Error("fixed commit mismatch");
      if (run.manifestHash && run.manifestHash !== snapshot.manifestHash)
        throw new Error("snapshot changed while resuming");
      run = this.save(run, {
        manifestHash: snapshot.manifestHash,
        snapshotFiles: snapshot.files.map(({ path, hash }) => ({ path, hash })),
        snapshotOmitted: snapshot.omitted,
        progress: {
          phase: "static",
          message: "コードと依存関係を解析しています",
          updatedAt: clock(),
        },
        updatedAt: clock(),
      });
      this.assertPinnedInputs(run, product, controller.signal);
      const stages: NonNullable<
        ReturnType<DiagnosticStore["getCheckpoint"]>
      >["staticAnalysis"][] = [];
      const currentCheckpoint = this.products.getCheckpoint(run.id);
      for (const engine of diagnosticEngines) {
        const prior =
          engine === "static"
            ? currentCheckpoint?.staticAnalysis
            : currentCheckpoint?.dependencyAnalysis;
        run = this.save(run, {
          progress: {
            phase: engine,
            message:
              prior?.coverage.status === "complete"
                ? `${engine === "static" ? "静的解析" : "依存関係照合"}の保存済み結果を再利用しています`
                : engine === "static"
                  ? "コードを解析しています"
                  : "依存関係を照合しています",
            updatedAt: clock(),
          },
          updatedAt: clock(),
        });
        if (prior?.coverage.status === "complete") {
          stages.push(prior);
          continue;
        }
        this.assertPinnedInputs(run, product, controller.signal);
        const result = diagnosticAnalysisSchema.parse(
          await analyzeSnapshot(snapshot, {
            allowDependencyNetwork: run.allowDependencyNetwork,
            engines: [engine],
            fetcher: this.options.fetcher,
            signal: controller.signal,
          }),
        );
        const coverage = result.coverage.find((item) => item.engine === engine);
        if (!coverage) throw new Error("diagnostic engine coverage missing");
        const stage = {
          findings: result.findings.filter(
            (finding) => finding.engine === engine,
          ),
          coverage,
        };
        this.products.saveEngineCheckpoint(
          run.id,
          checkpointIdentity,
          engine,
          stage.findings,
          stage.coverage,
        );
        stages.push(stage);
      }
      const analysis = diagnosticAnalysisSchema.parse({
        findings: stages.flatMap((stage) => stage?.findings ?? []),
        coverage: stages
          .map((stage) => stage?.coverage)
          .filter((item): item is NonNullable<typeof item> => Boolean(item)),
      });
      this.assertPinnedInputs(run, product, controller.signal);
      let finalAnalysis = analysis;
      const modelConfig = this.modelReviewConfig(product);
      if (modelConfig.enabled) {
        clearTimeout(timeout);
        const modelProvider = this.modelProvider(product);
        const modelBudget = this.modelReviewBudgetFor(modelProvider);
        let plannedModelBatchCount = 0;
        modelReviewTimeout = setTimeout(
          () => {
            this.stopReasons.set(run.id, "model-timeout");
            controller.abort();
          },
          Math.max(
            1_000,
            Math.min(
              15 * 60_000,
              this.options.modelReviewTimeoutMs ??
                DEFAULT_MODEL_REVIEW_TIMEOUT_MS,
            ),
          ),
        );
        modelReviewTimeout.unref();
        run = this.save(run, {
          progress: {
            phase: "model_review",
            message: "製品仕様とコードをAIでレビューしています",
            updatedAt: clock(),
          },
          updatedAt: clock(),
        });
        try {
          plannedModelBatchCount = plannedModelReviewBatchCount(
            snapshot,
            modelBudget,
            this.options.modelReviewBatchSize,
          );
          const modelState = this.workflows.get(product.linkedProjectId);
          this.assertPinnedInputs(
            run,
            product,
            controller.signal,
            modelState.revision,
          );
          const modelContext = workflowContext(
            modelState,
            `${product.title} の固定commit ${run.commit}に対する防御的静的レビュー`,
            "local",
          );
          const modelInput = this.modelReviewInput(
            run,
            product,
            modelContext,
            modelState,
            snapshot,
            analysis.findings,
          );
          const provider =
            modelReviewProviderFromWorkflowProvider(modelProvider);
          const invoke = this.options.workflowInvokeModel
            ? (prompt: string, signal: AbortSignal, maxOutputTokens: number) =>
                this.options.workflowInvokeModel!(
                  modelProvider,
                  prompt,
                  signal,
                  maxOutputTokens,
                )
            : createOpenAICompatibleModelReviewInvoker(
                modelProvider,
                this.options.fetcher ?? fetch,
              );
          const currentModelCheckpoint = this.products.getCheckpoint(
            run.id,
          )?.modelReview;
          const result = await reviewSnapshot(snapshot, modelInput, {
            invoke,
            provider,
            signal: controller.signal,
            checkpoint: currentModelCheckpoint,
            onCheckpoint: async (checkpoint: ModelReviewCheckpoint) => {
              this.products.saveModelReviewCheckpoint(
                run.id,
                checkpointIdentity,
                checkpoint,
              );
              const current = this.products.getRun(run.productId, run.id);
              const coverage = this.modelReviewCheckpointCoverage(
                checkpoint,
                snapshot,
                plannedModelBatchCount,
              );
              run = this.save(current, {
                modelReview: {
                  enabled: true,
                  providerId: modelProvider.id,
                  providerKind:
                    modelProvider.kind === "local" ||
                    modelProvider.kind === "cloud"
                      ? modelProvider.kind
                      : null,
                  model: modelProvider.model,
                  configVersion: modelProvider.configVersion,
                  inputHash: null,
                  contextHash: null,
                  budget: modelBudget,
                  coverage,
                  record: null,
                  failure: null,
                },
                updatedAt: clock(),
              });
            },
            maxBudget: this.options.modelReviewBudget,
            batchSize: this.options.modelReviewBatchSize,
          });
          const modelFindingOccurrences = new Map<string, number>();
          const modelFindings = result.findings.map((finding) => {
            const identity = [
              finding.path.replace(/\\/g, "/"),
              finding.category,
              finding.originalText.replace(/\s+/g, " ").trim(),
            ].join("\0");
            const occurrence = modelFindingOccurrences.get(identity) ?? 0;
            modelFindingOccurrences.set(identity, occurrence + 1);
            return this.modelFindingToDiagnostic(finding, occurrence);
          });
          const modelCoverage = this.modelReviewCoverageToDiagnostic(
            result.coverage,
          );
          finalAnalysis = diagnosticAnalysisSchema.parse({
            findings: [...analysis.findings, ...modelFindings],
            coverage: [...analysis.coverage, modelCoverage],
          });
          run = this.save(run, {
            modelReview: {
              enabled: true,
              providerId: modelProvider.id,
              providerKind:
                modelProvider.kind === "local" || modelProvider.kind === "cloud"
                  ? modelProvider.kind
                  : null,
              model: result.report.model,
              configVersion: result.report.configVersion,
              inputHash: result.report.hashes.input,
              contextHash: modelReviewContextHash(
                modelInput,
                result.report.budget,
                modelProvider,
              ),
              budget: result.report.budget,
              coverage: result.coverage,
              record: result.report,
              failure: null,
            },
            updatedAt: clock(),
          });
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "model reviewに失敗しました";
          const current = this.products.getRun(run.productId, run.id);
          const savedCoverage = current.modelReview?.coverage;
          const checkpointCoverage = this.products.getCheckpoint(
            run.id,
          )?.modelReview;
          const checkpointMismatch =
            error instanceof ModelReviewCheckpointError;
          // A checkpoint identity/schema mismatch invalidates every stored
          // model batch, including a stale run-level `complete` coverage.
          // Reusing that coverage would let the outer completion check mark
          // the run completed and would classify old model findings as fixed.
          const coverage = checkpointMismatch
            ? this.unavailableModelReview(
                product,
                modelProvider,
                message,
                false,
                modelBudget,
              ).coverage
            : savedCoverage?.status === "partial" ||
                savedCoverage?.status === "complete"
              ? savedCoverage
              : checkpointCoverage
                ? this.modelReviewCheckpointCoverage(
                    checkpointCoverage,
                    snapshot,
                    plannedModelBatchCount,
                  )
                : this.unavailableModelReview(
                    product,
                    modelProvider,
                    message,
                    false,
                    modelBudget,
                  ).coverage;
          run = this.save(current, {
            modelReview: {
              ...this.unavailableModelReview(
                product,
                modelProvider,
                message,
                false,
                modelBudget,
              ),
              enabled: true,
              coverage,
            },
            updatedAt: clock(),
          });
          finalAnalysis = diagnosticAnalysisSchema.parse({
            findings: analysis.findings,
            coverage: [
              ...analysis.coverage,
              this.modelReviewCoverageToDiagnostic(run.modelReview!.coverage),
            ],
          });
          if (controller.signal.aborted) throw error;
        } finally {
          if (modelReviewTimeout) clearTimeout(modelReviewTimeout);
          modelReviewTimeout = undefined;
        }
      }
      const findings = this.compare(run, product, snapshot, finalAnalysis);
      const linked = await this.linkFindings(
        product,
        run,
        findings,
        finalAnalysis.coverage,
        controller.signal,
      );
      this.assertPinnedInputs(
        run,
        product,
        controller.signal,
        linked.workflowRevision,
      );
      const linkedFindings = findings.map((finding) => ({
        ...finding,
        ...linked.get(finding.fingerprint),
      }));
      const complete = finalAnalysis.coverage.every(
        (coverage) => coverage.status === "complete",
      );
      run = this.save(run, {
        status: complete ? "completed" : "partial",
        findings: linkedFindings as DiagnosticRunFinding[],
        coverage: finalAnalysis.coverage,
        progress: {
          phase: "finished",
          message: complete ? "診断完了" : "診断完了（未診断範囲あり）",
          updatedAt: clock(),
        },
        finishedAt: clock(),
        updatedAt: clock(),
        failure: null,
      });
    } catch (error) {
      const reason = this.stopReasons.get(run.id);
      const status = controller.signal.aborted
        ? reason === "user"
          ? "stopped"
          : "interrupted"
        : reason === "configuration"
          ? "interrupted"
          : "failed";
      const current = this.products.getRun(run.productId, run.id);
      if (current.status === "queued" || current.status === "running") {
        this.save(current, {
          status,
          progress: {
            phase: "finished",
            message:
              status === "stopped"
                ? "利用者が停止しました"
                : status === "interrupted"
                  ? "サーバー停止で中断しました"
                  : "診断に失敗しました",
            updatedAt: clock(),
          },
          finishedAt: clock(),
          updatedAt: clock(),
          failure:
            status === "failed"
              ? "固定commitの診断に失敗しました"
              : reason === "configuration"
                ? "診断中に製品設定または案件知識が変更されました"
                : reason === "timeout"
                  ? "固定snapshot診断の実行時間上限に達しました"
                  : reason === "model-timeout"
                    ? "local model診断の実行時間上限に達しました"
                    : null,
        });
      }
    } finally {
      clearTimeout(timeout);
      if (modelReviewTimeout) clearTimeout(modelReviewTimeout);
    }
  }

  private assertPinnedInputs(
    run: DiagnosticRun,
    product: Product,
    signal: AbortSignal,
    expectedWorkflowRevision = run.workflowRevision,
  ) {
    if (signal.aborted) throw new Error("diagnostic aborted");
    const currentProduct = this.products.get(run.productId);
    if (
      currentProduct.diagnosticRevision !== run.specificationRevision ||
      currentProduct.allowDependencyNetwork !== run.allowDependencyNetwork
    ) {
      this.stopReasons.set(run.id, "configuration");
      throw new Error("product configuration changed");
    }
    const state = this.workflows.get(product.linkedProjectId);
    if (
      state.revision !== expectedWorkflowRevision ||
      state.scope.version !== run.commit
    ) {
      this.stopReasons.set(run.id, "configuration");
      throw new Error("workflow state changed");
    }
  }

  private compare(
    run: DiagnosticRun,
    product: Product,
    snapshot: Awaited<ReturnType<typeof snapshotRepository>>,
    analysis: DiagnosticAnalysis,
  ): DiagnosticRunFinding[] {
    const previous = run.previousRunId
      ? this.products.getRun(run.productId, run.previousRunId)
      : undefined;
    const priorCurrent =
      previous?.findings.filter((candidate) => candidate.presentInAnalysis) ??
      [];
    const methodologyComparable = Boolean(
      previous &&
      previous.engineVersion === run.engineVersion &&
      previous.specificationRevision === run.specificationRevision &&
      previous.allowDependencyNetwork === run.allowDependencyNetwork &&
      JSON.stringify(previous.knowledge) === JSON.stringify(run.knowledge) &&
      JSON.stringify(previous.rules) === JSON.stringify(run.rules),
    );
    const modelReviewComparable = Boolean(
      previous?.modelReview?.enabled &&
      run.modelReview?.enabled &&
      previous.modelReview.providerId === run.modelReview.providerId &&
      previous.modelReview.model === run.modelReview.model &&
      previous.modelReview.configVersion === run.modelReview.configVersion &&
      previous.modelReview.contextHash === run.modelReview.contextHash &&
      JSON.stringify(
        previous.modelReview.budget ??
          previous.modelReview.record?.budget ??
          null,
      ) ===
        JSON.stringify(
          run.modelReview.budget ?? run.modelReview.record?.budget ?? null,
        ),
    );
    const candidates: DiagnosticRunFinding[] = analysis.findings.map(
      (finding) => {
        const old = priorCurrent.find(
          (candidate) => candidate.fingerprint === finding.fingerprint,
        );
        const priorSame = previous?.findings.find(
          (candidate) => candidate.fingerprint === finding.fingerprint,
        );
        const delta = old
          ? methodologyComparable &&
            (finding.engine !== "model" || modelReviewComparable)
            ? ("continuing" as const)
            : ("needs_review" as const)
          : priorSame
            ? ("needs_review" as const)
            : ("new" as const);
        const workflowQuestion = [
          `製品: ${product.title}`,
          `仕様: ${product.specification}`,
          `診断commit: ${run.commit}`,
          `指摘: ${finding.title} (${finding.severity}, ${finding.ruleId})`,
          `位置: ${finding.path}:${finding.line}`,
          `根拠: ${finding.evidence}`,
          `推奨確認: ${finding.remediation}`,
          "製品仕様と承認済み案件知識を使い、影響・適用条件・未確認点を人が確認してください。これは候補であり自動判定ではありません。",
        ]
          .join("\n")
          .slice(0, 10_000);
        return {
          ...finding,
          delta,
          presentInAnalysis: true,
          comparedToRunId: previous?.id ?? null,
          workflowFindingId: null,
          workflowUrl: `/api/projects/${encodeURIComponent(product.linkedProjectId)}/workflow`,
          workflowQuestion,
          workflowQuestionClassification: "local" as const,
        };
      },
    );
    if (!previous) return candidates;
    const currentFingerprints = new Set(
      analysis.findings.map((finding) => finding.fingerprint),
    );
    for (const old of previous.findings.filter(
      (finding) => !currentFingerprints.has(finding.fingerprint),
    )) {
      const coverage = analysis.coverage.find(
        (item) => item.engine === old.engine,
      );
      const fileIncluded = snapshot.files.some(
        (file) => file.path === old.path,
      );
      const pathOmitted =
        coverage?.omitted.some((item) => item.path === old.path) ||
        snapshot.omitted.some((item) => item.path === old.path);
      const observedCoverage = Boolean(
        methodologyComparable &&
        (old.engine !== "model" || modelReviewComparable) &&
        coverage &&
        !pathOmitted &&
        (old.engine === "dependency" || old.engine === "model"
          ? coverage.status === "complete"
          : fileIncluded &&
            coverage.assessed > 0 &&
            coverage.status !== "unavailable" &&
            coverage.status !== "unsupported"),
      );
      candidates.push({
        ...old,
        presentInAnalysis: false,
        delta: observedCoverage ? "not_observed" : "needs_review",
        // A finding absent from the current analysis has not passed the
        // current suppression/context check.  Keep the raw historical
        // candidate for remediation comparison, but never carry a previous
        // suppressed_human disposition into a non-observed result.
        reviewDisposition: "confirmation_required",
        ...(old.suppression
          ? {
              suppression: {
                ...old.suppression,
                status: "unknown" as const,
                reason: "not_observed",
                reused: false,
              },
            }
          : {}),
        comparedToRunId: previous.id,
        workflowUrl: `/api/projects/${encodeURIComponent(product.linkedProjectId)}/workflow`,
        workflowQuestion: [
          `製品: ${product.title}`,
          `仕様: ${product.specification}`,
          `前回commit: ${previous.commit}`,
          `今回commit: ${run.commit}`,
          `以前の指摘: ${old.title} (${old.severity}, ${old.ruleId})`,
          `位置: ${old.path}:${old.line}`,
          `根拠: ${old.evidence}`,
          `推奨確認: ${old.remediation}`,
          `今回の${old.engine} coverage: ${coverage?.status ?? "unavailable"}; assessed=${coverage?.assessed ?? 0}`,
          observedCoverage
            ? "対象範囲は今回解析されましたが指摘は観測されませんでした。これだけで修正済みとは扱わず、人が修正コミットと証跡を確認してください。"
            : "今回の対象範囲が十分に診断されていないため、解消を推定できません。人が未診断範囲を確認してください。",
        ]
          .join("\n")
          .slice(0, 10_000),
        workflowQuestionClassification: "local",
      });
    }
    return candidates;
  }

  /**
   * Bind workflow observations to the diagnostic method that produced them.
   *
   * Knowledge, rules, and eligible human judgments stay in the ordinary
   * FindingReviewContext fields so the current finding can be excluded from
   * that hash independently.  This metadata contains only method identity:
   * changing another finding's judgment must not invalidate this finding by
   * smuggling the full model input (which may include that finding's own
   * judgment) into the methodology hash.
   */
  private findingReviewMethodologyHash(run: DiagnosticRun, product: Product) {
    const modelReview = run.modelReview;
    const enabled = modelReview?.enabled === true;
    const provider = enabled
      ? this.modelProviders.find(
          (candidate) => candidate.id === modelReview?.providerId,
        )
      : undefined;
    const budget = enabled
      ? (modelReview?.budget ?? modelReview?.record?.budget ?? null)
      : null;
    const stableBudget = budget
      ? Object.fromEntries(
          Object.entries(budget).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : null;
    return digest(
      JSON.stringify({
        methodologyVersion: 1,
        engineVersion: run.engineVersion,
        allowDependencyNetwork: run.allowDependencyNetwork,
        modelReview: {
          enabled,
          provider: enabled
            ? {
                id: provider?.id ?? modelReview?.providerId ?? null,
                kind: provider?.kind ?? modelReview?.providerKind ?? null,
                model: provider?.model ?? modelReview?.model ?? null,
                configVersion:
                  provider?.configVersion ?? modelReview?.configVersion ?? null,
                disableThinking: provider?.disableThinking ?? null,
              }
            : null,
          budget: stableBudget,
          cloudConsent: enabled
            ? product.modelReview?.cloudConsent === true
            : false,
          schemaVersion: enabled ? MODEL_REVIEW_SCHEMA_VERSION : null,
          contractVersion: enabled ? MODEL_REVIEW_CONTRACT_VERSION : null,
        },
      }),
    );
  }

  private findingReviewContext(
    run: DiagnosticRun,
    product: Product,
    state: WorkflowState,
  ): FindingReviewContext {
    if (!run.commit)
      throw new Error("finding review context requires a fixed commit");
    const knowledge = run.knowledge.map((ref) => {
      const item = state.knowledge.find(
        (candidate) =>
          candidate.id === ref.id && candidate.revision === ref.revision,
      );
      if (!item || item.status !== "active")
        throw new Error("diagnostic knowledge context changed");
      return {
        id: ref.id,
        revision: ref.revision,
        contentHash: ref.contentHash,
        sourceRefs: item.sourceRefs,
      };
    });
    const rules = run.rules.map((ref) => {
      const item = state.rules.find(
        (candidate) =>
          candidate.id === ref.id && candidate.revision === ref.revision,
      );
      if (
        !item ||
        item.status !== "active" ||
        item.appliesToVersion !== run.commit
      )
        throw new Error("diagnostic rule context changed");
      return {
        id: ref.id,
        revision: ref.revision,
        contentHash: ref.contentHash,
        appliesToVersion: item.appliesToVersion,
        sourceRefs: item.sourceRefs,
      };
    });
    const currentDocuments = new Map(
      state.documents.map((document) => [document.id, document]),
    );
    const sourceRefsAllowedForLocal = (refs: readonly WorkflowSourceRef[]) =>
      refs.every((source) => {
        const document = currentDocuments.get(source.docId);
        return Boolean(
          document &&
          (document.classification === "public" ||
            document.classification === "local"),
        );
      });
    const sourceRefsStillCurrent = (refs: readonly WorkflowSourceRef[]) =>
      refs.every((source) => {
        const document = currentDocuments.get(source.docId);
        return Boolean(
          document &&
          document.revision === source.revision &&
          document.body.includes(source.excerpt),
        );
      });
    const conditionsChangedAfter = (at: string) =>
      state.events.some(
        (event) =>
          event.at > at &&
          (event.type === "scope-changed" ||
            event.type.startsWith("knowledge-") ||
            event.type.startsWith("rule-")),
      );
    const pinnedRules = new Map(run.rules.map((item) => [item.id, item]));
    const rulesCurrent = (refs: readonly { id: string; revision: number }[]) =>
      refs.every((ref) => {
        const pinned = pinnedRules.get(ref.id);
        const current = state.rules.find(
          (rule) => rule.id === ref.id && rule.revision === ref.revision,
        );
        return Boolean(
          pinned &&
          pinned.revision === ref.revision &&
          pinned.contentHash ===
            (current ? contentHash(current.content) : "") &&
          current?.status === "active" &&
          current.appliesToVersion === run.commit,
        );
      });
    const pastJudgments = state.findings.flatMap((finding) => {
      if (finding.judgment === "unconfirmed") return [];
      const decision = finding.decisions.at(-1);
      if (
        !decision ||
        decision.targetVersion !== run.commit ||
        !decision.sourceRefs.length ||
        !sourceRefsAllowedForLocal(decision.sourceRefs) ||
        !sourceRefsStillCurrent(decision.sourceRefs) ||
        conditionsChangedAfter(decision.at) ||
        !rulesCurrent(decision.ruleRefs)
      )
        return [];
      return [
        {
          findingId: finding.id,
          revision: decision.revision,
          targetVersion: decision.targetVersion,
          judgment: decision.judgment,
          reason: decision.reason,
          sourceRefs: decision.sourceRefs,
        },
      ];
    });
    return {
      targetVersion: run.commit,
      purpose: state.scope.purpose,
      specificationRevision: run.specificationRevision,
      specificationHash: digest(product.specification),
      metadata: {
        diagnosticMethodologyHash: this.findingReviewMethodologyHash(
          run,
          product,
        ),
      },
      knowledge,
      rules,
      pastJudgments,
    };
  }

  private async linkFindings(
    product: Product,
    run: DiagnosticRun,
    findings: DiagnosticRunFinding[],
    coverage: DiagnosticRun["coverage"],
    signal: AbortSignal,
  ) {
    const result = new Map<
      string,
      Pick<
        DiagnosticRunFinding,
        "workflowFindingId" | "reviewDisposition" | "suppression"
      >
    >();
    const checkAbort = () => {
      if (signal.aborted) throw new Error("diagnostic aborted");
    };
    let state = this.workflows.get(product.linkedProjectId);
    if (state.revision !== run.workflowRevision) {
      this.stopReasons.set(run.id, "configuration");
      throw new Error("workflow state changed");
    }
    const reviewContext = this.findingReviewContext(run, product, state);
    const active = findings.filter((finding) => finding.presentInAnalysis);
    const blocks = active.map((finding) => ({
      finding,
      block: [
        `## ${finding.title} (${finding.severity})`,
        `Fingerprint: ${finding.fingerprint}`,
        `Rule: ${finding.ruleId}`,
        `Location: ${finding.path}:${finding.line}`,
        `Remediation: ${finding.remediation}`,
        "Evidence:",
        finding.evidence,
      ].join("\n"),
      excerpt: finding.evidence.slice(0, 1800),
    }));
    const groups: (typeof blocks)[] = [];
    let group: typeof blocks = [];
    let bytes = 0;
    for (const item of blocks) {
      const size = Buffer.byteLength(item.block, "utf8") + 2;
      if (group.length && bytes + size > 300_000) {
        groups.push(group);
        group = [];
        bytes = 0;
      }
      group.push(item);
      bytes += size;
    }
    if (group.length) groups.push(group);
    if (!groups.length) groups.push([]);
    for (let index = 0; index < groups.length; index++) {
      const current = groups[index]!;
      const body = [
        `# 診断run ${run.id}`,
        `Product: ${product.title}`,
        `Commit: ${run.commit}`,
        `Manifest: ${run.manifestHash ?? "pending"}`,
        `Engine: ${run.engineVersion}`,
        `Approved-context workflow revision: ${run.workflowRevision}`,
        `File hashes: ${JSON.stringify(run.snapshotFiles)}`,
        `Snapshot omissions (${run.snapshotOmitted.length} total): ${JSON.stringify(run.snapshotOmitted.slice(0, 20))}`,
        `Analysis coverage: ${JSON.stringify(coverage.map((item) => ({ engine: item.engine, status: item.status, assessed: item.assessed, omittedCount: item.omitted.length, limitations: item.limitations.slice(0, 20) })))}`,
        `Approved knowledge: ${run.knowledge.map((item) => `${item.id}@${item.revision}`).join(", ") || "none"}`,
        `Approved rules: ${run.rules.map((item) => `${item.id}@${item.revision}`).join(", ") || "none"}`,
        current.length
          ? current.map((item) => item.block).join("\n\n")
          : "このrunでは指摘候補がありません。コード安全の証明ではありません。coverageを確認してください。",
      ].join("\n\n");
      const documentTitle = `診断結果 ${run.id} ${run.commit} (${index + 1}/${groups.length})`;
      const existingDocument = state.documents.find(
        (document) => document.title === documentTitle,
      );
      if (!existingDocument || existingDocument.body !== body) {
        checkAbort();
        state = this.workflows.command(state.projectId, state.revision, {
          type: "document",
          documentId: existingDocument?.id,
          value: { title: documentTitle, body, classification: "local" },
        });
      }
      const document = state.documents.find(
        (item) => item.title === documentTitle,
      )!;
      for (const item of current) {
        checkAbort();
        const sourceRef: WorkflowSourceRef = {
          docId: document.id,
          revision: document.revision,
          excerpt: item.excerpt,
        };
        const existing = state.findings.find(
          (candidate) =>
            candidate.fingerprint === item.finding.fingerprint &&
            candidate.targetVersion === run.commit,
        );
        const evidenceHash = hashFindingEvidence(item.finding);
        // The finding's own decision is checked independently by
        // evaluateFindingSuppression.  Excluding it here prevents merely
        // recording that decision from invalidating the suppression it
        // created, while a change to another applicable judgment changes the
        // model context for every other finding.
        const contextHash = hashFindingReviewContext({
          ...reviewContext,
          pastJudgments: reviewContext.pastJudgments?.filter(
            (judgment) => judgment.findingId !== existing?.id,
          ),
        });
        const evaluationBefore = existing
          ? evaluateFindingSuppression(state, existing, {
              contextHash,
              evidenceHash,
            })
          : undefined;
        const lastObservation = existing?.observationHistory.at(-1);
        const sameEvidence = Boolean(
          lastObservation?.contextHash === contextHash &&
          lastObservation.evidenceHash === evidenceHash,
        );
        const recheckRequired = Boolean(
          evaluationBefore &&
          ["invalidated", "expired", "unknown"].includes(
            evaluationBefore.status,
          ),
        );
        if (!sameEvidence || recheckRequired) {
          const observation =
            `${item.finding.title} (${item.finding.severity}) at ${item.finding.path}:${item.finding.line}. ${item.finding.evidence}`.slice(
              0,
              20_000,
            );
          state = this.workflows.command(state.projectId, state.revision, {
            type: "finding-observation",
            findingId: existing?.id,
            fingerprint: item.finding.fingerprint,
            targetVersion: run.commit!,
            observation,
            sourceRefs: [sourceRef],
            contextHash,
            evidenceHash,
          });
        }
        const link = state.findings.find(
          (candidate) =>
            candidate.fingerprint === item.finding.fingerprint &&
            candidate.targetVersion === run.commit,
        );
        if (link) {
          const evaluationAfter = evaluateFindingSuppression(state, link, {
            contextHash,
            evidenceHash,
          });
          // Keep the reason that caused a recheck even after observeFinding
          // has safely deactivated the old suppression.  The raw candidate is
          // still returned and remains confirmation-required in that case.
          const evaluation =
            evaluationBefore &&
            ["invalidated", "expired", "unknown"].includes(
              evaluationBefore.status,
            ) &&
            !evaluationAfter.reusable
              ? evaluationBefore
              : evaluationAfter;
          result.set(item.finding.fingerprint, {
            workflowFindingId: link.id,
            reviewDisposition: evaluation.reusable
              ? "suppressed_human"
              : "confirmation_required",
            suppression: {
              status: evaluation.status,
              reason: evaluation.reason,
              decisionRevision: evaluation.decisionRevision,
              judgment: evaluation.judgment,
              expiresAt: evaluation.expiresAt,
              reused: evaluation.reusable,
            },
          });
        }
      }
    }
    return Object.assign(result, { workflowRevision: state.revision });
  }

  async resumeRun(productId: string, runId: string) {
    return this.resume(productId, runId);
  }

  private async scheduleTick() {
    if (this.closing) return;
    for (const product of this.products.list()) {
      if (this.closing) return;
      if (
        !product.schedule.enabled ||
        this.products
          .listRuns(product.id)
          .some((run) => run.status === "queued" || run.status === "running")
      )
        continue;
      const latest = product.latestRun;
      const baseline = latest?.startedAt ?? product.updatedAt;
      if (
        Date.now() - Date.parse(baseline) <
        product.schedule.intervalMinutes! * 60_000
      )
        continue;
      try {
        await this.startRun(product.id, {
          trigger: "schedule",
          requestId: `schedule-${Math.floor(Date.now() / (product.schedule.intervalMinutes! * 60_000))}`,
        });
      } catch {
        /* An active run or transient Git error is retried on the next timer tick. */
      }
    }
  }

  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const [id, controller] of this.controllers) {
      this.stopReasons.set(id, "shutdown");
      controller.abort();
    }
    await Promise.allSettled([...this.tasks.values(), ...this.scheduleTasks]);
  }
}
