import { DomainError } from "../shared/domain-error.js";

export function parseRepositoryUrl(value: string) {
  const match =
    /^https:\/\/github\.com\/([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]{1,100})\/?$/i.exec(
      value.trim(),
    );
  const repo = match?.[2].replace(/\.git$/i, "");
  if (!match || !repo || repo === "." || repo === "..")
    throw new DomainError(
      "公開GitHubリポジトリのURLを入力してください（https://github.com/owner/repo）。",
      400,
    );
  return {
    owner: match[1],
    repo,
    name: `${match[1]}/${repo}`,
    url: `https://github.com/${match[1]}/${repo}`,
  };
}

export async function researchJson(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  body?: unknown,
) {
  const response = await fetcher(url, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error(
      "公開APIに接続できませんでした。通信環境を確認し、時間をおいて再試行してください。",
    );
  });
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429)
    throw new Error(
      "公開APIの利用上限に達したか、アクセスが制限されています。時間をおいて再試行してください。",
    );
  if (!response.ok)
    throw new Error(
      `公開APIから取得できませんでした（HTTP ${response.status}）。`,
    );
  const limit = 3 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit || !response.body)
    throw new Error("取得データが空か、3 MiBの上限を超えています。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Error("取得データが3 MiBの上限を超えています。");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    value: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    sha256: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
