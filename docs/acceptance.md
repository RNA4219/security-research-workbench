# 検証記録

## 実施環境と対象

- Windows / Node.js 24.15.0
- agent-protocols公開commit: `c3d64bc3b8b7e6549bd30d9d176c954ae785039a`
- memx-resolver公開commit: `f91848160bf55819cfce5cf4c53ffc8e9353a55a`
- 実データを使わず、公開資料の要約と人工的な入力だけを使用。

## 要件と証跡

| 要件 | 検証 |
|---|---|
| FR-01 プロジェクト保存 | Storeを閉じて再接続し、全フィールドとrevisionを比較。新規作成はE2Eでも確認 |
| FR-02 資料取込 | E2EでMarkdownファイル・資料JSON・テキスト入力を保存し、画面で確認 |
| FR-03 重複・履歴・再確認 | 同一資料の再取込、更新履歴、承認失効を単体テスト。E2Eで更新後・再読込後の状態を確認 |
| FR-04 OSS比較 | サンプル3製品を表示。追加・出典選択・採否編集をE2Eで確認 |
| FR-05 プロンプト | 選択資料のみ含むこと、回答Schemaの存在、画面での生成を確認 |
| FR-06 回答取込 | 不正JSON、重複・既存ID、不明出典、未知フィールド、根拠欠落を拒否。元回答は保存 |
| FR-07 要件レビュー | 取込時draft、明示的承認、編集・資料更新・制約変更時の再確認を確認 |
| FR-08 エクスポート | JSONと保存状態の一致、Markdownの出典、有効なv2契約とグラフ、同一版の決定的出力、ダウンロードを確認 |
| FR-09 memx | 実サーバーでsync / 冪等再sync / search / chunks / ack / fresh / stale / project分離を確認 |
| FR-10 導入 | 同梱パッケージとlockfileでの新規clone検証・CI結果は下記の完了確認で記録 |

## セキュリティ・障害動作

Host/Origin/必須ヘッダー制限、2MiB制限、http/https限定、未知DB版の拒否、保存競合の409をテスト。
MarkdownのHTMLと外部画像を描画しないことをE2Eで確認。memx未設定・接続失敗はプロジェクトを破壊しない。
サービスはループバックにのみbindする。一般公開サーバーとしての認証・複数ユーザー分離は提供しない。

## 実行コマンド

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
npm audit --omit=dev
```

実memx連携テストは、空の専用ストアを用意して次のように実行する（PowerShell）。

```powershell
# 別ターミナル: 公開memxをビルドし、空の作業ディレクトリで起動
mem api serve --addr 127.0.0.1:17766 --resolver resolver.db

# 本アプリのディレクトリ
$env:MEMX_URL='http://127.0.0.1:17766'
npm run test:memx
```

## 完了確認

- 実装commit `0d2faba8cc356f5c96f2bc28b316b95d2527cd8d` を公開GitHubから新規cloneし、`npm ci`、型検査、11件の単体/APIテスト、ビルド、4件のE2Eが成功。cloneのGit差分はなし。
- [GitHub CI run 37124427474](https://github.com/RNA4219/security-research-workbench/actions/runs/37124427474) は全step成功。Ubuntu / Node.js 24でも同じ検証が通った。
- `npm audit` および `npm audit --omit=dev` は検証時点で0件。
- 公開memxの上記固定commitをビルドし、専用ストアで `npm run test:memx` 相当の実連携テストが成功。
- アプリ内ブラウザでサンプルの資料・要件レビュー画面を確認。E2Eでは390px幅の入口も確認。
- 公開対象に実データ・環境変数ファイル・開発cacheがないことを確認。依存tgzのSHA256はTHIRD_PARTY_NOTICESと一致。

Agent_toolsのREADME・HUB・案内スキル・repo map、およびworkflow-cookbookの既存責務台帳にローカル登録済み。これらは本リポジトリの配布物ではない。
