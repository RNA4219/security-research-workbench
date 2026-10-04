import { createHash, randomUUID } from "node:crypto";
import { claimFields } from "../shared/model.js";
import {
  claimReady,
  invalidate,
  normalizeRequirement,
  review,
  sourcesForClaims,
} from "./provenance.js";
import {
  replySchema,
  type Command,
  type Project,
  type ProjectInput,
  type SourceInput,
} from "../shared/model.js";

import {
  DomainError,
  checkRefs,
  readyRequirement,
  refs,
} from "./validation.js";
export { DomainError } from "./validation.js";
export { prompt, internalContract, contracts, markdown } from "./exports.js";
export function newProject(input: ProjectInput): Project {
  const now = new Date().toISOString();
  return {
    ...input,
    schemaVersion: "2.0",
    id: randomUUID(),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    sources: [],
    candidates: [],
    requirements: [],
    evidence: [],
    claims: [],
    reviews: [],
  };
}
function addSource(p: Project, value: SourceInput, sourceId?: string) {
  const hash = createHash("sha256").update(value.body).digest("hex");
  const current = sourceId
    ? p.sources.find((s) => s.id === sourceId)
    : undefined;
  if (sourceId && !current) throw new DomainError("資料がありません", 404);
  if (current) {
    if (
      (["title", "url", "retrievedAt", "version", "body"] as const).every(
        (key) => value[key] === current[key],
      )
    )
      return;
    const { history, id, ...previous } = current;
    Object.assign(current, value, {
      hash,
      revision: current.revision + 1,
      history: [...history, previous],
    });
    const eids = p.evidence
      .filter((e) => e.sourceId === id)
      .map((e) => {
        e.verificationStatus = "unverified";
        return e.id;
      });
    const cids = p.claims
      .filter((c) => c.evidenceIds.some((eid) => eids.includes(eid)))
      .map((c) => {
        c.verificationStatus = "unverified";
        return c.id;
      });
    invalidate(p, cids, [id]);
  } else if (
    !p.sources.some(
      (s) =>
        s.hash === hash && s.url === value.url && s.version === value.version,
    )
  ) {
    p.sources.push({
      ...value,
      id: randomUUID(),
      hash,
      revision: 1,
      history: [],
    });
  }
}
export function applyCommand(original: Project, command: Command): Project {
  const p = structuredClone(original);
  switch (command.type) {
    case "project":
      if (
        p.objective !== command.value.objective ||
        p.audience !== command.value.audience ||
        p.constraints !== command.value.constraints ||
        p.scope !== command.value.scope ||
        p.outOfScope !== command.value.outOfScope
      ) {
        for (const r of p.requirements) {
          r.status = "needs_review";
          review(
            p,
            "requirement",
            r.id,
            r.status,
            "プロジェクトの前提が更新されました",
          );
        }
        for (const c of p.candidates) {
          c.status = "needs_review";
          review(
            p,
            "candidate",
            c.id,
            c.status,
            "プロジェクトの前提が更新されました",
          );
        }
      }
      Object.assign(p, command.value);
      break;
    case "source":
      addSource(p, command.value, command.sourceId);
      break;
    case "sources":
      for (const value of command.value.sources) addSource(p, value);
      break;
    case "candidate": {
      refs(p, command.value.sourceIds);
      const current =
        command.candidateId &&
        p.candidates.find((c) => c.id === command.candidateId);
      if (command.candidateId && !current)
        throw new DomainError("比較候補がありません", 404);
      const cid = current ? current.id : randomUUID();
      if (current) {
        invalidate(
          p,
          p.claims.filter((c) => c.candidateId === cid).map((c) => c.id),
        );
        Object.assign(current, command.value, { status: "draft" });
      } else p.candidates.push({ ...command.value, id: cid, status: "draft" });
      for (const field of claimFields.filter(
        (f) => f !== "requirement_basis",
      )) {
        const existing = p.claims.find(
          (c) => c.candidateId === cid && c.field === field,
        );
        const legacy = ["features", "license", "maintenance"].includes(field);
        const value = legacy ? String(command.value[field as "features"]) : "";
        if (
          existing &&
          (!legacy ||
            existing.value === value ||
            (existing.valueState === "unknown" && value === "未確認") ||
            (existing.valueState === "empty" && value === "値なし"))
        )
          continue;
        const unknown = ["未確認", "unknown"].includes(value);
        const input = {
          candidateId: cid,
          field,
          valueState: unknown
            ? ("unknown" as const)
            : value
              ? ("known" as const)
              : ("empty" as const),
          value: unknown ? "" : value,
          evidenceIds: [] as string[],
          verificationStatus: "unverified" as const,
        };
        if (existing)
          Object.assign(existing, input, { revision: existing.revision + 1 });
        else p.claims.push({ ...input, id: randomUUID(), revision: 1 });
      }
      break;
    }
    case "evidence": {
      refs(p, [command.value.sourceId]);
      const old = p.evidence.find((e) => e.id === command.evidenceId);
      if (command.evidenceId && !old)
        throw new DomainError("Evidenceがありません", 404);
      const value = {
        ...command.value,
        sourceRevision: p.sources.find((s) => s.id === command.value.sourceId)!
          .revision,
      };
      if (old) {
        Object.assign(old, value, { revision: old.revision + 1 });
        const cids = p.claims
          .filter((c) => c.evidenceIds.includes(old.id))
          .map((c) => {
            c.verificationStatus = "unverified";
            return c.id;
          });
        invalidate(p, cids);
      } else p.evidence.push({ ...value, id: randomUUID(), revision: 1 });
      break;
    }
    case "claim": {
      checkRefs(command.value.evidenceIds, p.evidence, "Evidence");
      if (command.value.candidateId)
        checkRefs([command.value.candidateId], p.candidates, "候補");
      const old = p.claims.find((c) => c.id === command.claimId);
      if (command.claimId && !old)
        throw new DomainError("Claimがありません", 404);
      if (
        old &&
        (old.candidateId !== command.value.candidateId ||
          old.field !== command.value.field)
      )
        throw new DomainError("主張の所属と項目は変更できません");
      if (
        command.value.candidateId &&
        p.claims.some(
          (c) =>
            c.id !== command.claimId &&
            c.candidateId === command.value.candidateId &&
            c.field === command.value.field,
        )
      )
        throw new DomainError("同じ比較項目が既にあります");
      const value = {
        ...command.value,
        id: old?.id ?? randomUUID(),
        revision: (old?.revision ?? 0) + 1,
      };
      if (
        value.verificationStatus === "verified" &&
        (value.valueState !== "known" || !claimReady(p, value))
      )
        throw new DomainError(
          "確認済みの主張には現在の資料に基づく確認済みEvidenceが必要です",
        );
      if (old) Object.assign(old, value);
      else p.claims.push(value);
      invalidate(p, [value.id]);
      const candidate = p.candidates.find((c) => c.id === value.candidateId);
      if (
        candidate &&
        ["features", "license", "maintenance"].includes(value.field)
      )
        candidate[value.field as "features"] =
          value.valueState === "known"
            ? value.value
            : value.valueState === "unknown"
              ? "未確認"
              : "値なし";
      break;
    }
    case "candidate-review": {
      const c = p.candidates.find((c) => c.id === command.candidateId);
      if (!c) throw new DomainError("比較候補がありません", 404);
      const claims = p.claims.filter((cl) => cl.candidateId === c.id);
      if (
        command.status === "approved" &&
        (!claims.length || claims.some((cl) => !claimReady(p, cl)))
      )
        throw new DomainError(
          "比較項目の主張とEvidenceを確認してください",
          409,
        );
      c.status = command.status;
      review(p, "candidate", c.id, c.status, command.note);
      break;
    }
    case "reply": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(command.raw);
      } catch {
        throw new DomainError(
          "JSONを解析できません。コードフェンスを除いて確認してください。",
        );
      }
      const reply = replySchema.parse(parsed);
      if (
        new Set(reply.requirements.map((r) => r.id)).size !==
        reply.requirements.length
      )
        throw new DomainError("要件IDが重複しています");
      for (const r of reply.requirements) {
        refs(p, r.sourceIds);
        checkRefs(r.claimIds ?? [], p.claims, "Claim");
        if (p.requirements.some((existing) => existing.id === r.id))
          throw new DomainError(
            `要件ID ${r.id} は既存です。編集画面を使ってください。`,
            409,
          );
        p.requirements.push({
          ...normalizeRequirement(p, r),
          status: "draft",
          sourceVersions: {},
        });
      }
      break;
    }
    case "requirement": {
      refs(p, command.value.sourceIds);
      checkRefs(command.value.claimIds ?? [], p.claims, "Claim");
      const r = p.requirements.find((r) => r.id === command.value.id);
      if (!r) throw new DomainError("要件がありません", 404);
      Object.assign(r, normalizeRequirement(p, command.value), {
        status: "draft",
        sourceVersions: {},
      });
      review(p, "requirement", r.id, "draft", "要件を編集しました");
      break;
    }
    case "review": {
      const r = p.requirements.find((r) => r.id === command.requirementId);
      if (!r) throw new DomainError("要件がありません", 404);
      refs(p, r.sourceIds);
      if (command.status === "approved") readyRequirement(p, r);
      r.status = command.status;
      r.sourceIds = sourcesForClaims(p, r.claimIds);
      review(p, "requirement", r.id, r.status, command.note);
      r.sourceVersions = Object.fromEntries(
        r.sourceIds.map((id) => [
          id,
          p.sources.find((s) => s.id === id)!.revision,
        ]),
      );
    }
  }
  for (const r of p.requirements) r.sourceIds = sourcesForClaims(p, r.claimIds);
  p.revision++;
  p.updatedAt = new Date().toISOString();
  return p;
}
