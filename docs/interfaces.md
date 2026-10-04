# API・データ形式 v2

APIは `http://127.0.0.1:4317/api`。すべてのAPI呼出には `X-Workbench: 1`、POSTには `Content-Type: application/json` が必要です。
ブラウザのOriginは接続先と一致する必要があります。Hostは設定ポートの `127.0.0.1` または `localhost` のみ。CORSは提供しません。

## 主要API

| Method | Path | 内容 |
|---|---|---|
| GET | `/config` | memx設定の有無 |
| POST | `/vulnerabilities/lookup` | `{cveId}`を指定した明示的な公開情報照会。OSV・KEV・EPSSの状態と、掲載元ごとの未検証資料下書き `sourceDrafts` を返す |
| GET/POST | `/projects` | 一覧・作成 |
| GET | `/projects/:id` | 現在のプロジェクト |
| POST | `/projects/:id/commands` | `{revision, command}`。古いrevisionは409 |
| POST | `/projects/:id/prompt` | `{sourceIds: [...]}`。プロンプト生成と原文保存 |
| GET | `/projects/:id/export/:format` | `markdown`, `json`, `contracts`, `agent-protocols` |
| GET | `/schemas/task-contract` | WorkbenchTaskContractのJSON Schema |
| GET | `/projects/:id/history` | 保存版の一覧 |
| GET | `/projects/:id/history/:revision` | その版のスナップショット |
| GET | `/projects/:id/artifacts` | 直近50件のプロンプト・AI回答・資料取込・出力記録。旧記録もDB内に保持 |
| POST | `/projects/:id/memx` | 明示的なresolver操作 |

入力Schemaの正本は `src/shared/model.ts`。不正入力は400と `{error, issues?: [{path,message}]}`。未存在は404、競合は409、サイズ超過は413、memx未設定は503、接続失敗は502です。

脆弱性照会はCVE ID形式だけを受け付け、固定の3提供元へ通信します。`osv`、`kev`、`epss` は `status`（`found`、OSVのみ`withdrawn`、`not_found`、`unavailable`）、`sourceUrl`、`fetchedAt`、取得できた場合の`sha256`、掲載時の`data`を返します。`sourceDrafts` は掲載のあった提供元だけを実際の取得URL・提供元の版で表す配列です。照会だけではDBを変更しません。明示保存時は既存の `sources` コマンドで1回のrevisionとして登録します。

## 資料JSON

```json
{
  "schemaVersion": "1.0",
  "sources": [{
    "title": "公開資料",
    "url": "https://example.org/document",
    "retrievedAt": "2026-10-03T00:00:00.000Z",
    "version": "1",
    "body": "# 調査\n\n資料の本文"
  }]
}
```

Markdown/textファイルは本文として読み込み、URL等をフォームで補います。ファイルは利用者が選んだものだけをブラウザで読み、サーバーに任意パスを渡しません。

## AI回答JSON

```json
{
  "schemaVersion": "1.0",
  "requirements": [{
    "id": "REQ-001",
    "title": "根拠の確認",
    "description": "要件から出典を参照できる",
    "priority": "medium",
    "sourceIds": [],
    "claimIds": [],
    "rationale": "利用者が必要と判断した",
    "acceptance": ["出典を画面で確認できる"],
    "tasks": ["出典参照を実装する"]
  }]
}
```

資料を根拠にする場合は画面・プロンプトにある確認済み主張のIDを `claimIds` に指定し、`sourceIds` は空にします。根拠のない利用者判断なら `rationale` が必要です。回答のschemaVersionは`1.0`または`2.0`を受け付けます。旧形式のsourceIds参照は未検証のClaim/Evidenceへ変換し、確認せず承認することはできません。
未知フィールド、重複・既存要件ID、不明な資料IDは拒否します。AIがレビュー状態を指定することはできません。本文解析に失敗した回答も原文を残します。

`command.type` は `project`, `source`, `sources`, `candidate`, `evidence`, `claim`, `candidate-review`, `reply`, `requirement`, `review`。
`source` は `sourceId`、`candidate` は `candidateId` の指定で更新。それ以外は新規登録です。資料更新は元の版を履歴へ退避し、参照する要件を再確認状態にします。
目的・利用者・制約・対象範囲・対象外の変更も比較と要件の再確認を求めます。要件編集は未レビューに戻ります。

