import type { ApiError } from "../shared/model.js";
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
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
  const r = await fetch(`/api${path}`, { headers: { "X-Workbench": "1" } });
  if (!r.ok) throw new Error(((await r.json()) as ApiError).error);
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
