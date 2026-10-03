import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyCommand,
  internalContract,
  newProject,
  prompt,
  contracts,
} from "../src/server/domain.js";
import { migrateProject } from "../src/server/provenance.js";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { Memx } from "../src/server/memx.js";
import { exampleProject, exampleSources } from "../src/shared/example.js";
import {
  projectInput,
  sourceInput,
  claimInput,
  type Command,
  type Project,
  type RequirementInput,
} from "../src/shared/model.js";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const source = exampleSources[0];
const candidate = {
  name: "候補",
  url: source.url,
  features: "機能",
  license: "未確認",
  maintenance: "未確認",
  rationale: "比較対象",
  decision: "consider" as const,
  sourceIds: [],
};
const requirement = (
  extra: Partial<RequirementInput> = {},
): RequirementInput => ({
  id: "R1",
  title: "要件",
  description: "利用者判断",
  sourceIds: [],
  rationale: "独立した判断",
  priority: "high",
  acceptance: ["保存して再読込できる"],
  tasks: ["保存"],
  ...extra,
});
function fixture() {
  let p = applyCommand(newProject(exampleProject), {
    type: "source",
    value: source,
  });
  p = applyCommand(p, { type: "candidate", value: candidate });
  p = applyCommand(p, {
    type: "evidence",
    value: {
      sourceId: p.sources[0].id,
      sourceType: "official",
      excerpt: "機能の根拠",
      verificationStatus: "verified",
    },
  });
  const {
    id,
    revision: _,
    ...value
  } = p.claims.find((c) => c.field === "features")!;
  p = applyCommand(p, {
    type: "claim",
    claimId: id,
    value: {
      ...value,
      verificationStatus: "verified",
      evidenceIds: [p.evidence[0].id],
    },
  });
  p = applyCommand(p, {
    type: "candidate-review",
    candidateId: p.candidates[0].id,
    status: "approved",
  });
  p = applyCommand(p, {
    type: "reply",
    raw: JSON.stringify({
      schemaVersion: "2.0",
      requirements: [requirement({ claimIds: [id], rationale: "" })],
    }),
  });
  return applyCommand(p, {
    type: "review",
    requirementId: "R1",
    status: "approved",
  });
}

describe("FR-02/12 入力の境界と決定表", () => {
  it.each([0, 1, 199, 200, 201])("プロジェクト名 %i 文字", (n) => {
    expect(
      projectInput.safeParse({ ...exampleProject, title: "名".repeat(n) })
        .success,
    ).toBe(n >= 1 && n <= 200);
  });
  it.each([0, 1, 999999, 1000000, 1000001])("資料本文 %i 文字", (n) => {
    expect(
      sourceInput.safeParse({ ...source, body: "x".repeat(n) }).success,
    ).toBe(n >= 1 && n <= 1000000);
  });
  it.each(["known", "unknown", "empty"] as const)(
    "値状態 %s と空文字の整合",
    (valueState) => {
      for (const value of ["", "実値"])
        expect(
          claimInput.safeParse({
            field: "features",
            valueState,
            value,
            evidenceIds: [],
            verificationStatus: "unverified",
          }).success,
        ).toBe(valueState === "known" ? value !== "" : value === "");
    },
  );
});

