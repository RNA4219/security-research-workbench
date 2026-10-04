import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError } from "../shared/domain-error.js";
import {
  diagnosticRunSchema,
  productInputSchema,
  productSettingsSchema,
  runInputSchema,
} from "../shared/product-diagnostics.js";
import type { Store } from "./store.js";
import {
  ProductDiagnosticsService,
  type DiagnosticServiceOptions,
} from "./diagnostic-service.js";

const productId = z.string().uuid();

export function registerDiagnosticRoutes(
  app: FastifyInstance,
  store: Store,
  options: DiagnosticServiceOptions = {},
) {
  const service = new ProductDiagnosticsService(store, options);
  app.addHook("onClose", async () => service.close());

  app.get("/api/diagnostics/repositories", async () =>
    service.listRepositories(),
  );
  app.get("/api/products", async () => service.listProducts());
  app.post("/api/products", async (req, reply) =>
    reply
      .code(201)
      .send(service.createProduct(productInputSchema.parse(req.body))),
  );
  app.get("/api/products/:id", async (req) => {
    const { id } = z.strictObject({ id: productId }).parse(req.params);
    return service.detail(id);
  });
  app.post("/api/products/:id/settings", async (req) => {
    const { id } = z.strictObject({ id: productId }).parse(req.params);
    const body = productSettingsSchema.parse(req.body);
    const { revision, ...change } = body;
    return service.updateProduct(id, revision, change);
  });
  app.get("/api/products/:id/runs", async (req) => {
    const { id } = z.strictObject({ id: productId }).parse(req.params);
    return service.listRuns(id);
  });
  app.post("/api/products/:id/runs", async (req, reply) => {
    const { id } = z.strictObject({ id: productId }).parse(req.params);
    const input = runInputSchema.parse(req.body);
    if (input.trigger === "schedule")
      throw new DomainError(
        "schedule runは製品設定からの定期実行でのみ開始します",
      );
    return reply.code(202).send(await service.startRun(id, input));
  });
  app.get("/api/products/:id/runs/:runId", async (req) => {
    const params = z
      .strictObject({ id: productId, runId: productId })
      .parse(req.params);
    return diagnosticRunSchema.parse(service.getRun(params.id, params.runId));
  });
  app.post("/api/products/:id/runs/:runId/stop", async (req) => {
    z.strictObject({}).parse(req.body ?? {});
    const params = z
      .strictObject({ id: productId, runId: productId })
      .parse(req.params);
    return service.stop(params.id, params.runId);
  });
  app.post("/api/products/:id/runs/:runId/resume", async (req, reply) => {
    z.strictObject({}).parse(req.body ?? {});
    const params = z
      .strictObject({ id: productId, runId: productId })
      .parse(req.params);
    return reply
      .code(202)
      .send(await service.resumeRun(params.id, params.runId));
  });
  return service;
}
