import type {
  ProjectInput,
  SourceInput,
  CandidateInput,
} from "../shared/model.js";
import { reviewLabels } from "./provenance.js";
export type Tab =
  | "workflow"
  | "vulnerability"
  | "sources"
  | "evidence"
  | "compare"
  | "requirements"
  | "export"
  | "history"
  | "settings";
export const tabs: [Tab, string, string][] = [
  ["workflow", "↻", "調査・判断・修正"],
  ["vulnerability", "◇", "脆弱性知識"],
  ["sources", "01", "調査資料"],
  ["evidence", "◎", "根拠と主張"],
  ["compare", "02", "OSS比較"],
  ["requirements", "03", "要件とレビュー"],
  ["export", "04", "出力"],
  ["history", "↺", "履歴"],
  ["settings", "⚙", "設定・連携"],
];
export const labels = {
  ...reviewLabels,
  draft: "未レビュー",
  approved: "承認済み",
  needs_review: "再確認が必要",
  consider: "検討中",
  adopt: "採用",
  reject: "見送り",
};
export const blankProject: ProjectInput = {
  title: "",
  objective: "",
  audience: "",
  constraints: "",
};
export const blankSource = (): SourceInput => ({
  title: "",
  url: "",
  version: "1",
  retrievedAt: new Date().toISOString(),
  body: "",
});
export const blankCandidate: CandidateInput = {
  name: "",
  url: "",
  features: "",
  license: "未確認",
  maintenance: "未確認",
  decision: "consider",
  rationale: "",
  sourceIds: [],
};
