import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  researchRepository,
  researchMarkdown,
} from "../src/research/repository-research.js";
import {
  parseRepositoryUrl,
  researchJson,
} from "../src/research/research-http.js";
import {
  parseLockfile,
  queryDependencies,
} from "../src/research/research-dependencies.js";
import { createApp } from "../src/server/app.js";
import {
  researchFetcher,
  jsonResponse as json,
  fixtureLock,
  researchSha,
  fileResponse,
} from "./research-fixtures.js";

const repoUrl = "https://github.com/example/research-fixture";
const headers = { host: "127.0.0.1:4317", "x-workbench": "1" };
afterEach(() => vi.restoreAllMocks());

it("同時調査を制限し、終了・失敗後は次の調査を受け付ける", async () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { resolve, promise };
  };
  const waiting = deferred();
  const started = deferred();
  let delay = true;
  const base = researchFetcher();
  const app = await createApp({
    dbPath: ":memory:",
    researchFetch: async (url, init) => {
      if (delay) {
        started.resolve();
        await waiting.promise;
        delay = false;
      }
      return base(url, init);
    },
  });
  try {
    const first = app
      .inject({
        method: "POST",
        url: "/api/research",
        headers,
        payload: { repoUrl },
      })
      .then((r) => r);
    await started.promise;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/research",
          headers,
          payload: { repoUrl },
        })
      ).statusCode,
    ).toBe(429);
    waiting.resolve();
    expect((await first).statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/research",
          headers,
          payload: { repoUrl: "https://example.test/" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/research",
          headers,
          payload: { repoUrl },
        })
      ).statusCode,
    ).toBe(201);
  } finally {
    waiting.resolve();
    await app.close();
  }
});

it("過大な照合結果は上限を示し、Gitの修正コミットをnpm修正版に混ぜない", async () => {
  const parsed = parseLockfile(fixtureLock);
  const result = await queryDependencies(
    parsed,
    researchFetcher((u) => {
      if (u.endsWith("querybatch"))
        return json({
          results: [
            {
              vulns: Array.from({ length: 201 }, (_, i) => ({
                id: `TEST-${i}`,
              })),
            },
            {},
          ],
        });
      if (u.endsWith("/TEST-0"))
        return json({
          id: "TEST-0",
          affected: [
            {
              package: { ecosystem: "npm", name: "lodash" },
              ranges: [
                { type: "GIT", events: [{ fixed: "a".repeat(40) }] },
                {
                  type: "SEMVER",
                  events: [{ fixed: "4.17.21" }, { fixed: "not-version" }],
                },
              ],
            },
          ],
        });
      return undefined;
    }),
    new AbortController().signal,
  );
  expect(result.result.findings).toHaveLength(200);
  expect(result.result.findings[0].fixes).toEqual(["4.17.21"]);
  expect(result.result.status).toBe("partial");
  expect(result.limitations.join()).toContain("上限");
});

