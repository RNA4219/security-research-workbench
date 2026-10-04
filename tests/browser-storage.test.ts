import { expect, it } from "vitest";
import { browserHistory, storageKey } from "../src/research/browser-storage.js";
import { researchRepository } from "../src/research/repository-research.js";
import { researchFetcher } from "./research-fixtures.js";
function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
  return { values, storage, history: browserHistory(() => storage) };
}
const report = () =>
  researchRepository(
    "https://github.com/example/research-fixture",
    researchFetcher(),
  );
it("履歴は再起動しても復元され、同じIDは重複せず最新20件を残す", async () => {
  const { storage, history } = fixture();
  expect(await history.list()).toEqual([]);
  const original = await report();
  for (let i = 0; i < 23; i++)
    await history.save({ ...original, id: crypto.randomUUID() });
  await history.save(original);
  await history.save(original);
  const reopened = browserHistory(() => storage);
  expect(await reopened.list()).toHaveLength(20);
  expect((await reopened.list())[0].id).toBe(original.id);
  expect(await reopened.get(original.id)).toEqual(original);
  await reopened.clear();
  expect(await reopened.list()).toEqual([]);
  await expect(reopened.get(original.id)).rejects.toThrow("見つかりません");
});
it("保存サイズを超える場合は古い履歴を間引き、1件でも大きすぎる場合は既存履歴を保つ", async () => {
  const { history } = fixture();
  const original = await report();
  for (let i = 0; i < 3; i++)
    await history.save({
      ...original,
      id: crypto.randomUUID(),
      limitations: ["a".repeat(900_000)],
    });
  expect(await history.list()).toHaveLength(2);
  await expect(
    history.save({ ...original, limitations: ["a".repeat(2_100_000)] }),
  ).rejects.toThrow("保存上限");
  expect(await history.list()).toHaveLength(2);
});
it("破損した履歴・上限超過・危険なリンクを受け入れず、明示削除で復旧する", async () => {
  const { values, history } = fixture();
  const original = await report();
  for (const raw of [
    "bad json",
    "[]".repeat(1_100_000),
    JSON.stringify([{}]),
    JSON.stringify([
      {
        ...original,
        repository: { ...original.repository, url: "javascript:alert(1)" },
      },
    ]),
  ]) {
    values.set(storageKey, raw);
    await expect(history.list()).rejects.toThrow("保存設定");
    await expect(history.save(original)).rejects.toThrow("保存設定");
    expect(values.get(storageKey)).toBe(raw);
  }
  await history.clear();
  await history.save(original);
  expect(await history.get(original.id)).toEqual(original);
});
it("保存領域の無効化・容量不足を呼出元に伝える", async () => {
  const disabled = browserHistory(() => {
    throw new Error("disabled");
  });
  await expect(disabled.list()).rejects.toThrow("保存設定");
  await expect(disabled.clear()).rejects.toThrow("disabled");
  const { storage } = fixture();
  storage.setItem = () => {
    throw new Error("quota");
  };
  await expect(
    browserHistory(() => storage).save(await report()),
  ).rejects.toThrow("quota");
});
