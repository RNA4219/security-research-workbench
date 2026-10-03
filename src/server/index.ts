import { createApp } from "./app.js";
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORTが不正です");
const app = await createApp({
  port,
  dbPath: process.env.DATA_PATH,
  memxUrl: process.env.MEMX_URL,
});
await app.listen({ host: "127.0.0.1", port });
console.log(`Security Research Workbench: http://127.0.0.1:${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
