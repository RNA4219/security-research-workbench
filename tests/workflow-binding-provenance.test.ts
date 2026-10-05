import { expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { exampleProject } from "../src/shared/example.js";
import type { WorkflowState } from "../src/shared/workflow.js";
import { scope } from "./workflow-fixtures.js";

it("公開APIは自己申告のコード対応情報を拒否し、通常の手動観測は保持する", async () => {
  const app = await createApp({
    dbPath: ":memory:",
    staticRoot: ".cache/absent-static",
  });
  const headers = {
    host: "127.0.0.1:4317",
    "x-workbench": "1",
    "content-type": "application/json",
  };
  const post = (url: string, value: unknown) =>
    app.inject({
      method: "POST",
      url,
      headers,
      payload: JSON.stringify(value),
    });
  try {
    const created = await post("/api/projects", exampleProject);
    expect(created.statusCode).toBe(201);
    const project = created.json<{ id: string }>();
    const base = `/api/projects/${project.id}/workflow`;
    const read = async () =>
      (await app.inject({ url: base, headers })).json<WorkflowState>();
    let state = await read();
    const commit = "a".repeat(40);
    const scoped = await post(`${base}/commands`, {
      revision: state.revision,
      command: { type: "scope", value: { ...scope, version: commit } },
    });
    expect(scoped.statusCode).toBe(200);
    state = scoped.json();
    const document = await post(`${base}/commands`, {
      revision: state.revision,
      command: {
        type: "document",
        value: {
          title: "手動の確認資料",
          body: "担当者の観測記録",
          classification: "local",
        },
      },
    });
    expect(document.statusCode).toBe(200);
    state = document.json();
    const source = state.documents[0]!;
    const observation = {
      type: "finding-observation",
      fingerprint: "manual-observation",
      targetVersion: commit,
      observation: "担当者の観測記録",
      sourceRefs: [
        { docId: source.id, revision: source.revision, excerpt: source.body },
      ],
      contextHash: "b".repeat(64),
      evidenceHash: "c".repeat(64),
    };
    const rejected = await post(`${base}/commands`, {
      revision: state.revision,
      command: {
        ...observation,
        modelSourceBinding: {
          version: 1,
          targetVersion: commit,
          snapshotManifestHash: "d".repeat(64),
          path: "unverified.ts",
          line: 999,
          originalTextHash: "e".repeat(64),
          category: "authorization",
          severity: "high",
          specRefIds: [],
          falsePositiveCandidate: false,
          uncertaintyLevel: "low",
        },
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("手動では登録できません");
    expect(await read()).toEqual(state);
    const accepted = await post(`${base}/commands`, {
      revision: state.revision,
      command: observation,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const finding = accepted.json<WorkflowState>().findings[0]!;
    expect(finding.observation).toBe("担当者の観測記録");
    expect(
      finding.observationHistory.at(-1)?.modelSourceBinding,
    ).toBeUndefined();
  } finally {
    await app.close();
  }
});
