# 調査記録と採否判断

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

## 記事からの設計判断

[Logos概要](https://blog.cybozu.io/entry/logos-overview)の知識・分割・フィードバック、[Ergon](https://blog.cybozu.io/entry/logos-llm-wiki-ergon)の用途別知識蓄積を参考にした。
本製品では資料から要件への証跡を中心にする。スキャンハーネス自体は作らない。

## 配布上の発見

agent-protocolsの公開READMEはnpmパッケージを案内しているが、調査時のnpm registryは404だった。
公開commit `c3d64bc3b8b7e6549bd30d9d176c954ae785039a` から生成するtgzを同梱し、上流のコードを変更せず利用する。
ローカルの未コミットコードを依存物に混ぜない。

## 知識レビュー

Daybreak Blueはこの実行環境のサブエージェントとして選択できなかったため未使用。公開防御知識のレビューは一次資料照合で実施した。
