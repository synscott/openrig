import { reportMembership, reportTags, type ReportAssociation, type ReportMembership } from "./report-association.js";
import type { ReportTimecard } from "./report-timecard.js";

export type ReportBucket = "done" | "in_flight" | "left_to_do" | "unresolved";
export interface ReportEvidence { source: string; label: string; at: string | null }
export type ReportFact = { kind: "unknown"; reason: string } | { kind: "reported"; value: string; evidence: ReportEvidence[] };
export interface ReportNode {
  key: string; id: string | null; parent: string | null; title: string; source: string; aliases: readonly string[];
  status: string | null; stage: string | null; intent: string;
  progress?: string; evidence?: ReportEvidence[];
  counting?: "unit" | "rollup";
  owner: string | null; nextAction: string | null; blocker: string | null;
  acceptance: ReportFact; integration: ReportFact;
}
export interface ReportQueueRecord {
  qitemId: string; tags: string[] | null; body: string; summary: string | null;
  state: string; destinationSession: string; sourceSession: string; blockedOn: string | null;
  handedOffFrom: string | null; chainOfRecord: string[] | null; evidenceRef: string | null;
  tsCreated: string; tsUpdated: string; resolution: string | null;
}
export interface ReportItem {
  key: string; id: string | null; parent: string | null; title: string; source: string;
  counting: "unit" | "rollup"; bucket: ReportBucket; classification: string;
  authoredStatus: string | null; owner: string | null; stage: string | null;
  progress: string; nextAction: string | null; blocker: string | null;
  acceptance: ReportFact; integration: ReportFact;
  attempts: ReportQueueRecord[]; evidence: ReportEvidence[]; warnings: string[];
  timecard: ReportTimecard;
}
export type ReportDiagnostic =
  | { kind: "source"; key: string; reason: string; source: string; queue: null }
  | { kind: "queue_association" | "ambiguous_work"; key: string; reason: string; source: string; queue: ReportQueueRecord; timecard: ReportTimecard };
export interface ReportTotals { done: number; inFlight: number; leftToDo: number; unresolved: number; total: number }
export interface MissionWorkReport {
  mission: string; missionId: string | null; authoredStatus: string | null; asOf: string; items: ReportItem[];
  totals: ReportTotals; diagnostics: ReportDiagnostic[];
  queueCoverage: { candidates: number; members: number; legacyMembers: number; excluded: number };
}

const buckets = new Map<string, ReportBucket>([
  ...["done", "complete", "completed", "delivered", "shipped"].map((status): [string, ReportBucket] => [status, "done"]),
  ...["wip", "in-progress", "working", "blocked", "implemented", "verified", "review"].map((status): [string, ReportBucket] => [status, "in_flight"]),
  ...["planned", "placeholder", "pending"].map((status): [string, ReportBucket] => [status, "left_to_do"]),
]);
const open = new Set(["pending", "in-progress", "blocked"]);
export const unknownReportFact = (reason: string): ReportFact => ({ kind: "unknown", reason });

export function reportTotals(items: readonly ReportItem[]): ReportTotals {
  const totals: ReportTotals = { done: 0, inFlight: 0, leftToDo: 0, unresolved: 0, total: 0 };
  for (const item of items) {
    if (item.counting === "rollup") continue;
    totals.total++;
    if (item.bucket === "done") totals.done++;
    else if (item.bucket === "in_flight") totals.inFlight++;
    else if (item.bucket === "left_to_do") totals.leftToDo++;
    else totals.unresolved++;
  }
  return totals;
}

