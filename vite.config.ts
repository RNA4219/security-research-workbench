import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createInstrumenter } from "istanbul-lib-instrument";
export default defineConfig(({ mode }) => ({
  plugins: [
    ...(mode === "coverage"
      ? [
          {
            name: "browser-coverage",
            enforce: "pre" as const,
            transform(code: string, id: string) {
              if (!/\/src\/client\/.*\.[tj]sx?$/.test(id.replaceAll("\\", "/")))
                return;
              const instrumenter = createInstrumenter({
                esModules: true,
                parserPlugins: ["typescript", "jsx"],
                produceSourceMap: true,
                coverageGlobalScope: "globalThis",
                coverageGlobalScopeFunc: false,
              });
              return {
                code: instrumenter.instrumentSync(code, id),
                map: instrumenter.lastSourceMap(),
              };
            },
          },
        ]
      : []),
    react(),
  ],
  build: {
    outDir:
      mode === "coverage" ? ".cache/coverage-build/client" : "dist/client",
  },
}));
