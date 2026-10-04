# 最終検証記録（2026-10-04）

**結果: Go。** RanD → Code-to-gate → HATE → manual-bb → QEG の接続、最終判定、record保存まで完了した。

対象アプリのビルドは `c3d96d55126f8982b78818989f8456d7d6c280b0`。Windows / Node 24 / Chromium、専用DB・4320番で確認した。以後の変更は証跡変換と文書のみで、アプリのソースは変更していない。変換ツールはアプリとは別のproducerとして、実行時のソースSHA256を記録している。

## Chain status / artifact map

| 工程 | 状態 | 実行結果・原本 |
|---|---|---|
| RanD | ran | 現行要件15件を抽出・監査。[要件](final-evidence/artifacts/rand-document.json) / [audit](final-evidence/artifacts/rand-audit.json) |
| Code-to-gate | ran | 指摘0件、readiness passed。[readiness](final-evidence/artifacts/ctg-readiness.json) |
| HATE | ran | 自動83件をJUnit/LCOVから正規化、eligible。[正規化結果](final-evidence/artifacts/hate-test-results.ndjson) / [precheck](final-evidence/artifacts/hate-precheck.json) |
| manual-bb | ran | ケース・モデルのハッシュを照合。P0 4/4、必須観点100%、standard Go。[観測](final-evidence/manual-observations.json) / [原本Gate](final-evidence/manual-gate-original.json) |
| QEG | ran | standard Go、DQ 0、blocker 0、waiver 0。[Gate](final-evidence/gate-verdict.json) / [record](final-evidence/quality-evidence-record.md) |

QEGは単体/API/変換検査70件、E2E 13件を各suiteとして集約し、通常ビルド1件・手動4件を加えた7実行を採用する。FR-01〜15、4件の回帰リスク、26ソースファイルを76ノード・82エッジへ接続し、30のテスト義務を配置した。

## 修正・自動検証

1409行だった画面をフォーム・工程別画面・状態管理を含むアプリ外枠へ分割した。根拠編集とサーバーの検証・出力処理も分離し、起動時の環境変数に既存デフォルト値を明示した。静的指摘5件は抑制せず解消した。

回答ファイルの上限・訂正後の取込、プロンプトのクリップボードコピー、画面内再読込を追加検証した。Windowsのクリップボード改行差は比較時に正規化する。証跡変換にも9件の検査を加え、古いcommit・改変要件・失敗/重複テスト・手動結果不足・静的指摘・低カバレッジ・未確定変更を拒否する。

型検査・通常ビルド・自動83件が成功した。通常ビルドでもE2E 13件を別途実行し、全件合格した。

| 指標 | 今回 | 最初の計測 |
|---|---:|---:|
| 行 | **98.58%**（839/851） | 52.64% |
| 文 | 98.22% | — |
| 関数 | 98.13% | — |
| 分岐 | **95.74%**（495/517） | — |
| v0.1からの変更行 | **99.34%**（603/607） | 64.94% |

[計測原本](final-evidence/coverage-gate.json)と[対象ハッシュ](final-evidence/run-identity.json)を保存。全体90%、ファイル別の行90%・分岐85%、変更行90%の基準は維持した。

## 手動ブラックボックス

[実行前計画](../manual-bb/final-plan.json)を型付きチェックリスト・観点・リスク・ケースへ変換した。見積り計21分。自動試験の境界値・状態遷移を補う重点回帰として次の4件を実行した。

1. 未承認比較のプロンプト拒否、エラーを閉じた後の工程移動。
2. 要件→Claim→Evidence→URL、承認済み契約の実ダウンロード、資料更新による失効・再承認拒否・契約無効化・旧版履歴。
3. 専用サーバーを実際に停止し、日本語エラーと入力保持を確認。再起動だけでは再送されず、明示保存で1件のみ登録。再度再起動して内容と履歴を復元。
4. 同じrevisionを2タブで開いて競合を発生させ、後発の編集値保持と上書き拒否を確認。

2の前提はAPIで準備し、手動合格には数えなかった。画面観測はエージェントによるもので、人の独立承認ではない。過去ビルドの手動12件を今回の実行として使っていない。通常利用の4317番と利用者のDBは維持した。

## QEG契約と異常検出

HATE独自グラフをQEG wire 0.2のnative_graphへ明示変換した。manual-bbの新しいevidence_summaryはQEG 0.5内蔵の旧契約へ射影し、情報量の多い原本も同梱した。元データ・対応表・正規化実行・ビルド識別・変換ツールをハッシュで追跡できる。

実QEG CLIで原本の複製へ異常を入れた。[結果](final-evidence/negative-controls.json): 正常はGo/exit 0、ハッシュ改変・古いビルド・手動証跡欠落はdisqualified/exit 2、最新実行の失敗はno_go/exit 2。失敗を過去の成功で隠さないことを確認した。

## 再実行

保存済みGateの再評価:

```powershell
node C:/Users/ryo-n/Codex_dev/quality-evidence-graph/dist/cli.js gate docs/testing/final-evidence
```

現行アプリを最初から検証する場合は変更をcommitしてcleanにし、毎回新しい出力フォルダーを指定する。

```powershell
npm run test:quality
$bbPython = 'C:/Users/ryo-n/Codex_dev/Agent_tools/manual-bb-test-harness/.venv/Scripts/python.exe'
& $bbPython scripts/quality-chain.py design --out .cache/new-chain
& $bbPython scripts/quality-chain.py collect --out .cache/new-chain
# 専用DBの通常ビルドを計画通りに操作し、manual-observations.jsonへ記録する。
# 形式: head, results[{tc_id,result,timestamp,actual,attachments}]
& $bbPython scripts/quality-chain.py finish --out .cache/new-chain
node scripts/qeg-negative-controls.mjs .cache/new-chain/qeg C:/Users/ryo-n/Codex_dev/quality-evidence-graph/dist/cli.js .cache/new-chain/negative-controls
```

`--tools-root`でOSSの配置元を変更できる。観測結果はスクリプトが生成しない。収集済みJUnitを固定するため、後から個別テストを実行しても証跡母集団が変わらない。

使用版（Git）: RanD `b4315040`、Code-to-gate `c6d7137c`、HATE `22dc83b9`、manual-bb `b1830dee`、QEG `e6d25957`。[manifest](final-evidence/manifest.json)で公開証跡のバイト列を固定した。

Goの範囲はローカル機能回帰。外部デプロイ、人の公開承認、他OS・他ブラウザ、未導入OSSの実運用、変異テスト・長期flake率は評価していない。以前の記録は履歴として残し、本記録で静的指摘・現行手動証跡・QEG接続を完了とする。
