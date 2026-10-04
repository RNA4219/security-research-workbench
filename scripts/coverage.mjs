import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, relative } from "node:path";
import coverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { createHash } from "node:crypto";

const startedAt = new Date().toISOString();
const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "git failed");
  return result.stdout.trim();
};
const sourceFiles = git(
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "--",
  "src",
  "tests",
  "scripts",
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "vitest.config.ts",
  "playwright.config.ts",
  "playwright.pages.config.ts",
  "pages",
).split(/\r?\n/);
const sourceHashes = Object.fromEntries(
  [...new Set(sourceFiles)]
    .filter(Boolean)
    .map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
);
const runIdentity = {
  startedAt,
  head: git("rev-parse", "HEAD"),
  dirty: Boolean(git("status", "--porcelain")),
  sourceHashes,
  node: process.version,
  platform: process.platform,
};

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    stdio: "inherit",
    env: { ...process.env, WORKBENCH_COVERAGE: "1" },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// 固定されたテスト成果物だけを消す。過去の実行結果でカバレッジを水増ししない。
for (const name of [
  "coverage",
  "browser-coverage",
  "coverage-combined",
  "quality",
]) {
  const dir = resolve(".cache", name);
  if (
    !dir.startsWith(resolve(".cache") + "/") &&
    !dir.startsWith(resolve(".cache") + "\\")
  )
    throw new Error("Invalid output path");
  rmSync(dir, { recursive: true, force: true });
}
run("node_modules/typescript/bin/tsc", ["-p", "tsconfig.server.json"]);
run("node_modules/vitest/vitest.mjs", ["run", "--coverage"]);
run("node_modules/vite/bin/vite.js", ["build", "--mode", "coverage"]);
run("node_modules/@playwright/test/cli.js", ["test"]);
run("node_modules/vite/bin/vite.js", ["build", "--mode", "pages-coverage"]);
run("node_modules/@playwright/test/cli.js", [
  "test",
  "-c",
  "playwright.pages.config.ts",
]);
const map = coverage.createCoverageMap(
  JSON.parse(readFileSync(".cache/coverage/coverage-final.json", "utf8")),
);
const browser = coverage.createCoverageMap({});
for (const file of readdirSync(".cache/browser-coverage"))
  browser.merge(
    JSON.parse(readFileSync(`.cache/browser-coverage/${file}`, "utf8")),
  );
// 計測方式の異なるstatement mapを同じファイルへ加算しない。
for (const path of map
  .files()
  .filter((p) => p.replaceAll("\\", "/").includes("/src/client/"))) {
  const browserPath = browser.files().find((p) => resolve(p) === resolve(path));
  if (!browserPath) throw new Error(`Browser coverage missing: ${path}`);
  map.data[path] = browser.fileCoverageFor(browserPath);
}
const dir = ".cache/coverage-combined";
mkdirSync(dir, { recursive: true });
const ctx = libReport.createContext({ dir, coverageMap: map });
for (const type of ["text", "json", "json-summary", "lcovonly", "html"])
  reports.create(type).execute(ctx);
const metrics = map.getCoverageSummary().toJSON();
writeFileSync(
  `${dir}/run-identity.json`,
  JSON.stringify(
    { ...runIdentity, finishedAt: new Date().toISOString() },
    null,
    2,
  ),
);
// 全ソースを分母に残す。v0.1基準の変更行は参考値として別途保存する。
const baseline = "0d2faba8cc356f5c96f2bc28b316b95d2527cd8d";
const diff = spawnSync("git", ["diff", "--unified=0", baseline, "--", "src"], {
  encoding: "utf8",
});
if (diff.status !== 0)
  throw new Error(
    "Coverage baseline is unavailable; fetch repository history.",
  );
const changed = new Map();
let current;
for (const line of diff.stdout.split(/\r?\n/)) {
  if (line.startsWith("+++ b/")) {
    current = line.slice(6);
    changed.set(current, new Set());
  }
  const hunk = /^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (hunk && current)
    for (let n = 0; n < Number(hunk[2] ?? 1); n++)
      changed.get(current).add(Number(hunk[1]) + n);
}
const files = map.files().map((path) => {
  const name = relative(process.cwd(), path).replaceAll("\\", "/");
  const lines = Object.entries(
    map.fileCoverageFor(path).getLineCoverage(),
  ).filter(([n]) => changed.get(name)?.has(Number(n)));
  return {
    file: name,
    total: lines.length,
    covered: lines.filter(([, hits]) => hits > 0).length,
  };
});
const total = files.reduce((n, f) => n + f.total, 0),
  covered = files.reduce((n, f) => n + f.covered, 0);
const changedPct = total ? (covered / total) * 100 : 100;
const thresholds = { lines: 90, statements: 90, functions: 90, branches: 90 };
const failures = Object.entries(thresholds)
  .filter(([key, minimum]) => metrics[key].pct < minimum)
  .map(([key, minimum]) => `${key}: ${metrics[key].pct} < ${minimum}`);
for (const path of map.files()) {
  const file = map.fileCoverageFor(path).toSummary();
  if (file.lines.pct < 90)
    failures.push(
      `${relative(process.cwd(), path)} lines: ${file.lines.pct} < 90`,
    );
  if (file.branches.pct < 85)
    failures.push(
      `${relative(process.cwd(), path)} branches: ${file.branches.pct} < 85`,
    );
}
if (changedPct < 90)
  failures.push(`changed lines: ${changedPct.toFixed(2)} < 90`);
writeFileSync(
  `${dir}/gate.json`,
  JSON.stringify(
    {
      thresholds,
      metrics,
      changed: { baseline, total, covered, pct: changedPct, files },
      failures,
      verdict: failures.length ? "fail" : "pass",
    },
    null,
    2,
  ),
);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
