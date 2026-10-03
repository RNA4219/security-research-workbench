import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  applyCommand,
  internalContract,
  contracts,
  markdown,
  newProject,
  prompt,
} from "../src/server/domain.js";
import { Store } from "../src/server/store.js";
import {
  claimInput,
  internalTaskContractSchema,
  mutationSchema,
  type Claim,
  type Command,
  type Project,
} from "../src/shared/model.js";
import { exampleProject, exampleSources } from "../src/shared/example.js";
import { createApp } from "../src/server/app.js";

const input = ({ id: _, revision: __, ...c }: Claim) => c;
function fixture() {
  let p = applyCommand(
    newProject({
      ...exampleProject,
      scope: "依存関係",
      outOfScope: "自動実行",
    }),
    {
      type: "sources",
      value: { schemaVersion: "1.0", sources: exampleSources },
    },
  );
  p = applyCommand(p, {
    type: "candidate",
    value: {
      name: "OSS",
      url: exampleSources[0].url,
      features: "比較",
      license: "未確認",
      maintenance: "未確認",
      decision: "consider",
      rationale: "選定",
      sourceIds: [],
    },
  });
  for (const s of p.sources.slice(0, 2))
    p = applyCommand(p, {
      type: "evidence",
      value: {
        sourceId: s.id,
        excerpt: s.title + "の根拠",
        sourceType: "official",
        verificationStatus: "verified",
      },
    });
  const c = p.claims.find((c) => c.field === "features")!;
  p = applyCommand(p, {
    type: "claim",
    claimId: c.id,
    value: {
      ...input(c),
      evidenceIds: p.evidence.map((e) => e.id),
      verificationStatus: "verified",
    },
  });
  return p;
}
function approve(p: Project) {
  p = applyCommand(p, {
    type: "candidate-review",
    candidateId: p.candidates[0].id,
    status: "approved",
    note: "出典を確認",
  });
  p = applyCommand(p, {
    type: "reply",
    raw: JSON.stringify({
      schemaVersion: "2.0",
      requirements: [
        {
          id: "R1",
          title: "要件",
          description: "比較できる",
          priority: "high",
          claimIds: [p.claims.find((c) => c.field === "features")!.id],
          sourceIds: [],
          rationale: "",
          acceptance: ["根拠を参照できる"],
          tasks: ["画面を作る"],
        },
      ],
    }),
  });
  return applyCommand(p, {
    type: "review",
    requirementId: "R1",
    status: "approved",
    note: "受入条件を確認",
  });
}
afterEach(() => vi.restoreAllMocks());
describe("Deep Researchの不足要件", () => {
  it("非対応アダプターの失敗を隔離し、内部契約と保存データを維持する", async () => {
    const name = "@rna4219/agent-protocols";
    const parse = vi.fn(() => {
      throw new Error("unsupported v2");
    });
    vi.doMock(name, () => ({
      createDeterministicContractId: () => "test",
      deriveGenerationPolicy: () => ({}),
      parseContract: parse,
      validateContractGraph: () => ({ valid: false }),
    }));
    try {
      const p = approve(fixture()),
        before = structuredClone(p);
      await expect(contracts(p)).rejects.toMatchObject({ status: 503 });
      expect(parse).toHaveBeenCalled();
      expect(
        internalTaskContractSchema.safeParse(internalContract(p)).success,
      ).toBe(true);
      expect(p).toEqual(before);
    } finally {
      vi.doUnmock(name);
    }
  });
  it("複数Evidenceの参照を内部契約・Markdown・逆参照で保持する", () => {
    const p = approve(fixture());
    const c = internalContract(p);
    expect(internalTaskContractSchema.safeParse(c).success).toBe(true);
    expect(c.sourceRefs).toHaveLength(2);
    expect(c.claims).toHaveLength(1);
    expect(c.claims[0].candidateId).toBe(c.candidates[0].id);
    expect(c.evidence).toHaveLength(2);
    expect(c.requirements[0].claimIds).toEqual([c.claims[0].id]);
    expect(c.requirements[0].sourceRefs).toEqual(
      p.sources.slice(0, 2).map((s) => s.id),
    );
    expect(c.outOfScope).toBe("自動実行");
    expect(internalContract(p)).toEqual(c);
    const md = markdown(p);
    for (const e of p.evidence) {
      expect(md).toContain(e.id);
      expect(md).toContain(e.excerpt);
    }
    for (const s of p.sources.slice(0, 2)) expect(md).toContain(s.url);
    expect(md).toContain("判断履歴");
    expect(md).toContain("未確認");
    expect(md).toContain("値なし");
  });
  it("未確認と値なしを区別し、不整合な値と根拠なしの検証済みを拒否する", () => {
    const p = fixture();
    expect(p.claims.find((c) => c.field === "license")!.valueState).toBe(
      "unknown",
    );
    expect(p.claims.find((c) => c.field === "release")!.valueState).toBe(
      "empty",
    );
    expect(() =>
      claimInput.parse({
        ...input(p.claims[0]),
        valueState: "unknown",
        value: "推測",
      }),
    ).toThrow();
    expect(() =>
      applyCommand(p, {
        type: "claim",
        claimId: p.claims[0].id,
        value: {
          ...input(p.claims[0]),
          valueState: "known",
          value: "x",
          verificationStatus: "verified",
          evidenceIds: [],
        },
      }),
    ).toThrow("Evidence");
    for (const evidenceIds of [
      ["missing"],
      [p.evidence[0].id, p.evidence[0].id],
    ])
      expect(() =>
        applyCommand(p, {
          type: "claim",
          claimId: p.claims[0].id,
          value: { ...input(p.claims[0]), evidenceIds },
        }),
      ).toThrow();
  });
  it("比較レビューをAPI側で強制し、根拠の欠落したプロンプトを拒否する", () => {
    let p = fixture();
    expect(() =>
      prompt(
        p,
        p.sources.map((s) => s.id),
      ),
    ).toThrow("レビュー");
    p = approve(p);
    expect(() => prompt(p, [p.sources[0].id])).toThrow("全Evidence");
    const txt = prompt(
      p,
      p.sources.slice(0, 2).map((s) => s.id),
    );
    expect(txt).toContain(p.evidence[1].id);
    expect(txt).toContain("outOfScope");
    expect(txt).not.toContain(p.sources[2].body);
  });
  it.each(["source", "evidence", "claim", "project"] as const)(
    "%sの更新で比較と要件を再確認対象にする",
    (kind) => {
      let p = approve(fixture());
      const s = p.sources[0],
        e = p.evidence[0],
        c = p.claims.find((c) => c.field === "features")!;
      const commands: Record<string, Command> = {
        source: {
          type: "source",
          sourceId: s.id,
          value: { ...exampleSources[0], body: "変更" },
        },
        evidence: {
          type: "evidence",
          evidenceId: e.id,
          value: {
            sourceId: e.sourceId,
            sourceType: e.sourceType,
            excerpt: "変更",
            verificationStatus: "verified",
          },
        },
        claim: {
          type: "claim",
          claimId: c.id,
          value: {
            ...input(c),
            value: "変更",
            verificationStatus: "unverified",
          },
        },
        project: {
          type: "project",
          value: {
            ...exampleProject,
            scope: "別の対象",
            outOfScope: "自動実行",
          },
        },
      };
      p = applyCommand(p, commands[kind]);
      expect(p.candidates[0].status).toBe("needs_review");
      expect(p.requirements[0].status).toBe("needs_review");
      expect(() => internalContract(p)).toThrow("承認済み");
      expect(() =>
        prompt(
          p,
          p.sources.map((s) => s.id),
        ),
      ).toThrow();
      if (kind !== "project")
        expect(() =>
          applyCommand(p, {
            type: "review",
            requirementId: "R1",
            status: "approved",
          }),
        ).toThrow("根拠不足");
    },
  );
  it("根拠不足・修正要求・却下を保存し、承認時刻と理由を記録する", () => {
    let p = approve(fixture());
    for (const status of [
      "needs_evidence",
      "needs_revision",
      "rejected",
      "approved",
    ] as const)
      p = applyCommand(p, {
        type: "review",
        requirementId: "R1",
        status,
        note: `${status}の理由`,
      });
    expect(p.reviews.slice(-4).map((r) => r.status)).toEqual([
      "needs_evidence",
      "needs_revision",
      "rejected",
      "approved",
    ]);
    expect(p.reviews.at(-1)?.revision).toBe(p.revision);
    expect(Number.isNaN(Date.parse(p.reviews.at(-1)!.at))).toBe(false);
    expect(markdown(p)).toContain("rejectedの理由");
  });
  it("v1 DBを原本・既存履歴を変更せず移行し、再起動でも移行を繰り返さない", () => {
    mkdirSync(".cache/tests", { recursive: true });
    const path = `.cache/tests/migration-${randomUUID()}.db`;
    const old = {
      ...newProject(exampleProject),
      schemaVersion: "1.0",
      evidence: undefined,
      claims: undefined,
      reviews: undefined,
      candidates: [],
      sources: [
        {
          ...exampleSources[0],
          id: "s1",
          revision: 1,
          hash: "original-hash",
          history: [],
        },
      ],
      requirements: [
        {
          id: "legacy",
          title: "旧要件",
          description: "元の記述",
          sourceIds: ["s1"],
          rationale: "",
          acceptance: ["保存"],
          tasks: ["実装"],
          priority: "high",
          status: "approved",
          sourceVersions: { s1: 1 },
        },
      ],
    };
    const raw = JSON.stringify(old);
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE projects(id TEXT PRIMARY KEY, revision INTEGER, data TEXT); CREATE TABLE revisions(project_id TEXT,revision INTEGER,data TEXT,PRIMARY KEY(project_id,revision)); PRAGMA user_version=1;",
    );
    db.prepare("INSERT INTO projects VALUES(?,?,?)").run(old.id, 1, raw);
    db.prepare("INSERT INTO revisions VALUES(?,?,?)").run(old.id, 1, raw);
    db.close();
    let store = new Store(path);
    const p = store.get(old.id);
    expect(p.schemaVersion).toBe("2.0");
    expect(p.revision).toBe(2);
    expect(p.sources[0].body).toBe(exampleSources[0].body);
    expect(p.requirements[0].status).toBe("needs_review");
    expect(p.evidence[0].verificationStatus).toBe("unverified");
    expect(p.requirements[0].claimIds).toHaveLength(1);
    expect(JSON.stringify(store.revision(old.id, 1))).toBe(raw);
    store.close();
    store = new Store(path);
    expect(store.get(old.id)).toEqual(p);
    expect(store.history(old.id)).toHaveLength(2);
    store.close();
  });
  it("内部Schemaを公開し、外部通信なしで保存・再読込・出力できる", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    const app = await createApp({ dbPath: ":memory:" });
    try {
      const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        headers,
        payload: exampleProject,
      });
      const p = created.json<Project>();
      const get = await app.inject({ url: `/api/projects/${p.id}`, headers });
      expect(get.json()).toEqual(p);
      expect(
        (
          await app.inject({ url: "/api/schemas/task-contract", headers })
        ).json().properties.kind.const,
      ).toBe("WorkbenchTaskContract");
      expect(
        (
          await app.inject({
            url: `/api/projects/${p.id}/export/markdown`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
