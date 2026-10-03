import assert from "node:assert/strict";
import { createApp } from "../dist/server/app.js";
import { exampleProject, exampleSources } from "../dist/shared/example.js";

if (!process.env.MEMX_URL)
  throw new Error("専用のmemxストアを起動してMEMX_URLを設定してください");
const app = await createApp({
  dbPath: ":memory:",
  memxUrl: process.env.MEMX_URL,
});
const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
async function post(url, payload) {
  const r = await app.inject({ method: "POST", url, headers, payload });
  assert.equal(r.statusCode < 300, true, r.body);
  return r.json();
}
try {
  let p = await post("/api/projects", exampleProject);
  const command = async (command) => {
    p = await post(`/api/projects/${p.id}/commands`, {
      revision: p.revision,
      command,
    });
  };
  const memx = (body) => post(`/api/projects/${p.id}/memx`, body);
  await command({ type: "source", value: exampleSources[0] });
  assert.equal((await memx({ action: "sync" })).synced, 1);
  assert.equal((await memx({ action: "sync" })).synced, 0);
  const chunks = await memx({ action: "chunks", sourceId: p.sources[0].id });
  assert.ok(chunks.chunks.length > 0);
  await memx({ action: "ack", sourceId: p.sources[0].id });
  assert.equal((await memx({ action: "stale" })).status, "fresh");
  const search = await memx({ action: "search", query: "Trivy" });
  assert.ok(search.results.length > 0);
  await command({
    type: "source",
    sourceId: p.sources[0].id,
    value: {
      ...exampleSources[0],
      version: "2",
      body: "# Trivy\n\n公開資料の更新をテスト",
    },
  });
  await memx({ action: "sync" });
  assert.equal((await memx({ action: "stale" })).status, "stale");
  const other = await post("/api/projects", {
    ...exampleProject,
    title: "別プロジェクト",
  });
  const isolated = await post(`/api/projects/${other.id}/memx`, {
    action: "search",
    query: "Trivy",
  });
  assert.equal(isolated.results?.length ?? 0, 0);
  console.log(
    "PASS: live memx sync / idempotency / chunks / ack / fresh / search / stale / project isolation",
  );
} finally {
  await app.close();
}
