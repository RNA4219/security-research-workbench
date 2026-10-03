import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
const reportDir =
  process.env.WORKBENCH_COVERAGE === "1"
    ? ".cache/quality"
    : ".cache/e2e-report";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 30000,
  reporter: [
    ["list"],
    ["junit", { outputFile: `${reportDir}/e2e-junit.xml` }],
    ["json", { outputFile: `${reportDir}/e2e-results.json` }],
  ],
  use: {
    baseURL: "http://127.0.0.1:4318",
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/e2e/server.mjs",
    url: "http://127.0.0.1:4318/healthz",
    reuseExistingServer: false,
    env: {
      PORT: "4318",
      DATA_PATH: `.cache/e2e-${randomUUID()}.db`,
      MEMX_URL: "",
    },
  },
});
