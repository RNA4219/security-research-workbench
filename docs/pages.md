# GitHub Pages版

公開URL: https://rna4219.com/open/security-research-workbench/

公開版は[要求・要件定義v4](requirements.md)のUR-01（補助機能）の入口を提供する。特定製品のコード診断FR-32〜37と、製品知識・判断管理FR-17〜31は[ローカル版](product-diagnostics.md)で扱う。以下の公開版の動作確認やテスト合格は、これらのローカル機能の合格証跡ではない。ローカル実行機能や非公開知識を静的公開資産へ含めない。

`/open/` の公開ツール一覧から「OSSの採用前調査」を開く。URL調査、確認事項、依存照合、過去の調査、Markdown出力をブラウザで利用できる。ローカルサーバーを起動する必要はない。

## 構成

- `npm run build:pages` で `dist/pages/` にHTML・JS・CSS・ライセンスを生成する。baseは `/open/security-research-workbench/`。
- サイトのGitHub Pagesワークフローは、この公開リポジトリの固定コミットをcheckoutしてビルドする。生成物だけをサイトの `public/open/security-research-workbench/` へ配置する。
- `src/research/` はローカル版と公開版で共有する。バイト列・UTF-8・SHA-256にはWeb標準APIを使用する。
- 公開版は `/api`、SQLite、localhostに接続しない。GitHub REST APIとOSVへ `credentials: omit`、リファラーなしで通信する。公開リポジトリだけを対象にする。
- GitHub APIの認証なし利用制限や通信失敗は画面へ表示する。OSVを取得できない場合は未照合として残す。
- 資料整理・要件レビュー、memx連携、個別CVEの資料化はローカル版で提供する。

## 保存

localStorageのキーは `security-research-workbench:reports:v1`。最新20件・UTF-8のJSONで2 MiBまで保持し、超過時は古い結果から削除する。破損した保存データはスキーマで拒否し、自動で上書きしない。利用者は画面下部からこのツールの履歴だけを削除できる。

保存不能でも取得結果とMarkdown出力は利用でき、「未保存」と表示する。履歴はブラウザ・サイトごとに分かれ、別端末との共有はない。サイトデータ消去やプライベート閲覧の終了に備え、必要な結果は出力して保管する。

## 検証

2026-10-04、公開用サブパスを使って以下を確認した。

- 型検査、通常ビルド、Pagesビルドが成功。
- 単体・API 117件、ローカル版ブラウザ20件、Pages版ブラウザ4件が成功。
- Pages版では調査→履歴→再読込→Markdown出力→履歴削除、保存不能、履歴破損、API制限、OSV通信失敗、390px幅を確認。通信先の固定応答を使った回帰テストであり、外部APIの可用性を保証するものではない。
- 全体の統合カバレッジは行98.71%、文98.22%、関数98.00%、分岐94.92%。既存の基準を維持したまま合格。

再検証は `npm run build:pages` と `npm run test:pages`。`npm run test:quality` はローカル版とPages版のブラウザ計測を両方含む。
