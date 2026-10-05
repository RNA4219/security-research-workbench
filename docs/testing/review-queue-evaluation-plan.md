# production review queue評価計画

この評価は、モデルのfinding精度を測るmodel-review比較とは別の証跡です。同じ無害なメモリ内候補をBとCへ渡し、Bは承認判断を使わず、Cはproductionの`evaluateFindingSuppression`を使ったときに、確認待ち判定が同一条件だけで再利用されるかを確認します。モデル、攻撃操作、PoC、脆弱性再現、外部標的スキャンは使いません。

## 固定入力

`evaluations/review-queue/` に製品scope、仕様資料、承認済みknowledge、現行rule、1件のraw candidate、14件の不透明なcase IDを保存します。goldはcaseごとの期待されるproduction status/reasonを別ファイルへ分け、コードやcase IDに正解を埋めません。次の負例を固定しています。

- 期限切れ、対象版変更、仕様hash変更、knowledge hash変更、rule hash変更
- evidence hash変更、context/evidence hashのない旧データ、基準失効
- 明示的人判断なし、fingerprint変更、出典資料変更、直近判断revision変更、判断内容変更

正例は、明示的人判断、同一target version/fingerprint、直近decision revision、将来期限、現行source/rule、context hash/evidence hash一致が揃う1件だけです。

## production接続

`scripts/review-queue-evaluation.mjs` は`dist/server/workflow-domain.js`のproduction exported contractを直接importします。状態fixtureの作成もproduction `newWorkflow`/`applyWorkflowCommand`を使い、判定は`evaluateFindingSuppression`、context hashは`hashFindingReviewContext`、evidence hashは`hashFindingEvidence`だけで計算します。モデルの過去判断IDや評価器独自の抑止条件でqueueを除外しません。

各recordにはcandidate、実際にhelperへ渡したcontext/evidence hashと時刻、production結果、`queueRequired = !productionResult.reusable`、実測elapsedMsを保存します。raw candidateを後からfilterせず、helper errorは失敗recordとして残します。

## 実行と証跡

manifestは`eval:20261005-review-queue-01`として固定し、dataset hash、runner hash、production helper bundle hash、条件B/C、queue定義、モデル不使用を保存します。実行前にrunner内preflightがmanifest、dataset、runner、helper bundleのhashを検査します。

```powershell
node scripts/review-queue-evaluation.mjs `
  --manifest evaluations/review-queue/manifest.json `
  --corpus evaluations/review-queue `
  --output evaluations/review-queue/results/<fresh-run>
```

runには`manifest.json`、`preflight-check.json`、`records.jsonl`、`artifact.json`、`summary.json`を保存し、CLIは続けてcanonical schema 1.1の`postrun-manifest.json`と`postrun-check.json`を生成します。postrunはartifact hash、records、error/crash/timeout、有限値の主指標を確認します。出力後にはworkflow-cookbookのcheckerでも検査します。

```powershell
py -3 ..\workflow-cookbook\tools\ci\check_evaluation_identity_manifest.py `
  --manifest evaluations/review-queue/results/<run>/postrun-manifest.json `
  --stage postrun --check --json
```

## 集計と解釈

B/Cそれぞれで、実行成功数、queue待ち件数、再利用件数、production status/reason一致、再利用precision/recall/F1、negative-control leakageを保存します。case単位のB/Cペアは`caseId+condition+candidateId`で決定的に対応させ、`queueReductionRate = (B queue - C queue) / B queue`を計算します。

現在のfixtureではBの確認待ち14件に対して、Cは同一条件の1件だけを再利用し13件となります。したがってqueue reductionは1件、率は1/14です。負例の再利用は0件です。これはproduction helperが明示判断の適用条件を守ったことを示すworkflow効果であり、モデル精度改善や実際の人の所要時間短縮の証明ではありません。人の時間は測定していないため、queue件数はproxyとして扱います。

gold mismatch、helper error、negative-control leakageがあれば`evaluation_decision=fail`として結果を保存し、成功数やケース数を改善根拠へ読み替えません。

## queue03の追加対照（dataset v2）

queue01/02の入力と結果は保持し、`evaluations/review-queue/v2/`に新しいdataset versionを作成した。既存14ケースにq15を追加し、別findingの現行人判断をproduction contextの`pastJudgments`へ含める。s15では別findingの判断をproduction commandで変更し、同じ候補の抑止判定へ渡すcontext hashだけが変わる。Cの正解は`invalidated/context_changed`であり、判断IDの存在だけで確認待ちから外さない。

v2のmanifestはcase count 15、q15を前提変更negative controlとして固定し、dataset hash・runner hash・build前のproduction helper hashを保存している。worker2のdomain変更を親がbuildした後、production helper hashを実測値へ更新した新freezeでqueue03を実行する。build前のdistでqueue03の実測結果は作らない。

build後の実行コマンドは次のとおり。helper hashをmanifestへ反映してpreflightを通した後に実行する。

```powershell
node scripts/review-queue-evaluation.mjs `
  --manifest evaluations/review-queue/v2/manifest.json `
  --corpus evaluations/review-queue/v2 `
  --output evaluations/review-queue/results/queue-controls-20261005-03-final `
  --run-id review-queue-20261005-03
```

## queue03実測結果

[queue-controls-20261005-03-final](../../evaluations/review-queue/results/queue-controls-20261005-03-final)で、build後のproduction helper（SHA-256 `6e3bce9dbc8103fb8ed0c87c11eecd7af76ff89faccf5d83366ab8626c53161c`）を使って30件を実行した。Bは15件すべて確認待ち、Cは14件が確認待ちで、同一条件で再利用できたのはq01の1件だけだった。queue reductionは1件、`1/15 = 6.67%`。q15は他findingの現行人判断変更を受け、Cが`invalidated/context_changed`として再確認を要求した。

全30件が完了し、error 0、gold mismatch 0、negative-control leakage 0、Cのreusable precision/recall/F1は1/1/1だった。raw candidate 30件、固定manifest、preflight/postrun証跡を保存し、canonical checkerはpreflight/postrunとも`status: ok`である。この結果はproduction workflowの確認待ち件数proxyであり、モデル精度や人の確認時間短縮の測定ではない。
