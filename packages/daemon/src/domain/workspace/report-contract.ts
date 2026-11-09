import type { ProjectWorkReport } from "./project-report.js";
import type { ReportEvidence, ReportFact, ReportQueueRecord, ReportItem, ReportDiagnostic, ReportTotals } from "./report-projection.js";
import type { ReportDuration, ReportInterval, ReportTimecard } from "./report-timecard.js";

type RecordValue = Record<string, unknown>;
const invalid = (): never => { throw new Error("Projects report source returned an invalid contract"); };
function isRecord(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function record(value: unknown): RecordValue { return isRecord(value) ? value : invalid(); }
function text(value: unknown): string { return typeof value === "string" ? value : invalid(); }
function nullable(value: unknown): string | null { return value === null ? null : text(value); }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : invalid(); }
function flag(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function list<T>(value: unknown, parse: (item: unknown) => T): T[] { return Array.isArray(value) ? value.map(parse) : invalid(); }
function evidence(value: unknown): ReportEvidence { const v = record(value); return { source: text(v.source), label: text(v.label), at: nullable(v.at) }; }
function fact(value: unknown): ReportFact {
  const v = record(value);
  if (v.kind === "unknown") return { kind: "unknown", reason: text(v.reason) };
  if (v.kind === "reported") return { kind: "reported", value: text(v.value), evidence: list(v.evidence, evidence) };
  return invalid();
}
function duration(value: unknown): ReportDuration {
  const v = record(value);
  if (v.kind === "unknown") return { kind: "unknown", reason: text(v.reason) };
  if (v.kind === "partial" || v.kind === "measured") return { kind: v.kind, reason: text(v.reason), milliseconds: number(v.milliseconds) };
  return invalid();
}
function interval(value: unknown): ReportInterval { const v = record(value); return { start: text(v.start), end: text(v.end), actor: nullable(v.actor), source: text(v.source), label: text(v.label), result: text(v.result) }; }
function timecard(value: unknown): ReportTimecard {
  const v = record(value), effort = record(v.effort);
  if (effort.kind !== "unknown") return invalid();
  return { commands: list(v.commands, interval), lifecycle: list(v.lifecycle, item => { const row = record(item); return { ...interval(item), state: text(row.state), ongoing: flag(row.ongoing) }; }),
    commandTime: duration(v.commandTime), waiting: duration(v.waiting), effort: { kind: "unknown", reason: text(effort.reason) },
    byActor: list(v.byActor, item => { const row = record(item); return { actor: nullable(row.actor), commandMilliseconds: number(row.commandMilliseconds) }; }), issues: list(v.issues, text) };
}
function queue(value: unknown): ReportQueueRecord {
  const v = record(value);
  return { qitemId: text(v.qitemId), tags: v.tags === null ? null : list(v.tags, text), body: text(v.body), summary: nullable(v.summary), state: text(v.state), destinationSession: text(v.destinationSession), sourceSession: text(v.sourceSession), blockedOn: nullable(v.blockedOn), handedOffFrom: nullable(v.handedOffFrom), chainOfRecord: v.chainOfRecord === null ? null : list(v.chainOfRecord, text), evidenceRef: nullable(v.evidenceRef), tsCreated: text(v.tsCreated), tsUpdated: text(v.tsUpdated), resolution: nullable(v.resolution) };
}
function item(value: unknown): ReportItem {
  const v = record(value);
  if (v.counting !== "unit" && v.counting !== "rollup") return invalid();
  if (v.bucket !== "done" && v.bucket !== "in_flight" && v.bucket !== "left_to_do") return invalid();
  return { key: text(v.key), id: nullable(v.id), parent: nullable(v.parent), title: text(v.title), source: text(v.source), counting: v.counting, bucket: v.bucket,
    classification: text(v.classification), authoredStatus: nullable(v.authoredStatus), owner: nullable(v.owner), stage: nullable(v.stage), progress: text(v.progress), nextAction: nullable(v.nextAction), blocker: nullable(v.blocker), acceptance: fact(v.acceptance), integration: fact(v.integration), attempts: list(v.attempts, queue), evidence: list(v.evidence, evidence), warnings: list(v.warnings, text), timecard: timecard(v.timecard) };
}
function diagnostic(value: unknown): ReportDiagnostic {
  const v = record(value), common = { key: text(v.key), reason: text(v.reason), source: text(v.source) };
  if (v.kind === "source" && v.queue === null) return { ...common, kind: "source", queue: null };
  if (v.kind === "queue_association" || v.kind === "ambiguous_work") return { ...common, kind: v.kind, queue: queue(v.queue), timecard: timecard(v.timecard) };
  return invalid();
}
function totals(value: unknown): ReportTotals {
  const v = record(value), result = { done: number(v.done), inFlight: number(v.inFlight), leftToDo: number(v.leftToDo), total: number(v.total) };
  if (result.done + result.inFlight + result.leftToDo !== result.total) return invalid();
  return result;
}
export function parseProjectWorkReport(value: unknown): ProjectWorkReport {
  const v = record(value), project = record(v.project);
  if (v.coverage !== "partial") return invalid();
  return { project: { id: text(project.id), root: text(project.root), name: text(project.name) }, asOf: text(v.asOf), revision: text(v.revision), coverage: "partial", issues: list(v.issues, text), unmappedQueue: list(v.unmappedQueue, queue),
    sources: list(v.sources, item => { const source = record(item); return { path: text(source.path), sha256: text(source.sha256), modifiedAt: text(source.modifiedAt) }; }),
    missions: list(v.missions, value => { const mission = record(value), coverage = record(mission.queueCoverage); return { mission: text(mission.mission), missionId: nullable(mission.missionId), authoredStatus: nullable(mission.authoredStatus), asOf: text(mission.asOf), items: list(mission.items, item), totals: totals(mission.totals), diagnostics: list(mission.diagnostics, diagnostic), queueCoverage: { candidates: number(coverage.candidates), members: number(coverage.members), legacyMembers: number(coverage.legacyMembers), excluded: number(coverage.excluded) } }; }) };
}

export function parseReportProjects(value: unknown): { catalogPath: string; projects: Array<{ id: string; root: string; name: string; error?: string }> } {
  const v = record(value);
  return { catalogPath: text(v.catalogPath), projects: list(v.projects, entry => { const p = record(entry); return { id: text(p.id), root: text(p.root), name: text(p.name), ...(p.error === undefined ? {} : { error: text(p.error) }) }; }) };
}