describe("FR-11/13/15 根拠と承認の回帰", () => {
  it("変更なし・タイトル変更は根拠の承認を失効させない", () => {
    const p = fixture();
    const same = applyCommand(p, {
      type: "source",
      sourceId: p.sources[0].id,
      value: source,
    });
    expect(same.sources[0]).toEqual(p.sources[0]);
    const renamed = applyCommand(same, {
      type: "project",
      value: { ...exampleProject, title: "新しい題名" },
    });
    expect(renamed.requirements[0].status).toBe("approved");
    expect(renamed.candidates[0].status).toBe("approved");
    expect(internalContract(renamed).requirements).toHaveLength(1);
  });
  it("候補編集は関連承認を失効し、変更していないClaimと原本を維持する", () => {
    const p = fixture(),
      before = structuredClone(p);
    const oldLicense = p.claims.find((c) => c.field === "license")!;
    const next = applyCommand(p, {
      type: "candidate",
      candidateId: p.candidates[0].id,
      value: { ...candidate, features: "変更した機能" },
    });
    expect(next.requirements[0].status).toBe("needs_review");
    expect(next.candidates[0].status).toBe("draft");
    expect(
      next.claims.find((c) => c.field === "features")?.evidenceIds,
    ).toEqual([]);
    expect(next.claims.find((c) => c.field === "license")).toEqual(oldLicense);
    expect(p).toEqual(before);
  });
  it("要件編集・再レビューと旧形式の同じ出典からの再正規化", () => {
    let p = fixture();
    p = applyCommand(p, {
      type: "requirement",
      value: requirement({ sourceIds: [p.sources[0].id] }),
    });
    expect(p.requirements[0].status).toBe("draft");
    const ids = p.requirements[0].claimIds;
    p = applyCommand(p, {
      type: "requirement",
      value: requirement({ sourceIds: [p.sources[0].id], description: "改訂" }),
    });
    expect(p.requirements[0].claimIds).toEqual(ids);
    expect(p.claims.find((c) => c.id === ids[0])?.value).toBe("改訂");
    expect(p.evidence.filter((e) => e.id.startsWith("legacy_e_"))).toHaveLength(
      1,
    );
    expect(() =>
      applyCommand(p, {
        type: "review",
        requirementId: "R1",
        status: "approved",
      }),
    ).toThrow("根拠不足");
    expect(p.reviews.at(-1)?.note).toBe("要件を編集しました");
  });
  it("Claimの所属変更・項目重複を拒否する", () => {
    const p = fixture();
    const { id, revision: _, ...value } = p.claims[0];
    expect(() =>
      applyCommand(p, {
        type: "claim",
        claimId: id,
        value: { ...value, field: "requirement_basis" },
      }),
    ).toThrow("所属");
    expect(() => applyCommand(p, { type: "claim", value })).toThrow("既に");
    const next = applyCommand(p, {
      type: "claim",
      value: {
        field: "requirement_basis",
        valueState: "unknown",
        value: "",
        evidenceIds: [],
        verificationStatus: "unverified",
      },
    });
    expect(next.claims).toHaveLength(p.claims.length + 1);
  });
  it.each(["unverified", "disputed"] as const)(
    "Evidence %s では確認済みClaimを保存できない",
    (verificationStatus) => {
      const p = fixture();
      p.evidence[0].verificationStatus = verificationStatus;
      const {
        id,
        revision: _,
        ...value
      } = p.claims.find((c) => c.field === "features")!;
      expect(() =>
        applyCommand(p, { type: "claim", claimId: id, value }),
      ).toThrow("Evidence");
      expect(() =>
        applyCommand(p, {
          type: "candidate-review",
          candidateId: p.candidates[0].id,
          status: "approved",
        }),
      ).toThrow("Evidence");
      expect(() => prompt(p, [p.sources[0].id])).toThrow("再確認");
    },
  );
  it("要件は未確認Claimを事実扱いせず、資料版不一致を出力しない", () => {
    const p = fixture();
    p.requirements[0].sourceVersions[p.sources[0].id] = 0;
    expect(() => internalContract(p)).toThrow("版が変わって");
    const unknown = p.claims.find((c) => c.valueState === "unknown")!;
    const next = applyCommand(p, {
      type: "requirement",
      value: requirement({ claimIds: [unknown.id] }),
    });
    expect(() =>
      applyCommand(next, {
        type: "review",
        requirementId: "R1",
        status: "approved",
      }),
    ).toThrow("根拠不足");
  });
  it("不明IDをどの編集入口からも拒否し、元データを維持する", () => {
    const p = fixture(),
      before = structuredClone(p);
    const commands: Command[] = [
      { type: "source", sourceId: "missing", value: source },
      { type: "candidate", candidateId: "missing", value: candidate },
      {
        type: "evidence",
        evidenceId: "missing",
        value: {
          sourceId: p.sources[0].id,
          sourceType: "other",
          excerpt: "x",
          verificationStatus: "unverified",
        },
      },
      {
        type: "claim",
        claimId: "missing",
        value: {
          field: "features",
          value: "",
          valueState: "empty",
          evidenceIds: [],
          verificationStatus: "unverified",
        },
      },
      { type: "candidate-review", candidateId: "missing", status: "draft" },
      { type: "requirement", value: requirement({ id: "missing" }) },
      { type: "review", requirementId: "missing", status: "draft" },
    ];
    for (const command of commands)
      expect(() => applyCommand(p, command)).toThrow("ありません");
    expect(p).toEqual(before);
  });
  it("v1候補移行で既知・未確認・値なしを区別し、v2は独立したコピーを返す", () => {
    const p = fixture();
    const legacy = {
      ...p,
      schemaVersion: "1.0",
      evidence: undefined,
      claims: undefined,
      reviews: undefined,
    };
    const migrated = migrateProject(legacy);
    expect(migrated.candidates[0].status).toBe("draft");
    expect(
      migrated.claims.find((c) => c.field === "features")?.valueState,
    ).toBe("known");
    expect(migrated.claims.find((c) => c.field === "license")?.valueState).toBe(
      "unknown",
    );
    expect(migrated.claims.find((c) => c.field === "release")?.valueState).toBe(
      "empty",
    );
    expect(migrateProject(p)).toEqual(p);
    expect(migrateProject(p)).not.toBe(p);
    expect(() => migrateProject({ ...p, schemaVersion: "99.0" })).toThrow();
  });
});

