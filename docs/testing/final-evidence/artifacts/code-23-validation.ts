import type { Project } from "../shared/model.js";
import { claimReady } from "./provenance.js";
export class DomainError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function checkRefs(
  ids: string[],
  existing: { id: string }[],
  label: string,
) {
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !existing.some((e) => e.id === id))
  )
    throw new DomainError(`${label}IDが不明または重複しています`);
}
export function readyRequirement(
  p: Project,
  r: Project["requirements"][number],
) {
  checkRefs(r.claimIds, p.claims, "Claim");
  if (
    r.claimIds.some((id) => {
      const c = p.claims.find((c) => c.id === id)!;
      return c.valueState !== "known" || !claimReady(p, c);
    })
  )
    throw new DomainError(
      "根拠不足です。参照する主張とEvidenceを確認してください",
      409,
    );
  if (!r.claimIds.length && !r.rationale.trim())
    throw new DomainError("根拠または利用者判断が必要です");
}
export function refs(p: Project, ids: string[]) {
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !p.sources.some((s) => s.id === id))
  )
    throw new DomainError("出典IDが不明または重複しています");
}
