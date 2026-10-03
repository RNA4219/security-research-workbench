import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyCommand, DomainError, newProject } from "./domain.js";
import type { Command, Project, ProjectInput } from "../shared/model.js";
import { migrateProject } from "./provenance.js";

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 2) {
      this.db.close();
      throw new Error("未対応のDBバージョンです");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(project_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id, revision));
      CREATE TABLE IF NOT EXISTS artifacts(id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memx(project_id TEXT NOT NULL, source_id TEXT NOT NULL, doc_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(project_id,source_id));
      `);
      if (version < 2) {
        const rows = this.db.prepare("SELECT id,data FROM projects").all() as {
          id: string;
          data: string;
        }[];
        for (const row of rows) {
          const p = migrateProject(JSON.parse(row.data));
          p.revision++;
          p.updatedAt = new Date().toISOString();
          this.db
            .prepare("UPDATE projects SET revision=?,data=? WHERE id=?")
            .run(p.revision, JSON.stringify(p), p.id);
          this.snapshot(p);
        }
      }
      this.db.exec("PRAGMA user_version=2; COMMIT;");
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw e;
    }
  }
  list() {
    return (
      this.db
        .prepare("SELECT data FROM projects ORDER BY rowid DESC")
        .all() as { data: string }[]
    ).map((row) => {
      const p = JSON.parse(row.data) as Project;
      return { id: p.id, title: p.title, revision: p.revision };
    });
  }
  get(id: string): Project {
    const row = this.db
      .prepare("SELECT data FROM projects WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new DomainError("プロジェクトがありません", 404);
    return JSON.parse(row.data);
  }
  create(input: ProjectInput) {
    const p = newProject(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO projects VALUES (?,?,?)")
        .run(p.id, p.revision, JSON.stringify(p));
      this.snapshot(p);
      this.db.exec("COMMIT");
      return p;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private snapshot(p: Project) {
    this.db
      .prepare("INSERT INTO revisions VALUES (?,?,?)")
      .run(p.id, p.revision, JSON.stringify(p));
  }
  mutate(id: string, revision: number, command: Command) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.get(id);
      if (old.revision !== revision)
        throw new DomainError(
          "別の画面で更新されました。再読込してやり直してください。",
          409,
        );
      const p = applyCommand(old, command);
      this.db
        .prepare("UPDATE projects SET revision=?,data=? WHERE id=?")
        .run(p.revision, JSON.stringify(p), id);
      this.snapshot(p);
      if (command.type === "source" || command.type === "sources")
        this.artifact(id, "source-import", JSON.stringify(command.value));
      this.db.exec("COMMIT");
      return p;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  artifact(id: string, kind: string, body: string) {
    this.get(id);
    this.db
      .prepare(
        "INSERT INTO artifacts(project_id,kind,created_at,body) VALUES (?,?,?,?)",
      )
      .run(id, kind, new Date().toISOString(), body);
  }
  history(id: string) {
    this.get(id);
    return this.db
      .prepare(
        "SELECT revision FROM revisions WHERE project_id=? ORDER BY revision DESC",
      )
      .all(id);
  }
  revision(id: string, revision: number) {
    this.get(id);
    const r = this.db
      .prepare("SELECT data FROM revisions WHERE project_id=? AND revision=?")
      .get(id, revision) as { data: string } | undefined;
    if (!r) throw new DomainError("履歴がありません", 404);
    return JSON.parse(r.data) as Project;
  }
  artifacts(id: string) {
    this.get(id);
    return this.db
      .prepare(
        "SELECT id,kind,created_at,body FROM artifacts WHERE project_id=? ORDER BY id DESC LIMIT 50",
      )
      .all(id);
  }
  close() {
    this.db.close();
  }
}