describe("FR-01/07/15 APIとトランザクション", () => {
  const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
  it("不正入力の詳細、一覧、履歴、不明ID、サーバー内部例外を区別する", async () => {
    const app = await createApp({
      dbPath: ":memory:",
      staticRoot: ".cache/nonexistent-static",
    });
    cleanups.push(() => app.close());
    const invalid = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { ...exampleProject, title: "" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().issues[0].path).toBe("title");
    const p = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: exampleProject,
      })
    ).json<Project>();
    expect(
      (await app.inject({ url: "/api/projects", headers })).json(),
    ).toEqual([{ id: p.id, title: p.title, revision: 1 }]);
    expect(
      (
        await app.inject({ url: `/api/projects/${p.id}/history/1`, headers })
      ).json(),
    ).toEqual(p);
    expect(
      (
        await app.inject({ url: `/api/projects/${p.id}/history`, headers })
      ).json(),
    ).toHaveLength(1);
    for (const url of [
      "/api/projects/missing",
      `/api/projects/${p.id}/history/2`,
    ])
      expect((await app.inject({ url, headers })).statusCode).toBe(404);
    const spy = vi.spyOn(Store.prototype, "get").mockImplementation(() => {
      throw new Error("internal detail");
    });
    const broken = await app.inject({ url: `/api/projects/${p.id}`, headers });
    expect(broken.statusCode).toBe(500);
    expect(broken.body).not.toContain("internal detail");
    spy.mockRestore();
    expect((await app.inject({ url: "/healthz", headers })).json()).toEqual({
      status: "ok",
    });
  });
  it("一括取込の途中失敗・競合時も状態と履歴を変更せず、失敗原本は残す", async () => {
    const app = await createApp({ dbPath: ":memory:" });
    cleanups.push(() => app.close());
    const p = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: exampleProject,
      })
    ).json<Project>();
    const raw = JSON.stringify({
      schemaVersion: "2.0",
      requirements: [
        requirement(),
        requirement({ id: "R2", sourceIds: ["missing"] }),
      ],
    });
    const failed = await app.inject({
      method: "POST",
      url: `/api/projects/${p.id}/commands`,
      headers,
      payload: { revision: 1, command: { type: "reply", raw } },
    });
    expect(failed.statusCode).toBe(400);
    expect(
      (await app.inject({ url: `/api/projects/${p.id}`, headers })).json(),
    ).toEqual(p);
    expect(
      (
        await app.inject({ url: `/api/projects/${p.id}/history`, headers })
      ).json(),
    ).toHaveLength(1);
    expect(
      (
        await app.inject({ url: `/api/projects/${p.id}/artifacts`, headers })
      ).json()[0].body,
    ).toBe(raw);
    const valid = {
      type: "project",
      value: { ...exampleProject, title: "更新" },
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${p.id}/commands`,
          headers,
          payload: { revision: 1, command: valid },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/projects/${p.id}/commands`,
          headers,
          payload: { revision: 1, command: valid },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({ url: `/api/projects/${p.id}/history`, headers })
      ).json(),
    ).toHaveLength(2);
  });
  it("不正な旧プロジェクトが混在すると移行全体をロールバックする", () => {
    const dir = mkdtempSync(join(tmpdir(), "workbench-migration-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "migration.db"),
      db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE projects(id TEXT PRIMARY KEY, revision INTEGER, data TEXT); CREATE TABLE revisions(project_id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(project_id,revision)); PRAGMA user_version=1;",
    );
    const old = { ...fixture(), schemaVersion: "1.0" },
      raw = JSON.stringify(old);
    db.prepare("INSERT INTO projects VALUES(?,?,?)").run(
      old.id,
      old.revision,
      raw,
    );
    db.prepare("INSERT INTO projects VALUES(?,?,?)").run(
      "bad",
      1,
      '{"schemaVersion":"99.0"}',
    );
    db.close();
    expect(() => new Store(path)).toThrow();
    const check = new DatabaseSync(path);
    cleanups.push(() => check.close());
    expect(
      check.prepare("SELECT data FROM projects WHERE id=?").get(old.id)?.data,
    ).toBe(raw);
    expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  });
});

