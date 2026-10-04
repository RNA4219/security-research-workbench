import type { Store } from "./store.js";
import { DomainError } from "../shared/domain-error.js";
import type { WorkflowState, WorkflowCommand } from "../shared/workflow.js";
import type { WorkflowRun } from "../shared/workflow-run.js";
import {
  newWorkflow,
  applyWorkflowCommand,
  importResearch,
} from "./workflow-domain.js";
import { newProject } from "./domain.js";

/** 案件と実行を別revisionで保存し、古い画面による上書きを防ぐ。 */
export class WorkflowStore {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_history (
        project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(project_id, revision)
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_cases (
        report_id TEXT PRIMARY KEY REFERENCES repository_research(id), project_id TEXT NOT NULL REFERENCES projects(id)
      );
    `);
  }
  get(projectId: string): WorkflowState {
    this.store.get(projectId);
    const row = this.store.db
      .prepare("SELECT data FROM workflows WHERE project_id=?")
      .get(projectId) as { data: string } | undefined;
    if (row) return JSON.parse(row.data);
    const state = newWorkflow(projectId);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db
        .prepare("INSERT INTO workflows VALUES (?,?,?)")
        .run(projectId, state.revision, JSON.stringify(state));
      this.snapshot(state);
      this.store.db.exec("COMMIT");
      return state;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  private snapshot(state: WorkflowState) {
    this.store.db
      .prepare("INSERT INTO workflow_history VALUES (?,?,?)")
      .run(state.projectId, state.revision, JSON.stringify(state));
  }
  update(
    projectId: string,
    revision: number,
    change: (state: WorkflowState) => WorkflowState,
  ): WorkflowState {
    // 初期化はtransaction外。以降のread/compare/write/snapshotは一体で確定する。
    this.get(projectId);
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.get(projectId);
      if (old.revision !== revision)
        throw new DomainError(
          "別の画面で案件が更新されました。再読込してください。",
          409,
        );
      const next = change(old);
      if (next.projectId !== projectId)
        throw new DomainError("案件の変更先が一致しません");
      if (JSON.stringify(old) === JSON.stringify(next)) {
        this.store.db.exec("COMMIT");
        return old;
      }
      next.revision = revision + 1;
      this.store.db
        .prepare("UPDATE workflows SET revision=?,data=? WHERE project_id=?")
        .run(next.revision, JSON.stringify(next), projectId);
      this.snapshot(next);
      this.store.db.exec("COMMIT");
      return next;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  command(projectId: string, revision: number, command: WorkflowCommand) {
    return this.update(projectId, revision, (state) =>
      applyWorkflowCommand(state, command),
    );
  }
  import(projectId: string, revision: number, reportId: string) {
    const report = this.store.getResearch(reportId);
    return this.update(projectId, revision, (state) =>
      importResearch(state, report),
    );
  }
  adopt(reportId: string) {
    const report = this.store.getResearch(reportId);
    const existing = this.store.db
      .prepare("SELECT project_id FROM research_cases WHERE report_id=?")
      .get(reportId) as { project_id: string } | undefined;
    if (existing) return this.store.get(existing.project_id);
    const project = newProject({
      title: `${report.repository.name} の採用判断`,
      objective:
        "公開情報の調査結果に、利用条件と人の判断を重ねて採用前の確認を進める。",
      audience: "導入を判断する開発者・レビュー担当者",
      constraints: "根拠と対象版を確認し、未確認事項を安全と扱わない。",
    });
    const state = importResearch(
      newWorkflow(project.id, {
        target: report.repository.url,
        version: report.repository.commit ?? "unknown",
        purpose: "OSSの採用前調査",
        ownership:
          "公開情報の閲覧と手元の利用条件の確認。対象への試験実行は含めない。",
        allowedProviderIds: ["manual"],
        allowedMethods: ["static-review", "known-issue-match", "manual-review"],
      }),
      report,
    );
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
        .run(project.id, state.revision, JSON.stringify(state));
      this.snapshot(state);
      this.store.db
        .prepare("INSERT INTO research_cases VALUES (?,?)")
        .run(reportId, project.id);
      this.store.db.exec("COMMIT");
      return project;
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
  }
  history(projectId: string): { revision: number }[] {
    this.get(projectId);
    return this.store.db
      .prepare(
        "SELECT revision FROM workflow_history WHERE project_id=? ORDER BY revision DESC",
      )
      .all(projectId) as { revision: number }[];
  }
  historical(projectId: string, revision: number): WorkflowState {
    this.store.get(projectId);
    const row = this.store.db
      .prepare(
        "SELECT data FROM workflow_history WHERE project_id=? AND revision=?",
      )
      .get(projectId, revision) as { data: string } | undefined;
    if (!row) throw new DomainError("案件の履歴がありません", 404);
    return JSON.parse(row.data);
  }
  listRuns(projectId: string): WorkflowRun[] {
    this.store.get(projectId);
    return (
      this.store.db
        .prepare(
          "SELECT data FROM workflow_runs WHERE project_id=? ORDER BY rowid DESC LIMIT 100",
        )
        .all(projectId) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  interruptedRuns(): WorkflowRun[] {
    return (
      this.store.db
        .prepare(
          "SELECT data FROM workflow_runs WHERE json_extract(data, '$.status')='running'",
        )
        .all() as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  activeRuns(projectId: string): WorkflowRun[] {
    this.store.get(projectId);
    return (
      this.store.db
        .prepare(
          "SELECT data FROM workflow_runs WHERE project_id=? AND json_extract(data, '$.status') IN ('running','waiting_response')",
        )
        .all(projectId) as { data: string }[]
    ).map((row) => JSON.parse(row.data));
  }
  getRun(projectId: string, runId: string): WorkflowRun {
    this.store.get(projectId);
    const row = this.store.db
      .prepare("SELECT data FROM workflow_runs WHERE id=? AND project_id=?")
      .get(runId, projectId) as { data: string } | undefined;
    if (!row) throw new DomainError("この案件の実行記録がありません", 404);
    return JSON.parse(row.data);
  }
  saveRun(run: WorkflowRun, expectedRevision: number): void {
    this.store.get(run.projectId);
    if (run.revision !== expectedRevision + 1)
      throw new DomainError("実行記録の版が不正です", 409);
    if (expectedRevision === 0) {
      const result = this.store.db
        .prepare("INSERT OR IGNORE INTO workflow_runs VALUES (?,?,?,?)")
        .run(run.id, run.projectId, run.revision, JSON.stringify(run));
      if (result.changes !== 1)
        throw new DomainError("実行記録が既に存在します", 409);
    } else {
      const result = this.store.db
        .prepare(
          "UPDATE workflow_runs SET revision=?,data=? WHERE id=? AND project_id=? AND revision=?",
        )
        .run(
          run.revision,
          JSON.stringify(run),
          run.id,
          run.projectId,
          expectedRevision,
        );
      if (result.changes !== 1)
        throw new DomainError("実行記録が別の操作で更新されました", 409);
    }
  }
}
