// Fixed public-provider responses for offline tests; never used by the production entry point.
export const researchSha = "a".repeat(40);
export const fixtureLock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "test-only" },
    "node_modules/lodash": {
      version: "4.17.20",
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
    },
    "node_modules/dev-only": { version: "1.0.0", dev: true },
  },
};
export const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
export const fileResponse = (value: unknown) => ({
  type: "file",
  encoding: "base64",
  content: Buffer.from(JSON.stringify(value)).toString("base64"),
});
export function researchFetcher(
  override?: (
    url: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined,
): typeof fetch {
  return async (input, init) => {
    const url = String(input),
      changed = override?.(url, init);
    if (changed) return changed;
    if (url === "https://api.github.com/repos/example/research-fixture")
      return jsonResponse({
        full_name: "example/research-fixture",
        private: false,
        description: "自動テスト用の公開応答",
        license: { spdx_id: "MIT" },
        archived: false,
        default_branch: "main",
      });
    if (url.endsWith("/commits/main"))
      return jsonResponse({
        sha: researchSha,
        commit: { committer: { date: "2026-10-01T00:00:00Z" } },
      });
    if (url.endsWith("/releases/latest"))
      return jsonResponse({ tag_name: "v1.0.0" });
    if (url.includes("/contents/npm-shrinkwrap.json"))
      return jsonResponse({}, 404);
    if (url.includes("/contents/package-lock.json"))
      return jsonResponse(fileResponse(fixtureLock));
    if (url.endsWith("/querybatch")) {
      const queries = JSON.parse(String(init?.body)).queries as {
        package: { name: string };
      }[];
      return jsonResponse({
        results: queries.map((q) =>
          q.package.name === "lodash"
            ? { vulns: [{ id: "GHSA-test-fixture" }] }
            : {},
        ),
      });
    }
    if (url.endsWith("/vulns/GHSA-test-fixture"))
      return jsonResponse({
        id: "GHSA-test-fixture",
        summary: "固定応答による更新案内のテスト",
        affected: [
          {
            package: { name: "lodash", ecosystem: "npm" },
            ranges: [
              {
                type: "SEMVER",
                events: [{ introduced: "0" }, { fixed: "4.17.21" }],
              },
            ],
          },
        ],
      });
    return jsonResponse({}, 404);
  };
}
