# 検証記録

## manual-bbによる設計・画面試験（2026-10-04）

[事前設計](manual-bb/2026-10-04-plan.md)に従って専用DBで手動12ケースすべて合格。根拠の複数参照、比較承認ゲート、資料更新による失効、競合、通信断時の入力保持と明示再保存、連携障害を実画面で確認した。UIのバージョン表記を修正し、23単体/API・5E2E・型検査・ビルドが成功。単体/APIによる変更箇所の行coverageは64.94%（E2E/手動は未合算）で75%条件に届かないため、正式standard Gateはno_go。計画した画面テストは完了している。詳細と画像は[実行結果](manual-bb/2026-10-04-results.md)を参照。

## Windowsローカル起動の復旧（2026-10-04）

画面に`Failed to fetch`が出た際、4317の待受がなく、healthzへの接続が拒否されていた。バックグラウンド起動用の` scripts/local-server.ps1`を追加し、起動用シェルが終了した後のstatus・起動の冪等性・stop/start・既存プロジェクトの読込みを実際に確認した。PIDの再利用で別プロセスを止めないよう、起動時刻・実行ファイル・引数も照合する。

取得・保存・ダウンロードの通信エラーを日本語の再起動案内へ置換し、自動再送しないことを`tests/client-api.test.ts`で検証した。型検査とproduction buildも成功。自動ログイン時起動やWindowsサービスの登録は行っていない。

## v0.2：Deep Research不足要件の検証（2026-10-04）

| 要件 | 証跡 |
|---|---|
| FR-11 根拠グラフ | `tests/provenance.test.ts`で要件→Claim→複数Evidence→URLの閉じた参照を確認。E2EでEvidenceから関連要件への逆引き、項目から複数根拠の表示、Markdownへの全URL保持を確認 |
| FR-12 比較状態 | 同じ項目のknown/unknown/emptyを保存。未確認に値を混ぜる不正入力、根拠のないverified、未知・重複参照を拒否。E2Eで未確認と値なしを切替え、再描画と出力を確認 |
| FR-13 比較承認 | 未承認の比較からのプロンプト生成と、複数Evidenceの資料選択漏れを拒否。根拠確認→比較承認→プロンプト生成をE2Eで実行 |
| FR-14 独立契約 | WorkbenchTaskContractのSchema検証・決定的出力・根拠保持を検証。`tests/optional-smoke.mjs`で両アダプター不在の別インストールから、ループバック起動・UI配信・編集・レビュー・プロンプト・Core全出力・失敗後の状態保持を確認。外部fetchは0件 |
| FR-15 レビュー・移行 | 根拠不足・修正要求・却下・承認の理由と日時を記録。資料・Evidence・Claim・前提の変更による失効を検証。旧DBの原文と全既存revisionを変更せず移行し、再起動時の冪等性を確認 |

ローカルで型検査、22件の単体/APIテスト、5件のE2E、production buildが成功。実際に使用していたv1 DBもバックアップ後に移行し、全資料本文・hash・旧スナップショットの一致と`/healthz`を確認した。比較画面のスクリーンショットを目視し、390px幅でもページ全体が横にはみ出さないことを検証した。

任意依存なしの検証は、ビルド済みdist・package/lockfile・vendor・smoke scriptを別ディレクトリへ配置し、`npm ci --omit=dev --omit=optional --ignore-scripts`後に実行。親ディレクトリのnode_modulesへ解決されない場所を使用した。非対応agent-protocols APIのエラーも別テストで503に隔離し、内部契約と保存状態が変わらないことを確認した。

CIは通常構成と任意runtime依存を省いた構成の2通りを検証する。既存v0.1の実memx確認記録は以下に保持する。今回memxの通信処理自体は変更していない。

## v0.1の検証記録

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
