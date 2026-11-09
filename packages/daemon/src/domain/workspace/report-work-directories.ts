export interface ReportWorkDirectory { ref: string; disposition: "work" | "container" | "artifacts" }
export function parseReportWorkDirectories(manifest: unknown): { entries: ReportWorkDirectory[]; issues: string[] } {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(manifest) || !record(manifest.reporting) || manifest.reporting.work_directories === undefined) return { entries: [], issues: [] };
  const values = manifest.reporting.work_directories;
  if (!Array.isArray(values)) return { entries: [], issues: ["reporting.work_directories must be an array"] };
  const entries: ReportWorkDirectory[] = [];
  const issues: string[] = [];
  for (const value of values) {
    if (!record(value) || Object.keys(value).some(key => key !== "ref" && key !== "disposition") || typeof value.ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value.ref) || value.ref.split("/").some(part => !part || part === "." || part === "..") || (value.disposition !== "work" && value.disposition !== "container" && value.disposition !== "artifacts")) {
      issues.push("Invalid work directory: require a contained relative ref and work/container/artifacts disposition"); continue;
    }
    entries.push({ ref: value.ref, disposition: value.disposition });
  }
  const unique = entries.filter(entry => entries.filter(other => other.ref === entry.ref).length === 1);
  for (const ref of new Set(entries.filter(entry => !unique.includes(entry)).map(entry => entry.ref))) issues.push(`Duplicate or conflicting work directory ${ref}`);
  return { entries: unique, issues };
}
