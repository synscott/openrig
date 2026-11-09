import type { QueueTransition } from "../queue-transition-log.js";
import { createHash } from "node:crypto";

export interface ReportInterval {
  identity: string;
  start: string;
  end: string;
  actor: string | null;
  source: string;
  label: string;
  result: string;
}
export type ReportDuration = { kind: "unknown"; reason: string } | { kind: "partial" | "measured"; milliseconds: number; reason: string };
export interface ReportLifecycleEvent {
  transitionId: number;
  qitemId: string;
  at: string;
  state: string;
  actor: string | null;
  note: string | null;
}
export interface ReportTimecard {
  commands: ReportInterval[];
  events: ReportLifecycleEvent[];
  lifecycle: Array<ReportInterval & { state: string; ongoing: boolean }>;
  commandTime: ReportDuration;
  waiting: ReportDuration;
  effort: { kind: "unknown"; reason: string };
  byActor: Array<{ actor: string | null; commandMilliseconds: number }>;
  issues: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readCommandIntervals(value: unknown, source: string): { intervals: ReportInterval[]; issues: string[] } {
  if (!Array.isArray(value)) return { intervals: [], issues: [`${source}: no command interval array`] };
  const intervals: ReportInterval[] = [];
  const issues: string[] = [];
  value.forEach((row: unknown, index) => {
    if (!object(row) || typeof row.started_at !== "string" || typeof row.ended_at !== "string") {
      issues.push(`${source}[${index}]: missing recorded command endpoints`);
      return;
    }
    const start = Date.parse(row.started_at), end = Date.parse(row.ended_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      issues.push(`${source}[${index}]: invalid command interval`);
      return;
    }
    const label = typeof row.label === "string" ? row.label : Array.isArray(row.argv) && row.argv.every(v => typeof v === "string") ? row.argv.join(" ") : "Recorded command";
    const identity = createHash("sha256").update(JSON.stringify([row.head ?? null, row.dirty_diff_sha256 ?? null, row.cwd ?? null, row.argv ?? null, row.started_at, row.ended_at, row.actor ?? null, label, row.exit ?? null])).digest("hex");
    intervals.push({ identity, start: new Date(start).toISOString(), end: new Date(end).toISOString(), actor: typeof row.actor === "string" ? row.actor : null,
      source: `${source}[${index}]`, label, result: typeof row.exit === "number" ? `exit ${row.exit}` : "result unrecorded" });
  });
  return { intervals, issues };
}

export function intervalMilliseconds(intervals: readonly Pick<ReportInterval, "start" | "end">[]): number {
  const sorted = intervals.map(interval => ({ start: Date.parse(interval.start), end: Date.parse(interval.end) }))
    .filter(interval => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end >= interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0, start = 0, end = 0;
  for (const interval of sorted) {
    if (interval.start > end) { total += end - start; start = interval.start; end = interval.end; }
    else end = Math.max(end, interval.end);
  }
  return total + end - start;
}

export function buildReportTimecard(input: {
  transitions: readonly Pick<QueueTransition, "transitionId" | "qitemId" | "ts" | "state" | "actorSession" | "transitionNote">[];
  commands: readonly ReportInterval[];
  asOf: string;
  issues?: readonly string[];
}): ReportTimecard {
  const issues = [...(input.issues ?? [])];
  const cutoff = Date.parse(input.asOf);
  const events: ReportLifecycleEvent[] = [];
  const groups = new Map<string, typeof input.transitions[number][]>();
  for (const transition of [...input.transitions].sort((a, b) => a.transitionId - b.transitionId)) {
    const at = Date.parse(transition.ts);
    if (at > cutoff) { issues.push(`queue:${transition.qitemId}#${transition.transitionId}: future lifecycle event excluded`); continue; }
    if (!Number.isFinite(at)) issues.push(`queue:${transition.qitemId}#${transition.transitionId}: event clock unavailable`);
    events.push({ transitionId: transition.transitionId, qitemId: transition.qitemId, at: transition.ts, state: transition.state, actor: transition.actorSession || null, note: transition.transitionNote });
    const group = groups.get(transition.qitemId) ?? [];
    group.push(transition); groups.set(transition.qitemId, group);
  }
  const lifecycle: ReportTimecard["lifecycle"] = [];
  for (const transitions of groups.values()) {
    const changes = [...transitions].sort((a, b) => a.transitionId - b.transitionId)
      .filter((transition, index, sorted) => index === 0 || sorted[index - 1]?.state !== transition.state);
    changes.forEach((transition, index) => {
      const next = changes[index + 1];
      const start = Date.parse(transition.ts), end = next ? Math.min(Date.parse(next.ts), cutoff) : cutoff;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        issues.push(`queue:${transition.qitemId}#${transition.transitionId}: invalid lifecycle clock`); return;
      }
      lifecycle.push({ identity: `queue:${transition.qitemId}#${transition.transitionId}`, start: new Date(start).toISOString(), end: new Date(end).toISOString(), actor: transition.actorSession || null,
        source: `queue:${transition.qitemId}#${transition.transitionId}`, label: transition.transitionNote ?? transition.state,
        result: next?.state ?? "as of snapshot", state: transition.state, ongoing: !next });
    });
  }
  const closed = input.commands.filter(command => Date.parse(command.end) <= cutoff && Date.parse(command.start) <= Date.parse(command.end));
  if (closed.length !== input.commands.length) issues.push("Unclosed or future command intervals excluded from measured time");
  const commands = [...new Map(closed.map(command => [command.identity, command])).values()];
  if (commands.length !== closed.length) issues.push("Repeated command records deduplicated by recorded candidate, command and interval identity");
  const actors = new Set(commands.map(command => command.actor));
  const waiting = lifecycle.filter(interval => interval.state === "blocked");
  return {
    commands: [...commands].sort((a, b) => a.start.localeCompare(b.start) || a.source.localeCompare(b.source)), events, lifecycle,
    commandTime: commands.length ? { kind: "partial", milliseconds: intervalMilliseconds(commands), reason: "Recorded command wall time; retained records do not establish complete effort coverage" }
      : { kind: "unknown", reason: "No attributed closed command intervals recorded" },
    waiting: lifecycle.length ? { kind: "partial", milliseconds: intervalMilliseconds(waiting), reason: "Recorded blocked lifecycle residence; unmarked waits and missing history remain unknown" }
      : { kind: "unknown", reason: "No lifecycle history recorded" },
    effort: { kind: "unknown", reason: "Queue residence and command wall time do not measure continuous model or human effort" },
    byActor: [...actors].map(actor => ({ actor, commandMilliseconds: intervalMilliseconds(commands.filter(command => command.actor === actor)) })), issues,
  };
}
