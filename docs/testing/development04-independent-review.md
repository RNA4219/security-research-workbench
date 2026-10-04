# development-abc-20261005-04 独立方法論監査

監査日: 2026-10-05

## 対象と同一性

対象は管理下の無害な静的fixtureによる development split のみである。固定manifestは `evaluations/model-review/manifest.json`、`manifest_id` は `eval:20261005-model-review-04`、`task_id` は `model-review-20261005-04`、SHA-256は `afb8e7b501b10624b19d70da847888d942f84554d073a57ba960c9db746fc360` である。結果ディレクトリ `evaluations/model-review/results/development-abc-20261005-04/manifest.json` も同じ内容・hashだった。development casesのhashは `7a066c4562ed10a5095530f0854136c78f902b75b1b5306b4adf6c595d93defa`、goldのhashは `c877db9cce5dbf0f7b188db5364bf2c31d0436a4c8454a720caac3ede2a2534a` である。

結果は9ケースをA/B/C各条件で3回ずつ実行した81レコードであり、実質的なfixture数は9件である。全レコードが成功し、postrun検査とcanonical検査は成功した。保存済みraw prompt/responseを確認し、追加のモデル呼出しは行っていない。holdoutのコード、gold、応答内容は本監査では読んでいない。

## 独立確認

- strict matchingを再集計すると、全体は `TP54 / FP0 / FN9` となり、条件別ではAが `12 / 0 / 9`、Bが `21 / 0 / 0`、Cが `21 / 0 / 0` で、保存summaryと一致した。matchingはpath・category・location基準であり、実製品全般の意味的正しさを表すものではない。
- 保存された54件のfindingについて、path・行範囲・`originalText`をfixtureのsourceと照合し、54件すべて引用行が一致した。根拠行検証は固定engineのsource検証も通過している。
- 各条件・ケースの3反復は同一出力だった。したがって反復安定性は確認できるが、81件を独立した実例数として数えない。
- prompt内の `fixedRuleFindingsForContextOnly` はA/B/Cすべて空だった。今回の差分を固定ルール結果の言い換えとする証拠は確認できない。
- manifest、cases、goldのhashとpostrun記録に基づき、採点後のgoldまたはmatching変更、測定中の追加モデル呼出しは確認できなかった。

## 重要な採点上の問題

1. `scripts/model-review-evaluation.mjs:539-551` は `recheckPriorDecision === null` を未提供として数えながら、同じ値を `false` として `changedAssumptionMisses` に加算する。保存結果は全81件が `recheckUnavailable` で、変更前提9件も再確認フラグ未提供なのに、変更前提見逃し率が100%と記録されている。これはモデルの再確認見逃し率として利用できず、未測定として表示する必要がある。
2. Cは `scripts/model-review-evaluation.mjs:966-1014` で過去判断を入力するが、固定engineの `evaluations/model-review/results/development-abc-20261005-04/source-bundle/engine/model-review.js:164-172` が `targetVersion` と `conditionHash` の一致しない判断をprompt前に除外する。変更前提a08の旧判断 `judgment-notes-old` は旧conditionHashのため除外され、保存promptにも含まれなかった。一方goldはa08で `recheckPriorDecision: true` を要求しているため、Cによる変更前提の再確認や過去判断の増分効果は測定できていない。Cの結果をBより優れた再確認性能として主張してはならない。

## 許される結論と限界

この開発fixtureに限れば、BはAより9件多くgold findingを拾い、FPは増えなかった。これは提示した仕様・承認知識を追加した条件での限定的な差分証拠である。Cはfindingの結果がBと同じで、再確認フラグも全件未提供のため、条件付き過去判断の有効性や人の確認時間短縮は示していない。処理時間、queue差、未提供フラグを実人時間・安全性・実製品性能へ読み替えない。記事由来の優越性、未知の実製品での検出性能、holdoutでの一般化はこの資料から主張できない。
