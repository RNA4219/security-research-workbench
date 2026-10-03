import { createApp } from "../../dist/server/app.js";
// テスト専用の起動入口。利用者の4317番ポート・DB・製品ビルドは変更しない。
const app = await createApp({
  port: 4318,
  dbPath: process.env.DATA_PATH,
  staticRoot:
    process.env.WORKBENCH_COVERAGE === "1"
      ? ".cache/coverage-build/client"
      : "dist/client",
});
await app.listen({ port: 4318, host: "127.0.0.1" });
