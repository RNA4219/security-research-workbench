import { defineConfig, devices } from "@playwright/test";
const mode =
  process.env.WORKBENCH_COVERAGE === "1" ? "pages-coverage" : "pages";
export default defineConfig({
  testDir: "tests/pages",
  outputDir: "test-results/pages",
  workers: 1,
  reporter: [
    ["list"],
    ["junit", { outputFile: ".cache/quality/pages-junit.xml" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4319/open/security-research-workbench/",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --mode ${mode} --host 127.0.0.1 --port 4319 --strictPort`,
    url: "http://127.0.0.1:4319/open/security-research-workbench/",
    reuseExistingServer: false,
  },
});
