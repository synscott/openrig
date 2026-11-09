import { useState } from "react";
import type { ReportDuration, ReportFact, ReportItem } from "@openrig/daemon/project-report";
import { useProjectWorkReport, useReportProjects } from "../../hooks/useProjectWorkReport.js";

const labels = { done: "Done", in_flight: "In flight", left_to_do: "Left to do" };
function duration(value: ReportDuration): string {
  return value.kind === "unknown" ? "Unknown" : `${(value.milliseconds / 60000).toFixed(1)} min${value.kind === "partial" ? " recorded" : ""}`;
}
function fact(value: ReportFact): string { return value.kind === "unknown" ? `Unknown. ${value.reason}` : value.value; }
function WorkDetail({ item }: { item: ReportItem }) {
  return <div className="space-y-4 border-t border-outline-variant/30 p-4 text-sm">
    <dl className="grid gap-3 sm:grid-cols-2">
      <div><dt className="text-on-surface-variant">Progress</dt><dd className="whitespace-pre-wrap break-words">{item.progress || "No sourced progress recorded"}</dd></div>
      <div><dt className="text-on-surface-variant">Next action</dt><dd>{item.nextAction ?? "Not recorded"}</dd></div>
      <div><dt className="text-on-surface-variant">Blocker</dt><dd>{item.blocker ?? "No explicit blocker recorded"}</dd></div>
      <div><dt className="text-on-surface-variant">Classification</dt><dd>{item.classification}</dd></div>
      <div><dt className="text-on-surface-variant">Acceptance</dt><dd>{fact(item.acceptance)}</dd></div>
      <div><dt className="text-on-surface-variant">Integration</dt><dd>{fact(item.integration)}</dd></div>
    </dl>
    <section aria-label="Item timecard" className="space-y-2">
      <h4 className="font-semibold">Timecard</h4>
      <p>Command wall time: {duration(item.timecard.commandTime)} · Blocked residence: {duration(item.timecard.waiting)} · Continuous effort: unknown</p>
      <p className="text-xs text-on-surface-variant">{item.timecard.effort.reason} Unmarked waits and unrecorded time remain unknown.</p>
      {item.timecard.commands.map((command, index) => <div key={`${command.source}-${index}`} className="break-words border-l border-outline-variant/40 pl-3">
        <p>{command.label} · {command.actor ?? "Actor unrecorded"} · {command.result}</p>
        <p className="font-mono text-xs">{command.start} to {command.end}</p><p className="text-xs text-on-surface-variant">{command.source}</p>
      </div>)}
      {item.timecard.lifecycle.map((interval, index) => <p key={`${interval.source}-${index}`} className="break-words text-xs text-on-surface-variant">{interval.state} · {interval.actor ?? "Unknown actor"} · {interval.start} to {interval.end}{interval.ongoing ? " · as of snapshot" : ""}</p>)}
    </section>
    {item.warnings.concat(item.timecard.issues).map((warning, index) => <p key={index} className="break-words text-xs text-on-surface-variant">{warning}</p>)}
    <section aria-label="Item evidence"><h4 className="font-semibold">Sources and evidence</h4>{[...item.evidence, ...(item.acceptance.kind === "reported" ? item.acceptance.evidence : []), ...(item.integration.kind === "reported" ? item.integration.evidence : [])].map((evidence, index) => <p key={index} className="break-words font-mono text-xs">{evidence.label} · {evidence.source}{evidence.at ? ` · ${evidence.at}` : ""}</p>)}</section>
  </div>;
}

