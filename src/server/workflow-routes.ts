import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { id } from "../shared/model.js";
import { providerKind, workflowCommand } from "../shared/workflow.js";
import { workflowContext } from "./workflow-domain.js";
import type { Store } from "./store.js";
import { WorkflowStore } from "./workflow-store.js";
import { DomainError } from "../shared/domain-error.js";
import {
  workflowModelResponse,
  workflowRunCreateInput,
  workflowRunComparisonInput,
  type WorkflowRunSnapshot,
} from "../shared/workflow-run.js";
import {
  abortActiveWorkflowRuns,
  compareWorkflowRuns,
  createWorkflowRun,
  listWorkflowProviders,
  recoverInterruptedWorkflowRun,
  resumeWorkflowRun,
  stopWorkflowRun,
  submitWorkflowRunResponse,
  type WorkflowProviderDefinition,
  type WorkflowRunDependencies,
} from "./workflow-runner.js";
import {
  invokeOpenAICompatible,
  workflowProvidersFromEnvironment,
} from "./workflow-providers.js";

export type WorkflowRouteOptions = {
  workflowProviders?: WorkflowProviderDefinition[];
  workflowInvokeModel?: WorkflowRunDependencies["invokeModel"];
};
export async function registerWorkflowRoutes(
  app: FastifyInstance,
  store: Store,
  options: WorkflowRouteOptions = {},
) {
  const workflows = new WorkflowStore(store);
  const base = "/api/projects/:id/workflow";
  const project = (params: unknown) => z.object({ id }).parse(params).id;
  const revision = z.number().int().positive();
  app.post("/api/research/:id/adopt", async (req, reply) => {
    const { id: reportId } = z.object({ id: z.uuid() }).parse(req.params);
    z.strictObject({}).parse(req.body);
    return reply.code(201).send(workflows.adopt(reportId));
  });
  app.get(base, async (req) => workflows.get(project(req.params)));
  app.post(`${base}/commands`, async (req) => {
    const body = z
      .strictObject({ revision, command: workflowCommand })
      .parse(req.body);
    // Only the diagnostic service can attest that a binding was checked
    // against the pinned Git snapshot. Public/manual observations cannot.
    if (
      body.command.type === "finding-observation" &&
      body.command.modelSourceBinding !== undefined
    )
      throw new DomainError(
        "コード範囲の検証情報は診断処理が生成します。手動では登録できません",
      );
    const projectId = project(req.params);
    const next = workflows.command(projectId, body.revision, body.command);
    // 許可・原文・有効知識の更新後に、旧条件で後続の外部呼出しを始めない。
    if (
      next.revision !== body.revision &&
      ["scope", "document", "knowledge-review", "rule-review"].includes(
        body.command.type,
      )
    ) {
      for (const run of workflows.activeRuns(projectId))
        await stopWorkflowRun(projectId, run.id, deps);
    }
    return next;
  });
  app.post(`${base}/import-research`, async (req) => {
    const body = z
      .strictObject({ revision, researchId: z.uuid() })
      .parse(req.body);
    return workflows.import(
      project(req.params),
      body.revision,
      body.researchId,
    );
  });
  app.post(`${base}/context`, async (req) => {
    const body = z
      .strictObject({
        question: z.string().trim().min(1).max(10000),
        providerKind,
      })
      .parse(req.body);
    return workflowContext(
      workflows.get(project(req.params)),
      body.question,
      body.providerKind,
    );
  });
  app.get(`${base}/history`, async (req) =>
    workflows.history(project(req.params)),
  );
  app.get(`${base}/history/:revision`, async (req) => {
    const params = z
      .object({ id, revision: z.coerce.number().int().positive() })
      .parse(req.params);
    return workflows.historical(params.id, params.revision);
  });
  const providers =
    options.workflowProviders ?? workflowProvidersFromEnvironment();
  const deps: WorkflowRunDependencies = {
    store: {
      get: async (projectId, runId) => {
        try {
          return workflows.getRun(projectId, runId);
        } catch (error) {
          if (error instanceof DomainError && error.status === 404)
            return undefined;
          throw error;
        }
      },
      list: async (projectId) => workflows.listRuns(projectId),
      save: async (run, expected) => workflows.saveRun(run, expected ?? 0),
    },
    providers: () => providers,
    invokeModel: options.workflowInvokeModel ?? invokeOpenAICompatible,
  };
  for (const run of workflows.interruptedRuns())
    await recoverInterruptedWorkflowRun(run, deps);
  app.addHook("onClose", async () => {
    await abortActiveWorkflowRuns(deps);
  });
  const snapshot = (
    projectId: string,
    query: string,
    providerId: string,
  ): WorkflowRunSnapshot => {
    const state = workflows.get(projectId);
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) throw new DomainError("providerが見つかりません", 404);
    if (!state.scope.allowedProviderIds.includes(providerId))
      throw new DomainError("案件で許可されていないproviderです");
    if (
      !state.scope.allowedMethods.some(
        (method) => method === "manual-review" || method === "static-review",
      )
    )
      throw new DomainError(
        "案件で照会・レビューの確認方法が許可されていません",
      );
    const context = workflowContext(state, query, provider.kind);
    return {
      ...context,
      contextSnapshotRevision: state.revision,
      allowedProviderIds: state.scope.allowedProviderIds,
      ruleVersion: JSON.stringify(
        context.rules.map(({ id, revision }) => ({ id, revision })),
      ),
      knowledgeVersion: JSON.stringify(
        context.knowledge.map(({ id, revision }) => ({ id, revision })),
      ),
    };
  };
  app.get(`${base}/runs`, async (req) => ({
    runs: workflows.listRuns(project(req.params)),
    providers: listWorkflowProviders(deps),
  }));
  app.post(`${base}/runs`, async (req, reply) => {
    const projectId = project(req.params);
    const input = workflowRunCreateInput.parse(req.body);
    if (workflows.get(projectId).revision !== input.revision)
      throw new DomainError("案件が更新されました。再読込してください。", 409);
    const result = await createWorkflowRun(
      {
        projectId,
        input,
        snapshot: snapshot(projectId, input.query, input.providerId),
      },
      deps,
    );
    return reply.code(201).send(result);
  });
  const runParams = (params: unknown) =>
    z.object({ id, runId: id }).parse(params);
  app.get(`${base}/runs/:runId`, async (req) => {
    const p = runParams(req.params);
    return workflows.getRun(p.id, p.runId);
  });
  app.post(`${base}/runs/:runId/stop`, async (req) => {
    const p = runParams(req.params);
    z.strictObject({}).parse(req.body);
    return stopWorkflowRun(p.id, p.runId, deps);
  });
  app.post(`${base}/runs/:runId/resume`, async (req) => {
    const p = runParams(req.params);
    z.strictObject({}).parse(req.body);
    const old = workflows.getRun(p.id, p.runId);
    return resumeWorkflowRun(
      p.id,
      p.runId,
      snapshot(p.id, old.query, old.providerId),
      deps,
    );
  });
  app.post(`${base}/runs/:runId/response`, async (req) => {
    const p = runParams(req.params);
    const body = z
      .strictObject({ response: workflowModelResponse })
      .parse(req.body);
    const old = workflows.getRun(p.id, p.runId);
    return submitWorkflowRunResponse(
      p.id,
      p.runId,
      body.response,
      snapshot(p.id, old.query, old.providerId),
      deps,
    );
  });
  app.post(`${base}/runs/compare`, async (req) => {
    const p = project(req.params);
    const body = workflowRunComparisonInput.parse(req.body);
    const result = compareWorkflowRuns(
      workflows.getRun(p, body.leftRunId),
      workflows.getRun(p, body.rightRunId),
      body.evaluation,
    );
    store.artifact(
      p,
      "workflow-comparison",
      JSON.stringify({ ...body, result }),
    );
    return result;
  });
  app.post(`${base}/compare`, async (req) => {
    const p = project(req.params);
    const body = z
      .strictObject({
        leftRunId: id,
        rightRunId: id,
        labelSetId: z.string().trim().min(1).max(200),
        expectedFindingReferences: z.array(id).max(100),
        reviewTimeMsByRunId: z.record(
          id,
          z.number().finite().nonnegative().nullable(),
        ),
      })
      .parse(req.body);
    const left = workflows.getRun(p, body.leftRunId);
    const evaluation = {
      labelSetId: body.labelSetId,
      answerKeyDigest: createHash("sha256")
        .update(JSON.stringify([...body.expectedFindingReferences].sort()))
        .digest("hex"),
      target: left.target,
      targetVersion: left.targetVersion,
      contextFingerprint: left.contextFingerprint,
      knowledgeRefs: left.knowledgeRefs,
      ruleRefs: left.ruleRefs,
      expectedFindingReferences: body.expectedFindingReferences,
      reviewTimeMsByRunId: body.reviewTimeMsByRunId,
    };
    const result = compareWorkflowRuns(
      left,
      workflows.getRun(p, body.rightRunId),
      evaluation,
    );
    store.artifact(
      p,
      "workflow-comparison",
      JSON.stringify({ ...body, evaluation, result }),
    );
    return result;
  });
  return workflows;
}
