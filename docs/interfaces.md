# API・データ形式 v1

APIは `http://127.0.0.1:4317/api`。すべてのAPI呼出には `X-Workbench: 1`、POSTには `Content-Type: application/json` が必要です。
ブラウザのOriginは接続先と一致する必要があります。Hostは設定ポートの `127.0.0.1` または `localhost` のみ。CORSは提供しません。

## 主要API

| Method | Path | 内容 |
|---|---|---|
| GET | `/config` | memx設定の有無 |
| GET/POST | `/projects` | 一覧・作成 |
| GET | `/projects/:id` | 現在のプロジェクト |
| POST | `/projects/:id/commands` | `{revision, command}`。古いrevisionは409 |
| POST | `/projects/:id/prompt` | `{sourceIds: [...]}`。プロンプト生成と原文保存 |
| GET | `/projects/:id/export/:format` | `markdown`, `json`, `contracts` |
| GET | `/projects/:id/history` | 保存版の一覧 |
| GET | `/projects/:id/history/:revision` | その版のスナップショット |
| GET | `/projects/:id/artifacts` | 直近50件のプロンプト・AI回答原文 |
| POST | `/projects/:id/memx` | 明示的なresolver操作 |

入力Schemaの正本は `src/shared/model.ts`。不正入力は400と `{error, issues?: [{path,message}]}`。未存在は404、競合は409、サイズ超過は413、memx未設定は503、接続失敗は502です。

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
    "rationale": "利用者が必要と判断した",
    "acceptance": ["出典を画面で確認できる"],
    "tasks": ["出典参照を実装する"]
  }]
}
```

資料を根拠にする場合は画面・プロンプトにある資料IDを `sourceIds` に指定します。空なら `rationale` が必要です。
未知フィールド、重複・既存要件ID、不明な資料IDは拒否します。AIがレビュー状態を指定することはできません。本文解析に失敗した回答も原文を残します。

`command.type` は `project`, `source`, `sources`, `candidate`, `reply`, `requirement`, `review`。
`source` は `sourceId`、`candidate` は `candidateId` の指定で更新。それ以外は新規登録です。資料更新は元の版を履歴へ退避し、参照する要件を再確認状態にします。
目的・利用者・制約の変更も要件の再確認を求めます。要件編集は未レビューに戻ります。

## エクスポート

- Markdown: 現在の比較・全要件・レビュー状態・出典一覧。
- JSON: `schemaVersion: "1.0"` の現在のProjectと資料履歴。全体JSONは保存・外部処理用で、初版のインポート形式ではありません。
- contracts: 承認済み要件だけを `IntentContract` と `TaskSeed` の配列へ変換。出典URL・版・ハッシュをdescriptionへ保持します。v2 Schemaと契約グラフを上流ライブラリで検証し、同一版では同じIDを出力します。

TaskSeedは `lifecycle: draft`。generationPolicyは上流の `deriveGenerationPolicy` の結果を使い、Workbenchは実行・有効化しません。

## memx

`MEMX_URL=http://127.0.0.1:7766` のように起動時だけ設定します。ブラウザから接続URLは変更できず、リダイレクトしません。
`action` は `sync`, `search`（query必須）, `chunks` / `ack`（sourceId必須）, `stale`。
syncはそのプロジェクトの登録資料だけを送信し、sourceごとの同期revisionを記録します。途中失敗した場合も再試行でき、既に成功した資料は送信しません。
searchはprojectのfeature_keysで絞り込み、他のストアを横断検索しません。chunks/ackは自分の同期済みdoc_idだけを使います。

## 保存と運用

SQLiteの `user_version=1`、WAL、revisionによる楽観ロックを使用。現在状態・変更ごとのスナップショット・プロンプトと回答原文を保持します。
利用者データは `.data/`。バックアップはアプリを停止してディレクトリ単位でコピーします。自動削除・自動アップロードはありません。
将来版DBは拒否します。版0の新規DBを初期化できます。破壊的な移行は初版にありません。
