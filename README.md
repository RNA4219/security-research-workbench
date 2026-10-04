# Security Research Workbench

**特定製品のコードと依存関係を版ごとに診断し、人の判断、修正、修正版の再評価につなぐローカルアプリです。** 製品仕様と承認済み知識を使って指摘の影響を確認します。OSS採用前調査は補助機能です。

ローカル版のホームから管理下のGitリポジトリを製品として登録します。対象コミットを固定して実際のコードを解析し、前回の指摘が続いているか、修正版で観測されなくなったかを表示します。診断結果からコードの根拠を入れた照会へ進み、人の判定と修正証跡を残せます。[操作・設定・対象範囲](docs/product-diagnostics.md)と[要求・要件定義v4](docs/requirements.md)を参照してください。

初期のコード診断はJavaScript/TypeScriptのTLS・暗号関連の限定した静的ルール、依存診断はnpm lock v2/v3の既知情報照合です。未対応言語や解析失敗は未診断として残し、指摘が消えただけで修正完了にしません。未知の脆弱性を幅広く発見する能力や、実モデルの診断精度を実証したものではありません。

[継続診断のモック / サンプルを見る →](https://rna4219.com/open/security-research-workbench/) · [公開ツール一覧](https://rna4219.com/open/)

公開サイトの継続診断画面は、架空の製品・指摘・履歴を使ったモックです。初回診断、前回との比較、修正後の再評価、人の確認と知識承認の4場面を切り替えて見られます。実際の診断・保存・定期実行は行いません。実データを取得するOSS採用前調査は補助機能として開けます。

製品コードの診断、SQLiteへの案件保存、定期実行はローカル版で扱います。[知識・判定・修正の操作](docs/continuous-research.md)と[記事・要件・実装の対応](docs/logos-traceability.md)も参照できます。

## 補助機能：OSS採用前調査

導入候補を見つけたとき、GitHubの更新履歴、ライセンス、ロックファイル、脆弱性情報を一つずつ開いて転記する作業を引き受けます。資料や比較表を先に手入力する必要はありません。

| あなたがすること | アプリがすること | 返ってくるもの |
|---|---|---|
| 公開GitHub URLを入力して「このOSSを調べる」を押す | GitHubから保守情報と対象コミットのnpm lockfileを取得し、依存名・確定版をOSVと照合 | 採用前の確認事項、更新を検討する依存版と公開された修正境界、出典、未調査範囲 |

例えば、依存パッケージの版が公開アドバイザリと一致したら、その名前・版・ロックファイル内の場所・修正境界を並べます。archiveされていれば後継版や保守方法の確認を促し、ライセンスが識別できなければ利用条件の確認事項を出します。**取得できなかった情報は未確認として残します。**

結果は日時・コミット・出典付きで自動保存されます。「過去の調査」から再表示でき、Markdownとして持ち出せます。ChatGPTへの貼り付けやAPIキーは不要です。

<details>
<summary>実際の調査画面を見る</summary>

![このリポジトリの公開情報を調査した画面](docs/images/repository-research.png)

</details>

依存関係の照合は、現在**ルートの `npm-shrinkwrap.json` / `package-lock.json`（v2/3）**に対応しています。保守情報は言語を問いません。製品コードの問題、実行環境での影響、他の言語やサブディレクトリの依存関係は調査しません。採用の可否は、用途との適合と調査できなかった範囲も含めて判断してください。

## 公開版を使う

[公開版](https://rna4219.com/open/security-research-workbench/)は「モック / サンプル」と明記した継続診断の操作例から始まります。4つの場面は架空データの切り替えで、コードの取得や診断処理は実行しません。

実データでURLを調査する場合は、画面下部の「OSS採用前調査（実データ・補助機能）」を開いてください。インストール・APIキーは不要です。調査処理はブラウザで実行し、GitHubとOSVへ直接問い合わせます。履歴はこのブラウザに最新20件・合計2 MiBまで保存します。端末間の同期はありません。残したい結果はMarkdownでダウンロードしてください。

公開版はURLからのOSS調査に対応しています。利用条件や人の判断を案件として蓄積し、次回の調査と修正確認につなぐ場合は、次のローカル版を使います。

### ローカル版

Node.js 24を用意し、リポジトリで次を実行します。

```sh
npm ci
npm run build
npm start
```

1. http://127.0.0.1:4317 を開く。
2. 製品名、設定済みの管理下リポジトリ、対象ブランチまたはコミット、製品仕様を登録する。別の製品を扱う場合は[リポジトリ設定](docs/product-diagnostics.md#対象リポジトリを設定する)を行う。
3. 診断を開始し、固定コミット、コード位置付きの指摘、未診断範囲を読む。OSVへの依存名・版の送信は製品設定で明示的に許可した場合だけ行う。
4. 指摘から製品知識の照会へ進み、影響と対応方針を人が判断する。未承認の知識は自動で有効にしない。
5. 更新後の版で再診断する。修正版の結果と通常の回帰試験を確認し、担当者が修正完了を判断する。定期実行は設定で有効にした製品だけが対象。

従来のURL調査はホームの**「OSS採用前調査（補助）」**を開いて利用できます。そこから案件へ引き継ぐ操作も保持しています。

試すURLには、このリポジトリ `https://github.com/RNA4219/security-research-workbench` も使えます。結果は取得時点の公開情報によって変わります。

調査は最大45秒を目安に制限し、APIの利用制限や失敗を画面に表示します。GitHub認証は使わず、公開情報だけを取得します。OSVへ送るのは公開lockfileから抽出した依存名と版です。最大400パッケージ版を照合し、上限に達した場合は未調査範囲を表示します。

保存先はローカルの `.data/` で、Gitには含まれません。既存の資料取込・手動比較・要件レビューは、下部のプロジェクト作成と左のプロジェクト一覧から使えます。「サンプルで試す」は、未レビューの手動比較例を作成する機能です。

## 運用と詳しい仕様

Windowsでターミナルを閉じても使い続ける場合は、ビルド後にPowerShellで次を実行します。起動したシェルの終了後もバックグラウンドで動きます。PC再起動後は再びstartを実行してください。

```powershell
./scripts/local-server.ps1 start
./scripts/local-server.ps1 status
# 使用後に停止
./scripts/local-server.ps1 stop
```

この起動方法はポート4317とリポジトリ内の`.data/workbench.db`を使用します。ログとプロセス情報は`.cache/runtime/`に保存されます。接続エラー時はstatusで状態を確認し、停止していればstartを実行します。プロセスのID・起動時刻・実行ファイル・引数が一致する場合のみ、stopが停止を行います。

JSONの形式、レビュー状態、任意のagent-protocols・memx連携は以下の文書で説明します。個別CVEのOSV・CISA KEV・FIRST EPSS照会も、既存プロジェクトから利用できます。

## ドキュメント

- [URLからの調査仕様・対象範囲・テスト設計](docs/repository-research.md)
- [特定製品の継続診断：操作・対象登録・CI](docs/product-diagnostics.md)
- [特定製品の継続診断の受入計画](docs/manual-bb/product-diagnostics-plan.md)
- [特定製品の継続診断の実装・受入記録](docs/testing/2026-10-04-product-diagnostics.md)
- [継続調査・判断・修正確認の使い方とAPI](docs/continuous-research.md)
- [GitHub Pages版の構成・公開・検証](docs/pages.md)
- [自動調査の実測・検証結果](docs/testing/2026-10-04-repository-research.md)
- [要求・要件定義v4：特定製品の継続診断](docs/requirements.md)
- [Logos 3記事との対応・実装と検証](docs/logos-traceability.md)
- [追加要件の受入計画](docs/manual-bb/logos-plan.md)
- [Logos要件v3の実装・検証結果](docs/testing/2026-10-04-logos-workflow.md)
- [調査と設計判断](docs/research.md)
- [公開脆弱性知識の出典と読み方](docs/vulnerability-knowledge.md)
- [公開脆弱性知識の手動検証](docs/manual-bb/vulnerability-results.md)
- [APIとデータ形式](docs/interfaces.md)
- [検証記録](docs/acceptance.md)
- [テスト拡充とカバレッジ](docs/testing/2026-10-04-coverage.md)
- [v2時点の最終検証・QEG Go判定](docs/testing/2026-10-04-final-gate.md)
- [依存OSS・再ビルド](THIRD_PARTY_NOTICES.md)

## 開発コマンド

`npm run check` で型検査・テスト・ビルド、`npm run test:e2e` でブラウザテストを実行します。
ブラウザテスト前に `npx playwright install chromium` を実行してください。

`npm run test:quality` は単体・APIとブラウザーのカバレッジを統合し、全体の行・文・関数・分岐90%、ファイル別の行90%・分岐85%、変更行90%を下回ると失敗します。変更行の基準コミットを参照するため、shallow cloneでは先に`git fetch --unshallow`を実行してください。
結果は`.cache/coverage-combined/index.html`、`gate.json`、`lcov.info`、実行対象のハッシュ付き`run-identity.json`、`.cache/quality/*junit.xml`に保存されます。画面の計測用ビルドは`.cache/coverage-build`、一時DBと待受はテスト専用の4318番を使用します。通常の製品ビルドには計測を含めません。
テスト設計の範囲は[継続回帰テスト計画](docs/testing-plan.md)を参照してください。CIで同じカバレッジ条件と通常ビルドのブラウザーテストを実行し、レポートをartifactとして保存します。

## memx-resolver

任意連携です。ローカルで専用のresolverストアを起動し、`MEMX_URL=http://127.0.0.1:7766` を設定して本アプリを起動します。
画面から資料同期、検索、参照、鮮度確認を操作できます。未接続でも基本機能は利用可能です。

## 任意アダプターと旧版データ

agent-protocolsはoptionalDependenciesです。通常の`npm ci`では固定版を導入し、出力操作時だけ読み込みます。ビルド後に`npm ci --omit=dev --omit=optional --ignore-scripts`を行うと、アダプターなしの実行環境になります。`npm start`で基本機能を利用でき、内部タスク契約の出力に外部OSSは不要です。開発ビルドにはVite等のプラットフォーム依存パッケージが必要なため、通常の`npm ci`を使用してください。

旧DB（user_version=1）は起動時に版2へトランザクション内で移行します。既存のスナップショットと原文を保持し、旧出典参照は未検証のEvidence/Claimへ変換します。旧承認は再レビューが必要です。更新前にアプリを停止して`.data/`をバックアップしてください。旧バイナリは新版DBを開けません。

## 対象外

攻撃・脆弱性再現、任意コマンドや修正ワーカーの自動実行、ホスティング、複数ユーザー認証は含めません。コードの静的診断は[明示した範囲](docs/product-diagnostics.md#診断の範囲)に限ります。モデル接続は手動受渡しが既定です。ローカル・外部モデルは[接続設定](docs/continuous-research.md#モデル接続)と案件ごとの許可を設定した場合だけ利用し、自動では切り替えません。
TaskSeedはドラフトとして出力し、実行は利用者の既存ワークフローに委ねます。
