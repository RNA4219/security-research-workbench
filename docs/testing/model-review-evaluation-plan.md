# 実モデルコードレビュー比較評価計画

この計画は、固定ルールの件数を数える代わりに、同じ製品のコード・仕様・承認済み知識・過去判断を読む静的モデルレビューの比較を行うためのものです。対象は管理下のメモリ内fixtureだけです。コードを実行せず、外部サービスへ接続せず、攻撃操作・PoC・脆弱性再現・外部標的スキャンを行いません。実装の機能受入計画は[実モデルレビューの受入計画](../manual-bb/model-review-plan.md)に分けて記録します。

## 固定する入力

`evaluations/model-review/` に同じ製品ID `fixture-ledger` のfixtureを保存します。`product.json` は共通製品仕様と共通知識、`cases/development.json` と `cases/holdout.json` は固定commit・コード・現行仕様・承認済み知識・過去判断、`gold/*.json` はcaseごとの正解集合です。caseファイルのIDとpathは問題種類を名前に含めず、正解をコードのコメントやファイル名に漏らしません。

developmentには権限、tenant分離、入力列挙値、状態遷移、個人情報ログ、暗号を含む陽性例とhard negative、前提変更・前提不変の過去判断例を入れます。holdoutは同じ6種類の問題を別のコード形で含め、未使用のhard negativeと前提変更controlを残します。goldには現在の問題カテゴリ、path、1-based line範囲、anchor、要人確認要求、過去判断の再確認要求だけを記録します。

すべてのコード入力には`source.codeSha256`を付け、runnerは読み込み時に再計算します。データ集合hashと条件別input hashはmanifestに記録し、manifestのhashが一致しなければ実モデルを呼びません。

## 条件と接続契約

同じproduction `reviewSnapshot`を一つのadapterから呼びます。adapterは`src/server/model-review.ts`の`reviewSnapshot`、`createOpenAICompatibleModelReviewInvoker`、`invokeOpenAICompatible`を使い、別のレビュー規則や固定ルールを実装しません。providerのendpointやAPI keyはprompt・artifactに書きません。

`model-review-production-adapter.mjs`の公開契約は次のとおりです。

```text
modelReviewEngine.review(input, context) -> Promise<result>
```

`input`はrunnerの`model-review-engine-input/v1`で、Aは`target`・レビュー指示・codeだけ、BはAに現行仕様と`approvedKnowledge`を加え、CはBに`approvedDecisionHistory`を加えます。`context`は`condition`、case ID、反復番号、timeout用AbortSignal、予算だけです。engineは`reviewSnapshot`へ変換し、productionの`ModelReviewInput`と厳格なfinding schemaを通します。

engineが返すproduction結果は、内部injectorが受け取ったprompt、providerのraw invocation、`report.model`、`report.used.promptTokens`／`completionTokens`をadapterが保持してrunnerへ返します。runnerはそれらを捨てずに`records.jsonl`へ保存します。現行production contractに永続化された「過去判断の再確認キュー」フィールドがない場合、adapterは`recheckPriorDecision=null`のまま保存し、findingの過去判断参照からキュー状態を推測しません。

## 実行手順

まずproduction側のビルドを作り、モデル設定をfreezeしたmanifestと一致させます。親タスクで使用するlocal providerの例は次のとおりです。

```powershell
$env:WORKFLOW_LOCAL_URL = "http://127.0.0.1:8081"
$env:WORKFLOW_LOCAL_MODEL = "C:\Users\ryo-n\Qwen3.5-4B-Q4_K_M.gguf"
$env:WORKFLOW_LOCAL_DISABLE_THINKING = "true"
$env:WORKFLOW_LOCAL_JSON_MODE = "true"
$env:MODEL_REVIEW_PROVIDER = "local"
npm run build
```

manifestの`evaluation.configuration.provider`には、使用GGUFのSHA256、llama.cppの実行版、`no-thinking`設定、JSON mode、出力token上限を保存します。モデルやprovider設定を切り替えた場合は同じmanifestを使い回さず、別manifestとしてfreezeします。
manifestの`identity.engine`と`identity.provider`は、adapterが実際にimportする`dist/server/*.js`のbundle hashを固定し、`identity.adapter`と`identity.runner`は実行するscriptのhashを固定します。source変更後はbuildしてこれらを再計算します。
実runではモデルを呼ぶ前に、runner・adapter・engine・providerと、それらが読む`dist/shared/diagnostic-engine.js`、`dist/shared/model-review.js`、`dist/shared/model.js`、`dist/shared/domain-error.js`、`package-lock.json`を`output/source-bundle/`へそのまま保存します。`source-bundle/hashes.json`には各実ファイルと保存コピーのSHA256を記録し、欠落またはmanifest identityとの不一致があれば最初のengine呼出しより前に停止します。このbundleはrunごとの再現証跡であり、manifestのgold・条件・採点を変更しません。
ctx16384のlocal runtimeに対して、比較budgetはinput 12000 tokens／output 2048 tokensに固定します。providerが返す実測usageをrecordsへ保存し、どちらかの上限を超えたrecordは`budget-exceeded`として失敗扱いにします。

次にmanifest preflightだけを実行し、成功してからdevelopmentを回します。`runEvaluation`はengine呼び出しの前にも同じpreflightを行います。

```powershell
node -e "import('./scripts/model-review-evaluation.mjs').then(async m => { const fs = await import('node:fs/promises'); const c = await m.loadCorpus('evaluations/model-review'); const manifest = JSON.parse(await fs.readFile('evaluations/model-review/manifest.json', 'utf8')); console.log(await m.preflightManifest(manifest, c)); })"
node scripts/model-review-evaluation.mjs `
  --engine scripts/model-review-production-adapter.mjs `
  --manifest evaluations/model-review/manifest.json `
  --corpus evaluations/model-review `
  --split development `
  --conditions A,B `
  --output evaluations/model-review/results/<fresh-development-run>
```

