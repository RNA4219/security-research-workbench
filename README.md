# Security Research Workbench

公開OSSの調査を、根拠付き比較・要件・実装タスクへつなぐローカルWebアプリ。

日本語UI / MIT / Node.js 24 / React / Fastify / SQLite。

## 開発

```sh
npm ci
npm run build
npm start
```

http://127.0.0.1:4317 を開きます。APIキーは不要です。データは `.data/` に保存され、Gitには含まれません。

Windowsでターミナルを閉じても使い続ける場合は、ビルド後にPowerShellで次を実行します。起動したシェルの終了後もバックグラウンドで動きます。PC再起動後は再びstartを実行してください。

```powershell
./scripts/local-server.ps1 start
./scripts/local-server.ps1 status
# 使用後に停止
./scripts/local-server.ps1 stop
```

この起動方法はポート4317とリポジトリ内の`.data/workbench.db`を使用します。ログとプロセス情報は`.cache/runtime/`に保存されます。接続エラー時はstatusで状態を確認し、停止していればstartを実行します。プロセスのID・起動時刻・実行ファイル・引数が一致する場合のみ、stopが停止を行います。

## 使い方

1. プロジェクトの目的・利用者・制約を入力します。
2. 公開資料のMarkdown、テキスト、版付きJSONを取り込み、URL・取得日・版を記録します。
3. 「根拠と主張」で資料の抜粋・要約（Evidence）を登録し、出典と照合して確認済みにします。
4. OSS比較の各項目（Claim）へEvidenceを関連付け、既知の値・未確認・値なしを区別します。既知の値を確認し、比較を承認してからプロンプトを作ります。
5. ChatGPT等にプロンプトを渡し、返されたJSONを取り込みます。取込直後は必ず未レビューです。
6. 要件・受入条件・主張参照を編集し、人が承認します。根拠不足・修正要求・却下も理由付きで記録できます。
7. Markdown、全体JSON、Workbench独自のタスク契約を出力します。agent-protocols v2への変換は任意です。

要件→Claim→Evidence→資料URLを辿れます。資料・根拠・主張の変更で関連する承認が失効します。サンプルも自動承認されません。

ソースコードの公開と、アプリ内資料の公開は別です。資料は自動送信・自動公開されません。

## ドキュメント

- [要件定義](docs/requirements.md)
- [調査と設計判断](docs/research.md)
- [APIとデータ形式](docs/interfaces.md)
- [検証記録](docs/acceptance.md)
- [依存OSS・再ビルド](THIRD_PARTY_NOTICES.md)

## 開発コマンド

`npm run check` で型検査・テスト・ビルド、`npm run test:e2e` でブラウザテストを実行します。
ブラウザテスト前に `npx playwright install chromium` を実行してください。

## memx-resolver

任意連携です。ローカルで専用のresolverストアを起動し、`MEMX_URL=http://127.0.0.1:7766` を設定して本アプリを起動します。
画面から資料同期、検索、参照、鮮度確認を操作できます。未接続でも基本機能は利用可能です。

## 任意アダプターと旧版データ

agent-protocolsはoptionalDependenciesです。通常の`npm ci`では固定版を導入し、出力操作時だけ読み込みます。ビルド後に`npm ci --omit=dev --omit=optional --ignore-scripts`を行うと、アダプターなしの実行環境になります。`npm start`で基本機能を利用でき、内部タスク契約の出力に外部OSSは不要です。開発ビルドにはVite等のプラットフォーム依存パッケージが必要なため、通常の`npm ci`を使用してください。

旧DB（user_version=1）は起動時に版2へトランザクション内で移行します。既存のスナップショットと原文を保持し、旧出典参照は未検証のEvidence/Claimへ変換します。旧承認は再レビューが必要です。更新前にアプリを停止して`.data/`をバックアップしてください。旧バイナリは新版DBを開けません。

## 対象外

自動スキャン、攻撃・脆弱性再現、AI API課金、ワーカー自動実行、ホスティング、複数ユーザー認証は初版に含めません。
TaskSeedはドラフトとして出力し、実行は利用者の既存ワークフローに委ねます。
