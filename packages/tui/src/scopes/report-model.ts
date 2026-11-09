import type { MissionWorkReport, ReportDuration, ReportFact } from "@openrig/daemon/project-report";
import { listItem, wrapDetailLines, type ContentLine } from "../detail.js";

const duration = (value: ReportDuration): string => value.kind === "unknown" ? "unknown" : `${(value.milliseconds / 60000).toFixed(1)} min recorded`;
const fact = (value: ReportFact): string => value.kind === "unknown" ? `unknown: ${value.reason}` : value.value;
const labels = { done: "Done", in_flight: "In flight", left_to_do: "Left to do" };
export function reportContentLines(report: MissionWorkReport, selected: string | null, filter: string, width: number, sources: readonly { path: string; modifiedAt: string; sha256: string }[] = []): ContentLine[] {
  const lines: ContentLine[] = [
    { text: `${report.mission} · WORK REPORT` }, { text: `Authored mission status: ${report.authoredStatus ?? "unrecorded"}` }, { text: `As of ${report.asOf} · partial source coverage` },
    { text: `Done ${report.totals.done} · In flight ${report.totals.inFlight} · Left to do ${report.totals.leftToDo} = ${report.totals.total} known units` },
    { text: "Reported completion, acceptance and integration are separate. Rollup parents and PRs do not add units." },
    { text: "Left to do includes unknown completion; open a row for its source basis." },
  ];
  if (selected === "coverage") {
    lines.push({ text: `${report.queueCoverage.members} associated, ${report.queueCoverage.legacyMembers} declared legacy, ${report.queueCoverage.excluded} excluded of ${report.queueCoverage.candidates} mission queue candidates.` });
    for (const diagnostic of report.diagnostics.filter(row => !filter || `${row.key} ${row.reason} ${row.queue?.summary ?? ""}`.toLowerCase().includes(filter.toLowerCase()))) {
      lines.push({ text: `${diagnostic.queue?.summary ?? diagnostic.key}: ${diagnostic.reason}` }, { text: diagnostic.source });
      if (diagnostic.kind !== "source") {
        lines.push({ text: `${diagnostic.queue.destinationSession} · ${diagnostic.queue.state} · ${(diagnostic.queue.tags ?? []).join(" ")}` },
          { text: `Command wall time ${duration(diagnostic.timecard.commandTime)} · blocked residence ${duration(diagnostic.timecard.waiting)} · effort unknown` });
        for (const command of diagnostic.timecard.commands) lines.push({ text: `${command.label} · ${command.actor ?? "Actor unrecorded"} · ${command.result} · ${command.start} to ${command.end}` });
      }
    }
    lines.push({ text: "SOURCE READ MANIFEST" }, ...sources.map(source => ({ text: `${source.path} · modified ${source.modifiedAt} · SHA ${source.sha256.slice(0, 12)}` })));
    return wrapDetailLines(lines, width);
  }
  const item = selected ? report.items.find(row => row.key === selected || row.id === selected) : null;
  if (selected && !item) return wrapDetailLines([...lines, { text: "Work identity no longer represented in this snapshot. Go Back and refresh." }], width);
  if (item) {
    lines.push({ text: item.title }, { text: `${labels[item.bucket]} · ${item.owner ?? "Owner unrecorded"} · ${item.stage ?? "Stage unknown"}` },
      { text: `Progress: ${item.progress || "No sourced progress recorded"}` }, { text: `Next: ${item.nextAction ?? "Not recorded"}` },
      { text: `Blocker: ${item.blocker ?? "No explicit blocker recorded"}` }, { text: `Acceptance: ${fact(item.acceptance)}` }, { text: `Integration: ${fact(item.integration)}` },
      { text: "TIMECARD" }, { text: `Command wall time ${duration(item.timecard.commandTime)} · blocked residence ${duration(item.timecard.waiting)} · continuous effort unknown` }, { text: item.timecard.effort.reason });
    for (const command of item.timecard.commands) lines.push({ text: `${command.label} · ${command.actor ?? "Actor unrecorded"} · ${command.result}` }, { text: `${command.start} to ${command.end}` }, { text: command.source });
    for (const interval of item.timecard.lifecycle) lines.push({ text: `${interval.state} · ${interval.actor ?? "Actor unknown"} · ${interval.start} to ${interval.end}${interval.ongoing ? " · as of snapshot" : ""}` });
    for (const warning of [...item.warnings, ...item.timecard.issues]) lines.push({ text: `Coverage: ${warning}` });
    lines.push({ text: "EVIDENCE" }, ...[...item.evidence, ...(item.acceptance.kind === "reported" ? item.acceptance.evidence : []), ...(item.integration.kind === "reported" ? item.integration.evidence : [])].map(evidence => ({ text: `${evidence.label} · ${evidence.source}${evidence.at ? ` · ${evidence.at}` : ""}` })));
    return wrapDetailLines(lines, width);
  }
  const items = report.items.filter(row => row.counting === "unit" && (!filter || `${row.title} ${row.owner ?? ""} ${row.id ?? ""} ${labels[row.bucket]}`.toLowerCase().includes(filter.toLowerCase())));
  lines.push({ text: "Use /text to filter, work <identity> to open, r to refresh, Back to return." });
  for (const bucket of ["done", "in_flight", "left_to_do"] as const) {
    lines.push({ text: labels[bucket].toUpperCase() });
    for (const row of items.filter(item => item.bucket === bucket)) lines.push(listItem(`${row.title} · ${row.owner ?? "Owner unrecorded"} · ${row.stage ?? "Stage unknown"}`, { type: "execution-open", key: `report:${row.key}` }), { text: `  ${row.id ?? row.key}` });
  }
  if (!items.length) lines.push({ text: "No work units match this filter; source gaps remain available below." });
  lines.push(listItem(`Source coverage and unmapped records (${report.diagnostics.length})`, { type: "execution-open", key: "report:coverage" }));
  return wrapDetailLines(lines, width);
}
