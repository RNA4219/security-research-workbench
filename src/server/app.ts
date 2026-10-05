import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./store.js";
import {
  registerWorkflowRoutes,
  type WorkflowRouteOptions,
} from "./workflow-routes.js";
import { registerDiagnosticRoutes } from "./diagnostic-routes.js";
import { Memx } from "./memx.js";
import { lookupVulnerability } from "./vulnerability.js";
import {
  DomainError,
  contracts,
  internalContract,
  markdown,
  prompt,
} from "./domain.js";
import {
  id,
  projectInput,
  mutationSchema,
  internalTaskContractJsonSchema,
} from "../shared/model.js";
import { cveId } from "../shared/vulnerability.js";
import { researchInput } from "../shared/repository-research.js";
import {
  researchRepository,
  researchMarkdown,
} from "../research/repository-research.js";
import type { ModelReviewBudget } from "../shared/model-review.js";

export async function createApp(
  options: WorkflowRouteOptions & {
    dbPath?: string;
    port?: number;
    memxUrl?: string;
    staticRoot?: string;
    vulnerabilityFetch?: typeof fetch;
    researchFetch?: typeof fetch;
    diagnosticsRepositories?: Record<string, string>;
    diagnosticsFetch?: typeof fetch;
    diagnosticsScheduleIntervalMs?: number;
    modelReviewBudget?: Partial<ModelReviewBudget>;
    modelReviewBatchSize?: number;
    modelReviewTimeoutMs?: number;
  } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const store = new Store(options.dbPath ?? ".data/workbench.db");
  const memx = new Memx(options.memxUrl);
  const port = options.port ?? 4317;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  app.addHook("onClose", async () => store.close());
  app.addHook("onRequest", async (req, reply) => {
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    if (!hosts.has(req.headers.host ?? ""))
      return reply.code(403).send({ error: "Hostが許可されていません" });
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    )
      return reply.code(403).send({ error: "Originが許可されていません" });
    if (req.url.startsWith("/api/") && req.headers["x-workbench"] !== "1")
      return reply.code(403).send({ error: "X-Workbenchヘッダーが必要です" });
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: "入力形式を確認してください",
        issues: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    if (error instanceof DomainError)
      return reply.code(error.status).send({ error: error.message });
    const e = error as { statusCode?: number };
    const code = e.statusCode && e.statusCode < 500 ? e.statusCode : 500;
    return reply.code(code).send({
      error:
        code === 500
          ? "処理に失敗しました。入力は画面に保持されています。"
          : "リクエスト形式またはサイズを確認してください",
    });
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get(
    "/api/schemas/task-contract",
    async () => internalTaskContractJsonSchema,
  );
  app.get("/api/config", async () => ({ memx: memx.enabled }));
  await registerWorkflowRoutes(app, store, options);
  registerDiagnosticRoutes(app, store, {
    repositories: options.diagnosticsRepositories,
    fetcher: options.diagnosticsFetch,
    scheduleIntervalMs: options.diagnosticsScheduleIntervalMs,
    workflowProviders: options.workflowProviders,
    workflowInvokeModel: options.workflowInvokeModel,
    modelReviewBudget: options.modelReviewBudget,
    modelReviewBatchSize: options.modelReviewBatchSize,
    modelReviewTimeoutMs: options.modelReviewTimeoutMs,
  });
  let researching = false;
  app.get("/api/research", async () => store.listResearch());
  app.get("/api/research/:id", async (req) =>
    store.getResearch(z.object({ id: z.uuid() }).parse(req.params).id),
  );
  app.get("/api/research/:id/markdown", async (req, reply) => {
    const report = store.getResearch(
      z.object({ id: z.uuid() }).parse(req.params).id,
    );
    return reply
      .header(
        "Content-Disposition",
        'attachment; filename="repository-research.md"',
      )
      .type("text/markdown; charset=utf-8")
      .send(researchMarkdown(report));
  });
  app.post("/api/research", async (req, reply) => {
    const { repoUrl } = researchInput.parse(req.body);
    if (researching)
      throw new DomainError(
        "別の調査を実行中です。完了してから再試行してください。",
        429,
      );
    researching = true;
    try {
      return reply
        .code(201)
        .send(
          store.saveResearch(
            await researchRepository(repoUrl, options.researchFetch),
          ),
        );
    } finally {
      researching = false;
    }
  });
  app.post("/api/vulnerabilities/lookup", async (req) => {
    const body = z.strictObject({ cveId }).parse(req.body);
    return lookupVulnerability(body.cveId, options.vulnerabilityFetch);
  });
  app.get("/api/projects", async () => store.list());
  app.post("/api/projects", async (req, reply) =>
    reply.code(201).send(store.create(projectInput.parse(req.body))),
  );
  const projectId = (params: unknown) => z.object({ id }).parse(params).id;
  app.get("/api/projects/:id", async (req) => store.get(projectId(req.params)));
  app.post("/api/projects/:id/commands", async (req) => {
    const pid = projectId(req.params);
    const input = mutationSchema.parse(req.body);
    if (input.command.type === "reply")
      store.artifact(pid, "ai-response", input.command.raw);
    return store.mutate(pid, input.revision, input.command);
  });
  app.post("/api/projects/:id/prompt", async (req) => {
    const pid = projectId(req.params);
    const body = z
      .strictObject({ sourceIds: z.array(id).min(1).max(100) })
      .parse(req.body);
    const output = prompt(store.get(pid), body.sourceIds);
    store.artifact(pid, "prompt", output);
    return { prompt: output };
  });
  app.get("/api/projects/:id/export/:format", async (req, reply) => {
    const { id: pid, format } = z
      .object({
        id,
        format: z.enum(["json", "markdown", "contracts", "agent-protocols"]),
      })
      .parse(req.params);
    const p = store.get(pid);
    const output =
      format === "markdown"
        ? markdown(p)
        : JSON.stringify(
            format === "contracts"
              ? internalContract(p)
              : format === "agent-protocols"
                ? await contracts(p)
                : p,
            null,
            2,
          );
    store.artifact(pid, `export-${format}`, output);
    return reply
      .header(
        "Content-Disposition",
        `attachment; filename="workbench-${format}.${format === "markdown" ? "md" : "json"}"`,
      )
      .type(
        format === "markdown"
          ? "text/markdown; charset=utf-8"
          : "application/json",
      )
      .send(output);
  });
  app.get("/api/projects/:id/history", async (req) =>
    store.history(projectId(req.params)),
  );
  app.get("/api/projects/:id/history/:revision", async (req) => {
    const { id: pid, revision } = z
      .object({ id, revision: z.coerce.number().int().positive() })
      .parse(req.params);
    return store.revision(pid, revision);
  });
  app.get("/api/projects/:id/artifacts", async (req) =>
    store.artifacts(projectId(req.params)),
  );
  app.post("/api/projects/:id/memx", async (req) => {
    const p = store.get(projectId(req.params));
    const body = z
      .discriminatedUnion("action", [
        z.strictObject({ action: z.literal("sync") }),
        z.strictObject({ action: z.literal("stale") }),
        z.strictObject({
          action: z.literal("search"),
          query: z.string().min(1).max(500),
        }),
        z.strictObject({ action: z.enum(["chunks", "ack"]), sourceId: id }),
      ])
      .parse(req.body);
    switch (body.action) {
      case "sync":
        return memx.sync(p, store);
      case "stale":
        return memx.stale(p);
      case "search":
        return memx.search(p, body.query);
      default:
        return memx.source(p, store, body.sourceId, body.action === "ack");
    }
  });
  const root = resolve(options.staticRoot ?? "dist/client");
  if (existsSync(root)) await app.register(fastifyStatic, { root });
  return app;
}
