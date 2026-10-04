import type { ApiError } from "../shared/model.js";
async function connectedFetch(url: string, options: RequestInit) {
  try {
    return await fetch(url, options);
  } catch {
    throw new Error(
      "ローカルサーバーに接続できません。サーバーを起動してから、もう一度操作してください。",
    );
  }
}
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await connectedFetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-Workbench": "1",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const value: ApiError = await response.json();
    throw new Error(
      [
        value.error,
        ...(value.issues ?? []).map((i) => `${i.path}: ${i.message}`),
      ].join("\n"),
    );
  }
  return response.json() as Promise<T>;
}
export async function download(path: string, filename: string) {
  const r = await connectedFetch(`/api${path}`, {
    headers: { "X-Workbench": "1" },
  });
  if (!r.ok) throw new Error(((await r.json()) as ApiError).error);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
