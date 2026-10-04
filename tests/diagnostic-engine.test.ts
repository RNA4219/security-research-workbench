import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeSnapshot,
  resolveRepositoryCommit,
  snapshotRepository,
} from "../src/server/diagnostic-engine.js";
import {
  diagnosticAnalysisSchema,
  type DiagnosticSnapshot,
} from "../src/shared/diagnostic-engine.js";

const repos: string[] = [];
async function makeRepo(files: Record<string, string | Buffer>) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "diagnostic-engine-"));
  repos.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "user.email",
    "diagnostic-test@example.invalid",
  ]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Diagnostic test"]);
  execFileSync("git", ["-C", repo, "config", "core.autocrlf", "false"]);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(repo, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  execFileSync("git", ["-C", repo, "add", "--all"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  return {
    repo,
    commit: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  };
}

async function makeFastRepo(files: Record<string, string>) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "diagnostic-engine-fast-"));
  repos.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  const rows = Object.entries(files);
  let stream =
    "commit refs/heads/fixture\n" +
    "committer Diagnostic Test <diagnostic-test@example.invalid> 0 +0000\n" +
    "data 7\nfixture\n";
  for (const [relative, content] of rows) {
    stream +=
      "M 100644 inline " +
      relative +
      "\ndata " +
      Buffer.byteLength(content) +
      "\n" +
      content +
      "\n";
  }
  stream += "done\n";
  execFileSync("git", ["-C", repo, "fast-import", "--quiet"], {
    input: stream,
  });
  return {
    repo,
    commit: execFileSync(
      "git",
      ["-C", repo, "rev-parse", "refs/heads/fixture"],
      {
        encoding: "utf8",
      },
    ).trim(),
  };
}

function snapshot(
  content: string,
  files: DiagnosticSnapshot["files"] = [],
  omitted: DiagnosticSnapshot["omitted"] = [],
): DiagnosticSnapshot {
  const selectedFiles = [
    { path: "src/client.ts", content },
    ...files.map(({ path: filePath, content: fileContent }) => ({
      path: filePath,
      content: fileContent,
    })),
  ]
    .map((file) => ({
      ...file,
      hash: createHash("sha256").update(file.content).digest("hex"),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifestHash = createHash("sha256")
    .update(
      JSON.stringify({
        files: selectedFiles.map(({ path: filePath, hash }) => [
          filePath,
          hash,
        ]),
        omitted,
      }),
    )
    .digest("hex");
  return {
    commit: "a".repeat(40),
    manifestHash,
    files: selectedFiles,
    omitted,
  };
}

function snapshotWithoutFiles(): DiagnosticSnapshot {
  const omitted: DiagnosticSnapshot["omitted"] = [];
  const manifestHash = createHash("sha256")
    .update(JSON.stringify({ files: [], omitted }))
    .digest("hex");
  return {
    commit: "a".repeat(40),
    manifestHash,
    files: [],
    omitted,
  };
}

afterEach(async () => {
  await Promise.all(
    repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })),
  );
});

