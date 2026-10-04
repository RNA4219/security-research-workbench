import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import {
  parseLockfile,
  queryDependencies,
} from "../research/research-dependencies.js";
import {
  diagnosticAnalysisSchema,
  diagnosticSnapshotSchema,
  type DiagnosticAnalysis,
  type DiagnosticAnalysisOptions,
  type DiagnosticCoverage,
  type DiagnosticFinding,
  type DiagnosticSnapshot,
} from "../shared/diagnostic-engine.js";

const MAX_FILES = 500;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const MANIFESTS = new Set(["package-lock.json", "npm-shrinkwrap.json"]);
const SECRET_PATH =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|secrets?|credentials?)(?:\/|$)|(?:^|\/)(?:RSI(?:[-_ ][^/]*)?)(?:\/|$)/i;
const HASH = /^[a-f0-9]{40}$/i;
const HEX = /^[a-f0-9]{40}$/i;
type RawFinding = Omit<DiagnosticFinding, "fingerprint"> & {
  anchor: string;
  shape: string;
};
type AstNode = { type: string; [key: string]: any };

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Diagnostic operation aborted");
}

function git(
  repoPath: string,
  args: string[],
  signal: AbortSignal | undefined,
  maxBuffer: number,
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
  );
  return new Promise<Buffer>((resolve, reject) => {
    abortIfNeeded(signal);
    execFile(
      "git",
      ["--no-optional-locks", "--no-replace-objects", "-C", repoPath, ...args],
      {
        encoding: "buffer",
        maxBuffer,
        signal,
        timeout: GIT_TIMEOUT_MS,
        env,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function excludedRepositoryPath(repoPath: string) {
  return repoPath
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => /^RSI(?:[-_ ].*)?$/i.test(part));
}

function boundedOmissions<T extends { path: string; reason: string }>(
  items: T[],
): T[] {
  if (items.length <= MAX_FILES) return items;
  return [
    ...items.slice(0, MAX_FILES - 1),
    {
      path: "(additional omitted paths)",
      reason:
        items.length -
        MAX_FILES +
        1 +
        " additional unassessed paths were omitted from this list.",
    } as T,
  ];
}

function isPotentiallyAnalyzed(relativePath: string) {
  const base = path.posix.basename(relativePath).toLowerCase();
  return (
    SOURCE_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase()) ||
    MANIFESTS.has(base)
  );
}

function isSecretPath(relativePath: string) {
  return SECRET_PATH.test(relativePath.replaceAll("\\", "/"));
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestHash(
  files: DiagnosticSnapshot["files"],
  omitted: DiagnosticSnapshot["omitted"],
) {
  return hash(
    JSON.stringify({
      files: files.map(({ path: relativePath, hash: fileHash }) => [
        relativePath,
        fileHash,
      ]),
      omitted,
    }),
  );
}

function parseTree(output: Buffer) {
  const rows = output.toString("utf8").split("\0").filter(Boolean);
  return rows.map((row) => {
    const tab = row.indexOf("\t");
    if (tab < 0) throw new Error("Git tree entry is malformed");
    const header = row.slice(0, tab);
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\s+([0-9]+|-)$/.exec(
      header,
    );
    if (!match) throw new Error("Git tree entry is malformed");
    return {
      mode: match[1]!,
      type: match[2]!,
      oid: match[3]!,
      size: match[4] === "-" ? null : Number(match[4]),
      path: row.slice(tab + 1),
    };
  });
}

export async function snapshotRepository(
  repoPath: string,
  ref: string,
  signal?: AbortSignal,
): Promise<DiagnosticSnapshot> {
  if (!HASH.test(ref))
    throw new Error("A full 40-character Git commit ID is required");
  if (excludedRepositoryPath(path.resolve(repoPath)))
    throw new Error("Excluded repository path");
  abortIfNeeded(signal);
  const absoluteRepoPath = await realpath(repoPath);
  if (excludedRepositoryPath(absoluteRepoPath))
    throw new Error("Excluded repository path");
  if (!(await stat(absoluteRepoPath)).isDirectory())
    throw new Error("Repository path is not a directory");
  const resolved = (
    await git(
      absoluteRepoPath,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      signal,
      1024 * 1024,
    )
  )
    .toString("utf8")
    .trim()
    .toLowerCase();
  if (!HEX.test(resolved) || resolved !== ref.toLowerCase())
    throw new Error("Commit could not be resolved exactly");
  abortIfNeeded(signal);
  const tree = parseTree(
    await git(
      absoluteRepoPath,
      ["ls-tree", "-rz", "-l", "--full-tree", resolved],
      signal,
      MAX_TREE_BYTES,
    ),
  );
  const files: DiagnosticSnapshot["files"] = [];
  const omitted: DiagnosticSnapshot["omitted"] = [];
  let totalBytes = 0;
  let considered = 0;
  for (const entry of tree) {
    abortIfNeeded(signal);
    if (isSecretPath(entry.path)) {
      omitted.push({
        path: entry.path,
        reason: "秘密・環境設定・除外対象のパス",
      });
      continue;
    }
    if (entry.type === "commit" || entry.mode === "160000") {
      omitted.push({
        path: entry.path,
        reason: "サブモジュールの内容は解析していません",
      });
      continue;
    }
    if (entry.mode === "120000") {
      omitted.push({
        path: entry.path,
        reason: "シンボリックリンク先は読み取りません",
      });
      continue;
    }
    if (entry.type !== "blob" || !isPotentiallyAnalyzed(entry.path)) {
      omitted.push({
        path: entry.path,
        reason: "対応対象外のファイル形式です",
      });
      continue;
    }
    considered += 1;
    if (considered > MAX_FILES) {
      omitted.push({
        path: entry.path,
        reason: `ファイル数上限 (${MAX_FILES}) reached`,
      });
      continue;
    }
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size === null ||
      entry.size < 0 ||
      entry.size > MAX_FILE_BYTES
    ) {
      omitted.push({
        path: entry.path,
        reason: `ファイルサイズ上限 (${MAX_FILE_BYTES} bytes)`,
      });
      continue;
    }
    if (totalBytes + entry.size > MAX_TOTAL_BYTES) {
      omitted.push({
        path: entry.path,
        reason: `スナップショット総容量上限 (${MAX_TOTAL_BYTES} bytes)`,
      });
      continue;
    }
    const bytes = await git(
      absoluteRepoPath,
      ["cat-file", "blob", entry.oid],
      signal,
      MAX_FILE_BYTES + 1,
    );
    abortIfNeeded(signal);
    if (bytes.byteLength !== entry.size) {
      omitted.push({
        path: entry.path,
        reason: "Gitツリー記録とblobサイズが一致しません",
      });
      continue;
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      omitted.push({ path: entry.path, reason: "UTF-8テキストではありません" });
      continue;
    }
    files.push({ path: entry.path, hash: hash(bytes), content });
    totalBytes += bytes.byteLength;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  omitted.sort(
    (a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason),
  );
  const reportedOmitted = boundedOmissions(omitted);
  return {
    commit: resolved,
    manifestHash: manifestHash(files, reportedOmitted),
    files,
    omitted: reportedOmitted,
  };
}

export async function resolveRepositoryCommit(
  repoPath: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string> {
  if (
    !ref ||
    ref.length > 240 ||
    !/^[a-z\d._/-]+$/i.test(ref) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.startsWith("-")
  ) {
    throw new Error("Invalid Git ref");
  }
  if (excludedRepositoryPath(path.resolve(repoPath)))
    throw new Error("Excluded repository path");
  abortIfNeeded(signal);
  const absoluteRepoPath = await realpath(repoPath);
  if (excludedRepositoryPath(absoluteRepoPath))
    throw new Error("Excluded repository path");
  if (!(await stat(absoluteRepoPath)).isDirectory())
    throw new Error("Repository path is not a directory");
  const resolved = (
    await git(
      absoluteRepoPath,
      ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"],
      signal,
      1024 * 1024,
    )
  )
    .toString("utf8")
    .trim()
    .toLowerCase();
  if (!HASH.test(resolved))
    throw new Error("Git ref did not resolve to a commit");
  return resolved;
}

function isNode(value: unknown): value is AstNode {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as AstNode).type === "string"
  );
}

function walk(
  node: AstNode,
  visit: (
    node: AstNode,
    parent: AstNode | undefined,
    ancestors: AstNode[],
  ) => void,
) {
  const descend = (
    current: AstNode,
    parent: AstNode | undefined,
    ancestors: AstNode[],
  ) => {
    visit(current, parent, ancestors);
    const nextAncestors = [...ancestors, current];
    for (const [key, value] of Object.entries(current)) {
      if (
        [
          "loc",
          "start",
          "end",
          "comments",
          "leadingComments",
          "trailingComments",
          "innerComments",
          "tokens",
          "extra",
        ].includes(key)
      )
        continue;
      if (Array.isArray(value)) {
        for (const child of value)
          if (isNode(child)) descend(child, current, nextAncestors);
      } else if (isNode(value)) descend(value, current, nextAncestors);
    }
  };
  descend(node, undefined, []);
}

function stableShape(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableShape).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter(
      (key) =>
        ![
          "loc",
          "start",
          "end",
          "comments",
          "leadingComments",
          "trailingComments",
          "innerComments",
          "tokens",
          "extra",
        ].includes(key),
    )
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableShape(record[key])}`).join(",")}}`;
}