export function ProjectWorkReport() {
  const catalog = useReportProjects();
  const [selected, setSelected] = useState<string | null>(null);
  const [mission, setMission] = useState("");
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState("all");
  const project = catalog.data?.projects.find(entry => `${entry.id}\n${entry.root}` === selected) ?? (selected === null && catalog.data?.projects.length === 1 ? catalog.data.projects[0] : null) ?? null;
  const report = useProjectWorkReport(project);
  const missions = (report.data?.missions ?? []).filter(entry => !mission || entry.mission === mission);
  const items = missions.flatMap(entry => entry.items.filter(item => item.counting === "unit"));
  const visible = items.filter(item => (bucket === "all" || item.bucket === bucket) && `${item.title} ${item.owner ?? ""} ${item.stage ?? ""} ${item.id ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const totals = missions.reduce((sum, entry) => ({ done: sum.done + entry.totals.done, inFlight: sum.inFlight + entry.totals.inFlight, left: sum.left + entry.totals.leftToDo }), { done: 0, inFlight: 0, left: 0 });
  const stale = report.data ? Date.now() - Date.parse(report.data.asOf) > 60000 : false;
  return <section className="space-y-5" aria-label="Projects work report">
    <div className="flex flex-wrap items-end gap-3">
      <label className="space-y-1 text-xs text-on-surface-variant">Project<select aria-label="Project" className="block max-w-full rounded border border-outline-variant bg-surface p-2 text-on-surface" value={project ? `${project.id}\n${project.root}` : ""} onChange={event => { setSelected(event.target.value); setMission(""); }}><option value="">Choose a project</option>{catalog.data?.projects.map(entry => <option key={`${entry.id}-${entry.root}`} value={`${entry.id}\n${entry.root}`}>{entry.name} · {entry.id}</option>)}</select></label>
      <button type="button" className="rounded border border-outline-variant px-3 py-2 text-sm disabled:opacity-50" disabled={report.isFetching || !project} onClick={() => { void catalog.refetch(); void report.refetch(); }}>Refresh</button>
      <span className="text-xs text-on-surface-variant" role="status">{report.isFetching ? "Reading existing sources…" : report.data ? `As of ${new Date(report.data.asOf).toLocaleString()}${stale ? " · stale, refresh to update" : ""}` : "Read-only inventory"}</span>
    </div>
    {(catalog.error || report.error || project?.error) && <p role="alert" className="break-words text-sm text-on-surface-variant">{project?.error ?? catalog.error?.message ?? report.error?.message}. {report.data ? "Showing the previous snapshot; refresh to retry." : "Select another project or refresh to retry."}</p>}
    {catalog.isLoading && <p role="status">Reading project catalog…</p>}
    {report.data && <>
      {!!report.data.unmappedQueue.length && <details><summary className="cursor-pointer">Project queue records without a resolved mission ({report.data.unmappedQueue.length})</summary>{report.data.unmappedQueue.map(row => <p key={row.qitemId} className="break-words text-xs">{row.summary ?? row.qitemId} · {row.destinationSession} · {row.state} · {(row.tags ?? []).join(" ")}</p>)}</details>}
      <div className="border-y border-outline-variant/40 py-4"><h2 className="text-xl font-semibold">{items.length} known work units</h2><p className="mt-1 text-sm">Done {totals.done} · In flight {totals.inFlight} · Left to do {totals.left}</p><div className="mt-2 text-xs text-on-surface-variant">{missions.map(entry => <p key={entry.mission}>{entry.mission} · authored status {entry.authoredStatus ?? "unrecorded"}</p>)}</div><p className="mt-2 text-xs text-on-surface-variant">Reported completion, attributed acceptance, and integration are separate. Rollup parents and PRs are excluded from work totals. Source coverage is partial. Left to do includes unknown completion; open a row for its basis.</p></div>
      <div className="flex flex-wrap gap-3">
        <label className="text-xs">Mission<select aria-label="Mission" className="ml-2 rounded border border-outline-variant bg-surface p-2" value={mission} onChange={event => setMission(event.target.value)}><option value="">All missions</option>{report.data.missions.map(entry => <option key={entry.mission}>{entry.mission}</option>)}</select></label>
        <label className="text-xs">Status<select aria-label="Status" className="ml-2 rounded border border-outline-variant bg-surface p-2" value={bucket} onChange={event => setBucket(event.target.value)}><option value="all">All work</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <input type="search" aria-label="Filter work" placeholder="Filter title, owner, stage or ID" value={search} onChange={event => setSearch(event.target.value)} className="w-full rounded border border-outline-variant bg-surface p-2 text-sm sm:w-auto sm:min-w-0 sm:flex-1" />
      </div>
      <p className="text-xs text-on-surface-variant">Showing {visible.length} of {items.length} known work units</p>
      <div className="space-y-5">{(["done", "in_flight", "left_to_do"] as const).filter(group => bucket === "all" || bucket === group).map(group => <section key={group} aria-label={`${labels[group]} work`}>
        <h3 className="mb-2 text-sm font-semibold">{labels[group]} · {visible.filter(item => item.bucket === group).length}</h3>
        <div className="divide-y divide-outline-variant/30 border-y border-outline-variant/40">{visible.filter(item => item.bucket === group).map(item => <details key={item.key} className="group">
          <summary className="cursor-pointer py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><span className="ml-2 text-xs text-on-surface-variant">{labels[item.bucket]}</span><span className="ml-3 font-medium">{item.title}</span><span className="ml-3 break-words text-xs text-on-surface-variant">{item.owner ?? "Owner unrecorded"} · {item.stage ?? "Stage unknown"}</span></summary><WorkDetail item={item} />
        </details>)}</div>
      </section>)}</div>
      {!visible.length && <p role="status">No work units match these filters. Source gaps remain below.</p>}
      <details><summary className="cursor-pointer text-sm">Source coverage and unmapped records ({missions.reduce((sum, entry) => sum + entry.diagnostics.length, 0)})</summary><div className="mt-3 space-y-2 text-xs">{report.data.issues.map(issue => <p key={issue}>{issue}</p>)}<details><summary className="cursor-pointer">Source read manifest ({report.data.sources.length})</summary>{report.data.sources.map(source => <p key={source.path} className="break-words font-mono">{source.path} · modified {source.modifiedAt} · SHA {source.sha256.slice(0, 12)}</p>)}</details>{missions.map(entry => <div key={entry.mission}><h3 className="font-semibold">{entry.mission}</h3><p>{entry.queueCoverage.members} associated queue records, {entry.queueCoverage.legacyMembers} explicitly linked legacy records, {entry.queueCoverage.excluded} excluded of {entry.queueCoverage.candidates} mission candidates.</p>{entry.diagnostics.map((diagnostic, index) => <details key={`${diagnostic.key}-${index}`} className="my-2"><summary className="cursor-pointer break-words">{diagnostic.queue?.summary ?? diagnostic.key} · {diagnostic.reason}</summary><p className="break-words">{diagnostic.source}</p>{diagnostic.kind !== "source" && <><p className="break-words">{diagnostic.queue.destinationSession} · {diagnostic.queue.state} · {(diagnostic.queue.tags ?? []).join(" ")}</p><p>Recorded command wall time: {duration(diagnostic.timecard.commandTime)} · Blocked residence: {duration(diagnostic.timecard.waiting)} · Effort unknown</p>{diagnostic.timecard.commands.map((command, index) => <p key={index} className="break-words">{command.label} · {command.actor ?? "Actor unrecorded"} · {command.result} · {command.start} to {command.end}</p>)}</>}</details>)}</div>)}</div></details>
    </>}
    {catalog.data?.projects.length === 0 && <p>No catalog projects are declared.</p>}
  </section>;
}