describe("snapshotRepository", () => {
  it("reads a pinned commit, ignores working-tree edits, and excludes unsupported and secret paths", async () => {
    const fixture = await makeRepo({
      "src/client.ts": "export const safe = true;\n",
      "README.md": "not parsed",
      ".env": "TOKEN=never-read",
      "RSI-excluded/notes.ts": "export const ignored = true",
    });
    await writeFile(
      path.join(fixture.repo, "src/client.ts"),
      "export const changed = true;\n",
    );
    const result = await snapshotRepository(fixture.repo, fixture.commit);
    expect(result.commit).toBe(fixture.commit);
    expect(result.files.map((file) => file.path)).toEqual(["src/client.ts"]);
    expect(result.files[0]?.content).toContain("safe");
    expect(result.omitted.map(({ path: item }) => item)).toEqual(
      expect.arrayContaining(["README.md", ".env", "RSI-excluded/notes.ts"]),
    );
    await expect(snapshotRepository(fixture.repo, "HEAD")).rejects.toThrow();
  });

  it("honors cancellation and reports source file limits", async () => {
    const fixture = await makeRepo({ "src/large.ts": "x".repeat(262_145) });
    const result = await snapshotRepository(fixture.repo, fixture.commit);
    expect(result.files).toHaveLength(0);
    expect(result.omitted[0]?.reason).toContain("ファイルサイズ上限");
    const controller = new AbortController();
    controller.abort();
    await expect(
      snapshotRepository(fixture.repo, fixture.commit, controller.signal),
    ).rejects.toThrow();
  });

  it("resolves a user ref to a full immutable commit before taking its snapshot", async () => {
    const fixture = await makeRepo({
      "src/client.ts": "export const safe = true;\n",
    });
    const commit = await resolveRepositoryCommit(fixture.repo, "HEAD");
    expect(commit).toBe(fixture.commit);
    expect((await snapshotRepository(fixture.repo, commit)).commit).toBe(
      commit,
    );
    await expect(
      resolveRepositoryCommit(fixture.repo, "--help"),
    ).rejects.toThrow();
  });
  it("excludes symbolic links, submodules, and non-UTF8 source blobs", async () => {
    const fixture = await makeRepo({
      "src/binary.ts": Buffer.from([0xff, 0xfe, 0x00]),
      "src/client.ts": "export const safe = true;\n",
    });
    const linkedBlob = execFileSync(
      "git",
      ["-C", fixture.repo, "hash-object", "-w", "--stdin"],
      { input: Buffer.from("outside.ts") },
    )
      .toString("utf8")
      .trim();
    execFileSync("git", [
      "-C",
      fixture.repo,
      "update-index",
      "--add",
      "--cacheinfo",
      "120000," + linkedBlob + ",src/link.ts",
    ]);
    execFileSync("git", [
      "-C",
      fixture.repo,
      "update-index",
      "--add",
      "--cacheinfo",
      "160000," + fixture.commit + ",vendor/module",
    ]);
    execFileSync("git", ["-C", fixture.repo, "commit", "-qm", "links"]);
    const commit = execFileSync(
      "git",
      ["-C", fixture.repo, "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    ).trim();
    const result = await snapshotRepository(fixture.repo, commit);
    expect(result.files.map(({ path: item }) => item)).toEqual([
      "src/client.ts",
    ]);
    expect(result.omitted.map(({ path: item }) => item)).toEqual(
      expect.arrayContaining(["src/binary.ts", "src/link.ts", "vendor/module"]),
    );
  });

  it("caps source count and summarizes excess omitted paths", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 501; index += 1) {
      files["src/file-" + String(index).padStart(3, "0") + ".ts"] =
        "export const file" + index + " = true;\n";
    }
    const fixture = await makeFastRepo(files);
    const result = await snapshotRepository(fixture.repo, fixture.commit);
    expect(result.files).toHaveLength(500);
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0]?.reason).toContain("ファイル数上限");

    const unsupported: Record<string, string> = {};
    for (let index = 0; index < 502; index += 1) {
      unsupported["docs/file-" + String(index).padStart(3, "0") + ".txt"] =
        "text";
    }
    const omittedFixture = await makeFastRepo(unsupported);
    const omitted = await snapshotRepository(
      omittedFixture.repo,
      omittedFixture.commit,
    );
    expect(omitted.omitted).toHaveLength(500);
    expect(omitted.omitted.at(-1)?.path).toBe("(additional omitted paths)");
    expect(omitted.omitted.at(-1)?.reason).toContain("additional unassessed");
  }, 60_000);

  it("caps total snapshot bytes after enforcing each-file limits", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 18; index += 1) {
      files["src/file-" + index + ".ts"] = "x".repeat(250 * 1024);
    }
    const fixture = await makeRepo(files);
    const result = await snapshotRepository(fixture.repo, fixture.commit);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files.length).toBeLessThan(18);
    expect(result.omitted.some(({ reason }) => reason.includes("総容量"))).toBe(
      true,
    );
  });

  it("rejects a repository path containing an excluded segment", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "RSI-excluded-"));
    repos.push(parent);
    const excluded = path.join(parent, "copy");
    await mkdir(excluded);
    await expect(snapshotRepository(excluded, "a".repeat(40))).rejects.toThrow(
      "Excluded repository path",
    );
  });

  it("checks the resolved repository path before reading a directory symlink", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "diagnostic-link-"));
    repos.push(parent);
    const excluded = path.join(parent, "RSI-pentest");
    const alias = path.join(parent, "repo-alias");
    await mkdir(excluded);
    await symlink(excluded, alias, "junction");
    await expect(snapshotRepository(alias, "a".repeat(40))).rejects.toThrow(
      "Excluded repository path",
    );
  });

  it("propagates string abort reasons and rejects non-directory repository paths", async () => {
    const fixture = await makeRepo({
      "src/client.ts": "export const safe = true;\n",
    });
    const controller = new AbortController();
    controller.abort("cancelled");
    await expect(
      snapshotRepository(fixture.repo, fixture.commit, controller.signal),
    ).rejects.toThrow("Diagnostic operation aborted");
    const notDirectory = path.join(fixture.repo, "src", "client.ts");
    await expect(
      resolveRepositoryCommit(notDirectory, "HEAD"),
    ).rejects.toThrow();
    await expect(
      snapshotRepository(notDirectory, fixture.commit),
    ).rejects.toThrow("Repository path is not a directory");
    await expect(
      snapshotRepository(fixture.repo, "0".repeat(40)),
    ).rejects.toThrow();
  });

  it("rejects malformed and option-like refs before invoking Git", async () => {
    const fixture = await makeRepo({ "src/client.ts": "export {};\n" });
    for (const ref of [
      "",
      "-topic",
      "has space",
      "branch..name",
      "ref@{1}",
      "x".repeat(241),
    ]) {
      await expect(resolveRepositoryCommit(fixture.repo, ref)).rejects.toThrow(
        "Invalid Git ref",
      );
    }
    await expect(
      snapshotRepository(fixture.repo, "not-a-commit"),
    ).rejects.toThrow("full 40-character Git commit ID");
  });
});

