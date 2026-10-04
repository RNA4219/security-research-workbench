import { ClaimEditor } from "./claim-editor.js";
import { useState } from "react";
import {
  claimFields,
  fieldLabels,
  type Claim,
  type Command,
  type EvidenceInput,
  type Project,
  type ReviewStatus,
} from "../shared/model.js";

export const reviewLabels: Record<ReviewStatus, string> = {
  draft: "未レビュー",
  approved: "承認済み",
  needs_review: "再確認が必要",
  needs_evidence: "根拠不足",
  needs_revision: "修正要求",
  rejected: "却下",
};
const verification = {
  unverified: "未検証",
  verified: "確認済み",
  disputed: "異議あり",
};
type Submit = (c: Command) => Promise<void>;
export function ReviewControl({
  p,
  entity,
  entityId,
  submit,
}: {
  p: Project;
  entity: "candidate" | "requirement";
  entityId: string;
  submit: Submit;
}) {
  const [status, setStatus] = useState<ReviewStatus>("needs_evidence");
  const [note, setNote] = useState("");
  const entries = p.reviews.filter(
    (r) => r.entity === entity && r.entityId === entityId,
  );
  return (
    <details className="review-control">
      <summary>レビュー状態と判断履歴</summary>
      <label>
        レビュー状態
        <select
          aria-label="レビュー状態"
          value={status}
          onChange={(e) => setStatus(e.target.value as ReviewStatus)}
        >
          {Object.entries(reviewLabels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        判断理由
        <textarea
          aria-label="判断理由"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button
        onClick={() =>
          void submit(
            entity === "candidate"
              ? {
                  type: "candidate-review",
                  candidateId: entityId,
                  status,
                  note,
                }
              : { type: "review", requirementId: entityId, status, note },
          )
        }
      >
        レビューを記録
      </button>
      <ul>
        {entries.map((r, i) => (
          <li key={i}>
            {r.at} · 版{r.revision} · {reviewLabels[r.status]} {r.note}
          </li>
        ))}
      </ul>
    </details>
  );
}
export function Trace({ p, claimIds }: { p: Project; claimIds: string[] }) {
  return (
    <div className="trace">
      {claimIds.map((id) => {
        const c = p.claims.find((c) => c.id === id)!;
        return (
          <details key={id}>
            <summary>
              {fieldLabels[c.field]}:{" "}
              {c.valueState === "known"
                ? c.value
                : c.valueState === "unknown"
                  ? "未確認"
                  : "値なし"}{" "}
              · {verification[c.verificationStatus]}
            </summary>
            <small>Claim: {c.id}</small>
            {c.evidenceIds.map((eid) => {
              const e = p.evidence.find((e) => e.id === eid)!;
              const s = p.sources.find((s) => s.id === e.sourceId)!;
              return (
                <div className="evidence" key={eid}>
                  <strong>Evidence: {e.excerpt}</strong>
                  <span>
                    {verification[e.verificationStatus]} · 資料の版{" "}
                    {e.sourceRevision} / 現在 {s.revision}
                  </span>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title} ↗
                  </a>
                  <small>
                    {eid} · 取得 {s.retrievedAt} · {e.sourceType}
                  </small>
                </div>
              );
            })}
            {!c.evidenceIds.length && <p>根拠未登録</p>}
          </details>
        );
      })}
    </div>
  );
}
export function ClaimChoice({
  p,
  selected,
  onChange,
}: {
  p: Project;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <fieldset className="choices">
      <legend>根拠となる主張</legend>
      {p.claims.map((c) => (
        <label key={c.id}>
          <input
            type="checkbox"
            checked={selected.includes(c.id)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? [...selected, c.id]
                  : selected.filter((id) => id !== c.id),
              )
            }
          />
          <span>
            {p.candidates.find((x) => x.id === c.candidateId)?.name} /{" "}
            {fieldLabels[c.field]}:{" "}
            {c.value || (c.valueState === "unknown" ? "未確認" : "値なし")} ·{" "}
            {verification[c.verificationStatus]}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
export function ComparisonClaims({
  p,
  submit,
}: {
  p: Project;
  submit: Submit;
}) {
  return (
    <section>
      <h2>項目ごとの根拠と比較レビュー</h2>
      <p>
        既知の値はEvidenceを確認してから承認します。未確認と値なしはそのまま区別して記録します。
      </p>
      <div className="table-wrap">
        <table>
          <caption>項目別比較</caption>
          <thead>
            <tr>
              <th>比較項目</th>
              {p.candidates.map((c) => (
                <th key={c.id}>{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {claimFields
              .filter((f) => f !== "requirement_basis")
              .map((f) => (
                <tr key={f}>
                  <th>{fieldLabels[f]}</th>
                  {p.candidates.map((c) => (
                    <td key={c.id}>
                      <Trace
                        p={p}
                        claimIds={p.claims
                          .filter(
                            (cl) => cl.candidateId === c.id && cl.field === f,
                          )
                          .map((cl) => cl.id)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {p.candidates.map((c) => (
        <article className="panel" key={c.id} aria-label={`${c.name}の根拠`}>
          <h3>{c.name}</h3>
          <p>比較: {reviewLabels[c.status]}</p>
          {p.claims
            .filter((cl) => cl.candidateId === c.id)
            .map((cl) => (
              <div key={cl.id} className="claim-row">
                <Trace p={p} claimIds={[cl.id]} />
                <ClaimEditor p={p} claim={cl} submit={submit} />
              </div>
            ))}
          <button
            onClick={() =>
              void submit({
                type: "candidate-review",
                candidateId: c.id,
                status: "approved",
                note: "比較項目と根拠を確認",
              })
            }
          >
            比較を承認
          </button>
          <ReviewControl
            p={p}
            entity="candidate"
            entityId={c.id}
            submit={submit}
          />
        </article>
      ))}
    </section>
  );
}
export function EvidencePanel({ p, submit }: { p: Project; submit: Submit }) {
  const empty = (): EvidenceInput => ({
    sourceId: p.sources[0]?.id ?? "",
    sourceType: "official",
    excerpt: "",
    verificationStatus: "unverified",
  });
  const [eid, setId] = useState<string | undefined>();
  const [v, set] = useState<EvidenceInput>(empty);
  return (
    <section>
      <h2>根拠と主張</h2>
      <p>
        原文の抜粋または要約を登録し、出典と照合したうえで確認済みにします。
      </p>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          void submit({ type: "evidence", evidenceId: eid, value: v });
        }}
      >
        <h3>{eid ? "Evidenceを更新" : "Evidenceを追加"}</h3>
        <label>
          根拠の資料
          <select
            aria-label="根拠の資料"
            value={v.sourceId}
            onChange={(e) =>
              set({
                ...v,
                sourceId: e.target.value,
                verificationStatus: "unverified",
              })
            }
          >
            <option value="">選択してください</option>
            {p.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        {p.sources.find((s) => s.id === v.sourceId) && (
          <details>
            <summary>選択した資料の原文を確認</summary>
            <pre className="source-preview">
              {p.sources.find((s) => s.id === v.sourceId)!.body}
            </pre>
          </details>
        )}
        <label>
          資料種別
          <select
            aria-label="資料種別"
            value={v.sourceType}
            onChange={(e) =>
              set({
                ...v,
                sourceType: e.target.value as EvidenceInput["sourceType"],
              })
            }
          >
            <option value="official">一次資料</option>
            <option value="report">調査レポート</option>
            <option value="other">その他</option>
          </select>
        </label>
        <label>
          根拠の抜粋・要約
          <textarea
            aria-label="根拠の抜粋・要約"
            required
            value={v.excerpt}
            onChange={(e) =>
              set({
                ...v,
                excerpt: e.target.value,
                verificationStatus: "unverified",
              })
            }
          />
        </label>
        <label>
          根拠の確認状態
          <select
            aria-label="根拠の確認状態"
            value={v.verificationStatus}
            onChange={(e) =>
              set({
                ...v,
                verificationStatus: e.target
                  .value as EvidenceInput["verificationStatus"],
              })
            }
          >
            {Object.entries(verification).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!v.sourceId}>根拠を保存</button>{" "}
        <button
          type="button"
          onClick={() => {
            setId(undefined);
            set(empty());
          }}
        >
          新しい根拠
        </button>
      </form>
      {p.evidence.map((e) => {
        const s = p.sources.find((s) => s.id === e.sourceId)!;
        const claims = p.claims.filter((c) => c.evidenceIds.includes(e.id));
        const reqs = p.requirements.filter((r) =>
          r.claimIds.some((id) => claims.some((c) => c.id === id)),
        );
        return (
          <article key={e.id} className="panel">
            <h3>{e.excerpt}</h3>
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.title} ↗
            </a>
            <p>
              {verification[e.verificationStatus]} · 資料revision{" "}
              {e.sourceRevision} / 現在 {s.revision}
            </p>
            <small>Evidence: {e.id}</small>
            <p>
              参照する要件:{" "}
              {reqs.map((r) => r.id + " " + r.title).join(" / ") || "なし"}
            </p>
            <Trace p={p} claimIds={claims.map((c) => c.id)} />
            <button
              onClick={() => {
                setId(e.id);
                set({
                  sourceId: e.sourceId,
                  sourceType: e.sourceType,
                  excerpt: e.excerpt,
                  verificationStatus: e.verificationStatus,
                });
              }}
            >
              根拠を編集
            </button>
          </article>
        );
      })}
      {p.claims
        .filter((c) => !c.candidateId)
        .map((c) => (
          <article className="panel" key={c.id}>
            <Trace p={p} claimIds={[c.id]} />
            <ClaimEditor p={p} claim={c} submit={submit} />
          </article>
        ))}
    </section>
  );
}
