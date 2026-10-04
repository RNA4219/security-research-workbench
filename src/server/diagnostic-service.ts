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
  type DiagnosticAnalysis,
  type DiagnosticEngineName,
} from "../shared/diagnostic-engine.js";
import {
  diagnosticRunSchema,
  type DiagnosticRun,
  type DiagnosticRunFinding,
  type DiagnosticRepository,
  type Product,
  type RunInput,
} from "../shared/product-diagnostics.js";
import type { WorkflowSourceRef, WorkflowState } from "../shared/workflow.js";
import { applyWorkflowCommand, workflowContext } from "./workflow-domain.js";
import { WorkflowStore } from "./workflow-store.js";
import type { Store } from "./store.js";
import { DiagnosticStore } from "./diagnostic-store.js";
import {
  analyzeSnapshot,
  resolveRepositoryCommit,
  snapshotRepository,
} from "./diagnostic-engine.js";

type RepositoryEntry = DiagnosticRepository & { root: string };
export type DiagnosticServiceOptions = {
  repositories?: Record<string, string>;
  fetcher?: typeof fetch;
  scheduleIntervalMs?: number;
};

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const clock = () => new Date().toISOString();
const diagnosticEngines: DiagnosticEngineName[] = ["static", "dependency"];
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
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly stopReasons = new Map<
    string,
    "user" | "shutdown" | "configuration" | "timeout"
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
      }),
    );
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
        change.allowDependencyNetwork !== current.allowDependencyNetwork);
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
          findingCounts: run.findings.reduce(
            (counts, finding) => {
              if (finding.delta === "new") counts.new++;
              else if (finding.delta === "continuing") counts.continuing++;
              else if (finding.delta === "needs_review") counts.needsReview++;
              else counts.notObserved++;
              return counts;
            },
            { new: 0, continuing: 0, needsReview: 0, notObserved: 0 },
          ),
          progress: run.progress,
          incompleteCoverage: run.coverage.some(
            (coverage) => coverage.status !== "complete",
          ),
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
    const requestFingerprint = DiagnosticStore.requestFingerprint({
      trigger: input.trigger,
      ref,
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
      state = this.workflows.command(product.linkedProjectId, state.revision, {
        type: "scope",
        value: { ...state.scope, version: commit },
      });
    }
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
    if (
      !state.scope.allowedMethods.includes("static-review") ||
      !state.scope.allowedMethods.includes("known-issue-match")
    )
      throw new DomainError(
        "案件で静的レビューと既知依存照合の両方が許可されていません",
        409,
      );
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
    const timeout = setTimeout(() => {
      this.stopReasons.set(initial.id, "timeout");
      controller.abort();
    }, 45_000);
    timeout.unref();
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
      const findings = this.compare(run, product, snapshot, analysis);
      const linked = await this.linkFindings(
        product,
        run,
        findings,
        analysis.coverage,
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
      const complete = analysis.coverage.every(
        (coverage) => coverage.status === "complete",
      );
      run = this.save(run, {
        status: complete ? "completed" : "partial",
        findings: linkedFindings as DiagnosticRunFinding[],
        coverage: analysis.coverage,
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
                  ? "診断の実行時間上限に達しました"
                  : null,
        });
      }
    } finally {
      clearTimeout(timeout);
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
    const candidates: DiagnosticRunFinding[] = analysis.findings.map(
      (finding) => {
        const old = priorCurrent.find(
          (candidate) => candidate.fingerprint === finding.fingerprint,
        );
        const priorSame = previous?.findings.find(
          (candidate) => candidate.fingerprint === finding.fingerprint,
        );
        const delta = old
          ? methodologyComparable
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
        coverage &&
        !pathOmitted &&
        (old.engine === "dependency"
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

  private async linkFindings(
    product: Product,
    run: DiagnosticRun,
    findings: DiagnosticRunFinding[],
    coverage: DiagnosticRun["coverage"],
    signal: AbortSignal,
  ) {
    const result = new Map<
      string,
      Pick<DiagnosticRunFinding, "workflowFindingId">
    >();
    const checkAbort = () => {
      if (signal.aborted) throw new Error("diagnostic aborted");
    };
    let state = this.workflows.get(product.linkedProjectId);
    if (state.revision !== run.workflowRevision) {
      this.stopReasons.set(run.id, "configuration");
      throw new Error("workflow state changed");
    }
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
        if (
          !existing?.observationHistory.some((observation) =>
            observation.sourceRefs.some(
              (ref) =>
                ref.docId === document.id &&
                ref.revision === document.revision &&
                ref.excerpt === item.excerpt,
            ),
          )
        ) {
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
          });
        }
        const link = state.findings.find(
          (candidate) =>
            candidate.fingerprint === item.finding.fingerprint &&
            candidate.targetVersion === run.commit,
        );
        if (link)
          result.set(item.finding.fingerprint, { workflowFindingId: link.id });
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
    await Promise.allSettled([
      ...this.tasks.values(),
      ...this.scheduleTasks,
    ]);
  }
}
