import { createReviewSnapshotEngine } from "./model-review-evaluation.mjs";

// Build first so this adapter imports the production TypeScript contract and
// never introduces a second review implementation for the evaluation.
const production = await import("../dist/server/model-review.js");
const providersModule = await import("../dist/server/workflow-providers.js");

const providerId = process.env.MODEL_REVIEW_PROVIDER ?? "local";
const provider = providersModule
  .workflowProvidersFromEnvironment()
  .find((candidate) => candidate.id === providerId);
if (!provider) throw new Error(`model providerが見つかりません: ${providerId}`);
if (!provider.available || !provider.endpoint)
  throw new Error(`model providerが利用できません: ${providerId}`);

const modelProvider = production.modelReviewProviderFromWorkflowProvider(provider);
const invoke = production.createOpenAICompatibleModelReviewInvoker(provider);

export const modelReviewEngine = createReviewSnapshotEngine({
  reviewSnapshot: production.reviewSnapshot,
  provider: modelProvider,
  invoke,
});
