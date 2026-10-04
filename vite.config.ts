import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createInstrumenter } from "istanbul-lib-instrument";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
export default defineConfig(({ mode }) => ({
  root: mode.startsWith("pages") ? "pages" : ".",
  base: mode.startsWith("pages") ? "/open/security-research-workbench/" : "/",
  resolve: { alias: { "/src": resolve("src") } },
  plugins: [
    ...(mode.startsWith("pages")
      ? [
          {
            name: "pages-licenses",
            generateBundle() {
              const content = [
                readFileSync("LICENSE", "utf8"),
                ...["react", "react-dom", "scheduler", "zod"].map(
                  (name) =>
                    `\n--- ${name} ---\n${readFileSync(`node_modules/${name}/LICENSE`, "utf8")}`,
                ),
              ].join("\n");
              this.emitFile({
                type: "asset",
                fileName: "THIRD_PARTY_LICENSES.txt",
                source: content,
              });
            },
          } satisfies Plugin,
        ]
      : []),
    ...(mode.includes("coverage")
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
    emptyOutDir: true,
    outDir:
      mode === "pages-coverage"
        ? "../.cache/coverage-pages"
        : mode === "pages"
          ? "../dist/pages"
          : mode === "coverage"
            ? ".cache/coverage-build/client"
            : "dist/client",
  },
}));
