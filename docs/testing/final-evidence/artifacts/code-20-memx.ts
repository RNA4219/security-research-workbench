import type { Project } from "../shared/model.js";
import { DomainError } from "./domain.js";
import type { Store } from "./store.js";

export class Memx {
  private base?: string;
  constructor(value?: string) {
    if (value) {
      const u = new URL(value);
      if (
        u.protocol !== "http:" ||
        !["127.0.0.1", "[::1]"].includes(u.hostname) ||
        u.username ||
        u.password ||
        u.pathname !== "/" ||
        u.search ||
        u.hash
      )
        throw new Error("MEMX_URLはループバックHTTPのルートURLに限定します");
      this.base = u.origin;
    }
  }
  get enabled() {
    return !!this.base;
  }
  private async post(
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.base)
      throw new DomainError(
        "MEMX_URLが未設定です。基本機能はそのまま使用できます。",
        503,
      );
    try {
      const r = await fetch(this.base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const reader = r.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const c = await reader.read();
        if (c.done) break;
        size += c.value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Error("response too large");
        }
        chunks.push(c.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new DomainError(
        "memxへの接続または応答に失敗しました。設定・起動状態を確認してください。",
        502,
      );
    }
  }
  async sync(p: Project, store: Store) {
    let synced = 0;
    for (const s of p.sources) {
      const previous = store.db
        .prepare("SELECT revision FROM memx WHERE project_id=? AND source_id=?")
        .get(p.id, s.id) as { revision: number } | undefined;
      if (previous?.revision === s.revision) continue;
      const data = await this.post("/v1/docs:ingest", {
        doc_id: `doc:spec:srw-${p.id}-${s.id}`,
        doc_type: "spec",
        title: s.title,
        source_path: `srw/${p.id}/${s.id}.md`,
        version: String(s.revision),
        version_scheme: "string",
        updated_at: p.updatedAt,
        tags: ["security-research-workbench"],
        feature_keys: [p.id],
        body: s.body,
        summary: `${s.url} (${s.version})`,
        chunking: { mode: "heading", max_chars: 4000 },
      });
      if (typeof data.doc_id !== "string")
        throw new DomainError("memx応答にdoc_idがありません", 502);
      store.db
        .prepare(
          "INSERT INTO memx VALUES (?,?,?,?) ON CONFLICT(project_id,source_id) DO UPDATE SET doc_id=excluded.doc_id, revision=excluded.revision",
        )
        .run(p.id, s.id, data.doc_id, s.revision);
      synced++;
    }
    return { synced };
  }
  search(p: Project, query: string) {
    return this.post("/v1/docs:search", {
      query,
      feature_keys: [p.id],
      limit: 10,
    });
  }
  async source(p: Project, store: Store, sourceId: string, ack = false) {
    const mapping = store.db
      .prepare(
        "SELECT doc_id,revision FROM memx WHERE project_id=? AND source_id=?",
      )
      .get(p.id, sourceId) as { doc_id: string; revision: number } | undefined;
    if (!mapping) throw new DomainError("まず資料を同期してください");
    if (ack)
      return this.post("/v1/reads:ack", {
        task_id: `task:research:local:${p.id}`,
        doc_id: mapping.doc_id,
        version: String(mapping.revision),
        reader: "human",
      });
    return this.post("/v1/chunks:get", { doc_id: mapping.doc_id, limit: 10 });
  }
  stale(p: Project) {
    return this.post("/v1/docs:stale-check", {
      task_id: `task:research:local:${p.id}`,
    });
  }
}
