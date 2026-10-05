# holdout-abc-20261005-04 独立監査

監査日: 2026-10-05

## 対象と保存証跡

対象は、同じ製品仕様・承認知識を持つ無害な静的fixtureのholdoutだけである。対象結果は `evaluations/model-review/results/holdout-abc-20261005-04/`、固定manifestは `manifest_id=eval:20261005-model-review-04`、実行IDは `model-review-1791147513070` である。A/B/C各8ケースを3反復し、72レコードを確認した。developmentや入力・gold・既存結果は変更していない。追加モデル呼出しも行っていない。

主要ファイルのSHA-256は次のとおりである。

| ファイル                                                                          | SHA-256                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `evaluations/model-review/results/holdout-abc-20261005-04/manifest.json`          | `afb8e7b501b10624b19d70da847888d942f84554d073a57ba960c9db746fc360` |
| `evaluations/model-review/cases/holdout.json`                                     | `3d9c5cf3c1f51fe5ce25754cb1c85ab0160e75bcc0b004ddce28c26f17309845` |
| `evaluations/model-review/gold/holdout.json`                                      | `e21466c69dddb58044403725ab989638a4c7143ce14f9571e132ba8ef57a1366` |
| `evaluations/model-review/results/holdout-abc-20261005-04/records.jsonl`          | `52507e80350a3ff556e2672fdfb0fe11d4bccdb63d1aaf474af827d03406e65f` |
| `evaluations/model-review/results/holdout-abc-20261005-04/summary.json`           | `18f2ed6add01e7669a307346d448591037d621009c45f0e8cc78df31a95e5846` |
| `evaluations/model-review/results/holdout-abc-20261005-04/corrected-metrics.json` | `575446d2fb82f7135a723f1311d05a9866d5e42e92c28a46520cf71301a85a0a` |
| `evaluations/model-review/results/holdout-abc-20261005-04/artifact.json`          | `b59c4154d33fc8e4aa2c14f5e96579eb207c1d9d1591b4025a37aa8ab2aac6d0` |

## 独立再計算

goldは4件のpositive（b01、b03、b06、b07）と4件のhard negative（b02、b04、b05、b08）で構成される。casesに記録された8件すべてで、fixtureコードのSHA-256が `source.codeSha256` と一致した。goldの4つのanchorも、指定pathの指定行をインデントを除いて照合すると一致した。

保存recordsを条件・ケース・反復ごとに再集計し、findingはpath・category・lineStart/lineEnd・anchorの決定的比較で照合した。結果は次のとおりで、summaryおよびcorrected-metricsのTP/FP/FNと一致した。

| 条件 | レコード |  TP |  FP |  FN | precision | recall |     F1 |
| ---- | -------: | --: | --: | --: | --------: | -----: | -----: |
| A    |       24 |   3 |   0 |   9 |      1.00 |   0.25 |   0.40 |
| B    |       24 |  12 |   0 |   0 |      1.00 |   1.00 |   1.00 |
| C    |       24 |  12 |   0 |   0 |      1.00 |   1.00 |   1.00 |
| 合計 |       72 |  27 |   0 |   9 |      1.00 |   0.75 | 0.8571 |

全72件が `completed`、schema valid、coverage `complete` であり、error・timeout・partialは0件、未採点taskと未採点gold findingも0件だった。予測された27件すべてでpathはfixtureと一致し、lineStart/lineEndの行をトリムした内容がanchorと一致した。Bの8ケースは各3反復で正規化出力とresponse hashが同一だったため、反復安定性は確認できるが、独立した24実例とは数えない。

原 `summary.json` のカテゴリ別 `successfulRecords` と `evaluationRate` は0になっているが、全72件の実レコードは成功している。この表示上の不整合は `corrected-metrics.json` がカテゴリ別に再集計しており、TP/FP/FNは変更していない。本監査のカテゴリ評価率は、修正済みsidecarと実レコードを基準にし、原summaryの0を性能値として扱っていない。

## Bのケース別理由・修正案レビュー

