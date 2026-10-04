import { createApp } from "../../dist/server/app.js";
import { researchFetcher } from "../research-fixtures.ts";
import { createDiagnosticFixture } from "../diagnostic-fixture.mjs";
// テスト専用の起動入口。利用者の4317番ポート・DB・製品ビルドは変更しない。
const diagnosticFixture = await createDiagnosticFixture();
const app = await createApp({
  port: 4318,
  dbPath: process.env.DATA_PATH,
  researchFetch: researchFetcher(),
  diagnosticsRepositories: { fixture: diagnosticFixture.directory },
  staticRoot:
    process.env.WORKBENCH_COVERAGE === "1"
      ? ".cache/coverage-build/client"
      : "dist/client",
});
await app.listen({ port: 4318, host: "127.0.0.1" });
