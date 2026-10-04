import { z } from "zod";
import type { ResearchReport } from "../shared/repository-research.js";

export const storageKey = "security-research-workbench:reports:v1";
const limit = 2 * 1024 * 1024;
const https = z.url({ protocol: /^https$/ });
const nullable = z.string().nullable();
// 保存領域も外部入力として検証する。壊れた履歴は自動で上書きしない。
const reportSchema = z.object({
  id: z.uuid(),
  collectedAt: z.iso.datetime(),
  repository: z.object({
    name: z.string(),
    url: https,
    description: z.string(),
    license: nullable,
    archived: z.boolean(),
    defaultBranch: z.string(),
    commit: nullable,
    committedAt: nullable,
    latestRelease: nullable,
    releaseStatus: z.enum(["found", "none", "unavailable"]),
  }),
  dependencies: z.object({
    status: z.enum(["complete", "partial", "unavailable", "unsupported"]),
    lockfile: nullable,
    total: z.number(),
    queried: z.number(),
    skipped: z.number(),
    withdrawn: z.number(),
    unassessed: z
      .array(z.object({ path: z.string(), reason: z.string() }))
      .optional(),
    findings: z.array(
      z.object({
        name: z.string(),
        version: z.string(),
        paths: z.array(z.string()),
        development: z.boolean(),
        advisoryId: z.string(),
        summary: z.string(),
        url: https,
        fixes: z.array(z.string()),
        detailStatus: z.enum(["available", "unavailable"]),
      }),
    ),
  }),
  actions: z.array(
    z.object({ title: z.string(), detail: z.string(), sourceUrl: https }),
  ),
  limitations: z.array(z.string()),
  sources: z.array(
    z.object({ label: z.string(), url: https, sha256: z.string() }),
  ),
});
const historySchema = z.array(reportSchema).max(20);
type StorageAccess = () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function browserHistory(access: StorageAccess = () => localStorage) {
  const read = (): ResearchReport[] => {
    try {
      const raw = access().getItem(storageKey);
      if (!raw) return [];
      if (new Blob([raw]).size > limit) throw new Error();
      return historySchema.parse(JSON.parse(raw));
    } catch {
      throw new Error(
        "ブラウザの保存設定を確認してください。履歴が壊れている場合は下部から削除できます。",
      );
    }
  };
  return {
    list: async () =>
      read().map((r) => ({
        id: r.id,
        name: r.repository.name,
        collectedAt: r.collectedAt,
        findings: r.dependencies.findings.length,
        status: r.dependencies.status,
      })),
    get: async (id: string) => {
      const report = read().find((r) => r.id === id);
      if (!report)
        throw new Error(
          "保存した結果が見つかりません。URLから再調査してください。",
        );
      return report;
    },
    save: async (report: ResearchReport) => {
      const reports = [
        reportSchema.parse(report),
        ...read().filter((r) => r.id !== report.id),
      ].slice(0, 20);
      while (
        new Blob([JSON.stringify(reports)]).size > limit &&
        reports.length > 1
      )
        reports.pop();
      if (new Blob([JSON.stringify(reports)]).size > limit)
        throw new Error("保存上限を超えています。");
      access().setItem(storageKey, JSON.stringify(reports));
    },
    clear: async () => {
      access().removeItem(storageKey);
    },
  };
}
