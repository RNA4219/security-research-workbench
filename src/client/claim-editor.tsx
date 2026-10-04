import { useEffect, useState } from "react";
import {
  fieldLabels,
  type Claim,
  type ClaimInput,
  type Command,
  type Project,
} from "../shared/model.js";

const verification = {
  unverified: "未検証",
  verified: "確認済み",
  disputed: "異議あり",
};
type Submit = (c: Command) => Promise<void>;
export function ClaimEditor({
  p,
  claim,
  submit,
}: {
  p: Project;
  claim: Claim;
  submit: Submit;
}) {
  const input = (c: Claim): ClaimInput => ({
    candidateId: c.candidateId,
    field: c.field,
    value: c.value,
    valueState: c.valueState,
    evidenceIds: c.evidenceIds,
    verificationStatus: c.verificationStatus,
  });
  const [v, set] = useState(input(claim));
  useEffect(() => set(input(claim)), [claim]);
  return (
    <details className="claim-editor">
      <summary>{fieldLabels[claim.field]}を編集</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit({ type: "claim", claimId: claim.id, value: v });
        }}
      >
        <label>
          値の状態
          <select
            aria-label="値の状態"
            value={v.valueState}
            onChange={(e) =>
              set({
                ...v,
                valueState: e.target.value as ClaimInput["valueState"],
                value: "",
                verificationStatus: "unverified",
              })
            }
          >
            <option value="known">既知の値</option>
            <option value="unknown">未確認</option>
            <option value="empty">値なし</option>
          </select>
        </label>
        {v.valueState === "known" && (
          <label>
            比較値
            <textarea
              aria-label="比較値"
              required
              value={v.value}
              onChange={(e) =>
                set({
                  ...v,
                  value: e.target.value,
                  verificationStatus: "unverified",
                })
              }
            />
          </label>
        )}
        <fieldset className="choices">
          <legend>この主張のEvidence（複数選択可）</legend>
          {p.evidence.map((e) => (
            <label key={e.id}>
              <input
                type="checkbox"
                checked={v.evidenceIds.includes(e.id)}
                onChange={(ev) =>
                  set({
                    ...v,
                    evidenceIds: ev.target.checked
                      ? [...v.evidenceIds, e.id]
                      : v.evidenceIds.filter((id) => id !== e.id),
                    verificationStatus: "unverified",
                  })
                }
              />
              <span>
                {e.excerpt} · {verification[e.verificationStatus]}
              </span>
            </label>
          ))}
        </fieldset>
        <label>
          主張の確認状態
          <select
            aria-label="主張の確認状態"
            value={v.verificationStatus}
            onChange={(e) =>
              set({
                ...v,
                verificationStatus: e.target
                  .value as ClaimInput["verificationStatus"],
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
        <button>主張を保存</button>
      </form>
    </details>
  );
}
