import type { z } from "zod";
import type { internalTaskContractSchema } from "../shared/model.js";

type Contract = z.infer<typeof internalTaskContractSchema>;
// importは出力操作時だけ実行する。Coreの型・永続データは上流Schemaに依存しない。
export async function convertAgentProtocols(
  contract: Contract,
  createdAt: string,
  updatedAt: string,
) {
  const name = "@rna4219/agent-protocols";
  const api = await import(name);
  for (const method of [
    "createDeterministicContractId",
    "deriveGenerationPolicy",
    "parseContract",
    "validateContractGraph",
  ]) {
    if (typeof api[method] !== "function")
      throw new Error("Unsupported agent-protocols API");
  }
  const common = {
    schemaVersion: "2.0.0",
    lifecycle: "draft",
    revision: 1,
    createdAt: updatedAt,
    updatedAt,
  };
  const capabilities = ["read_repo", "write_repo"];
  const key = `${contract.projectId}:${contract.projectRevision}`;
  const intentId = api.createDeterministicContractId(
    "IntentContract",
    key,
    createdAt,
  );
  const intent = api.parseContract({
    ...common,
    kind: "IntentContract",
    id: intentId,
    intent: `${contract.objective}\n対象: ${contract.scope}\n対象外: ${contract.outOfScope}`,
    creator: "security-research-workbench",
    priority: "medium",
    requestedCapabilities: capabilities,
  });
  const tasks = contract.requirements.map((r) => {
    const claims = contract.claims.filter((c) => r.claimIds.includes(c.id));
    const evidence = contract.evidence.filter((e) =>
      claims.some((c) => c.evidenceIds.includes(e.id)),
    );
    const sources = contract.sourceRefs.filter((s) =>
      r.sourceRefs.includes(s.id),
    );
    const candidates = contract.candidates.filter((c) =>
      claims.some((cl) => cl.candidateId === c.id),
    );
    return api.parseContract({
      ...common,
      kind: "TaskSeed",
      id: api.createDeterministicContractId(
        "TaskSeed",
        `${key}:${r.id}`,
        createdAt,
      ),
      intentId,
      description: `${r.id}: ${r.title}\n${r.description}\n受入条件:\n${r.acceptanceCriteria.join("\n")}\n判断: ${r.rationale}\n根拠グラフ:\n${JSON.stringify({ candidates, claims, evidence, sources })}`,
      ownerRole: "developer",
      executionPlan: r.tasks,
      requestedCapabilitiesSnapshot: capabilities,
      generationPolicy: api.deriveGenerationPolicy(capabilities),
    });
  });
  const output = [intent, ...tasks];
  if (!api.validateContractGraph(output).valid)
    throw new Error("Unsupported contract graph");
  return output;
}