function memberName(node: AstNode | undefined): string | undefined {
  if (
    !node ||
    !["MemberExpression", "OptionalMemberExpression"].includes(node.type)
  )
    return undefined;
  if (!node.computed && node.property?.type === "Identifier")
    return node.property.name;
  if (node.property?.type === "StringLiteral") return node.property.value;
  return undefined;
}

function importedBindings(ast: AstNode) {
  const modules = new Map<string, string>();
  const cryptoFunctions = new Map<string, string>();
  const variables = new Map<string, AstNode>();
  walk(ast, (node) => {
    if (
      node.type === "ImportDeclaration" &&
      typeof node.source?.value === "string"
    ) {
      for (const specifier of node.specifiers ?? []) {
        if (specifier.local?.name)
          modules.set(specifier.local.name, node.source.value);
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.imported?.name &&
          ["createHash", "createHmac"].includes(specifier.imported.name) &&
          ["crypto", "node:crypto"].includes(node.source.value)
        )
          cryptoFunctions.set(specifier.local.name, specifier.imported.name);
      }
    }
    if (node.type === "VariableDeclarator" && node.init) {
      if (node.id?.type === "Identifier")
        variables.set(node.id.name, node.init);
      if (
        node.id.type === "Identifier" &&
        node.init.type === "CallExpression" &&
        node.init.callee?.name === "require" &&
        typeof node.init.arguments?.[0]?.value === "string"
      ) {
        const moduleName = node.init.arguments[0].value;
        modules.set(node.id.name, moduleName);
      }
      if (
        node.id.type === "ObjectPattern" &&
        node.init?.type === "CallExpression" &&
        node.init.callee?.name === "require" &&
        ["crypto", "node:crypto"].includes(node.init.arguments?.[0]?.value)
      ) {
        for (const property of node.id.properties ?? []) {
          if (
            property.key?.name &&
            property.value?.name &&
            ["createHash", "createHmac"].includes(property.key.name)
          )
            cryptoFunctions.set(property.value.name, property.key.name);
        }
      }
    }
  });
  return { modules, cryptoFunctions, variables };
}

