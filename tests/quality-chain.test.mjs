import { test, expect } from "vitest";
import { validateEvidenceInputs } from "../scripts/qeg-package.mjs";

function snapshot() {
  const head = "a".repeat(40);
  return {
    identity: { head, dirty: false },
    sourceHash: "b".repeat(64),
    requirements: { source: { sha256: "b".repeat(64) } },
    findings: {
      repo: { revision: head.slice(0, 12), dirty: false },
      findings: [],
    },
    readiness: { repo: { revision: head.slice(0, 12) }, status: "passed" },
    hate: [
      {
        commit_sha: head,
        payload: { canonical_test_id: "test-a", status: "passed" },
      },
    ],
    precheck: { commit_sha: head, payload: { decision: "eligible" } },
    manual: {
      head,
      results: [
        {
          tc_id: "TC-1",
          result: "pass",
          actual: ["observed"],
          attachments: ["observation.txt"],
        },
      ],
    },
    cases: { manual_cases: [{ tc_id: "TC-1" }] },
    coverage: {
      failures: [],
      changed: { pct: 95 },
      metrics: { lines: { pct: 95 } },
    },
  };
}

test("同一ビルドの完全な証跡だけを受け付ける", () => {
  expect(() => validateEvidenceInputs(snapshot())).not.toThrow();
});

test.each([
  [
    "古い手動結果",
    (s) => {
      s.manual.head = "c".repeat(40);
    },
  ],
  [
    "改変された要件",
    (s) => {
      s.sourceHash = "c".repeat(64);
    },
  ],
  [
    "自動テスト失敗",
    (s) => {
      s.hate[0].payload.status = "failed";
    },
  ],
  [
    "手動ケース不足",
    (s) => {
      s.manual.results = [];
    },
  ],
  [
    "静的指摘未解決",
    (s) => {
      s.findings.findings = [{ severity: "high" }];
    },
  ],
  [
    "低カバレッジ",
    (s) => {
      s.coverage.changed.pct = 89;
    },
  ],
  [
    "実行後の未確定変更",
    (s) => {
      s.identity.dirty = true;
    },
  ],
  [
    "HATEの重複結果",
    (s) => {
      s.hate.push(s.hate[0]);
    },
  ],
])("%sを拒否してGateの成功を捏造しない", (_name, mutate) => {
  const input = snapshot();
  mutate(input);
  expect(() => validateEvidenceInputs(input)).toThrow();
});