保存raw responseの各ケース第1反復を、同じケースのcode、仕様、承認知識、goldと照合した。空のhard negativeには、不要な指摘や修正案を出していないことを確認した。

| case | 判定       | 根拠と理由・修正案の確認                                                                                                                                                                                                                                                                                                                   |
| ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| b01  | 支持       | `src/routes/documents.js:4` の `repo.remove(id);` を引用し、仕様の所有者または管理者確認がなく `actor` を認可に使っていないと説明している。所有者または管理者権限を確認してから削除する修正案は仕様に対応する。                                                                                                                            |
| b02  | 支持       | `src/routes/projects.js:2` の `tenantId === actor.tenantId` が仕様どおりで、指摘なし。hard negativeへの余分な修正案もない。                                                                                                                                                                                                                |
| b03  | 支持       | `src/services/role.js:2` のtruthy値の直接代入をallowlist不在として説明している。allowlist検証と不許可値の拒否を提案しており方向は支持できる。「sanitize」は具体的実装を固定しない表現だが、主修正である許可値検証を損なわない。                                                                                                            |
| b04  | 支持       | `src/services/job-state.js:4` の遷移表照合と不許可遷移の拒否を満たすhard negativeとして、指摘なし。                                                                                                                                                                                                                                        |
| b05  | 支持       | `src/observability/audit-safe.js:2` でemailとtokenをredactしてからログへ渡しており、仕様に整合するhard negativeとして、指摘なし。                                                                                                                                                                                                          |
| b06  | 支持       | `src/services/session.js:2` の利用者IDと時刻をbase64url化する処理を予測可能と説明している。承認済みCSPRNG wrapperへの置換と十分なentropyを提案しており、仕様に対応する。                                                                                                                                                                   |
| b07  | 一部不確実 | `src/routes/export.js:2` のrole名依存を、現行仕様の `export:read` capability要件に反するものとして説明し、capability確認への置換を提案している点は支持できる。ただし旧版の承認判断を現行条件へ再利用せず再確認すべきケースで、raw responseに `recheckPriorDecision: true` の要求への説明がなく、再確認の理由・修正案としては不完全である。 |
| b08  | 支持       | `src/routes/report-view.js:2` のtenant境界と `reports:read` permission確認が仕様と現行承認判断に一致するhard negativeとして、指摘なし。                                                                                                                                                                                                    |

Bは4つのpositiveを各3反復で検出し、4つのhard negativeに誤検知を出さなかった。`requiresHumanConfirmation`もBのpositive 12件とnegative 12件でgoldと一致した。ただしb07の再確認要求は応答から確認できない。

## 再確認指標の扱い

goldが要求する再確認はb07の各条件3反復、合計9件である。しかし保存された72件すべてで `normalized.recheckPriorDecision` が `null`、summaryの `recheckUnavailableCount` が72だった。したがって、summaryにある `changedAssumptionMisses=9` と `changedAssumptionMissRate=1` は、再確認を測定した結果ではなく、未提供値をmissとして数えた値である。再確認成功率・見逃し率として解釈せず、holdoutでも再確認指標は未測定と扱う。postrunの `outcome.decision` も `unmeasured` であり、Cの過去判断再利用効果や確認待ち削減はこの結果から主張できない。

## 結論と限界

この固定holdoutでは、B/CはAより9件多くgold findingを拾い、FPを増やさなかった。Bの仕様・承認知識を使ったfinding検出は、4つのpositiveと4つのhard negativeという限定された合成集合で、今回の反復範囲では根拠行と説明・修正案も概ね仕様に支持された。CはfindingのTP/FP/FNがBと同じで、過去判断の再確認値は未提供なので、Bを上回る効果や人の確認時間短縮は示していない。

8件の静的fixtureを3反復した結果であり、実製品全般、未知の問題種類、実人の所要時間、実アプリ挙動、攻撃耐性へ一般化できない。モデル呼出しを追加していないため、ここでの理由品質は保存raw responseの限定レビューである。postrun検査は `postrun-check.json` と `postrun-canonical-check.json` の両方で `status: ok` だった。
