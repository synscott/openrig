import { useQuery } from "@tanstack/react-query";
import { parseProjectWorkReport, parseReportProjects, type ProjectWorkReport } from "@openrig/daemon/project-report";
import { useSelectedHostId } from "./useHosts.js";
import { withHostParam } from "../lib/host-param.js";

export interface ReportProjectChoice { id: string; root: string; name: string; error?: string }
async function read(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Projects source unavailable (${response.status})`);
  return response.json();
}
export function useReportProjects() {
  const host = useSelectedHostId();
  return useQuery<{ projects: ReportProjectChoice[]; catalogPath: string }>({ queryKey: ["report-projects", host], queryFn: () => read(withHostParam("/api/scopes/projects", host)).then(parseReportProjects), staleTime: 30000 });
}
export function useProjectWorkReport(project: ReportProjectChoice | null) {
  const host = useSelectedHostId();
  const query = new URLSearchParams(project ? { project: project.id, projectRoot: project.root } : {});
  return useQuery<ProjectWorkReport>({ queryKey: ["project-work-report", host, project?.id, project?.root], enabled: !!project && !project.error,
    queryFn: () => read(withHostParam(`/api/scopes/report?${query}`, host)).then(parseProjectWorkReport), staleTime: 30000 });
}
