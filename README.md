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

## 使い方

1. プロジェクトの目的・利用者・制約を入力します。
2. 公開資料のMarkdown、テキスト、版付きJSONを取り込み、URL・取得日・版を記録します。
3. OSS候補を比較し、選択した資料でChatGPT用プロンプトを作ります。
4. ChatGPT等にプロンプトを渡し、返されたJSONを取り込みます。取込直後は必ず未レビューです。
5. 要件・受入条件を編集し、人が承認します。資料更新後は再確認が必要です。
6. Markdown、全体JSON、agent-protocols v2契約を出力します。

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

## 対象外

自動スキャン、攻撃・脆弱性再現、AI API課金、ワーカー自動実行、ホスティング、複数ユーザー認証は初版に含めません。
TaskSeedはドラフトとして出力し、実行は利用者の既存ワークフローに委ねます。
