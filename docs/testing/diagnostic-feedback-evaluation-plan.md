# 診断フィードバック統合評価計画

## 目的と範囲

この評価は、製品診断で得たモデル候補に対して、テスト主体が理由・根拠・期限を付けた判断を記録した後、同じ固定版を再診断したときに、raw候補を保持したまま同一条件の明示的な人判断だけを確認待ちから分けられるかを検証する。測定対象は既存workflowの判断再利用と再確認境界であり、確認待ち件数の減少を人の作業時間短縮、検出精度、またはモデル品質の向上とは解釈しない。

固定ルールとモデル候補が重なるfixtureでも、ここで記録するのはworkflow状態遷移の効果だけである。モデルの発見範囲、別比較の性能、実利用者の判断品質はこの評価の結論に含めない。攻撃実行、脆弱性の再現、任意コマンド実行、fixtureソースの実行は行わない。

## 実行モード

### contract

`contract` は固定fixtureと依存性注入したfake local provider/invokerを使う契約試験である。fake応答はschemaと根拠行保持を確認するためだけに使い、実モデルの精度証拠として扱わない。既存のVitestでは`createApp`を注入できるが、出力には`realModelUsed: false`を記録する。

### live

`live` は明示的に `--mode live` を指定した場合だけ実行する。デフォルトではproductionの `dist/server/app.js` と `dist/server/workflow-providers.js` をロードし、環境由来の `workflowProvidersFromEnvironment` から利用可能なlocal providerだけを選ぶ。endpointはloopback（127.0.0.1、localhost、::1）に限り、cloud/manual providerやテスト用`createApp`注入は拒否する。

モデル呼び出しはロードしたproduction provider implementationの`invokeOpenAICompatible`をそのまま使う。live経路にはcontract応答へのfallbackを置かない。endpointの生値やAPI keyは証跡へ保存せず、providerの設定fingerprint、model、configVersion、token/cost情報だけを保存する。外部依存照会は両モードで禁止し、実際のモデル通信先は許可済みloopback providerだけとする。

liveでは、ロードしたapp moduleとprovider implementation、および`dist`内のserver/shared/researchにある相対import依存を再帰的に収集し、相対path・byte数・SHA-256・内容、Node version、runtime snapshot hash、build identityを`runtime-source-snapshot.json`と`artifact.json`へ保存する。評価script自身と`package-lock.json`も同じ証跡へ含める。任意のworkspace/privateファイルを走査せず、build root内の依存だけを対象にする。fixtureのtracked sourceとcommit/hashも`source-snapshot.json`へ保存し、再現に必要な対象を固定する。

## 評価手順

スクリプトは出力ディレクトリ内に小さなGit fixtureと分離SQLite DBを作る。既存ファイルがある出力先は、DBや証跡を上書きしないため開始前に拒否する。両モードでmodel review budgetを明示的に固定し、`maxOutputTokens=2048`、liveのmodel review timeoutを120秒、pollingを200ms、待機期限をtimeout後15秒の後処理猶予込みとする。実際にrunへ保存されたbudgetもartifactへ転記する。

1. `baseline` commit、製品仕様、local model review設定で製品を作り、診断を実行する。
2. モデル候補がraw結果に残り、確認待ちが発生したことを確認する。候補が無い、raw候補が消える、または実モデル呼び出しが失敗した場合は成功扱いにしない。
3. workflowの公開command APIで、テスト主体の`accepted_known`判断と、同一fingerprint・対象commit・期限付きsuppressionを記録する。判断command、理由、sourceRefs、targetVersion、suppression期限を保存する。これは実利用者の判定ではない。
4. 同じ固定版を新規runとして診断し、raw候補を残したまま、条件一致した候補だけが`suppressed_human` / `reused: true`として確認待ちから分けられることを確認する。各診断モデル呼び出しについてraw prompt/response、prompt/response hash、provider設定、参照した過去判断IDを保存する。
5. 製品仕様を変更し、同じcommitを再診断する。候補がrawのまま残り、旧suppressionが再利用されず`confirmation_required`へ戻ることを確認する。仕様変更後のモデル入力に旧判断が同条件として残らないことも確認する。

候補が消えた場合は確認作業削減の成功とせず、gate failureとしてartifactへ失敗理由を保存する。liveのpollingが期限を超えた場合は対象runだけにstop commandを送り、最後に観測したrun、停止結果、未完了coverage、raw invocationを保存してgate failureにする。出力には各phaseのraw model candidates、confirmation queue candidates、run detail、workflow snapshotを残す。

