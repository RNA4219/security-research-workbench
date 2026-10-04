export function createDiagnosticFixture(directory?: string): Promise<{
  directory: string;
  commits: { baseline: string; updated: string; fixed: string };
}>;