describe("analyzeSnapshot", () => {
  it("finds disabled TLS validation with a stable fingerprint across comment shifts and clears it when fixed", async () => {
    const unsafe =
      "import https from 'node:https';\nexport const client = new https.Agent({ rejectUnauthorized: false });\n";
    const first = await analyzeSnapshot(snapshot(unsafe));
    const shifted = await analyzeSnapshot(
      snapshot("// harmless comment\n" + unsafe),
    );
    expect(first.findings).toHaveLength(1);
    expect(first.findings[0]).toMatchObject({
      ruleId: "tls.reject-unauthorized-disabled",
      severity: "high",
      path: "src/client.ts",
      line: 2,
    });
    expect(shifted.findings[0]?.fingerprint).toBe(
      first.findings[0]?.fingerprint,
    );
    expect(
      (await analyzeSnapshot(snapshot(unsafe.replace("false", "true"))))
        .findings,
    ).toHaveLength(0);
  });

  it("detects weak hashing and sensitive Math.random but ignores comments and strings", async () => {
    const code = [
      "import { createHash } from 'node:crypto';",
      "const digest = createHash('sha1');",
      "const sessionToken = Math.random();",
      "// createHash('md5'); const authKey = Math.random();",
      'const text = "rejectUnauthorized: false";',
    ].join("\n");
    const result = await analyzeSnapshot(snapshot(code));
    expect(result.findings.map(({ ruleId }) => ruleId)).toEqual([
      "crypto.weak-hash",
      "crypto.math-random-secret",
    ]);
  });

  it("supports aliased hash imports and does not treat nested metadata or a shadowed https parameter as TLS settings", async () => {
    const code = [
      "import https from 'node:https';",
      "import { createHash as makeDigest } from 'node:crypto';",
      "const digest = makeDigest('md5');",
      "const safe = new https.Agent({ metadata: { rejectUnauthorized: false } });",
      "function build(https: unknown) { return new https.Agent({ rejectUnauthorized: false }); }",
    ].join("\n");
    const result = await analyzeSnapshot(snapshot(code));
    expect(result.findings.map(({ ruleId }) => ruleId)).toEqual([
      "crypto.weak-hash",
    ]);
  });

  it("detects TLS environment overrides, direct request options, require crypto aliases, and sensitive random values", async () => {
    const code = [
      "import https from 'https';",
      "import crypto from 'node:crypto';",
      "const { createHash: hash } = require('crypto');",
      "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';",
      "const request = https.request('https://example.invalid', { ['rejectUnauthorized']: false });",
      "const agent = new https.Agent({ rejectUnauthorized: false });",
      "function makeSession() { const sessionSecret = Math.random(); return sessionSecret; }",
      "const harmlessValue = Math.random();",
      "const strong = crypto.createHash('sha256');",
      "const weak = hash('md5');",
    ].join("\n");
    const result = await analyzeSnapshot(snapshot(code));
    expect(result.findings.map(({ ruleId }) => ruleId)).toEqual([
      "tls.node-tls-reject-unauthorized-zero",
      "tls.reject-unauthorized-disabled",
      "tls.reject-unauthorized-disabled",
      "crypto.math-random-secret",
      "crypto.weak-hash",
    ]);
  });

  it("handles require-bound modules, computed member names, and default-parameter shadowing", async () => {
    const code = [
      "const https = require('https');",
      "const crypto = require('crypto');",
      "const digest = crypto['createHash']('sha1');",
      "const request = https['request']('https://example.invalid', { rejectUnauthorized: false });",
      "function local(https: unknown = {}) { return https.request('url', { rejectUnauthorized: false }); }",
      "const dynamic = https[method]('url');",
    ].join("\n");
    const result = await analyzeSnapshot(snapshot(code));
    expect(result.findings.map(({ ruleId }) => ruleId)).toEqual([
      "crypto.weak-hash",
      "tls.reject-unauthorized-disabled",
    ]);
  });

  it("keeps separate findings in one named function and leaves harmless settings unflagged", async () => {
    const code = [
      "import https from 'node:https';",
      "function connect() {",
      "  new https.Agent({ rejectUnauthorized: false }); new https.Agent({ rejectUnauthorized: false });",
      "  https.request('https://example.invalid', { rejectUnauthorized: false });",
      "}",
      "https.Agent({ rejectUnauthorized: true });",
      "const sparse = [, ,];",
    ].join("\n");
    const result = await analyzeSnapshot(snapshot(code));
    const tls = result.findings.filter(
      ({ ruleId }) => ruleId === "tls.reject-unauthorized-disabled",
    );
    expect(tls).toHaveLength(3);
    expect(new Set(tls.map(({ fingerprint }) => fingerprint)).size).toBe(3);
    expect(tls.map(({ fingerprint }) => fingerprint)).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
  });

  it("exposes syntax failures, unsupported files, and absent source as unassessed", async () => {
    const result = await analyzeSnapshot(
      snapshot("export const broken = ;", [
        { path: "README.md", hash: "d".repeat(64), content: "text" },
      ]),
    );
    expect(result.coverage[0]).toMatchObject({
      status: "partial",
      assessed: 0,
    });
    expect(result.coverage[0]?.omitted.map(({ path: item }) => item)).toEqual(
      expect.arrayContaining(["src/client.ts", "README.md"]),
    );
    expect(
      (await analyzeSnapshot(snapshotWithoutFiles())).coverage[0]?.status,
    ).toBe("unsupported");
    await expect(
      analyzeSnapshot({
        ...snapshot(""),
        commit: "HEAD",
      } as unknown as DiagnosticSnapshot),
    ).rejects.toThrow();
  });

  it("parses lockfile v3 locally without requests unless dependency networking is enabled", async () => {
    const lock = JSON.stringify(
      {
        name: "fixture",
        lockfileVersion: 3,
        packages: {
          "": { name: "fixture", version: "1.0.0" },
          "node_modules/example": {
            name: "example",
            version: "1.2.3",
            resolved: "https://registry.npmjs.org/example/-/example-1.2.3.tgz",
          },
        },
      },
      null,
      2,
    );
    const snap = snapshot("export const safe = true;", [
      { path: "package-lock.json", hash: "d".repeat(64), content: lock },
    ]);
    let fetchCount = 0;
    const fetcher: typeof fetch = async (input) => {
      fetchCount += 1;
      if (String(input).endsWith("querybatch")) {
        return new Response(
          JSON.stringify({
            results: [{ vulns: [{ id: "GHSA-abcd-efgh-ijkl" }] }],
          }),
        );
      }
      return new Response(
        JSON.stringify({
          id: "GHSA-abcd-efgh-ijkl",
          summary: "fixture advisory",
          affected: [
            {
              package: { ecosystem: "npm", name: "example" },
              ranges: [{ type: "SEMVER", events: [{ fixed: "1.2.4" }] }],
            },
          ],
        }),
      );
    };
    const local = await analyzeSnapshot(snap, {
      allowDependencyNetwork: false,
      fetcher,
    });
    expect(fetchCount).toBe(0);
    expect(
      local.coverage.find(({ engine }) => engine === "dependency"),
    ).toMatchObject({ status: "partial", assessed: 0 });
    const online = await analyzeSnapshot(snap, {
      allowDependencyNetwork: true,
      fetcher,
    });
    expect(fetchCount).toBe(2);
    expect(
      online.coverage.find(({ engine }) => engine === "dependency")?.status,
    ).toBe("complete");
    expect(online.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "dependency.osv-known-advisory",
        path: "package-lock.json",
      }),
    );
    const emptyLock = JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: { "": { name: "fixture", version: "1.0.0" } },
    });
    const empty = await analyzeSnapshot(
      snapshot("export const safe = true;", [
        { path: "package-lock.json", hash: "e".repeat(64), content: emptyLock },
      ]),
      { allowDependencyNetwork: false, fetcher },
    );
    expect(
      empty.coverage.find(({ engine }) => engine === "dependency"),
    ).toMatchObject({
      status: "complete",
      assessed: 0,
    });
  });

  it("marks unsupported lockfiles and network failures as unassessed", async () => {
    const source = "export const safe = true;";
    const unsupportedLock = snapshot(source, [
      {
        path: "package-lock.json",
        hash: "f".repeat(64),
        content: JSON.stringify({
          name: "fixture",
          lockfileVersion: 1,
          packages: {},
        }),
      },
    ]);
    const invalid = await analyzeSnapshot(unsupportedLock);
    expect(
      invalid.coverage.find(({ engine }) => engine === "dependency"),
    ).toMatchObject({ status: "unsupported", assessed: 0 });
    const packageLock = JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/example": {
          name: "example",
          version: "1.2.3",
          resolved: "https://registry.npmjs.org/example/-/example-1.2.3.tgz",
        },
      },
    });
    const networkFailure = await analyzeSnapshot(
      snapshot(source, [
        {
          path: "package-lock.json",
          hash: "e".repeat(64),
          content: packageLock,
        },
      ]),
      {
        allowDependencyNetwork: true,
        fetcher: async () => {
          throw new Error("network unavailable");
        },
      },
    );
    expect(
      networkFailure.coverage.find(({ engine }) => engine === "dependency"),
    ).toMatchObject({ status: "unavailable", assessed: 0 });
  });

  it("runs selected engine stages independently and marks skipped stages unavailable", async () => {
    const lock = JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/example": { name: "example", version: "1.2.3" },
      },
    });
    const snap = snapshot(
      "import https from 'node:https';\nnew https.Agent({ rejectUnauthorized: false });",
      [{ path: "package-lock.json", hash: "0".repeat(64), content: lock }],
    );
    let fetchCount = 0;
    const staticOnly = await analyzeSnapshot(snap, {
      allowDependencyNetwork: true,
      fetcher: async () => {
        fetchCount++;
        throw new Error("not expected");
      },
      engines: ["static"],
    });
    expect(staticOnly.findings.map(({ engine }) => engine)).toEqual(["static"]);
    expect(staticOnly.coverage).toEqual([
      expect.objectContaining({
        engine: "static",
        status: "complete",
        assessed: 1,
      }),
      expect.objectContaining({
        engine: "dependency",
        status: "unavailable",
        limitations: [expect.stringContaining("選択していません")],
      }),
    ]);
    expect(fetchCount).toBe(0);

    const dependencyOnly = await analyzeSnapshot(snap, {
      allowDependencyNetwork: false,
      engines: ["dependency"],
    });
    expect(dependencyOnly.findings).toEqual([]);
    expect(dependencyOnly.coverage).toEqual([
      expect.objectContaining({
        engine: "static",
        status: "unavailable",
        assessed: 0,
        limitations: [expect.stringContaining("選択していません")],
      }),
      expect.objectContaining({ engine: "dependency", status: "partial" }),
    ]);
    expect(() =>
      diagnosticAnalysisSchema.parse({
        findings: staticOnly.findings,
        coverage: [staticOnly.coverage[0], dependencyOnly.coverage[1]],
      }),
    ).not.toThrow();
    await expect(
      analyzeSnapshot(snap, { allowDependencyNetwork: false, engines: [] }),
    ).rejects.toThrow("At least one supported diagnostic engine");
  });

  it("rejects invalid snapshots and pre-aborted analysis", async () => {
    await expect(
      analyzeSnapshot({
        ...snapshot(""),
        manifestHash: "invalid",
      } as unknown as DiagnosticSnapshot),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeSnapshot(snapshot("export const safe = true;"), {
        allowDependencyNetwork: false,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  it("rejects file-hash and manifest tampering before returning results", async () => {
    const base = snapshot("export const safe = true;");
    await expect(
      analyzeSnapshot({
        ...base,
        files: [{ ...base.files[0]!, content: "export const changed = true;" }],
      }),
    ).rejects.toThrow("file hash does not match");
    await expect(
      analyzeSnapshot({ ...base, manifestHash: "0".repeat(64) }),
    ).rejects.toThrow("manifest hash does not match");
  });

  it("reports matched advisories without a known fix as review-only guidance", async () => {
    const lock = JSON.stringify({
      name: "fixture",
      lockfileVersion: 3,
      packages: {
        "": { name: "fixture", version: "1.0.0" },
        "node_modules/example": { name: "example", version: "1.2.3" },
        "node_modules/local-copy": {
          name: "local-copy",
          version: "2.0.0",
          resolved: "file:../private/local-copy.tgz",
        },
      },
    });
    const fetcher: typeof fetch = async (input) =>
      String(input).endsWith("querybatch")
        ? new Response(
            JSON.stringify({ results: [{ vulns: [{ id: "GHSA-no-fix" }] }] }),
          )
        : new Response(
            JSON.stringify({
              id: "GHSA-no-fix",
              summary: "No fixed version is published",
              affected: [
                { package: { ecosystem: "npm", name: "example" }, ranges: [] },
              ],
            }),
          );
    const result = await analyzeSnapshot(
      snapshot("export const safe = true;", [
        { path: "package-lock.json", hash: "0".repeat(64), content: lock },
      ]),
      { allowDependencyNetwork: true, fetcher },
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "dependency.osv-known-advisory",
        remediation: expect.stringContaining("determine an approved update"),
      }),
    );
  });
});