function isFunctionNode(node: AstNode) {
  return [
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "ObjectMethod",
    "ClassMethod",
  ].includes(node.type);
}

function shadowsImportedName(ancestors: AstNode[], localName: string) {
  for (const ancestor of ancestors) {
    if (
      isFunctionNode(ancestor) &&
      (ancestor.params ?? []).some(
        (param: AstNode) =>
          (param.type === "Identifier" && param.name === localName) ||
          (param.type === "AssignmentPattern" &&
            param.left?.type === "Identifier" &&
            param.left.name === localName),
      )
    )
      return true;
  }
  return false;
}

function isString(node: AstNode | undefined) {
  return node?.type === "StringLiteral" ? (node.value as string) : undefined;
}

function isFalse(node: AstNode | undefined) {
  return node?.type === "BooleanLiteral" && node.value === false;
}

function anchorFor(ancestors: AstNode[], current: AstNode) {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const node = ancestors[i]!;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier")
      return `variable:${node.id.name}`;
    if (
      [
        "FunctionDeclaration",
        "ClassDeclaration",
        "ClassMethod",
        "ObjectMethod",
      ].includes(node.type)
    ) {
      const name = node.id?.name ?? node.key?.name ?? node.key?.value;
      if (typeof name === "string") return `${node.type}:${name}`;
    }
  }
  if (current.type === "AssignmentExpression")
    return `assignment:${stableShape(current.left)}`;
  return "module";
}