describe("FR-09 memx異常系と部分再試行（実ループバックHTTP）", () => {
  async function endpoint(
    reply: (
      path: string,
      body: Record<string, unknown>,
    ) => { status?: number; body: unknown; raw?: boolean },
  ) {
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const result = reply(req.url!, JSON.parse(raw));
      res.statusCode = result.status ?? 200;
      res.end(result.raw ? String(result.body) : JSON.stringify(result.body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  it.each([
    { status: 503, body: {} },
    { body: "not json", raw: true },
    { body: "x".repeat(2_000_001), raw: true },
    { body: {} },
  ])("異常応答 %# を隔離し、同期済みとして記録しない", async (response) => {
    const url = await endpoint(() => response),
      store = new Store(":memory:");
    cleanups.push(() => store.close());
    const base = store.create(exampleProject),
      p = store.mutate(base.id, 1, { type: "source", value: source });
    const adapter = new Memx(url);
    await expect(adapter.sync(p, store)).rejects.toMatchObject({ status: 502 });
    await expect(adapter.source(p, store, p.sources[0].id)).rejects.toThrow(
      "まず資料を同期",
    );
    expect(store.get(p.id)).toEqual(p);
  });
  it("途中成功後の再試行は未同期分だけ送る。各APIの結果を返す", async () => {
    const calls: string[] = [];
    let failSecond = true;
    const url = await endpoint((path, body) => {
      if (path === "/v1/docs:ingest") {
        calls.push(String(body.doc_id));
        if (calls.length === 2 && failSecond) return { status: 503, body: {} };
        return { body: { doc_id: body.doc_id } };
      }
      return {
        body: { route: path, results: [], chunks: [], status: "fresh" },
      };
    });
    const app = await createApp({ dbPath: ":memory:", memxUrl: url });
    cleanups.push(() => app.close());
    const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
    const p = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: exampleProject,
      })
    ).json<Project>();
    const imported = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${p.id}/commands`,
        headers,
        payload: {
          revision: 1,
          command: {
            type: "sources",
            value: {
              schemaVersion: "1.0",
              sources: exampleSources.slice(0, 2),
            },
          },
        },
      })
    ).json<Project>();
    const send = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: `/api/projects/${p.id}/memx`,
        headers,
        payload: payload as object,
      });
    expect((await send({ action: "sync" })).statusCode).toBe(502);
    failSecond = false;
    expect((await send({ action: "sync" })).json()).toEqual({ synced: 1 });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toBe(calls[2]);
    expect(calls[0]).not.toBe(calls[1]);
    for (const payload of [
      { action: "search", query: "機能" },
      { action: "stale" },
      { action: "chunks", sourceId: imported.sources[0].id },
      { action: "ack", sourceId: imported.sources[0].id },
    ])
      expect((await send(payload)).statusCode).toBe(200);
    expect((await send({ action: "search", query: "" })).statusCode).toBe(400);
    expect(
      (await app.inject({ url: `/api/projects/${p.id}`, headers })).json(),
    ).toEqual(imported);
  });
});

describe("FR-14 任意アダプターの不適合", () => {
  it.each(["missing-method", "invalid-graph"])(
    "%s の失敗後も内部契約を生成できる",
    async (kind) => {
      const name = "@rna4219/agent-protocols";
      vi.doMock(name, () =>
        kind === "missing-method"
          ? { createDeterministicContractId: undefined }
          : {
              createDeterministicContractId: () => "test",
              deriveGenerationPolicy: () => ({}),
              parseContract: (x: unknown) => x,
              validateContractGraph: () => ({ valid: false }),
            },
      );
      try {
        const p = fixture();
        await expect(contracts(p)).rejects.toMatchObject({ status: 503 });
        expect(internalContract(p).requirements).toHaveLength(1);
      } finally {
        vi.doUnmock(name);
      }
    },
  );
});