`--conditions A,B`はdevelopmentのA/Bを先に実測するための指定です。Cを含む比較を行う場合は同じfreezeの空ディレクトリで`--conditions A,B,C`を指定します。条件を省略するとA/B/C全件です。

developmentでprompt、予算、反復数を調整した場合は、holdoutをまだ読まずにmanifest、runner、source/input hashを更新して再freezeします。最終holdoutは新しい空のoutput directoryへ同じA/B/C、同じモデル、同じ反復数で実行します。出力先に既存ファイルがある場合runnerは上書きせず停止します。

```powershell
node scripts/model-review-evaluation.mjs `
  --engine scripts/model-review-production-adapter.mjs `
  --manifest evaluations/model-review/manifest.json `
  --corpus evaluations/model-review `
  --split holdout `
  --output evaluations/model-review/results/<fresh-holdout-run>
```

各runには`manifest.json`、`records.jsonl`、`artifact.json`、`summary.json`、`source-bundle/`を保存します。recordごとにprompt、raw response、失敗種別、実測elapsedMs、model、既知の場合だけusage tokenを残します。未取得の人のレビュー時間やtoken数を0として補いません。

元runのファイルはpostrun確認で上書きしません。checkerはartifactの`split`に対応するgoldを読み、`postrun-manifest.json`と`postrun-check.json`を新規に追加します。`--gold`を指定しない場合はdevelopmentなら`gold/development.json`、holdoutなら`gold/holdout.json`を使います。

```powershell
node scripts/model-review-postrun.mjs `
  --run-dir evaluations/model-review/results/<run-id> `
  --gold evaluations/model-review/gold/development.json
```

`postrun-manifest.json`は原runの正規schema 1.1 manifestを複製し、測定が完了したrunなら`status=completed`、error・timeout・partial・stopped・unavailable・未採点goldがあれば`status=failed`として、`outcome.artifact_path`、artifact hash、records、error/crash/timeout、有限値のprimary metricsを追加します。効果ゲートの判定は`outcome.decision`へ分離するため、測定が完了していても効果不合格なら`status=completed`かつ`decision=fail`になり得ます。artifactまたはsummaryに明示的な`evaluation_decision`がない場合は`decision=unmeasured`とし、測定完了やpostrun checkerの成功から効果合格を推定しません。workflow-cookbookのpostrun checkerは測定証跡を検査し、checker出力は`postrun-check.json`へそのまま保存します。追加の`postrun_evidence`へstatus別件数、条件別metrics、未採点taskと未採点gold findingの件数を保存します。holdoutを読んでいない場合は`holdout=not_run`、holdoutを実行した場合は`holdout=run`と明記します。postrun checkerの成功や測定完了だけをモデル精度の改善とは解釈しません。`unmeasured`は効果ゲートのpassではありません。

## 採点

findingのmatching keyは`normalized path + category + lineStart-lineEnd + normalized anchor`です。順序に依存せず、goldと予測を同じkeyで決定的に突き合わせます。precision、recall、F1、TP、FP、FNをcondition・split・category別に出します。全く同じkeyをモデルが再出力した場合、重複件数を別に記録しながら重複分もFPに残します。これにより出力後のdedupeでprecisionだけを見かけ上改善できません。

集計の`metrics.byCondition.A/B/C`は全条件合算と別に保存し、各条件のrecords、successfulRecords、precision、recall、F1、FP、FNを確認できるようにします。エラー、timeout、不正JSON、schema不適合、coverage/reportの`partial`・`stopped`・`unavailable`は空のfindingsへ変換せず、未採点taskとして扱います。そのtaskのgold findingはFNへ加えず、`unscoredGoldFindingCount`として記録します。従って`evaluationRate`（採点できたrecord比率）と`goldEvaluationRate`（採点可能gold比率）が1未満のrunから改善を主張しません。

要人確認件数はproduction findingの`remediation.humanReviewRequired`を通じてモデルが要確認としたtask/repetition数です。現行APIに永続化されたレビューキューや人の確認完了状態はないため、この値をキュー削減や人の所要時間へ読み替えません。過去判断の再確認件数はengineが明示的に返した`recheckPriorDecision`だけを数え、未提供の`null`は未測定として`recheckUnavailableCount`へ残します。未測定の前提変更controlは成功扱いにせず、前提不変controlでのfalse alarm、前提変更controlでの再確認missを独立に報告します。

エラー、timeout、不正JSON、schema不適合は空のfindingsへ変換せず、recordの失敗とartifactの`status=failed`へ残します。失敗runを改善の証拠にしません。holdoutの未測定や評価失敗を0点・改善として埋めません。既知の実測時間がない場合に、人の所要時間を推定して確認待ち削減へ読み替えません。

## 判定境界

この計画は実モデルの計測を可能にしますが、結果が出るまで改善を主張しません。親タスクの効果ゲートで、BはAに対してFPとFNがともに悪化せず少なくとも一方が改善、CはBに対してFPとFNを増やさず、実際に測定できる同条件の確認待ち指標が減ることを確認します。`recheckPriorDecision`が未提供のままならCの確認待ち削減効果は未達として扱い、finding参照や件数から補いません。前提変更controlで古い判断が新しい問題を隠した場合は失敗です。developmentだけの改善、単体fixtureの成功、case数、予定工数を実モデルの性能や人の時間短縮の証拠にはしません。
