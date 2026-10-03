import { defineConfig, devices } from "@playwright/test";
import { randomUUID } from "node:crypto";
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:4318",
    ...devices["Desktop Chrome"],
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node dist/server/index.js",
    url: "http://127.0.0.1:4318/healthz",
    reuseExistingServer: false,
    env: {
      PORT: "4318",
      DATA_PATH: `.cache/e2e-${randomUUID()}.db`,
      MEMX_URL: "",
    },
  },
});
