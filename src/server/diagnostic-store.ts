import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store.js";
import { newProject } from "./domain.js";
import { applyWorkflowCommand, newWorkflow } from "./workflow-domain.js";
import { DomainError } from "../shared/domain-error.js";
import {
  diagnosticCoverageSchema,
  diagnosticFindingSchema,
  diagnosticSnapshotSchema,
  type DiagnosticCoverage,
  type DiagnosticEngineName,
  type DiagnosticFinding,
  type DiagnosticSnapshot,
} from "../shared/diagnostic-engine.js";
import {
  productInputSchema,
  productSchema,
  diagnosticRunSchema,
  type DiagnosticRun,
  type Product,
  type ProductInput,
} from "../shared/product-diagnostics.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();

/** 製品診断データと紐付くworkflow projectを同じSQLite DBへ保存する。 */
export class DiagnosticStore {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS diagnostic_products (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        linked_project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagnostic_runs (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES diagnostic_products(id),
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        request_id TEXT,
        request_fingerprint TEXT,
        data TEXT NOT NULL,
        UNIQUE(product_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS diagnostic_runs_product_order
        ON diagnostic_runs(product_id, id);
      CREATE UNIQUE INDEX IF NOT EXISTS diagnostic_runs_one_active
        ON diagnostic_runs(product_id) WHERE status IN ('queued','running');
      CREATE TABLE IF NOT EXISTS diagnostic_checkpoints (
        run_id TEXT PRIMARY KEY REFERENCES diagnostic_runs(id) ON DELETE CASCADE,
        identity TEXT NOT NULL,
        snapshot TEXT,
        static_analysis TEXT,
        dependency_analysis TEXT
      );
    `);
  }

  private runSummaries(productId: string) {
    return this.store.db
      .prepare(
        "SELECT data FROM diagnostic_runs WHERE product_id=? ORDER BY rowid DESC LIMIT 500",
      )
      .all(productId) as { data: string }[];
  }

  private withLatestRun(product: Product): Product {
    const latest = this.runSummaries(product.id)[0];
    if (!latest) return { ...product, latestRun: null };
    const run = diagnosticRunSchema.parse(JSON.parse(latest.data));
    const findingCounts = {
      new: 0,
      continuing: 0,
      needsReview: 0,
      notObserved: 0,
    };
    for (const finding of run.findings) {
      if (finding.delta === "new") findingCounts.new++;
      else if (finding.delta === "continuing") findingCounts.continuing++;
      else if (finding.delta === "needs_review") findingCounts.needsReview++;
      else findingCounts.notObserved++;
    }
    return productSchema.parse({
      ...product,
      latestRun: {
        id: run.id,
        status: run.status,
        trigger: run.trigger,
        commit: run.commit,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        findingCounts,
        progress: run.progress,
        incompleteCoverage: run.coverage.some(
          (item) => item.status !== "complete",
        ),
      },
    });
  }

  create(input: ProductInput, repositoryName: string): Product {
    const parsed = productInputSchema.parse(input);
    const productId = randomUUID();
    const project = newProject({
      title: `${parsed.title} の継続診断`.slice(0, 200),
      objective:
        "指定された固定版を診断し、差分・人の判定・修正確認を追跡する。",
      audience: "製品の開発者・診断結果を確認するレビュー担当者",
      constraints:
        "管理下の固定コミットの静的レビューと既知依存情報の照合のみ。自動実行・攻撃再現は行わない。",
      scope: `管理下リポジトリ ${parsed.repositoryId} (${repositoryName})`,
      outOfScope:
        "任意コマンド、攻撃・再現、リポジトリ外のファイル、未診断範囲の安全判断",
    });
    let workflow = newWorkflow(project.id, {
      target: `localrepo://${parsed.repositoryId}`,
      version: parsed.ref,
      purpose:
        "登録製品の固定コミットを防御的に静的レビューし、既知依存問題と照合する。",
      ownership:
        "製品登録で指定された管理下ローカルGitリポジトリ。runごとに固定commitを保存する。",
      allowedProviderIds: ["manual"],
      allowedMethods: [
        "static-review",
        "known-issue-match",
        "manual-review",
        "regression-test",
      ],
    });
    workflow = applyWorkflowCommand(workflow, {
      type: "document",
      value: {
        title: "製品仕様",
        body: parsed.specification,
        classification: "local",
      },
    });
    const timestamp = now();
    const product = productSchema.parse({
      id: productId,
      title: parsed.title,
      repositoryId: parsed.repositoryId,
      ref: parsed.ref,
      specification: parsed.specification,
      allowDependencyNetwork: parsed.allowDependencyNetwork,
      schedule: parsed.schedule,
      revision: 1,
      diagnosticRevision: 1,
      linkedProjectId: project.id,
      createdAt: timestamp,
      updatedAt: timestamp,
      latestRun: null,
    });
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare("INSERT INTO projects VALUES (?,?,?)")
        .run(project.id, project.revision, JSON.stringify(project));
      this.store.db
        .prepare("INSERT INTO revisions VALUES (?,?,?)")
        .run(project.id, project.revision, JSON.stringify(project));
      this.store.db
        .prepare("INSERT INTO workflows VALUES (?,?,?)")
        .run(workflow.projectId, workflow.revision, JSON.stringify(workflow));
      this.store.db
        .prepare("INSERT INTO workflow_history VALUES (?,?,?)")
        .run(workflow.projectId, workflow.revision, JSON.stringify(workflow));
      this.store.db
        .prepare("INSERT INTO diagnostic_products VALUES (?,?,?,?)")
        .run(product.id, product.revision, project.id, JSON.stringify(product));
      this.store.db.exec("COMMIT");
      return product;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(): Product[] {
    const rows = this.store.db
      .prepare("SELECT data FROM diagnostic_products ORDER BY rowid DESC")
      .all() as { data: string }[];
    return rows.map(({ data }) =>
      this.withLatestRun(productSchema.parse(JSON.parse(data))),
    );
  }

  get(productId: string): Product {
    const row = this.store.db
      .prepare("SELECT data FROM diagnostic_products WHERE id=?")
      .get(productId) as { data: string } | undefined;
    if (!row) throw new DomainError("製品がありません", 404);
    return this.withLatestRun(productSchema.parse(JSON.parse(row.data)));
  }

  update(
    productId: string,
    revision: number,
    change: Partial<
      Pick<
        Product,
        "ref" | "specification" | "allowDependencyNetwork" | "schedule"
      >
    >,
  ): Product {
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.store.db
        .prepare("SELECT data FROM diagnostic_products WHERE id=?")
        .get(productId) as { data: string } | undefined;
      if (!row) throw new DomainError("製品がありません", 404);
      const current = productSchema.parse(JSON.parse(row.data));
      if (current.revision !== revision)
        throw new DomainError(
          "製品設定が更新されました。再読込してください。",
          409,
        );
      const diagnosisChanged =
        (change.ref !== undefined && change.ref !== current.ref) ||
        (change.specification !== undefined &&
          change.specification !== current.specification) ||
        (change.allowDependencyNetwork !== undefined &&
          change.allowDependencyNetwork !== current.allowDependencyNetwork);
      const next = productSchema.parse({
        ...current,
        ...change,
        revision: revision + 1,
        diagnosticRevision:
          current.diagnosticRevision + (diagnosisChanged ? 1 : 0),
        updatedAt: now(),
      });
      if (
        (change.ref !== undefined && change.ref !== current.ref) ||
        (change.specification !== undefined &&
          change.specification !== current.specification) ||
        (change.allowDependencyNetwork !== undefined &&
          change.allowDependencyNetwork !== current.allowDependencyNetwork)
      ) {
        const linked = this.store.db
          .prepare("SELECT data,revision FROM workflows WHERE project_id=?")
          .get(current.linkedProjectId) as
          { data: string; revision: number } | undefined;
        if (!linked) throw new DomainError("製品の診断案件がありません", 500);
        let workflow = JSON.parse(linked.data) as ReturnType<
          typeof newWorkflow
        >;
        if (change.ref !== undefined && change.ref !== current.ref) {
          workflow = applyWorkflowCommand(workflow, {
            type: "scope",
            value: { ...workflow.scope, version: change.ref },
          });
        }
        if (
          change.allowDependencyNetwork !== undefined &&
          change.allowDependencyNetwork !== current.allowDependencyNetwork
        ) {
          workflow = applyWorkflowCommand(workflow, {
            type: "scope",
            value: {
              ...workflow.scope,
              purpose: `登録製品の固定コミットを防御的に静的レビューし、既知依存問題と照合する。依存照合ネットワーク許可: ${change.allowDependencyNetwork ? "有効" : "無効"}`,
            },
          });
        }
        if (
          change.specification !== undefined &&
          change.specification !== current.specification
        ) {
          workflow = applyWorkflowCommand(workflow, {
            type: "document",
            documentId: workflow.documents.find(
              (document) => document.title === "製品仕様",
            )?.id,
            value: {
              title: "製品仕様",
              body: change.specification,
              classification: "local",
            },
          });
        }
        if (JSON.stringify(workflow) !== linked.data) {
          workflow.revision = linked.revision + 1;
          const saved = this.store.db
            .prepare(
              "UPDATE workflows SET revision=?,data=? WHERE project_id=? AND revision=?",
            )
            .run(
              workflow.revision,
              JSON.stringify(workflow),
              current.linkedProjectId,
              linked.revision,
            );
          if (saved.changes !== 1)
            throw new DomainError("製品の診断案件が同時に更新されました", 409);
          this.store.db
            .prepare("INSERT INTO workflow_history VALUES (?,?,?)")
            .run(
              workflow.projectId,
              workflow.revision,
              JSON.stringify(workflow),
            );
        }
      }
      const result = this.store.db
        .prepare(
          "UPDATE diagnostic_products SET revision=?,data=? WHERE id=? AND revision=?",
        )
        .run(next.revision, JSON.stringify(next), productId, revision);
      if (result.changes !== 1)
        throw new DomainError("製品設定が別の操作で更新されました", 409);
      this.store.db.exec("COMMIT");
      return this.withLatestRun(next);
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  listRuns(productId: string): DiagnosticRun[] {
    this.get(productId);
    return this.runSummaries(productId).map(({ data }) =>
      diagnosticRunSchema.parse(JSON.parse(data)),
    );
  }

  getRun(productId: string, runId: string): DiagnosticRun {
    const row = this.store.db
      .prepare("SELECT data FROM diagnostic_runs WHERE product_id=? AND id=?")
      .get(productId, runId) as { data: string } | undefined;
    if (!row) throw new DomainError("この製品の診断記録がありません", 404);
    return diagnosticRunSchema.parse(JSON.parse(row.data));
  }

  findRequest(productId: string, requestId: string) {
    const row = this.store.db
      .prepare(
        "SELECT data,request_fingerprint FROM diagnostic_runs WHERE product_id=? AND request_id=?",
      )
      .get(productId, requestId) as
      { data: string; request_fingerprint: string } | undefined;
    return row
      ? {
          run: diagnosticRunSchema.parse(JSON.parse(row.data)),
          fingerprint: row.request_fingerprint,
        }
      : undefined;
  }

  createRun(
    run: DiagnosticRun,
    requestFingerprint: string,
    checkpointIdentity?: string,
  ): { run: DiagnosticRun; created: boolean } {
    const value = diagnosticRunSchema.parse(run);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const product = this.store.db
        .prepare("SELECT id FROM diagnostic_products WHERE id=?")
        .get(value.productId);
      if (!product) throw new DomainError("製品がありません", 404);
      if (value.requestId) {
        const previous = this.findRequest(value.productId, value.requestId);
        if (previous) {
          if (previous.fingerprint !== requestFingerprint)
            throw new DomainError(
              "同じrequestIdが異なる入力で使われています",
              409,
            );
          this.store.db.exec("COMMIT");
          return { run: previous.run, created: false };
        }
      }
      this.store.db
        .prepare(
          "INSERT INTO diagnostic_runs (id,product_id,revision,status,request_id,request_fingerprint,data) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          value.id,
          value.productId,
          value.revision,
          value.status,
          value.requestId,
          requestFingerprint,
          JSON.stringify(value),
        );
      if (checkpointIdentity) {
        this.store.db
          .prepare(
            "INSERT INTO diagnostic_checkpoints (run_id,identity,snapshot,static_analysis,dependency_analysis) VALUES (?,? ,NULL,NULL,NULL)",
          )
          .run(value.id, checkpointIdentity);
      }
      this.store.db.exec("COMMIT");
      return { run: value, created: true };
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveRun(run: DiagnosticRun, expectedRevision: number): DiagnosticRun {
    const value = diagnosticRunSchema.parse(run);
    if (value.revision !== expectedRevision + 1)
      throw new DomainError("診断記録の版が不正です", 409);
    const result = this.store.db
      .prepare(
        "UPDATE diagnostic_runs SET revision=?,status=?,data=? WHERE id=? AND product_id=? AND revision=?",
      )
      .run(
        value.revision,
        value.status,
        JSON.stringify(value),
        value.id,
        value.productId,
        expectedRevision,
      );
    if (result.changes !== 1)
      throw new DomainError("診断記録が別の操作で更新されました", 409);
    return value;
  }

  getCheckpoint(runId: string) {
    const row = this.store.db
      .prepare(
        "SELECT identity,snapshot,static_analysis,dependency_analysis FROM diagnostic_checkpoints WHERE run_id=?",
      )
      .get(runId) as
      | {
          identity: string;
          snapshot: string | null;
          static_analysis: string | null;
          dependency_analysis: string | null;
        }
      | undefined;
    if (!row) return undefined;
    const parseStage = (value: string | null) => {
      if (!value) return null;
      const parsed = JSON.parse(value) as {
        findings: unknown;
        coverage: unknown;
      };
      if (!Array.isArray(parsed.findings))
        throw new DomainError("保存済み診断checkpointが不正です", 500);
      return {
        findings: parsed.findings.map((finding) =>
          diagnosticFindingSchema.parse(finding),
        ),
        coverage: diagnosticCoverageSchema.parse(parsed.coverage),
      };
    };
    return {
      identity: row.identity,
      snapshot: row.snapshot
        ? diagnosticSnapshotSchema.parse(JSON.parse(row.snapshot))
        : null,
      staticAnalysis: parseStage(row.static_analysis),
      dependencyAnalysis: parseStage(row.dependency_analysis),
    };
  }

  ensureCheckpoint(runId: string, identity: string) {
    this.store.db
      .prepare(
        "INSERT OR IGNORE INTO diagnostic_checkpoints (run_id,identity,snapshot,static_analysis,dependency_analysis) VALUES (?,?,NULL,NULL,NULL)",
      )
      .run(runId, identity);
    const checkpoint = this.getCheckpoint(runId);
    if (!checkpoint || checkpoint.identity !== identity)
      throw new DomainError("診断checkpointのidentityが一致しません", 409);
    return checkpoint;
  }

  saveSnapshotCheckpoint(
    runId: string,
    identity: string,
    snapshot: DiagnosticSnapshot,
  ) {
    const value = diagnosticSnapshotSchema.parse(snapshot);
    const result = this.store.db
      .prepare(
        "UPDATE diagnostic_checkpoints SET snapshot=? WHERE run_id=? AND identity=?",
      )
      .run(JSON.stringify(value), runId, identity);
    if (result.changes !== 1)
      throw new DomainError("診断checkpointのidentityが一致しません", 409);
  }

  saveEngineCheckpoint(
    runId: string,
    identity: string,
    engine: DiagnosticEngineName,
    findings: DiagnosticFinding[],
    coverage: DiagnosticCoverage,
  ) {
    const validatedFindings = findings.map((finding) =>
      diagnosticFindingSchema.parse(finding),
    );
    const validatedCoverage = diagnosticCoverageSchema.parse(coverage);
    if (
      validatedCoverage.engine !== engine ||
      validatedFindings.some((finding) => finding.engine !== engine)
    )
      throw new DomainError("診断engine checkpointの範囲が一致しません", 400);
    const column =
      engine === "static" ? "static_analysis" : "dependency_analysis";
    const result = this.store.db
      .prepare(
        `UPDATE diagnostic_checkpoints SET ${column}=? WHERE run_id=? AND identity=?`,
      )
      .run(
        JSON.stringify({
          findings: validatedFindings,
          coverage: validatedCoverage,
        }),
        runId,
        identity,
      );
    if (result.changes !== 1)
      throw new DomainError("診断checkpointのidentityが一致しません", 409);
  }

  recoverInterrupted(): DiagnosticRun[] {
    const rows = this.store.db
      .prepare(
        "SELECT id,product_id,revision,data FROM diagnostic_runs WHERE status IN ('queued','running')",
      )
      .all() as {
      id: string;
      product_id: string;
      revision: number;
      data: string;
    }[];
    const recovered: DiagnosticRun[] = [];
    for (const row of rows) {
      const current = diagnosticRunSchema.parse(JSON.parse(row.data));
      const next = diagnosticRunSchema.parse({
        ...current,
        revision: current.revision + 1,
        status: "interrupted",
        updatedAt: now(),
        failure:
          "サーバー再起動により中断されました。再開操作で同じ固定版を再評価できます。",
        statusHistory: [
          ...current.statusHistory,
          { status: "interrupted", at: now(), reason: "サーバー再起動" },
        ].slice(-100),
        progress: {
          ...current.progress,
          phase: "finished",
          message: "再起動により中断",
          updatedAt: now(),
        },
      });
      this.saveRun(next, current.revision);
      recovered.push(next);
    }
    return recovered;
  }

  static requestFingerprint(value: unknown) {
    return sha256(JSON.stringify(value));
  }
}
