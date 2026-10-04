# 調査記録と採否判断

## v3の要求訂正（2026-10-04）

Horos・Ergon・まとめ編を[要求・要件定義v3](requirements.md)の根拠へ明示的に取り込んだ。[記事との対応表](logos-traceability.md)で採用要素・適用範囲・現在の不足を管理する。製品の目的は、知識と人の判断を次の調査へ反映し、修正確認まで継続できること。URLからのOSS採用前調査はその入口とする。

v0.1/v0.2の「資料から要件への変換のみ」という範囲設定は製品全体には適用しない。工程管理、目的別知識の更新、過去判断の再利用、モデル交換、修正確認をFR-17〜31として採用した。追加要件は未実装であり、以下の過去の判断と検証結果を充足証拠にしない。

## 公開脆弱性知識（2026-10-04）

Daybreak Blueによる一次資料の設計レビューと、公式APIの実応答を照合した。CVEは識別子、OSVはOSSパッケージの影響範囲、CISA KEVは実際の悪用確認、FIRST EPSSは今後30日間にデータパートナーが悪用を観測する予測、CVSSは技術的深刻度、CWEは弱点分類として分ける。これらを一つの「安全・危険」点へ混ぜず、出典ごとの状態と時刻を表示する。

本アプリへの採用範囲は、CVE IDを明示入力した時だけ[OSV API](https://google.github.io/osv.dev/api/)、[CISA公式KEV公開データ](https://github.com/cisagov/kev-data)、[FIRST EPSS API](https://api.first.org/epss/)を固定URLで照会する垂直機能。CISAの[KEV運用説明](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)、FIRSTの[EPSSデータガイド](https://www.first.org/epss/data.html)、[CVSS v4.0仕様](https://www.first.org/cvss/v4.0/specification-document)、[CWEのmapping guidance](https://cwe.mitre.org/documents/cwe_usage/guidance.html)を表示上の解釈に用いた。

OSVのID照会はCVE-2021-44228で成功し、CISA KEVのJSONは照合時に約1.8MBであった。CVE ID以外の入力を外部URLに連結しない。上流のリダイレクト・過大応答・形式不正は`unavailable`として扱い、部分障害を「未掲載」に変換しない。OSVのGIT範囲はコミットイベントとして順序を保持し、パッケージ版とは呼ばない。撤回済みを別状態として警告する。保存は掲載元ごとの実取得URL・提供元版・応答ハッシュを持つ未検証Sourceとし、CVE.orgの未取得レコードを出典として偽装しない。要件やClaimを自動承認しない。

NVDのCPE分析、CVE原文のCNA/ADP構造、EPSS履歴、CWE taxonomy全件同期、OSV範囲を用いた資産・版の自動影響判定は今後の独立機能候補である。今回の画面は個別CVEの資料収集であり、資産評価や脆弱性スキャナーの結果ではない。

## v0.2追補（2026-10-04）

利用者提供のDeep Research本文「security-research-workbench 公開情報調査・要件定義案」を実装後に照合した。以下のv0.1記録だけでは不足していたため、Evidence/Claimの独立管理、比較項目ごとの確認状態、比較レビューの必須化、内部タスク契約、任意agent-protocols変換、詳細なレビュー状態を追加した。本文が推奨する12の比較軸を固定項目として採用した。

agent-protocolsはoptionalDependenciesへ変更し、WorkbenchTaskContractから出力時だけ変換する。SQLiteと内部モデルが正本であり、外部アダプターの不在・失敗でCoreの利用は妨げられない。旧版の出典紐付けは証跡を残して移行し、自動的な事実確認には扱わない。

今回採用したのは設計・受入条件である。提供レポート内の最新版番号や活動件数は再調査しておらず、新たな検証済み事実としてサンプルへ転記していない。以下はv0.1時点の記録であり、依存関係と比較項目の方針は本追補を優先する。

## v0.1調査記録

調査日: 2026-10-03。ChatGPTブラウザへ公開資料のみの調査・要件作成を依頼し、回答完了を確認した。Deep Research専用モードは使用していない。
非公開会話・接続アプリ・非公開コードを使用しないよう依頼した。本文は回答の要約と、GitHub一次資料を別途確認した結果である。

## 調査結果

| OSS | ライセンス | 確認した役割 | 本初版での採否 |
|---|---|---|---|
| [GPT Researcher](https://github.com/assafelovic/gpt-researcher) | Apache-2.0 | 出典付きWeb/ローカル調査、Markdownレポート | Markdown取込、出典追跡の参考。実行依存にはしない |
| [STORM](https://github.com/stanford-oval/storm) | MIT | 多角的な調査から出典付き記事を構成 | 調査・構造化・要件文章化の分離を参考にする |
| [Open Deep Research](https://github.com/langchain-ai/open_deep_research) | MIT | モデル・検索の差し替え可能な調査 | archive済みのため参考のみ |
| [Trivy](https://github.com/aquasecurity/trivy) | Apache-2.0 | 脆弱性・設定・secret・SBOM等 | 比較サンプル。実行しない |
| [OSV-Scanner](https://github.com/google/osv-scanner) | Apache-2.0 | OSVを使う依存関係の脆弱性検査 | 比較サンプル。実行しない |
| [DefectDojo](https://github.com/DefectDojo/django-DefectDojo) | BSD-3-Clause | 脆弱性管理・結果集約 | 比較サンプル。サーバー同期しない |
| [agent-protocols](https://github.com/RNA4219/agent-protocols) | MIT | v2契約Schemaと検証 | 公開コミット固定のパッケージを同梱して利用 |
| [memx-resolver](https://github.com/RNA4219/memx-resolver) | MIT | 資料登録・検索・chunk・読了・鮮度 | 任意のループバックHTTPアダプター |

ライセンス・公開状態はGitHub APIで確認。保守状況は確認日時のスナップショットであり、将来の保守保証ではない。ChatGPTが挙げた具体的な最新版番号は本調査で全件を独立検証していないため採用しない。

## ChatGPT案から採用した要件

- 原文、AI回答、編集後の要件を分離し、履歴を残す。
- 要件から根拠へ戻れる参照を持つ。根拠がない場合は利用者判断を明示する。
- AI回答をJSONで検証し、取込時は未レビューとして扱う。
- 資料・比較情報を含むプロンプトを生成し、自動送信は行わない。
- ローカル永続化、Markdownの安全な表示、同一版の決定的エクスポート。

ChatGPT案の自由な比較軸追加は初版から除外し、固定項目（機能・ライセンス・保守・判断・根拠）に絞る。
agent-protocolsはアプリ内部モデルとはアダプターで分離するが、契約出力に必要なため同梱する。

## v0.1時点の記事からの設計判断（v3で置換）

[Logos概要](https://blog.cybozu.io/entry/logos-overview)の知識・分割・フィードバック、[Ergon](https://blog.cybozu.io/entry/logos-llm-wiki-ergon)の用途別知識蓄積を参考にした。
当時は資料から要件への証跡を中心にし、ハーネス全体を範囲外にした。この一括した除外方針はv3で置き換え、防御的な調査・レビューの工程管理と知識の循環を採用する。記事にある各要素の採否を、対応表で個別に記録する。

## 配布上の発見

agent-protocolsの公開READMEはnpmパッケージを案内しているが、調査時のnpm registryは404だった。
公開commit `c3d64bc3b8b7e6549bd30d9d176c954ae785039a` から生成するtgzを同梱し、上流のコードを変更せず利用する。
ローカルの未コミットコードを依存物に混ぜない。

## 知識レビュー

Daybreak Blueはこの実行環境のサブエージェントとして選択できなかったため未使用。公開防御知識のレビューは一次資料照合で実施した。
