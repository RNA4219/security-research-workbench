import { afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  listen: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/server/app.js", () => ({
  createApp: vi.fn().mockResolvedValue(fake),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});
it.each(["1023", "65536", "abc", "4317.5"])(
  "不正なPORT %s では待受しない",
  async (port) => {
    vi.stubEnv("PORT", port);
    fake.listen.mockClear();
    await expect(import("../src/server/index.js")).rejects.toThrow(
      "PORTが不正",
    );
    expect(fake.listen).not.toHaveBeenCalled();
  },
);
it.each([undefined, "4319"])(
  "PORT %s でループバックにbindし、終了時にDBを閉じる",
  async (port) => {
    vi.stubEnv("PORT", port);
    const on = vi.spyOn(process, "on").mockImplementation(() => process);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await import("../src/server/index.js");
    expect(fake.listen).toHaveBeenLastCalledWith({
      host: "127.0.0.1",
      port: Number(port ?? 4317),
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const callback = on.mock.calls.find(([name]) => name === signal)![1];
      callback();
      await Promise.resolve();
      expect(fake.close).toHaveBeenCalled();
      expect(exit).toHaveBeenLastCalledWith(0);
    }
  },
);