function locate(node: AstNode): number {
  return Number.isInteger(node.loc?.start?.line) && node.loc.start.line > 0
    ? node.loc.start.line
    : 1;
}

function analyzeCodeFile(file: DiagnosticSnapshot["files"][number]): {
  findings: RawFinding[];
  error?: string;
} {
  const extension = path.posix.extname(file.path).toLowerCase();
  const typescript = [".ts", ".tsx", ".mts", ".cts"].includes(extension);
  try {
    const ast = parse(file.content, {
      sourceType: "unambiguous",
      plugins: [
        ...(typescript ? ["typescript" as const] : []),
        ...([".jsx", ".tsx"].includes(extension) ? ["jsx" as const] : []),
      ],
    }) as unknown as AstNode;
    const { modules, cryptoFunctions, variables } = importedBindings(ast);
    const candidates: RawFinding[] = [];
    const add = (
      ruleId: string,
      title: string,
      severity: DiagnosticFinding["severity"],
      node: AstNode,
      parent: AstNode | undefined,
      ancestors: AstNode[],
      evidenceNode: AstNode,
      remediation: string,
    ) => {
      const start = Number.isInteger(evidenceNode.start)
        ? (evidenceNode.start as number)
        : 0;
      const end = Number.isInteger(evidenceNode.end)
        ? (evidenceNode.end as number)
        : start;
      const evidence = file.content.slice(start, end).trim().slice(0, 1000);
      if (!evidence) return;
      candidates.push({
        ruleId,
        engine: "static",
        title,
        severity,
        path: file.path,
        line: locate(node),
        evidence,
        remediation,
        anchor: anchorFor(ancestors, node),
        shape: stableShape(node),
      });
    };
    const moduleFor = (node: AstNode | undefined) =>
      node?.type === "Identifier" ? modules.get(node.name) : undefined;
    const importedCryptoCall = (callee: AstNode | undefined) => {
      if (callee?.type === "Identifier")
        return cryptoFunctions.has(callee.name);
      const method = memberName(callee);
      return (
        !!method &&
        ["createHash", "createHmac"].includes(method) &&
        ["crypto", "node:crypto"].includes(moduleFor(callee?.object) ?? "")
      );
    };
    const isHttpsOptionsCall = (node: AstNode, ancestors: AstNode[]) => {
      if (!["CallExpression", "NewExpression"].includes(node.type))
        return false;
      const name = memberName(node.callee);
      const moduleName = moduleFor(node.callee?.object);
      if (
        !["https", "node:https", "tls", "node:tls"].includes(moduleName ?? "")
      )
        return false;
      if (shadowsImportedName(ancestors, node.callee.object.name)) return false;
      if (
        node.type === "NewExpression" &&
        name === "Agent" &&
        ["https", "node:https"].includes(moduleName!)
      )
        return true;
      return ["request", "get", "connect", "createSecureContext"].includes(
        name ?? "",
      );
    };
    const optionRoots = (call: AstNode): AstNode[] => {
      const args: AstNode[] = Array.isArray(call.arguments)
        ? call.arguments.filter((arg: unknown): arg is AstNode => isNode(arg))
        : [];
      const method = memberName(call.callee);
      const options =
        call.type === "NewExpression" ||
        ["connect", "createSecureContext"].includes(method ?? "")
          ? args.slice(0, 1)
          : args.filter((arg) => arg.type === "ObjectExpression");
      return options.flatMap((arg: AstNode) => {
        if (arg.type === "ObjectExpression") return [arg];
        if (arg.type === "Identifier") {
          const value = variables.get(arg.name);
          return value?.type === "ObjectExpression" ? [value] : [];
        }
        return [];
      });
    };
    walk(ast, (node, parent, ancestors) => {
      if (isHttpsOptionsCall(node, ancestors)) {
        for (const option of optionRoots(node)) {
          const properties =
            option.type === "ObjectExpression" ? (option.properties ?? []) : [];
          for (const property of properties) {
            const key =
              property.type === "ObjectProperty"
                ? property.computed
                  ? isString(property.key)
                  : (property.key?.name ?? property.key?.value)
                : undefined;
            if (key === "rejectUnauthorized" && isFalse(property.value)) {
              add(
                "tls.reject-unauthorized-disabled",
                "TLS証明書検証が無効です",
                "high",
                property,
                parent,
                ancestors,
                property,
                "証明書検証を有効にしてください。rejectUnauthorizedをfalseに設定しないでください。",
              );
            }
          }
        }
      }
      if (
        node.type === "AssignmentExpression" &&
        memberName(node.left) === "NODE_TLS_REJECT_UNAUTHORIZED"
      ) {
        const env = node.left.object;
        if (
          memberName(env) === "env" &&
          env.object?.name === "process" &&
          ["0", "0.0"].includes(String(node.right?.value ?? ""))
        ) {
          add(
            "tls.node-tls-reject-unauthorized-zero",
            "Node TLS証明書検証が無効です",
            "high",
            node,
            parent,
            ancestors,
            node,
            "NODE_TLS_REJECT_UNAUTHORIZEDの上書きを削除し、TLS証明書を検証してください。",
          );
        }
      }
      if (node.type === "CallExpression" && importedCryptoCall(node.callee)) {
        const method =
          node.callee.type === "Identifier"
            ? cryptoFunctions.get(node.callee.name)
            : memberName(node.callee);
        const algorithm = isString(node.arguments?.[0]);
        if (
          ["createHash", "createHmac"].includes(method ?? "") &&
          ["md5", "sha1"].includes(algorithm?.toLowerCase() ?? "")
        ) {
          add(
            "crypto.weak-hash",
            `弱い暗号ハッシュ方式: ${algorithm}`,
            "medium",
            node,
            parent,
            ancestors,
            node,
            "暗号用途にはSHA-256などの現行ハッシュ方式を使用してください。",
          );
        }
      }
      if (
        node.type === "CallExpression" &&
        memberName(node.callee) === "random" &&
        node.callee.object?.name === "Math"
      ) {
        const declaration = [...ancestors]
          .reverse()
          .find((item) => item.type === "VariableDeclarator");
        const name = declaration?.id?.name;
        if (
          typeof name === "string" &&
          /token|secret|nonce|password|credential|session|auth|key/i.test(name)
        ) {
          add(
            "crypto.math-random-secret",
            "セキュリティ上重要な値にMath.randomが使用されています",
            "medium",
            node,
            parent,
            ancestors,
            node,
            "秘密情報、トークン、認証値には暗号学的に安全な乱数生成器を使用してください。",
          );
        }
      }
    });
    return { findings: candidates };
  } catch {
    return {
      findings: [],
      error: "JavaScript/TypeScriptの構文を解析できませんでした",
    };
  }
}

