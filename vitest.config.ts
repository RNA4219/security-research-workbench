import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    reporters: ["default", "junit"],
    outputFile: { junit: ".cache/quality/unit-junit.xml" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      reportsDirectory: ".cache/coverage",
      reporter: ["text", "json", "json-summary"],
    },
  },
});
