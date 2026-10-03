import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  safeParseContract,
  validateContractGraph,
} from "@rna4219/agent-protocols";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import {
  applyCommand,
  contracts,
  newProject,
  prompt,
} from "../src/server/domain.js";
import { Memx } from "../src/server/memx.js";
import { exampleProject, exampleSources } from "../src/shared/example.js";
import {
  mutationSchema,
  replySchema,
  type Command,
  type Project,
  type RequirementInput,
} from "../src/shared/model.js";

const handles: { close: () => unknown }[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
});
const prepare = () =>
  applyCommand(newProject(exampleProject), {
    type: "sources",
    value: { schemaVersion: "1.0", sources: exampleSources },
  });
const requirement = (p: Project): RequirementInput => ({
  id: "REQ-001",
  title: "根拠付き比較",
  description: "資料を比較する",
  priority: "high",
  sourceIds: [p.sources[0].id],
  rationale: "",
  acceptance: ["出典へ戻れる"],
  tasks: ["比較画面を作る"],
});
const withRequirement = () => {
  const p = prepare();
  return applyCommand(p, {
    type: "reply",
    raw: JSON.stringify({
      schemaVersion: "1.0",
      requirements: [requirement(p)],
    }),
  });
};
describe("要件と根拠の整合性", () => {
  it("資料の重複を防ぎ、更新で承認を失効させ、原文を保存する", () => {
    let p = withRequirement();
    p = applyCommand(p, {
      type: "review",
      requirementId: "REQ-001",
      status: "approved",
    });
    p = applyCommand(p, { type: "source", value: exampleSources[0] });
    expect(p.sources).toHaveLength(3);
    p = applyCommand(p, {
      type: "source",
      sourceId: p.sources[0].id,
      value: { ...exampleSources[0], version: "2", body: "新しい説明" },
    });
    expect(p.sources[0].history[0].body).toBe(exampleSources[0].body);
    expect(p.requirements[0].status).toBe("needs_review");
    expect(() => contracts(p)).toThrow("承認済み");
  });
  it("一括取込は不明出典・重複ID・既存ID・自動承認を拒否する", () => {
    const p = prepare();
    const r = requirement(p);
    expect(() =>
      replySchema.parse({
        schemaVersion: "1.0",
        requirements: [{ ...r, status: "approved" }],
      }),
    ).toThrow();
    for (const requirements of [
      [r, r],
      [{ ...r, sourceIds: ["unknown"] }],
      [{ ...r, sourceIds: [], rationale: "" }],
    ]) {
      expect(() =>
        applyCommand(p, {
          type: "reply",
          raw: JSON.stringify({ schemaVersion: "1.0", requirements }),
        }),
      ).toThrow();
      expect(p.requirements).toHaveLength(0);
    }
    const p2 = withRequirement();
    expect(() =>
      applyCommand(p2, {
        type: "reply",
        raw: JSON.stringify({
          schemaVersion: "1.0",
          requirements: [requirement(p2)],
        }),
      }),
    ).toThrow("既存");
  });
  it("同じ版から決定的で有効な契約を生成し、承認要件だけを含める", () => {
    const p = applyCommand(withRequirement(), {
      type: "review",
      requirementId: "REQ-001",
      status: "approved",
    });
    const result = contracts(p);
    expect(result).toHaveLength(2);
    expect(result.every((r) => safeParseContract(r).success)).toBe(true);
    expect(validateContractGraph(result).valid).toBe(true);
    expect(contracts(p)).toEqual(result);
    expect(result[1].lifecycle).toBe("draft");
    expect(JSON.stringify(result)).toContain(exampleSources[0].url);
    expect(
      applyCommand(p, {
        type: "project",
        value: { ...exampleProject, constraints: "変更した制約" },
      }).requirements[0].status,
    ).toBe("needs_review");
  });
  it("プロンプトは選択資料だけを含み、出力形式を指定する", () => {
    const p = prepare();
    const value = prompt(p, [p.sources[0].id]);
    expect(value).toContain(JSON.stringify(p.sources[0].body));
    expect(value).not.toContain(p.sources[1].url);
    expect(value).toContain("回答JSON Schema");
    expect(() => prompt(p, ["unknown"])).toThrow();
  });
  it("受入条件・文字数・URLと未知フィールドを検証する", () => {
    expect(() =>
      mutationSchema.parse({
        revision: 1,
        command: {
          type: "source",
          value: { ...exampleSources[0], url: "file:///private" },
        },
      }),
    ).toThrow();
    const p = prepare();
    expect(() =>
      replySchema.parse({
        schemaVersion: "1.0",
        requirements: [{ ...requirement(p), acceptance: [] }],
      }),
    ).toThrow();
    expect(() =>
      replySchema.parse({
        schemaVersion: "2.0",
        requirements: [requirement(p)],
      }),
    ).toThrow();
  });
});
describe("永続化と履歴", () => {
  it("再起動で復元し、古いrevisionでの上書きを拒否する", () => {
    mkdirSync(".cache/tests", { recursive: true });
    const path = resolve(".cache/tests", `${randomUUID()}.db`);
    let store = new Store(path);
    const p = store.create(exampleProject);
    const next = store.mutate(p.id, p.revision, {
      type: "source",
      value: exampleSources[0],
    });
    expect(() =>
      store.mutate(p.id, p.revision, {
        type: "source",
        value: exampleSources[1],
      }),
    ).toThrow("別の画面");
    store.close();
    store = new Store(path);
    handles.push(store);
    expect(store.get(p.id)).toEqual(next);
    expect(store.revision(p.id, 1).sources).toHaveLength(0);
    expect(store.history(p.id)).toHaveLength(2);
  });
  it("将来版のDBを上書きしない", () => {
    mkdirSync(".cache/tests", { recursive: true });
    const path = resolve(".cache/tests", `${randomUUID()}.db`);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=99");
    db.close();
    expect(() => new Store(path)).toThrow("未対応");
  });
});
describe("API", () => {
  const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
  it("作成→資料→要件→承認→出力。誤入力と接続失敗はデータを壊さない", async () => {
    const app = await createApp({ dbPath: ":memory:" });
    handles.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: exampleProject,
    });
    expect(created.statusCode).toBe(201);
    let p = created.json<Project>();
    const pid = p.id;
    const send = async (command: Command) => {
      const r = await app.inject({
        method: "POST",
        url: `/api/projects/${pid}/commands`,
        headers,
        payload: { revision: p.revision, command },
      });
      expect(r.statusCode, r.body).toBe(200);
      p = r.json();
    };
    await send({ type: "source", value: exampleSources[0] });
    const bad = await app.inject({
      method: "POST",
      url: `/api/projects/${pid}/commands`,
      headers,
      payload: {
        revision: p.revision,
        command: { type: "reply", raw: "broken json" },
      },
    });
    expect(bad.statusCode).toBe(400);
    const artifacts = await app.inject({
      url: `/api/projects/${pid}/artifacts`,
      headers,
    });
    expect(artifacts.json()[0].body).toBe("broken json");
    await send({
      type: "reply",
      raw: JSON.stringify({
        schemaVersion: "1.0",
        requirements: [requirement(p)],
      }),
    });
    expect(p.requirements[0].status).toBe("draft");
    await send({
      type: "review",
      requirementId: "REQ-001",
      status: "approved",
    });
    const c = await app.inject({
      url: `/api/projects/${pid}/export/contracts`,
      headers,
    });
    expect(c.statusCode, c.body).toBe(200);
    expect(validateContractGraph(c.json()).valid).toBe(true);
    const md = await app.inject({
      url: `/api/projects/${pid}/export/markdown`,
      headers,
    });
    expect(md.body).toContain(exampleSources[0].url);
    const json = await app.inject({
      url: `/api/projects/${pid}/export/json`,
      headers,
    });
    expect(json.json()).toEqual(p);
    const memx = await app.inject({
      method: "POST",
      url: `/api/projects/${pid}/memx`,
      headers,
      payload: { action: "sync" },
    });
    expect(memx.statusCode).toBe(503);
    const same = await app.inject({ url: `/api/projects/${pid}`, headers });
    expect(same.json()).toEqual(p);
  });
  it("Host・Origin・必須ヘッダー・サイズの制限", async () => {
    const app = await createApp({ dbPath: ":memory:" });
    handles.push(app);
    expect(
      (
        await app.inject({
          url: "/api/projects",
          headers: { host: "other.example:4317", "x-workbench": "1" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/projects",
          headers: { ...headers, origin: "http://other.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/projects",
          headers: { host: headers.host },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { ...exampleProject, title: "x".repeat(2 * 1024 * 1024) },
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (await app.inject({ url: "/api/projects", headers })).headers[
        "content-security-policy"
      ],
    ).toContain("img-src 'none'");
  });
});
describe("memxアダプター", () => {
  it("ループバックのみを受け付ける", () => {
    expect(() => new Memx("https://example.com")).toThrow();
    expect(() => new Memx("http://127.0.0.1:7766/path")).toThrow();
  });
  it("同期・検索・参照・読了・鮮度の契約と再試行を確認する", async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      calls.push({ path: req.url!, body });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/v1/docs:ingest"
            ? { doc_id: body.doc_id }
            : { status: "fresh", chunks: [], results: [] },
        ),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    handles.push({
      close: () => new Promise<void>((r) => server.close(() => r())),
    });
    const address = server.address() as { port: number };
    const adapter = new Memx(`http://127.0.0.1:${address.port}`);
    const store = new Store(":memory:");
    handles.push(store);
    const base = store.create(exampleProject);
    const p = store.mutate(base.id, 1, {
      type: "source",
      value: exampleSources[0],
    });
    expect(await adapter.sync(p, store)).toEqual({ synced: 1 });
    expect(await adapter.sync(p, store)).toEqual({ synced: 0 });
    await adapter.search(p, "Trivy");
    await adapter.source(p, store, p.sources[0].id);
    await adapter.source(p, store, p.sources[0].id, true);
    await adapter.stale(p);
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/docs:ingest",
      "/v1/docs:search",
      "/v1/chunks:get",
      "/v1/reads:ack",
      "/v1/docs:stale-check",
    ]);
    expect(calls[1].body.feature_keys).toEqual([p.id]);
  });
});
