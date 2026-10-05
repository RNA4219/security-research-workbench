# development04 B 条件の根拠説明レビュー

## 対象と範囲

development04 の保存済み結果から、`split=development`、`condition=B`、`repetition=1` の9件だけを読み取り、B 応答が位置とカテゴリの一致に加えて、提示された仕様上の問題を説明しているかを確認した。対象は次の保存結果である。

- 応答記録: `evaluations/model-review/results/development-abc-20261005-04/records.jsonl`
- 対象フィルタ: `a01`〜`a09`、B、反復1
- 応答記録の SHA-256: `ef746b39469095533b0c72250a48f80315c79ba1762601e21c7d1890f9121e90`
- fixture: `evaluations/model-review/cases/development.json`
- このレビューでは holdout のコード、正解、結果は参照していない。モデル呼出し、攻撃操作、PoC、実行も行っていない。

判定は、`supported` を「応答の中心的な理由が、保存されたコード上の挙動と提示仕様または承認知識から直接支持される」、`uncertain` を「中心的な指摘は支持されるが、影響の説明や補足に提示データだけでは確定できない主張が混じる」、`unsupported` を「中心的な仕様違反の説明自体を提示データから支持できない」と定義した。これは9件1反復の根拠説明に対する質的レビューであり、モデルの一般性能や未知の問題への性能を示すものではない。

## 一致確認

9件すべてで、保存された B 入力の source path/text、ケース固有の仕様要件、ケース固有の承認知識、`conditionHash` が development fixture の対応値と一致した。B 入力には共通の製品スコープ情報が追加されているため、fixture のケース固有情報との比較ではその共通部分を除外して確認した。

7件の finding は保存された fixture の該当行と `originalText` が完全一致し、2件の hard negative（a07、a09）は `findings=[]` だった。したがって、以下の判定は位置やカテゴリの再採点ではなく、保存応答の rationale と仕様・コードの対応を読むレビューである。

## ケース別判定

| ケース | B のカテゴリ／位置 | 判定 | 根拠説明の確認 |
| --- | --- | --- | --- |
| a01 | `authorization`、`src/routes/profile.js:4` | supported | `spec-profile` と `knowledge-profile` の actor.id と profile.ownerId の照合要件を、プロフィールを返す行4の未照合に結び付けている。仕様上の所有境界を説明できている。 |
| a02 | `tenant-isolation`、`src/routes/invoices.js:3` | supported | `spec-invoice`／`knowledge-tenant` の actor.tenantId 導出要件と、requestedTenantId を使う行3を直接対比している。行4の `ownerId === actor.id` という既存条件には触れていないため、他テナント閲覧の影響は応答どおり「potentially」と読むべきだが、仕様違反の中心説明は支持される。 |
| a03 | `input-validation`、`src/services/visibility.js:2` | supported | `spec-visibility` の public/private allowlist と、値を検証せず保存する行2を対応付けている。任意値を保存できるという説明はコードと仕様から支持される。 |
| a04 | `state-transition`、`src/services/order-state.js:4` | supported | `spec-order` が要求する現在状態ごとの遷移表と、next の allowlist だけを確認する行4を対比している。approved から draft のような不許可遷移の例も、提示された遷移表から導ける。 |
| a05 | `pii-logging`、`src/observability/audit.js:2` | supported | `spec-log` の requestId 限定・email/token redaction 要件と、email/token をそのまま logger に渡す行2を直接結び付けている。PII と認証情報がログへ渡るという理由は提示仕様に一致する。 |
| a06 | `cryptography`、`src/services/password.js:2` | uncertain | 承認済み wrapper を使わず汎用 SHA-1 digest を直接作るという中心説明は `spec-crypto`／`knowledge-crypto` と行2から支持される。一方、SHA-1 の攻撃耐性、salt、key stretching、rainbow table への言及はこの fixture の仕様・承認知識には明記されていないため、補足的な影響説明としては未確認の一般主張を含む。 |
| a07 | finding なし（hard negative）、`src/routes/profile-safe.js:3` | supported | 応答は空の finding で、行3の ownerId と actor.id の照合および404返却が `spec-profile-safe`／`knowledge-profile-safe` と整合する。空応答なので個別 rationale はないが、仕様に反する主張もない。 |
| a08 | `tenant-isolation`、`src/routes/notes.js:2` | supported | `spec-notes-public` が入力 tenant 識別子を認証境界として信頼しないよう求めるのに対し、行2が requestedTenantId だけで絞り込むことを説明している。旧判断を現行 endpoint に適用する根拠は B 応答に持ち込まれていない。remediation の「requestedTenantId への権限確認」という一般化は、actor.tenantId から導出するという仕様そのものより広いため、助言としては仕様への再確認が必要だが、中心 rationale は支持される。 |
| a09 | finding なし（hard negative）、`src/routes/reports.js:2` | supported | 応答は空の finding で、行2が actor.tenantId で絞り込む実装と `spec-reports`／`knowledge-reports` が一致する。空応答なので個別 rationale はないが、仕様外の問題を作っていない。 |

## 結果の読み方

この限定レビューでは `supported=8`、`uncertain=1`、`unsupported=0` だった。`uncertain` は a06 の中心 finding を否定するものではなく、fixture が明示していない暗号学的影響を rationale に追加した点を切り分けたものである。a01 の remediation にある403例、a08 の一般化された remediation、a02 の既存 owner 条件の省略は、根拠説明の判定を変えるほどではないが、仕様に沿う人手確認用助言としてはそのまま承認しない。

この記録は development04 の B 反復1における説明根拠の確認であり、全製品、未知の問題種類、holdout、実運用のレビュー時間や精度への一般化を行わない。元の records、summary、gold、manifest、runner、採点 matching は変更していない。