function lockLine(content: string, packagePath: string) {
  const marker = JSON.stringify(packagePath);
  const offset = content.indexOf(marker);
  if (offset < 0) return 1;
  return content.slice(0, offset).split("\n").length;
}

function severityForDependency() {
  // The existing OSV adapter does not provide a normalized severity score.
  return "medium" as const;
}

export async function analyzeSnapshot(
  rawSnapshot: DiagnosticSnapshot,
  options: DiagnosticAnalysisOptions = { allowDependencyNetwork: false },
): Promise<DiagnosticAnalysis> {
  const snapshot = diagnosticSnapshotSchema.parse(rawSnapshot);
  const requestedEngines = options.engines ?? ["static", "dependency"];
  if (
    requestedEngines.length === 0 ||
    requestedEngines.some(
      (engine) => !["static", "dependency"].includes(engine),
    )
  ) {
    throw new Error(
      "At least one supported diagnostic engine must be selected",
    );
  }
  const selectedEngines = new Set(requestedEngines);
  for (const file of snapshot.files) {
    if (hash(file.content) !== file.hash) {
      throw new Error(
        "Diagnostic snapshot file hash does not match its content",
      );
    }
  }
  if (
    manifestHash(snapshot.files, snapshot.omitted) !== snapshot.manifestHash
  ) {
    throw new Error(
      "Diagnostic snapshot manifest hash does not match its contents",
    );
  }
  const signal = options.signal;
  abortIfNeeded(signal);
  const staticFindings: RawFinding[] = [];
  const staticOmitted = [...snapshot.omitted];
  let assessed = 0;
  if (selectedEngines.has("static")) {
    for (const file of snapshot.files) {
      abortIfNeeded(signal);
      const extension = path.posix.extname(file.path).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension)) {
        if (!MANIFESTS.has(path.posix.basename(file.path).toLowerCase()))
          staticOmitted.push({
            path: file.path,
            reason: "対応対象外のファイル形式です",
          });
        continue;
      }
      const parsed = analyzeCodeFile(file);
      if (parsed.error) {
        staticOmitted.push({ path: file.path, reason: parsed.error });
        continue;
      }
      assessed += 1;
      staticFindings.push(...parsed.findings);
    }
  }
  const occurrenceCounts = new Map<string, number>();
  const findings: DiagnosticFinding[] = staticFindings.map((item) => {
    const anchor = `${item.path}\0${item.ruleId}\0${item.anchor}\0${hash(item.shape)}`;
    const occurrence = occurrenceCounts.get(anchor) ?? 0;
    occurrenceCounts.set(anchor, occurrence + 1);
    const { anchor: _anchor, shape, ...finding } = item;
    return { ...finding, fingerprint: hash(`${anchor}\0${occurrence}`) };
  });
  const staticCoverage: DiagnosticCoverage = selectedEngines.has("static")
    ? (() => {
        const sourceCount = snapshot.files.filter((file) =>
          SOURCE_EXTENSIONS.has(path.posix.extname(file.path).toLowerCase()),
        ).length;
        return {
          engine: "static",
          status:
            sourceCount === 0
              ? "unsupported"
              : staticOmitted.length
                ? "partial"
                : "complete",
          assessed,
          omitted: boundedOmissions(staticOmitted),
          limitations: sourceCount
            ? [
                "列挙したJavaScript/TypeScriptの防御的ルールのみを評価しました。完全なセキュリティレビューではありません。",
              ]
            : [
                "対応パーサーで解析できるJavaScript/TypeScriptソースがありません。",
              ],
        };
      })()
    : {
        engine: "static",
        status: "unavailable",
        assessed: 0,
        omitted: [],
        limitations: ["この呼び出しでは静的解析stageを選択していません。"],
      };
  const lock = snapshot.files.find(
    (file) =>
      path.posix.dirname(file.path) === "." &&
      MANIFESTS.has(path.posix.basename(file.path).toLowerCase()),
  );
  let dependencyCoverage: DiagnosticCoverage;
  if (!selectedEngines.has("dependency")) {
    dependencyCoverage = {
      engine: "dependency",
      status: "unavailable",
      assessed: 0,
      omitted: [],
      limitations: ["この呼び出しでは依存照合stageを選択していません。"],
    };
  } else if (!lock) {
    dependencyCoverage = {
      engine: "dependency",
      status: "unsupported",
      assessed: 0,
      omitted: [],
      limitations: [
        "依存解析に対応するルートnpm lockfileVersion 2/3がありません。",
      ],
    };
  } else {
    try {
      const parsed = parseLockfile(JSON.parse(lock.content));
      if (!parsed.dependencies.length && !parsed.unassessed.length) {
        dependencyCoverage = {
          engine: "dependency",
          status: "complete",
          assessed: 0,
          omitted: [],
          limitations: [
            "ロックファイルに照合対象の依存パッケージはありません。",
          ],
        };
      } else if (!options.allowDependencyNetwork) {
        const notQueried = parsed.dependencies
          .slice(0, MAX_FILES)
          .map((dependency) => ({
            path: `${lock.path}:${dependency.paths[0] ?? dependency.name}`,
            reason:
              "OSVへの通信が許可されていないため、この依存関係の既知アドバイザリを照合していません",
          }));
        dependencyCoverage = {
          engine: "dependency",
          status: "partial",
          assessed: 0,
          omitted: boundedOmissions([
            ...parsed.unassessed.map(({ path: omittedPath, reason }) => ({
              path: `${lock.path}:${omittedPath}`,
              reason,
            })),
            ...notQueried,
          ]),
          limitations: [
            "依存関係の版はローカルで解析しましたが、allowDependencyNetworkがfalseのためOSVへ問い合わせていません。",
          ],
        };
      } else {
        const controller = new AbortController();
        const queried = await queryDependencies(
          parsed,
          options.fetcher ?? fetch,
          signal ?? controller.signal,
        );
        abortIfNeeded(signal);
        const status: DiagnosticCoverage["status"] = queried.result.status;
        dependencyCoverage = {
          engine: "dependency",
          status,
          assessed: queried.result.queried,
          omitted: boundedOmissions(
            (queried.result.unassessed ?? []).map(
              ({ path: omittedPath, reason }) => ({
                path: `${lock.path}:${omittedPath}`,
                reason,
              }),
            ),
          ),
          limitations: queried.limitations,
        };
        for (const result of queried.result.findings) {
          const packagePath = result.paths[0] ?? result.name;
          const findingPath = lock.path;
          const evidence =
            `${result.name}@${result.version} matched ${result.advisoryId}. Lock paths: ${result.paths.join(", ")}. ${result.summary}`.slice(
              0,
              4000,
            );
          const remediation = result.fixes.length
            ? `Review advisory ${result.advisoryId} and evaluate an update to ${result.fixes.join(", ")}. A human must confirm applicability.`
            : `Review advisory ${result.advisoryId} and determine an approved update or mitigation.`;
          findings.push({
            fingerprint: hash(
              `dependency\0${result.name}\0${result.version}\0${result.advisoryId}\0${packagePath}`,
            ),
            ruleId: "dependency.osv-known-advisory",
            engine: "dependency",
            title: `${result.name}@${result.version} matches ${result.advisoryId}`,
            severity: severityForDependency(),
            path: findingPath,
            line: lockLine(lock.content, packagePath),
            evidence,
            remediation,
            advisoryUrl: result.url,
          });
        }
      }
    } catch (error) {
      abortIfNeeded(signal);
      dependencyCoverage = {
        engine: "dependency",
        status: "unsupported",
        assessed: 0,
        omitted: [
          { path: lock.path, reason: "npm lockfile could not be parsed" },
        ],
        limitations: [
          error instanceof Error
            ? error.message.slice(0, 500)
            : "npm lockfile could not be parsed.",
        ],
      };
    }
  }
  findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );
  return diagnosticAnalysisSchema.parse({
    findings,
    coverage: [staticCoverage, dependencyCoverage],
  });
}