it("URLだけからコミット固定の依存照合と更新の確認事項を返す", async () => {
  const fetcher = vi.fn(researchFetcher());
  const result = await researchRepository(repoUrl, fetcher);
  expect(result.repository.commit).toBe(researchSha);
  expect(result.dependencies).toMatchObject({
    status: "complete",
    total: 2,
    queried: 2,
    skipped: 0,
  });
  expect(result.dependencies.findings[0]).toMatchObject({
    name: "lodash",
    version: "4.17.20",
    fixes: ["4.17.21"],
    detailStatus: "available",
  });
  expect(result.actions[0].title).toContain("更新");
  expect(
    fetcher.mock.calls.some(([url]) =>
      String(url).includes(`?ref=${researchSha}`),
    ),
  ).toBe(true);
  for (const [, init] of fetcher.mock.calls) {
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    expect(init?.headers).not.toHaveProperty("Authorization");
  }
  expect(result.sources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256))).toBe(
    true,
  );
  expect(researchMarkdown(result)).toContain("4.17.21");
  expect(researchMarkdown(result)).toContain("今回の調査範囲");
});
it.each([
  "http://github.com/a/b",
  "https://github.com.evil.test/a/b",
  "https://name:secret@github.com/a/b",
  "https://github.com/a/b/tree/main",
  "https://github.com/a/b?x=1",
  "https://github.com/a/..",
  "file:///tmp/x",
  "https://github.com/a/.git",
])("不正URL %s は通信前に拒否", async (url) => {
  const fetcher = vi.fn();
  await expect(researchRepository(url, fetcher)).rejects.toThrow("公開GitHub");
  expect(fetcher).not.toHaveBeenCalled();
});
it("URLの末尾.git、余白、末尾slashを正規化", () => {
  expect(
    parseRepositoryUrl(" https://github.com/Owner/Repo.git/ "),
  ).toMatchObject({ name: "Owner/Repo", url: "https://github.com/Owner/Repo" });
});
it.each([404, 403, 429, 500])(
  "GitHub HTTP %s は結果を捏造しない",
  async (status) => {
    await expect(
      researchRepository(
        repoUrl,
        researchFetcher(() => json({}, status)),
      ),
    ).rejects.toThrow();
  },
);
it.each([
  { full_name: "other/repo" },
  { private: true },
  { archived: "false" },
])("不一致・非公開・不正metadataを拒否 %j", async (change) => {
  const base = researchFetcher();
  const f = researchFetcher(async (url) => {
    if (url.endsWith("/example/research-fixture"))
      return json({ ...(await (await base(url)).json()), ...change });
    return base(url);
  });
  await expect(researchRepository(repoUrl, f)).rejects.toThrow();
});
it("lockfileなしは未対応、releaseなしはなしと表示する", async () => {
  const result = await researchRepository(
    repoUrl,
    researchFetcher((url) =>
      url.includes("/contents/") || url.includes("/releases/")
        ? json({}, 404)
        : undefined,
    ),
  );
  expect(result.dependencies.status).toBe("unsupported");
  expect(result.repository.releaseStatus).toBe("none");
  expect(result.actions.some((a) => a.title.includes("未照合"))).toBe(true);
  expect(researchMarkdown(result)).toContain("なし");
});
it.each([json({}, 500), json({ sha: "bad" })])(
  "commit未取得では依存ファイルを読まない",
  async (response) => {
    const f = vi.fn(
      researchFetcher((url) =>
        url.includes("/commits/")
          ? response
          : url.includes("/releases/")
            ? json({ wrong: "response" })
            : undefined,
      ),
    );
    const result = await researchRepository(repoUrl, f);
    expect(result.dependencies.status).toBe("unavailable");
    expect(f.mock.calls.some(([u]) => String(u).includes("/contents/"))).toBe(
      false,
    );
    expect(result.limitations.join()).toContain("最新リリース");
    expect(researchMarkdown(result)).toContain("未取得");
  },
);
it("archive・不明license・長期未更新は個別の確認事項を返す", async () => {
  const base = researchFetcher();
  const result = await researchRepository(repoUrl, async (url, init) => {
    if (String(url).endsWith("/example/research-fixture"))
      return json({
        ...(await (await base(url)).json()),
        archived: true,
        license: null,
        description: null,
      });
    if (String(url).includes("/commits/"))
      return json({
        sha: researchSha,
        commit: { committer: { date: "2020-01-01T00:00:00Z" } },
      });
    return base(url, init);
  });
  expect(result.actions.map((a) => a.title)).toEqual(
    expect.arrayContaining([
      "保守を引き継げるか確認する",
      "利用・配布条件を確認する",
      "保守状況を確認する",
    ]),
  );
});
it("shrinkwrapを優先、問題なしでも用途確認と調査範囲を残す", async () => {
  const f = vi.fn(
    researchFetcher((url) =>
      url.includes("/contents/npm-shrinkwrap")
        ? json(fileResponse({ lockfileVersion: 2, packages: { "": {} } }))
        : url.includes("/commits/")
          ? json({ sha: researchSha, commit: { committer: null } })
          : undefined,
    ),
  );
  const result = await researchRepository(repoUrl, f);
  expect(result.dependencies).toMatchObject({
    lockfile: "npm-shrinkwrap.json",
    status: "complete",
    queried: 0,
  });
  expect(result.actions[0].title).toContain("用途");
  expect(
    f.mock.calls.some(([url]) => String(url).includes("package-lock")),
  ).toBe(false);
});
it.each([
  fileResponse({ lockfileVersion: 1 }),
  { type: "dir" },
  { type: "file", encoding: "base64", content: "!!!" },
])("読めないlockを未照合にする %j", async (payload) => {
  const result = await researchRepository(
    repoUrl,
    researchFetcher((url) =>
      url.includes("package-lock") ? json(payload) : undefined,
    ),
  );
  expect(result.dependencies.status).toBe("unavailable");
  expect(result.limitations.length).toBeGreaterThan(1);
});
it("lock解析は重複版をまとめ、alias・開発用・未対応依存を区別する", () => {
  const result = parseLockfile({
    lockfileVersion: 2,
    packages: {
      ...fixtureLock.packages,
      "node_modules/nested/node_modules/lodash": {
        version: "4.17.20",
        dev: true,
      },
      "node_modules/alias": {
        name: "@scope/actual",
        version: "1.2.3-beta.1+build",
      },
      "node_modules/link": { link: true },
      workspace: {},
      "node_modules/invalid": "broken",
      "node_modules/git": {
        version: "1.0.0",
        resolved: "git+https://example.com/repo",
      },
      "node_modules/range": { version: "^1.0.0" },
    },
  });
  expect(result.dependencies).toHaveLength(3);
  expect(result.dependencies[0]).toMatchObject({
    development: false,
    paths: ["node_modules/lodash", "node_modules/nested/node_modules/lodash"],
  });
  expect(result.dependencies[2].name).toBe("@scope/actual");
  expect(result.skipped).toBe(5);
  expect(result.unassessed.map((item) => item.path)).toContain(
    "node_modules/git",
  );
});
it("400版を超えた分を未照合として数える", () => {
  const p = Object.fromEntries(
    Array.from({ length: 401 }, (_, i) => [
      `node_modules/p${i}`,
      { version: "1.0.0" },
    ]),
  );
  expect(parseLockfile({ lockfileVersion: 3, packages: p })).toMatchObject({
    total: 401,
    skipped: 1,
  });
});
it.each([{}, { results: [] }, { results: [{}, {}, {}] }])(
  "OSV不正応答は0件の完了にしない %j",
  async (payload) => {
    const r = await queryDependencies(
      parseLockfile(fixtureLock),
      researchFetcher((u) =>
        u.endsWith("querybatch") ? json(payload) : undefined,
      ),
      new AbortController().signal,
    );
    expect(r.result.status).toBe("unavailable");
    expect(r.result.queried).toBe(0);
  },
);
it("OSV継続ページ・撤回・詳細不一致を区別し、別packageのfixを混ぜない", async () => {
  const parsed = parseLockfile(fixtureLock);
  const f = researchFetcher((u) => {
    if (u.endsWith("querybatch"))
      return json({
        results: [
          {
            next_page_token: "more",
            vulns: [{ id: "ACTIVE" }, { id: "WITHDRAWN" }, { id: "MISMATCH" }],
          },
          {},
        ],
      });
    if (u.endsWith("ACTIVE"))
      return json({
        id: "ACTIVE",
        affected: [
          {
            package: { name: "other", ecosystem: "npm" },
            ranges: [{ type: "SEMVER", events: [{ fixed: "999.0.0" }] }],
          },
        ],
      });
    if (u.endsWith("WITHDRAWN"))
      return json({ id: "WITHDRAWN", withdrawn: "2026-01-01" });
    if (u.endsWith("MISMATCH")) return json({ id: "OTHER" });
    return undefined;
  });
  const r = await queryDependencies(parsed, f, new AbortController().signal);
  expect(r.result).toMatchObject({ status: "partial", withdrawn: 1 });
  expect(r.result.findings).toHaveLength(2);
  expect(r.result.findings[0].fixes).toEqual([]);
  expect(r.result.findings[1].detailStatus).toBe("unavailable");
  expect(r.limitations.join()).toContain("続き");
});
it("応答サイズをヘッダーとストリームの両方で制限し、空bodyも拒否", async () => {
  const signal = new AbortController().signal;
  await expect(
    researchJson(
      async () =>
        new Response("{}", { headers: { "content-length": "99999999" } }),
      "https://api.github.com/",
      signal,
    ),
  ).rejects.toThrow("上限");
  await expect(
    researchJson(
      async () => new Response(" ".repeat(3 * 1024 * 1024 + 1)),
      "https://api.github.com/",
      signal,
    ),
  ).rejects.toThrow("上限");
  await expect(
    researchJson(
      async () => new Response(null),
      "https://api.github.com/",
      signal,
    ),
  ).rejects.toThrow("空");
});
it("APIで保存・再起動後の読出し・Markdown出力ができ、不正idは拒否", async () => {
  const dir = mkdtempSync(join(tmpdir(), "workbench-research-"));
  const dbPath = join(dir, "test.db");
  const app = await createApp({ dbPath, researchFetch: researchFetcher() });
  const result = await app.inject({
    method: "POST",
    url: "/api/research",
    headers,
    payload: { repoUrl },
  });
  expect(result.statusCode).toBe(201);
  const saved = result.json();
  await app.close();
  const fetcher = vi.fn();
  const next = await createApp({ dbPath, researchFetch: fetcher });
  try {
    expect(
      (await next.inject({ url: "/api/research", headers })).json(),
    ).toHaveLength(1);
    expect(
      (await next.inject({ url: `/api/research/${saved.id}`, headers })).json(),
    ).toEqual(saved);
    expect(
      (
        await next.inject({
          url: `/api/research/${saved.id}/markdown`,
          headers,
        })
      ).body,
    ).toContain(researchSha);
    expect(
      (await next.inject({ url: "/api/research/not-an-id", headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await next.inject({
          url: "/api/research/00000000-0000-4000-8000-000000000000",
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await next.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
