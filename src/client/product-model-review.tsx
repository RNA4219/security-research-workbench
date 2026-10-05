import type {
  DiagnosticRun,
  ProductModelReview,
} from "../shared/product-diagnostics.js";
import type { WorkflowProviderSummary } from "../shared/workflow-run.js";

export const defaultModelReview: ProductModelReview = {
  enabled: false,
  providerId: "local",
  cloudConsent: false,
};

export function ModelReviewEditor({
  value,
  providers,
  error,
  onChange,
}: {
  value: ProductModelReview;
  providers: WorkflowProviderSummary[];
  error: string;
  onChange: (value: ProductModelReview) => void;
}) {
  const localProviders = providers.filter(
    (provider) => provider.kind === "local",
  );
  const selected = localProviders.find(
    (provider) => provider.id === value.providerId,
  );
  return (
    <fieldset className="diagnostics-schedule">
      <legend>製品仕様を使うAIレビュー（任意）</legend>
      <label className="diagnostics-check">
        <input
          type="checkbox"
          checked={value.enabled}
          disabled={!value.enabled && !selected?.available}
          onChange={(event) =>
            onChange({
              ...value,
              enabled: event.target.checked,
              cloudConsent: false,
            })
          }
        />
        <span>
          <b>ローカルモデルでコードをレビューする</b>
          <small>
            固定したコード、製品仕様、承認済みの知識、適用条件が一致する過去の判断を使います。結果は人が確認する指摘候補です。
          </small>
        </span>
      </label>
      {localProviders.length > 0 && (
        <label className="field">
          <span>AIレビューのモデル</span>
          <select
            value={value.providerId}
            onChange={(event) =>
              onChange({
                ...value,
                providerId: event.target.value,
                enabled: false,
                cloudConsent: false,
              })
            }
          >
            {localProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label} · {provider.model}
                {provider.available ? "" : "（未設定）"}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p role="status">{error}</p>}
      {!selected?.available && (
        <p className="muted">
          モデル接続が未設定です。サーバー起動時の WORKFLOW_LOCAL_URL と
          WORKFLOW_LOCAL_MODEL を設定すると選べます。
        </p>
      )}
      <p className="muted">
        コードと資料は、このPCで動くモデルへ渡します。開始後は各工程の進行と未診断範囲を確認できます。
      </p>
    </fieldset>
  );
}

export function ModelReviewEvidence({ run }: { run: DiagnosticRun }) {
  const model = run.modelReview;
  if (!model?.enabled)
    return <p className="muted">AIレビュー: この実行では無効です。</p>;
  const report = model.record;
  const pending =
    !report && (run.status === "queued" || run.status === "running");
  const reviewState = pending
    ? "レビュー待ち・実行中"
    : model.failure
      ? "レビューできませんでした"
      : model.coverage.status === "complete"
        ? "指定範囲のレビュー完了"
        : "一部または全部が未レビュー";
  return (
    <section className="diagnostic-model-review" aria-label="AIレビューの記録">
      <h4>製品仕様を使うAIレビュー</h4>
      <p>
        <b>{reviewState}</b>
      </p>
      {!pending && model.failure && <p role="status">{model.failure}</p>}
      {report?.stopReason === "max_budgets" && (
        <p role="status">
          設定した処理量または費用の上限に達しました。未レビューの範囲が残っています。
        </p>
      )}
      {report?.stopReason === "aborted" && (
        <p role="status">
          レビューを途中で停止しました。保存済みの工程と未レビューの範囲を確認してください。
        </p>
      )}
      {report?.stopReason === "no_source" && (
        <p role="status">レビュー対象のソースがありません。</p>
      )}
      <p>
        {model.model ?? "モデル未確定"} · {model.coverage.completedBatchCount}/
        {model.coverage.batchCount}工程を完了
      </p>
      <p>
        レビューした範囲: {model.coverage.assessedFiles}ファイル・
        {model.coverage.assessedLines}
        行。読み取った範囲の記録であり、問題をすべて発見したことは示しません。
      </p>
      {report && (
        <dl className="diagnostic-metadata">
          <div>
            <dt>モデル設定版</dt>
            <dd>{report.configVersion}</dd>
          </div>
          <div>
            <dt>今回の処理時間</dt>
            <dd>{(report.elapsedMs / 1000).toFixed(1)}秒</dd>
          </div>
          <div>
            <dt>保存済み工程を含む入力 / 出力トークン</dt>
            <dd>
              {report.used.promptTokens ?? "未計測"} /{" "}
              {report.used.completionTokens ?? "未計測"}
            </dd>
          </div>
          <div>
            <dt>中間保存の再利用</dt>
            <dd>{report.checkpoint.reused ? "あり" : "なし"}</dd>
          </div>
        </dl>
      )}
      <details>
        <summary>参照した知識と入力の記録</summary>
        <p>製品仕様 revision {run.specificationRevision}</p>
        {run.knowledge.length === 0 ? (
          <p>追加の承認済み知識はありません。</p>
        ) : (
          <ul>
            {run.knowledge.map((item) => (
              <li key={item.id}>
                <code>{item.id}</code> · revision {item.revision} ·{" "}
                <code>{item.contentHash}</code>
              </li>
            ))}
          </ul>
        )}
        <p>
          入力ハッシュ: <code>{model.inputHash ?? "未固定"}</code>
        </p>
        <p>
          知識・判断のハッシュ: <code>{model.contextHash ?? "未固定"}</code>
        </p>
      </details>
    </section>
  );
}
