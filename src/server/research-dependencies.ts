import { z } from "zod";
import type {
  Dependency,
  ResearchReport,
  ResearchSource,
} from "../shared/repository-research.js";
import { researchJson } from "./research-http.js";

const object = z.record(z.string(), z.unknown());
const version = /^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i;
const packageName = /^(?:@[a-z\d_.-]+\/)?[a-z\d_.-]+$/i;
const batchUrl = "https://api.osv.dev/v1/querybatch";
const batchSchema = z.object({
  results: z.array(
    z.object({
      vulns: z
        .array(
          z.object({ id: z.string().regex(/^[a-z\d][a-z\d._:-]{0,149}$/i) }),
        )
        .optional(),
      next_page_token: z.string().optional(),
    }),
  ),
});
const advisorySchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  withdrawn: z.string().optional(),
  affected: z
    .array(
      z.object({
        package: z.object({ name: z.string(), ecosystem: z.string() }),
        ranges: z
          .array(
            z.object({
              type: z.string(),
              events: z.array(z.object({ fixed: z.string().optional() })),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export function parseLockfile(raw: unknown) {
  const lock = object.parse(raw);
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3)
    throw new Error(
      "npm lockfileVersion 2 / 3に対応しています。この形式の依存関係は未照合です。",
    );
  const entries = Object.entries(object.parse(lock.packages)).filter(
    ([path]) => path !== "",
  );
  const found = new Map<string, Dependency>();
  let skipped = 0;
  const unassessed: { path: string; reason: string }[] = [];
  for (const [path, rawEntry] of entries) {
    const parsed = object.safeParse(rawEntry);
    const item = parsed.success ? parsed.data : {};
    const name =
      typeof item.name === "string"
        ? item.name
        : path.split("node_modules/").at(-1)!;
    const resolved = item.resolved;
    if (
      !path.includes("node_modules/") ||
      item.link ||
      !packageName.test(name) ||
      typeof item.version !== "string" ||
      !version.test(item.version) ||
      (resolved !== undefined &&
        (typeof resolved !== "string" ||
          !/^https:\/\/registry\.npmjs\.org\//.test(resolved)))
    ) {
      skipped++;
      if (unassessed.length < 30)
        unassessed.push({
          path,
          reason:
            "npmレジストリの確定版と対応づけられません。ローカルファイル・Git・独自レジストリ・版の指定方法を確認してください。",
        });
      continue;
    }
    const key = `${name}@${item.version}`;
    const old = found.get(key);
    if (old) {
      old.paths.push(path);
      old.development &&= item.dev === true;
    } else
      found.set(key, {
        name,
        version: item.version,
        paths: [path],
        development: item.dev === true,
      });
  }
  const dependencies = [...found.values()];
  const omitted = Math.max(0, dependencies.length - 400);
  for (const dependency of dependencies.slice(400, 430 - unassessed.length))
    unassessed.push({
      path: dependency.paths[0],
      reason: "400パッケージ版の照合上限を超えました。",
    });
  return {
    dependencies: dependencies.slice(0, 400),
    total: entries.length,
    skipped: skipped + omitted,
    unassessed,
  };
}

export async function queryDependencies(
  parsed: ReturnType<typeof parseLockfile>,
  fetcher: typeof fetch,
  signal: AbortSignal,
) {
  const sources: ResearchSource[] = [];
  const limitations: string[] = [];
  const result: ResearchReport["dependencies"] = {
    status: parsed.skipped ? "partial" : "complete",
    lockfile: null,
    total: parsed.total,
    queried: 0,
    skipped: parsed.skipped,
    unassessed: parsed.unassessed,
    findings: [],
    withdrawn: 0,
  };
  if (parsed.skipped)
    limitations.push(
      `${parsed.skipped}件は形式・取得元・400パッケージ版の上限により未照合です。`,
    );
  if (!parsed.dependencies.length) return { result, sources, limitations };
  let rows: z.infer<typeof batchSchema>["results"];
  try {
    const response = await researchJson(fetcher, batchUrl, signal, {
      queries: parsed.dependencies.map((d) => ({
        package: { ecosystem: "npm", name: d.name },
        version: d.version,
      })),
    });
    if (!response) throw new Error("OSV応答なし");
    rows = batchSchema.parse(response.value).results;
    if (rows.length !== parsed.dependencies.length)
      throw new Error("OSV応答件数不一致");
    sources.push({
      label: "OSV 依存版の照合",
      url: batchUrl,
      sha256: response.sha256,
    });
    result.queried = rows.length;
  } catch {
    result.status = "unavailable";
    limitations.push(
      "OSVへ問い合わせできませんでした。依存関係の問題件数は未確認です。再調査してください。",
    );
    return { result, sources, limitations };
  }
  if (rows.some((row) => row.next_page_token)) {
    result.status = "partial";
    limitations.push("OSVに続きのページがあります。今回の照合結果は一部です。");
  }
  const pairs = rows.flatMap((row, i) =>
    [...new Set((row.vulns ?? []).map((v) => v.id))].map((id) => ({
      dependency: parsed.dependencies[i],
      id,
    })),
  );
  const selected = pairs.slice(0, 200);
  const ids = [...new Set(selected.map((pair) => pair.id))].slice(0, 40);
  if (
    pairs.length > selected.length ||
    new Set(selected.map((p) => p.id)).size > ids.length
  ) {
    result.status = "partial";
    limitations.push(
      "200件の照合結果・40件のアドバイザリ詳細の上限に達しました。残りは未取得です。",
    );
  }
  const details = new Map<string, z.infer<typeof advisorySchema>>();
  for (let start = 0; start < ids.length; start += 4) {
    await Promise.all(
      ids.slice(start, start + 4).map(async (id) => {
        const url = `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`;
        try {
          const response = await researchJson(fetcher, url, signal);
          if (!response) return;
          const record = advisorySchema.parse(response.value);
          if (record.id !== id) return;
          details.set(id, record);
          sources.push({ label: id, url, sha256: response.sha256 });
        } catch {
          /* The match remains visible when advisory detail is unavailable. */
        }
      }),
    );
  }
  for (const { dependency, id } of selected) {
    const detail = details.get(id);
    if (detail?.withdrawn) {
      result.withdrawn++;
      continue;
    }
    if (!detail) result.status = "partial";
    const fixes = [
      ...new Set(
        (detail?.affected ?? [])
          .filter(
            (a) =>
              a.package.ecosystem === "npm" &&
              a.package.name === dependency.name,
          )
          .flatMap((a) =>
            (a.ranges ?? [])
              .filter((r) => r.type === "SEMVER" || r.type === "ECOSYSTEM")
              .flatMap((r) =>
                r.events.flatMap((e) =>
                  e.fixed && version.test(e.fixed) ? [e.fixed] : [],
                ),
              ),
          ),
      ),
    ];
    result.findings.push({
      ...dependency,
      advisoryId: id,
      summary:
        detail?.summary?.slice(0, 600) ||
        "概要はアドバイザリで確認してください。",
      url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
      fixes,
      detailStatus: detail ? "available" : "unavailable",
    });
  }
  if (result.findings.some((f) => f.detailStatus === "unavailable"))
    limitations.push(
      "一部のアドバイザリ詳細を取得できませんでした。修正境界は原文で確認してください。",
    );
  return { result, sources, limitations };
}
