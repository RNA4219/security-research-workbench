import { test as base, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const test = base.extend<{ collectCoverage: void }>({
  collectCoverage: [
    async ({ context }, use) => {
      if (process.env.WORKBENCH_COVERAGE !== "1") {
        await use();
        return;
      }
      const save = (coverage: unknown) => {
        if (!coverage) return;
        mkdirSync(".cache/browser-coverage", { recursive: true });
        writeFileSync(
          `.cache/browser-coverage/${randomUUID()}.json`,
          JSON.stringify(coverage),
        );
      };
      await context.exposeBinding("saveWorkbenchCoverage", (_, coverage) =>
        save(coverage),
      );
      await context.addInitScript(() => {
        addEventListener("beforeunload", () => {
          const w = window as unknown as {
            __coverage__?: unknown;
            saveWorkbenchCoverage: (c: unknown) => Promise<void>;
          };
          void w.saveWorkbenchCoverage(w.__coverage__);
        });
      });
      await use();
      for (const page of context.pages()) {
        if (!page.isClosed())
          save(
            await page.evaluate(
              () =>
                (window as unknown as { __coverage__?: unknown }).__coverage__,
            ),
          );
      }
    },
    { auto: true },
  ],
});
export { expect };
