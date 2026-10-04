# カテゴリ集計の独立監査に使ったコード

`recalculate-category-metrics-04.mjs` は、実行時の `.cache/recalculate-category-metrics-04.mjs` をバイト単位で保存したものです。SHA-256は `d5d3646fbee0625a0497829218f5f38688fa36bb3ddcb05a37cf77f81129fe73` です。

この再集計は、development04の81件がすべて正常に採点された条件に限ります。未採点レコードを含む別の実行の集計には使えません。元のモデル応答、gold、summary、artifactは変更していません。再確認フラグの欠測も補いません。

再現する場合は別の作業用コピーを用意し、次の配置を復元してください。

1. このスクリプトをリポジトリ直下の `.cache/recalculate-category-metrics-04.mjs` に置く。
2. `source-bundle/runner/model-review-evaluation.mjs` を `scripts/model-review-evaluation.mjs` に置く。runnerのSHA-256が `02104f183a6dec512a2db47238b6958860f15adace3de4a9d0a70927c9f3df37` と一致することを確認する。
3. 元のrecords・goldなどのハッシュを、`category-recalculation-20261005-04.json` の `sourceFiles` と照合する。
4. 作業用コピーで `node .cache/recalculate-category-metrics-04.mjs` を実行し、生成結果を保存済みの再集計JSONと比較する。

スクリプトは作業用コピー内の再集計JSONを出力先として使います。原証跡を保管した作業ツリー上では再実行しないでください。
