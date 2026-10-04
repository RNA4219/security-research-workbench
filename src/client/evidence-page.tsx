import { EvidencePanel } from "./provenance.js";

import type { ActiveWorkbench } from "./app.js";
export function EvidencePage({ ctx }: { ctx: ActiveWorkbench }) {
  const { p, tab, run, mutate } = ctx;
  return (
    <>
      {" "}
      {tab === "evidence" && (
        <EvidencePanel p={p} submit={(c) => run(() => mutate(c))} />
      )}
    </>
  );
}
