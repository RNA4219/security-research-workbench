import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** 読み取り診断の評価資料。生成したソースを実行したり外部へ接続したりしない。 */
export async function createDiagnosticFixture(directory) {
  const base = resolve(".cache");
  await mkdir(base, { recursive: true });
  const root = directory ?? (await mkdtemp(join(base, "diagnostic-fixture-")));
  await mkdir(join(root, "src"), { recursive: true });
  const git = async (...args) =>
    (
      await exec("git", ["-c", "core.hooksPath=", "-C", root, ...args], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      })
    ).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.name", "Workbench Diagnostic Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await writeFile(
    join(root, "README.md"),
    "# ローカル静的診断の評価資料\nコードは実行しない。外部の対象やサービスは存在しない。\n",
  );
  await writeFile(
    join(root, "src", "arithmetic.mjs"),
    "export const sum = (left, right) => left + right;\n",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "diagnostic-fixture",
      version: "1.0.0",
      private: true,
    }),
  );
  await writeFile(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "diagnostic-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "diagnostic-fixture", version: "1.0.0" } },
    }),
  );
  const source = (enabled, prefix = "") =>
    `${prefix}import https from "node:https";\nexport const client = new https.Agent({ rejectUnauthorized: ${enabled} });\n`;
  const commit = async (branch, content) => {
    await writeFile(join(root, "src", "client.ts"), content);
    await git("add", "--", ".");
    await git("commit", "--quiet", "-m", `diagnostic fixture: ${branch}`);
    const hash = await git("rev-parse", "HEAD");
    await git("branch", branch, hash);
    return hash;
  };
  const baseline = await commit("baseline", source(false));
  const updated = await commit(
    "updated",
    source(false, "// 行番号だけが変わった版\n"),
  );
  const fixed = await commit("fixed", source(true));
  return { directory: root, commits: { baseline, updated, fixed } };
}
