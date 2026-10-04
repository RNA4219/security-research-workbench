import { createApp } from "./app.js";
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORTが不正です");
const app = await createApp({
  port,
  dbPath: process.env.DATA_PATH ?? ".data/workbench.db",
  memxUrl: process.env.MEMX_URL ?? "",
  diagnosticsRepositories: parseDiagnosticsRepositories(
    process.env.WORKBENCH_DIAGNOSTIC_REPOSITORIES,
  ),
});
await app.listen({ host: "127.0.0.1", port });
console.log(`Security Research Workbench: http://127.0.0.1:${port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });

function parseDiagnosticsRepositories(
  value: string | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    const result: Record<string, string> = {};
    for (const [id, path] of Object.entries(parsed)) {
      if (typeof path !== "string") throw new Error();
      result[id] = path;
    }
    return result;
  } catch {
    throw new Error("WORKBENCH_DIAGNOSTIC_REPOSITORIESの形式が不正です");
  }
}
