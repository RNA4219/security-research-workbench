import { z } from "zod";

export const researchInput = z.strictObject({
  repoUrl: z.string().trim().min(1).max(250),
});
export type ResearchSource = { label: string; url: string; sha256: string };
export type Dependency = {
  name: string;
  version: string;
  paths: string[];
  development: boolean;
};
export type DependencyFinding = Dependency & {
  advisoryId: string;
  summary: string;
  url: string;
  fixes: string[];
  detailStatus: "available" | "unavailable";
};
export type ResearchReport = {
  id: string;
  collectedAt: string;
  repository: {
    name: string;
    url: string;
    description: string;
    license: string | null;
    archived: boolean;
    defaultBranch: string;
    commit: string | null;
    committedAt: string | null;
    latestRelease: string | null;
    releaseStatus: "found" | "none" | "unavailable";
  };
  dependencies: {
    status: "complete" | "partial" | "unavailable" | "unsupported";
    lockfile: string | null;
    total: number;
    queried: number;
    skipped: number;
    unassessed?: { path: string; reason: string }[];
    findings: DependencyFinding[];
    withdrawn: number;
  };
  actions: { title: string; detail: string; sourceUrl: string }[];
  limitations: string[];
  sources: ResearchSource[];
};
export type ResearchSummary = {
  id: string;
  name: string;
  collectedAt: string;
  findings: number;
  status: ResearchReport["dependencies"]["status"];
};
