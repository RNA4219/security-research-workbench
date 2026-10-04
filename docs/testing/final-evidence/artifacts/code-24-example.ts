import type { CandidateInput, SourceInput } from "./model.js";
export const exampleProject = {
  title: "防御ツールの選定調査",
  objective:
    "依存関係の検査から修正管理までの構成を、公開OSSの根拠から要件化する。",
  audience: "小規模な開発チーム",
  constraints: "ローカル運用。既存OSSを優先し、スキャナの自動実行は行わない。",
};
export const exampleSources: SourceInput[] = [
  {
    title: "Trivy / 公開概要",
    url: "https://github.com/aquasecurity/trivy",
    version: "2026-10-03",
    retrievedAt: "2026-10-03T00:00:00.000Z",
    body: "# Trivy\n\n脆弱性、設定不備、secret、SBOMなどを扱うツール。Apache-2.0。\n\n出典: https://github.com/aquasecurity/trivy\n\nこれは公開READMEの要約です。最新版や細かい対応形式は採用時に再確認してください。",
  },
  {
    title: "OSV-Scanner / 公開概要",
    url: "https://github.com/google/osv-scanner",
    version: "2026-10-03",
    retrievedAt: "2026-10-03T00:00:00.000Z",
    body: "# OSV-Scanner\n\nOSVの情報を使う依存関係の脆弱性検査ツール。Apache-2.0。\n\n出典: https://github.com/google/osv-scanner\n\nこの要約は導入判断を確定するものではありません。",
  },
  {
    title: "DefectDojo / 公開概要",
    url: "https://github.com/DefectDojo/django-DefectDojo",
    version: "2026-10-03",
    retrievedAt: "2026-10-03T00:00:00.000Z",
    body: "# DefectDojo\n\n検出結果を集約し、脆弱性の管理を支援する製品。BSD-3-Clause。\n\n出典: https://github.com/DefectDojo/django-DefectDojo\n\n運用負担と導入規模は個別に評価してください。",
  },
];
export const exampleCandidates: Omit<CandidateInput, "sourceIds">[] = [
  {
    name: "Trivy",
    url: exampleSources[0].url,
    features: "依存関係・設定・SBOMを横断して確認",
    license: "Apache-2.0",
    maintenance: "公開リポジトリを2026-10-03確認。採用前に再確認。",
    decision: "consider",
    rationale: "横断的な検査の候補。初版は比較資料として扱う。",
  },
  {
    name: "OSV-Scanner",
    url: exampleSources[1].url,
    features: "OSVによる依存関係の脆弱性検査",
    license: "Apache-2.0",
    maintenance: "公開リポジトリを2026-10-03確認。採用前に再確認。",
    decision: "consider",
    rationale: "依存関係を中心にした小さな構成の候補。",
  },
  {
    name: "DefectDojo",
    url: exampleSources[2].url,
    features: "複数の検査結果を集約し修正を管理",
    license: "BSD-3-Clause",
    maintenance: "公開リポジトリを2026-10-03確認。採用前に再確認。",
    decision: "consider",
    rationale: "管理層の候補。サーバー運用負担を調べる必要がある。",
  },
];
