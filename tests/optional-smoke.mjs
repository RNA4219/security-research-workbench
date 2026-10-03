import assert from "node:assert/strict";
import { createApp } from "../dist/server/app.js";
const moduleName = "@rna4219/agent-protocols";
await assert.rejects(import(moduleName), /Cannot find/);
let outbound = 0;
globalThis.fetch = async () => {
  outbound++;
  throw new Error("offline");
};
const app = await createApp({ dbPath: ":memory:" });
const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
try {
  await app.listen({ port: 0, host: "127.0.0.1" });
  assert.equal(app.server.address().address, "127.0.0.1");
  const html = await app.inject({ url: "/", headers });
  assert.equal(html.statusCode, 200);
  const asset = html.body.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset);
  assert.equal((await app.inject({ url: asset, headers })).statusCode, 200);
  let result = await app.inject({
    method: "POST",
    url: "/api/projects",
    headers,
    payload: {
      title: "任意依存なし",
      objective: "根拠を持つ要件を作る",
      audience: "開発者",
      constraints: "ローカル",
      scope: "資料",
      outOfScope: "自動実行",
    },
  });
  assert.equal(result.statusCode, 201);
  let p = result.json();
  const cmd = async (command) => {
    result = await app.inject({
      method: "POST",
      url: `/api/projects/${p.id}/commands`,
      headers,
      payload: { revision: p.revision, command },
    });
    assert.equal(result.statusCode, 200, result.body);
    p = result.json();
  };
  await cmd({
    type: "source",
    value: {
      title: "試験資料",
      url: "https://example.org/spec",
      retrievedAt: "2026-10-03T00:00:00.000Z",
      version: "1",
      body: "ローカルで資料を編集する",
    },
  });
  await cmd({
    type: "evidence",
    value: {
      sourceId: p.sources[0].id,
      sourceType: "official",
      excerpt: "資料を編集する",
      verificationStatus: "verified",
    },
  });
  await cmd({
    type: "candidate",
    value: {
      name: "サンプル",
      url: "https://example.org",
      features: "資料編集",
      license: "未確認",
      maintenance: "未確認",
      decision: "consider",
      rationale: "比較",
      sourceIds: [],
    },
  });
  const {
    id: cid,
    revision,
    ...claim
  } = p.claims.find((c) => c.field === "features");
  await cmd({
    type: "claim",
    claimId: cid,
    value: {
      ...claim,
      evidenceIds: [p.evidence[0].id],
      verificationStatus: "verified",
    },
  });
  await cmd({
    type: "candidate-review",
    candidateId: p.candidates[0].id,
    status: "approved",
  });
  result = await app.inject({
    method: "POST",
    url: `/api/projects/${p.id}/prompt`,
    headers,
    payload: { sourceIds: [p.sources[0].id] },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(result.json().prompt.includes(cid));
  await cmd({
    type: "reply",
    raw: JSON.stringify({
      schemaVersion: "2.0",
      requirements: [
        {
          id: "R1",
          title: "編集",
          description: "資料を編集できる",
          sourceIds: [],
          claimIds: [cid],
          rationale: "",
          priority: "high",
          acceptance: ["保存できる"],
          tasks: ["編集画面を作る"],
        },
      ],
    }),
  });
  await cmd({
    type: "review",
    requirementId: "R1",
    status: "approved",
    note: "確認",
  });
  for (const format of ["json", "markdown", "contracts"]) {
    result = await app.inject({
      url: `/api/projects/${p.id}/export/${format}`,
      headers,
    });
    assert.equal(result.statusCode, 200, result.body);
    if (format === "contracts") {
      assert.equal(result.json().kind, "WorkbenchTaskContract");
      assert.equal(result.json().evidence.length, 1);
    }
  }
  result = await app.inject({
    url: `/api/projects/${p.id}/export/agent-protocols`,
    headers,
  });
  assert.equal(result.statusCode, 503, result.body);
  result = await app.inject({
    method: "POST",
    url: `/api/projects/${p.id}/memx`,
    headers,
    payload: { action: "sync" },
  });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(
    (await app.inject({ url: `/api/projects/${p.id}`, headers })).json(),
    p,
  );
  assert.equal(outbound, 0);
  console.log(
    "PASS: optional dependencies absent; loopback, edit, review, prompt, all core exports, adapter failure isolation, zero outbound requests",
  );
} finally {
  await app.close();
}
