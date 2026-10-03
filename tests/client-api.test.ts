import { afterEach, expect, it, vi } from "vitest";
import { download, request } from "../src/client/api.js";

afterEach(() => vi.unstubAllGlobals());
it("通信が切れた取得・保存・ダウンロードに復旧案内を表示し、自動再送しない", async () => {
  const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
  vi.stubGlobal("fetch", fetch);
  await expect(request("/projects")).rejects.toThrow(
    "ローカルサーバーに接続できません",
  );
  await expect(request("/projects", { title: "入力を保持" })).rejects.toThrow(
    "サーバーを起動",
  );
  await expect(
    download("/projects/id/export/json", "project.json"),
  ).rejects.toThrow("もう一度操作");
  expect(fetch).toHaveBeenCalledTimes(3);
});
