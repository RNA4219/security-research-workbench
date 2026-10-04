import type { ResearchReport } from "../src/shared/repository-research.js";
import { newWorkflow } from "../src/server/workflow-domain.js";
import type { WorkflowScope } from "../src/shared/workflow.js";

export const scope: WorkflowScope = {
  target: "https://github.com/example/widget",
  version: "abc1234",
  purpose: "採用前レビュー",
  ownership: "組織が管理するリポジトリ",
  allowedProviderIds: ["manual", "local-model", "cloud-test"],
  allowedMethods: [
    "static-review",
    "known-issue-match",
    "normal-function-test",
    "regression-test",
    "manual-review",
  ],
};
export const workflow = () => newWorkflow("project-1", scope);

export const report = (
  id = "report-1",
  commit: string | null = "abc1234",
): ResearchReport => ({
  id,
  collectedAt: "2026-10-04T00:00:00.000Z",
  repository: {
    name: "example/widget",
    url: "https://github.com/example/widget",
    description: "sample project",
    license: "MIT",
    archived: false,
    defaultBranch: "main",
    commit,
    committedAt: "2026-10-03T00:00:00.000Z",
    latestRelease: "1.2.0",
    releaseStatus: "found",
  },
  dependencies: {
    status: "complete",
    lockfile: "package-lock.json",
    total: 1,
    queried: 1,
    skipped: 0,
    findings: [
      {
        name: "sample-package",
        version: "1.0.0",
        paths: ["node_modules/sample-package"],
        development: false,
        advisoryId: "GHSA-0000-0000-0000",
        summary: "A public advisory summary",
        url: "https://example.test/advisory",
        fixes: ["1.1.0"],
        detailStatus: "available",
      },
    ],
    withdrawn: 0,
  },
  actions: [],
  limitations: [],
  sources: [
    {
      label: "repository",
      url: "https://github.com/example/widget",
      sha256: "a".repeat(64),
    },
  ],
});
