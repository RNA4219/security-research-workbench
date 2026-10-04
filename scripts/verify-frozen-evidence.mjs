import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/testing/final-evidence");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const entries = Object.entries(manifest.files);
if (entries.length === 0) throw new Error("Frozen evidence manifest is empty");

for (const [name, expected] of entries) {
  const path = resolve(root, name);
  const within = relative(root, path);
  if (!within || within.startsWith("..") || isAbsolute(within)) {
    throw new Error(`Invalid evidence path: ${name}`);
  }
  const bytes = readFileSync(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== expected.bytes || sha256 !== expected.sha256) {
    throw new Error(`Frozen evidence does not match manifest: ${name}`);
  }
}

console.log(`Verified ${entries.length} frozen evidence files (${manifest.targetRevision})`);
