import {
  claimFields,
  type Project,
  type RequirementInput,
  type Claim,
  type ReviewStatus,
} from "../shared/model.js";
import { createHash } from "node:crypto";

export function review(
  p: Project,
  entity: "candidate" | "requirement",
  entityId: string,
  status: ReviewStatus,
  note = "",
) {
  p.reviews.push({
    entity,
    entityId,
    status,
    note,
    at: new Date().toISOString(),
    revision: p.revision + 1,
  });
}
export function sourcesForClaims(p: Project, ids: string[]) {
  return [
    ...new Set(
      ids
        .flatMap((id) => p.claims.find((c) => c.id === id)?.evidenceIds ?? [])
        .map((id) => p.evidence.find((e) => e.id === id)!.sourceId),
    ),
  ];
}
export function claimReady(p: Project, c: Claim) {
  if (c.valueState !== "known") return true;
  return (
    c.verificationStatus === "verified" &&
    c.evidenceIds.length > 0 &&
    c.evidenceIds.every((id) => {
      const e = p.evidence.find((e) => e.id === id);
      return (
        e?.verificationStatus === "verified" &&
        e.sourceRevision ===
          p.sources.find((s) => s.id === e.sourceId)?.revision
      );
    })
  );
}
export function invalidate(
  p: Project,
  claimIds: string[],
  sourceIds: string[] = [],
) {
  const candidates = p.candidates.filter((c) =>
    p.claims.some((cl) => cl.candidateId === c.id && claimIds.includes(cl.id)),
  );
  for (const c of candidates) {
    c.status = "needs_review";
    review(
      p,
      "candidate",
      c.id,
      c.status,
      "根拠または比較項目が更新されました",
    );
  }
  for (const r of p.requirements) {
    if (
      r.claimIds.some((id) => claimIds.includes(id)) ||
      r.sourceIds.some((id) => sourceIds.includes(id))
    ) {
      r.status = "needs_review";
      review(p, "requirement", r.id, r.status, "参照する根拠が更新されました");
    }
  }
}

// v1の関連は保持するが、検証された主張だとは扱わない。
export function legacyEvidence(p: Project, sourceId: string) {
  const eid = `legacy_e_${sourceId}`;
  if (!p.evidence.some((e) => e.id === eid)) {
    const s = p.sources.find((s) => s.id === sourceId)!;
    p.evidence.push({
      id: eid,
      sourceId,
      sourceRevision: s.revision,
      revision: 1,
      sourceType: "report",
      excerpt:
        "旧版から移行した資料参照。本文を確認し、具体的な抜粋・要約に更新してください。",
      verificationStatus: "unverified",
    });
  }
  return eid;
}
export function normalizeRequirement(p: Project, r: RequirementInput) {
  const claimIds = [...(r.claimIds ?? [])];
  const covered = sourcesForClaims(p, claimIds);
  const direct = r.sourceIds.filter((id) => !covered.includes(id));
  if (direct.length) {
    const cid = `legacy_r_${createHash("sha256").update(r.id).digest("hex").slice(0, 32)}`;
    const existing = p.claims.find((c) => c.id === cid);
    const c: Claim = {
      id: cid,
      revision: (existing?.revision ?? 0) + 1,
      field: "requirement_basis",
      valueState: "known",
      value: r.description,
      evidenceIds: direct.map((id) => legacyEvidence(p, id)),
      verificationStatus: "unverified",
    };
    if (existing) Object.assign(existing, c);
    else p.claims.push(c);
    if (!claimIds.includes(cid)) claimIds.push(cid);
  }
  return { ...r, claimIds, sourceIds: sourcesForClaims(p, claimIds) };
}

export function migrateProject(input: unknown): Project {
  const version = (input as { schemaVersion: string }).schemaVersion;
  if (!["1.0", "2.0"].includes(version))
    throw new Error("未対応のProjectバージョンです");
  const old = structuredClone(input) as Project;
  if (old.schemaVersion === "2.0") return old;
  const p: Project = {
    ...old,
    schemaVersion: "2.0",
    scope: old.audience,
    outOfScope: old.constraints,
    evidence: [],
    claims: [],
    reviews: [],
  };
  for (const c of p.candidates) {
    c.status = "draft";
    for (const field of claimFields.filter((f) => f !== "requirement_basis")) {
      const value = ["features", "license", "maintenance"].includes(field)
        ? String(c[field as "features"])
        : "";
      const unknown = ["未確認", "unknown"].includes(value);
      p.claims.push({
        id: `legacy_c_${c.id}_${field}`,
        revision: 1,
        candidateId: c.id,
        field,
        valueState: unknown ? "unknown" : value ? "known" : "empty",
        value: unknown ? "" : value,
        evidenceIds: value
          ? c.sourceIds.map((id) => legacyEvidence(p, id))
          : [],
        verificationStatus: "unverified",
      });
    }
  }
  p.requirements = p.requirements.map((r) => {
    const result = {
      ...r,
      ...normalizeRequirement(p, r),
      status: r.status === "approved" ? ("needs_review" as const) : r.status,
    };
    if (r.status === "approved")
      review(
        p,
        "requirement",
        r.id,
        "needs_review",
        "v2移行: 主張・根拠の確認が必要です",
      );
    return result;
  });
  return p;
}