## 成功条件

抑止範囲を `--match-policy exact_evidence|source_scope` で固定する。既定の `exact_evidence` は説明・理由・修正案の変化も再確認する。`source_scope` は、テスト主体が固定版・コード箇所・種類・重大度・仕様参照などの範囲を明示的に受け入れた場合の評価であり、文章の意味が等しいと自動判定する評価ではない。元の厳密比較の失敗をこの別条件の成功へ書き換えない。

契約試験では、同じ原文でタイトルと修正案を変える固定応答も用意する。厳密比較で確認待ちが残ること、明示的な範囲抑止では元候補を保持して再利用できること、仕様変更で必ず再確認に戻ることを別々に確認する。実モデルの応答は加工しない。

- 3回の診断が同じfixtureの固定commitを対象に完了する。
- 各診断のrunとモデル記録がともに完了し、モデルの全工程が完了して未レビュー範囲がない。部分診断・停止・失敗に候補が残っていても合格にしない。
- 各モデル呼出しの入力証跡から、固定commit・snapshot・仕様参照・過去判断の配列を検査できる。runのmanifest hash、fixtureのファイルhash・引用原文、そのphaseの製品仕様本文・版・hashと照合する。抽出エラー、参照欠落、別条件、呼出し記録の欠落を合格にしない。prompt契約にないconditionHashは推測せず、runに保存されたmodelReviewのinputHash・contextHashを別に保持する。
- 初回にモデル候補と確認待ちが存在する。
- 2回目にraw候補が残り、同一条件の明示的人判断・有効期限・根拠が一致した候補だけが`suppressed_human` / `reused: true`になる。
- 3回目の仕様変更後にsuppressionは再利用されず、候補は`confirmation_required`へ戻る。
- 3回目のモデル入力に仕様変更前の判断が有効な同条件として残らない。
- 候補が返らない、候補がrawから消える、条件不一致なのに確認待ちから消える、旧判断がモデル入力へ残る、またはlive provider呼び出しが不正応答・失敗になる場合はgate failureとする。
- liveのprovider moduleロード・設定検証などsetup段階で失敗した場合も、専用の空出力先へ`artifact.json`（`gate: fail`、raw invocation 0）と空の`raw-invocations.json`を保存してから処理を終了する。

`recheckPriorDecision`がモデルから提供されない場合、その不在を再確認の自動承認として扱わない。確認待ち件数はworkflow状態遷移のproxyであり、人的工数、精度、安全性、実製品性能の証拠ではない。

## 保存物と再現

デフォルト出力先は`.cache/diagnostic-feedback-evaluation/<timestamp>/`。出力先は空でなければ拒否する。主な保存物は次のとおり。

- `artifact.json`: mode、gate、provider設定要約、runtime/build identity、fixture commit、各phaseのrun・raw候補・確認待ち・coverage、workflow command/snapshot、再確認結果、呼び出し一覧。
- `raw-invocations.json`: contractまたはliveの各モデル呼び出しについて、raw prompt/response、prompt/response hash、provider要約、model/config、token/cost、参照した過去判断、エラー。
- `source-snapshot.json`: fixtureのtracked source、commit、各ファイルhash、全体snapshot hash。
- `runtime-source-snapshot.json`: liveで実際にロードしたapp/provider moduleと`dist`内の相対import依存、評価script、`package-lock.json`の内容、byte数、SHA-256、runtime snapshot hash、build identity。
- `diagnostics.sqlite`: 評価専用DB。
- `fixture/`: 対象commitを再確認できるGit fixture。

契約モードの局所テストは共有JUnitを変更しないよう、次で実行する。

```text
npx vitest run tests/diagnostic-feedback-evaluation.test.mjs --reporter=default
```

contractのCLI例:

```text
node scripts/diagnostic-feedback-evaluation.mjs --mode contract --output .cache/diagnostic-feedback-evaluation/manual-contract
```

liveのCLI例。事前にproduction buildとlocal loopback providerを用意し、出力先を新規ディレクトリにする。

```text
node scripts/diagnostic-feedback-evaluation.mjs --mode live --output .cache/diagnostic-feedback-evaluation/manual-live
```

明示的な範囲抑止を別条件で評価する場合は、`--match-policy source_scope` と別の新規出力先を指定する。結果には選択した範囲と、テスト主体による抑止commandを記録する。

live結果でも確認待ち件数の減少はworkflow効果の観測に留まり、実人時間やモデル精度の改善へ読み替えない。