export function projectMissionReport(input: {
  projectId: string; mission: string; missionId: string | null; missionStatus?: string | null; asOf: string;
  association: ReportAssociation; nodes: readonly ReportNode[]; rows: readonly ReportQueueRecord[];
  emptyTimecard: ReportTimecard; diagnostics?: readonly ReportDiagnostic[];
  evidenceCandidates?: ReadonlyMap<string, readonly string[]>;
}): MissionWorkReport {
  const diagnostics = [...(input.diagnostics ?? [])];
  const membership = new Map<string, ReportMembership>();
  const members = input.rows.filter(row => {
    const result = reportMembership({ tags: row.tags, projectId: input.projectId, missionId: input.missionId, missionName: input.mission, association: input.association });
    membership.set(row.qitemId, result);
    if (result.kind === "member") return true;
    diagnostics.push({ kind: "queue_association", key: row.qitemId, reason: result.reason, source: `queue:${row.qitemId}`, queue: row, timecard: input.emptyTimecard });
    return false;
  });
  const parent = new Map(input.rows.map(row => [row.qitemId, row.qitemId]));
  const root = (id: string): string => {
    const visited = new Set<string>();
    let current = id;
    for (;;) {
      const next = parent.get(current);
      if (!next || next === current || visited.has(next)) return current;
      visited.add(current); current = next;
    }
  };
  for (const row of input.rows) {
    for (const previous of [row.handedOffFrom, ...(row.chainOfRecord ?? [])]) {
      if (!previous || !parent.has(previous)) continue;
      const boundary = [membership.get(row.qitemId), membership.get(previous)];
      if (boundary.some(match => match?.kind === "excluded" && match.reason !== "project_missing" && match.reason !== "mission_missing")) continue;
      const left = root(row.qitemId), right = root(previous);
      if (left !== right) parent.set(left > right ? left : right, left > right ? right : left);
    }
  }
  const groups = new Map<string, ReportQueueRecord[]>();
  for (const row of members) { const key = root(row.qitemId); const group = groups.get(key) ?? []; group.push(row); groups.set(key, group); }
  const idClaims = new Map<string, number>();
  input.nodes.forEach(node => { if (node.id) idClaims.set(node.id, (idClaims.get(node.id) ?? 0) + 1); });
  const validNodes = input.nodes.filter(node => {
    if (!node.id || idClaims.get(node.id) === 1) return true;
    diagnostics.push({ kind: "source", key: node.key, source: node.source, queue: null, reason: `Duplicate authored work identity ${node.id}; excluded from unique totals` });
    return false;
  });
  const nodes = new Map(validNodes.map(node => [node.key, node]));
  const aliases = new Map<string, string[]>();
  for (const node of nodes.values()) {
    for (const alias of [node.id, node.source, node.key, ...node.aliases].filter((value): value is string => value !== null)) {
      const matches = aliases.get(alias) ?? []; matches.push(node.key); aliases.set(alias, matches);
    }
  }
  const attached = new Map<string, ReportQueueRecord[]>();
  const standalone: Array<{ key: string; rows: ReportQueueRecord[] }> = [];
  for (const [key, rows] of groups) {
    const declared = new Set<string>();
    for (const row of rows) {
      const tags = [...reportTags(row.tags)].filter(tag => tag.startsWith("slice:")).map(tag => tag.slice(6));
      const refs = [...tags, ...[...row.body.matchAll(/^Slice:[ \t]+(\S+)[ \t]*$/gm)].map(match => match[1] ?? "")];
      if (/\b(?:H|head|candidate)[=:]\s*[a-f0-9]{40,64}\b/i.test(row.body)) {
        refs.push(...[...row.body.matchAll(/\bcanonical[:=]?\s+(\/[^\s;,]+)/gi)].map(match => match[1] ?? ""));
      }
      refs.forEach(ref => declared.add(ref));
    }
    const matches = new Set([...declared].flatMap(ref => aliases.get(ref) ?? []));
    if (matches.size > 1 || [...declared].some(ref => !aliases.has(ref))) {
      for (const row of rows) diagnostics.push({ kind: "ambiguous_work", key: row.qitemId, reason: "Slice declarations are unresolved or identify multiple work units", source: `queue:${row.qitemId}`, queue: row, timecard: input.emptyTimecard });
      continue;
    }
    const nodeKey = [...matches][0];
    if (nodeKey) { const current = attached.get(nodeKey) ?? []; current.push(...rows); attached.set(nodeKey, current); }
    else {
      const possible = new Set(rows.flatMap(row => input.evidenceCandidates?.get(row.qitemId) ?? []));
      if (possible.size) {
        for (const row of rows) diagnostics.push({ kind: "ambiguous_work", key: row.qitemId, reason: `Evidence refers to possible work ${[...possible].join(", ")}; exact work/candidate identity unresolved`, source: `queue:${row.qitemId}`, queue: row, timecard: input.emptyTimecard });
      } else standalone.push({ key: `queue:${key}`, rows });
    }
  }
  const makeItem = (node: ReportNode, rows: ReportQueueRecord[], counting: ReportItem["counting"]): ReportItem => {
    const ordered = [...rows].sort((a, b) => a.tsUpdated.localeCompare(b.tsUpdated) || a.qitemId.localeCompare(b.qitemId));
    const latest = ordered.at(-1);
    const active = ordered.filter(row => open.has(row.state));
    const current = active.at(-1) ?? latest;
    const status = node.status?.toLowerCase() ?? "";
    const declaredBucket = buckets.get(status);
    const accepted = node.acceptance.kind === "reported";
    const stageBucket = node.stage ? buckets.get(node.stage.toLowerCase()) : undefined;
    const recordedProgress = !!node.progress?.trim() && !!node.evidence?.some(evidence => evidence.label === "Declared progress source");
    const conflictsWithUnstarted = !active.length && declaredBucket === "left_to_do" && (stageBucket === "in_flight" || recordedProgress || rows.length > 0);
    const bucket = active.length ? "in_flight" : accepted ? "done" : conflictsWithUnstarted ? "unresolved" : declaredBucket ?? "unresolved";
    const warnings: string[] = [];
    if (!declaredBucket && !accepted) warnings.push("Completion is unresolved; excluded from Done, In flight and Left to do until evidenced");
    if (declaredBucket === "done" && active.length) warnings.push("Authored completion conflicts with open queue work");
    if (accepted && active.length) warnings.push("Current accepted proof coexists with open queue work; acceptance and remaining activity are distinct");
    if (conflictsWithUnstarted) warnings.push("Authored unstarted status conflicts with recorded progress, work stage or queue history; completion unresolved");
    if (declaredBucket && stageBucket && declaredBucket !== stageBucket) warnings.push(`Authored status ${node.status} conflicts with stage ${node.stage}; ${conflictsWithUnstarted ? "completion remains unresolved" : "status classifies execution"}`);
    for (const row of rows) {
      const match = membership.get(row.qitemId);
      if (match?.kind === "member" && match.basis === "legacy") warnings.push(`Legacy project:${match.originalProject} associated by ${match.source}; original tags retained`);
    }
    return { key: node.key, id: node.id, parent: node.parent, title: node.title, source: node.source, counting, bucket,
      classification: active.length ? "Open associated queue work" : accepted ? "Current attributed proof accepted" : conflictsWithUnstarted ? "Authored unstarted status conflicts with execution evidence" : declaredBucket ? `Authored status: ${status}` : latest ? `Closed queue disposition ${latest.state}; completion unverified` : "Unclassified source work",
      authoredStatus: node.status, owner: current?.destinationSession ?? node.owner, stage: node.stage ?? current?.state ?? null,
      progress: node.progress ?? latest?.resolution ?? (latest ? `Queue ${latest.state}: ${latest.summary ?? latest.qitemId}` : node.intent ? `Intent: ${node.intent}` : "No sourced progress recorded"), nextAction: node.nextAction,
      blocker: current?.blockedOn ?? node.blocker, acceptance: node.acceptance, integration: node.integration,
      attempts: ordered, warnings: [...new Set(warnings)], timecard: input.emptyTimecard,
      evidence: [{ source: node.source, label: node.source.startsWith("queue:") ? "Queue lineage source" : "Work source", at: null }, ...(node.evidence ?? []), ...ordered.map(row => ({ source: `queue:${row.qitemId}`, label: row.summary ?? row.qitemId, at: row.tsUpdated })),
        ...ordered.flatMap(row => row.evidenceRef ? [{ source: row.evidenceRef, label: "Recorded evidence reference; verdict unverified", at: row.tsUpdated }] : [])] };
  };
  const parents = new Set(validNodes.flatMap(node => node.parent ? [node.parent] : []));
  const items = validNodes.map(node => makeItem(node, attached.get(node.key) ?? [], node.counting ?? (parents.has(node.key) ? "rollup" : "unit")));
  for (const group of standalone) {
    const first = [...group.rows].sort((a, b) => a.tsCreated.localeCompare(b.tsCreated) || a.qitemId.localeCompare(b.qitemId))[0];
    if (!first) continue;
    items.push(makeItem({ key: group.key, id: null, parent: null, title: first.summary ?? first.qitemId, source: `queue:${first.qitemId}`, aliases: [],
      status: null, stage: null, intent: "", owner: null, nextAction: null, blocker: null,
      acceptance: unknownReportFact("Queue closure is not acceptance"), integration: unknownReportFact("No revision-bound integration evidence") }, group.rows, "unit"));
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
  return { mission: input.mission, missionId: input.missionId, authoredStatus: input.missionStatus ?? null, asOf: input.asOf, items, totals: reportTotals(items), diagnostics,
    queueCoverage: { candidates: input.rows.length, members: members.length,
      legacyMembers: [...membership.values()].filter(value => value.kind === "member" && value.basis === "legacy").length, excluded: input.rows.length - members.length } };
}

export function recordedPrIntegration(value: unknown, source: string): Extract<ReportFact, { kind: "reported" }> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = "readback" in value && value.readback && typeof value.readback === "object" && !Array.isArray(value.readback) ? value.readback : value;
  if (!("pr" in record) || typeof record.pr !== "number" || !("head" in record) || typeof record.head !== "string" || !/^[a-f0-9]{40,64}$/i.test(record.head) || !("merged" in record) || typeof record.merged !== "boolean") return null;
  const at = "at" in record && typeof record.at === "string" && Number.isFinite(Date.parse(record.at)) ? record.at : null;
  const target = "baseRef" in record && typeof record.baseRef === "string" ? ` into ${record.baseRef}` : "; target not recorded";
  return { kind: "reported", value: `Recorded PR #${record.pr} at ${record.head}: ${record.merged ? "merged" : "not merged"}${target}`, evidence: [{ source, label: "Recorded PR integration status; distinct from work acceptance", at }] };
}