## Evidence・Claim・レビュー

Evidenceのvalue: `{sourceId, sourceType: "official" | "report" | "other", excerpt, verificationStatus: "unverified" | "verified" | "disputed"}`。`evidenceId`を指定すると更新し、現在の資料revisionを記録します。

Claimのvalue: `{candidateId?, field, valueState: "known" | "unknown" | "empty", value, evidenceIds, verificationStatus}`。`claimId`指定で更新します。既知の値は非空、未確認・値なしは空文字を保持します。確認済み主張には、現在の資料版を参照する確認済みEvidenceが必要です。比較はcandidateIdとfieldの組を一意に保持します。

field: `category`, `purpose`, `features`, `license`, `release`, `commit`, `archived`, `issueActivity`, `integration`, `inputOutput`, `deployment`, `maintenance`, `requirement_basis`（比較に属さない旧要件の根拠）。

`review`は`requirementId`、`candidate-review`は`candidateId`、両方に`status`と任意の`note`を指定します。状態は`draft`, `approved`（レポートのacceptedに相当）, `needs_review`, `needs_evidence`, `needs_revision`, `rejected`。判断は日時・revision・理由とともに蓄積します。AI回答から状態を指定することはできません。

資料の更新はEvidenceとClaimを未検証に戻し、比較と関連要件をneeds_reviewにします。EvidenceやClaimの編集も依存する承認を失効させます。比較承認はすべての既知の値に検証済み根拠を要求し、プロンプトAPIでも比較承認と資料の選択漏れを検査します。要件承認は未確認値や未検証の主張を根拠として許可しません。

## エクスポート

- Markdown: 現在の比較・全要件・状態・主張・Evidence・出典URL・未確認事項・判断履歴。未承認も状態を付けて表示します。
- JSON: `schemaVersion: "2.0"` の現在のProjectと資料履歴。全体JSONは保存・外部処理用で、インポート形式ではありません。
- contracts: 承認済み要件だけを独立した`WorkbenchTaskContract`（schemaVersion 1.0）へ出力。objective、scope、outOfScope、requirements、acceptanceCriteria、sourceRefs、claims、evidenceを含み、内部Schemaで検証します。同じproject revisionでは同一内容です。
- agent-protocols: 上記内部契約から`IntentContract`と`TaskSeed`へ変換する任意アダプター。主張・Evidence・資料URL・版・ハッシュをdescriptionへ保持します。v2 Schemaと契約グラフを上流ライブラリで検証し、同一版では同じIDを出力します。未導入・非対応・変換失敗は503。内部契約の出力と保存状態は影響を受けません。

TaskSeedは `lifecycle: draft`。generationPolicyは上流の `deriveGenerationPolicy` の結果を使い、Workbenchは実行・有効化しません。

## memx

`MEMX_URL=http://127.0.0.1:7766` のように起動時だけ設定します。ブラウザから接続URLは変更できず、リダイレクトしません。
`action` は `sync`, `search`（query必須）, `chunks` / `ack`（sourceId必須）, `stale`。
syncはそのプロジェクトの登録資料だけを送信し、sourceごとの同期revisionを記録します。途中失敗した場合も再試行でき、既に成功した資料は送信しません。
searchはprojectのfeature_keysで絞り込み、他のストアを横断検索しません。chunks/ackは自分の同期済みdoc_idだけを使います。

## 保存と運用

SQLiteの `user_version=2`、WAL、revisionによる楽観ロックを使用。現在状態・変更ごとのスナップショット・プロンプトと回答原文を保持します。出力結果もartifactとして保存します。
利用者データは `.data/`。バックアップはアプリを停止してディレクトリ単位でコピーします。自動削除・自動アップロードはありません。
将来版DBは拒否します。版0を初期化し、版1は単一トランザクションで移行します。旧スナップショットは元の形式のまま保持し、現在状態に新しいrevisionを追加します。旧資料参照は未検証のEvidence/Claimへ変換し、旧承認要件はneeds_reviewへ変更します。失敗時はロールバックします。
