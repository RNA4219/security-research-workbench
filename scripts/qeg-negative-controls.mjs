import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// Run deliberately corrupted copies. The accepted evidence package is never edited.
const [input, cli, output] = process.argv.slice(2).map((p) => resolve(p));
if (!input || !cli || !output || existsSync(output))
  throw Error("input / QEG CLI / fresh output directory are required");
const hash = (bytes) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
const results = [];
for (const name of [
  "positive",
  "hash-mismatch",
  "stale-build",
  "latest-failure",
  "missing-manual",
]) {
  const dir = resolve(output, name);
  mkdirSync(dir, { recursive: true });
  cpSync(resolve(input, "artifacts"), resolve(dir, "artifacts"), {
    recursive: true,
  });
  const envelope = JSON.parse(
    readFileSync(resolve(input, "gate-input.json"), "utf8"),
  );
  const node = envelope.graph.nodes.find((n) => n.id === "exec-unit-suite");
  const rawPath = resolve(dir, node.execution.rawArtifactRef.path);
  if (name === "hash-mismatch")
    writeFileSync(rawPath, readFileSync(rawPath, "utf8") + "\n");
  if (name === "stale-build")
    node.execution.target = {
      ...node.execution.target,
      revision: "0".repeat(40),
    };
  if (name === "missing-manual") {
    const manual = envelope.graph.nodes.find(
      (n) => n.id === "exec-TC-FINAL-03",
    );
    unlinkSync(resolve(dir, manual.execution.rawArtifactRef.path));
  }
  if (name === "latest-failure") {
    node.passed = false;
    node.execution.status = "fail";
    const raw = JSON.parse(readFileSync(rawPath, "utf8"));
    raw.status = "fail";
    const bytes = JSON.stringify(raw, null, 2) + "\n";
    writeFileSync(rawPath, bytes);
    const digest = hash(bytes);
    node.execution.rawArtifactRef.contentHash = digest;
    for (const ref of node.evidenceRefs)
      if (ref.path === node.execution.rawArtifactRef.path)
        ref.contentHash = digest;
    for (const metadata of [envelope.metadata, envelope.graph.metadata])
      for (const ref of metadata.inputArtifacts)
        if (ref.path === node.execution.rawArtifactRef.path)
          ref.contentHash = digest;
  }
  writeFileSync(
    resolve(dir, "gate-input.json"),
    JSON.stringify(envelope, null, 2),
  );
  const run = spawnSync(process.execPath, [cli, "gate", dir], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  writeFileSync(resolve(dir, "stdout.log"), run.stdout);
  writeFileSync(resolve(dir, "stderr.log"), run.stderr);
  const result = JSON.parse(run.stdout.slice(run.stdout.indexOf("{")));
  const expected =
    name === "positive"
      ? "go"
      : name === "latest-failure"
        ? "no_go"
        : "disqualified";
  if (
    result.verdict !== expected ||
    (run.status === 0) !== (name === "positive")
  )
    throw Error(`${name}: unexpected ${result.verdict}/${run.status}`);
  results.push({
    name,
    expected,
    actual: result.verdict,
    exitCode: run.status,
    dqCodes: [...new Set(result.disqualifications.map((d) => d.code))],
    blockers: result.blockers.length,
  });
}
writeFileSync(
  resolve(output, "summary.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(JSON.stringify(results, null, 2));
