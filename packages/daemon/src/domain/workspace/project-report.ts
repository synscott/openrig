import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { QueueRepository } from "../queue-repository.js";
import type { ProjectRead } from "./project-read.js";
import { insideProject } from "./project-read.js";
import { NODE_FILE_PRECEDENCE } from "../scope/node-file.js";
import { readSliceReadiness } from "../proof/judgments.js";
import { parseReportAssociation, reportTags } from "./report-association.js";
import { buildReportTimecard, readCommandIntervals, type ReportInterval } from "./report-timecard.js";
import { projectMissionReport, recordedPrIntegration, unknownReportFact, type MissionWorkReport, type ReportDiagnostic, type ReportNode, type ReportQueueRecord } from "./report-projection.js";

export interface ProjectWorkReport {
  project: Pick<ProjectRead, "id" | "root" | "name">;
  asOf: string;
  revision: string;
  missions: MissionWorkReport[];
  sources: Array<{ path: string; sha256: string; modifiedAt: string }>;
  issues: string[];
  unmappedQueue: ReportQueueRecord[];
  coverage: "partial";
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function frontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) throw new Error("Unterminated authored frontmatter");
  const value: unknown = parse(text.slice(3, end));
  if (!object(value)) throw new Error("Authored frontmatter must be a mapping");
  return value;
}
function mapQueue(row: import("../queue-repository.js").QueueItem): ReportQueueRecord {
  const { qitemId, tags, body, summary, state, destinationSession, sourceSession, blockedOn, handedOffFrom, chainOfRecord, evidenceRef, tsCreated, tsUpdated, resolution } = row;
  return { qitemId, tags, body, summary, state, destinationSession, sourceSession, blockedOn, handedOffFrom, chainOfRecord, evidenceRef, tsCreated, tsUpdated, resolution };
}

export function readProjectWorkReport(input: { project: ProjectRead; queue: QueueRepository | undefined; mission?: string; asOf?: string }): ProjectWorkReport {
  const { project, queue } = input;
  const asOf = input.asOf ?? new Date().toISOString();
  const sources: ProjectWorkReport["sources"] = [];
  const issues: string[] = [];
  const captured = new Map<string, string>();
  const read = (file: string): string => {
    const actual = insideProject(project.root, file);
    const previous = captured.get(actual);
    if (previous !== undefined) return previous;
    const stat = fs.statSync(actual);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error(`Source is not a bounded readable file: ${actual}`);
    const bytes = fs.readFileSync(actual);
    const text = bytes.toString("utf8"); captured.set(actual, text);
    sources.push({ path: actual, sha256: createHash("sha256").update(bytes).digest("hex"), modifiedAt: stat.mtime.toISOString() });
    return text;
  };
  const withinMission = (file: string, missionDir: string): string => {
    const actual = insideProject(project.root, file);
    const relative = path.relative(fs.realpathSync(missionDir), actual);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Work source escapes the canonical mission root");
    return actual;
  };
  const dirs = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    try {
      insideProject(project.root, dir);
      return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    } catch (error) { issues.push(`${dir}: directory source unavailable: ${error instanceof Error ? error.message : String(error)}`); return []; }
  };
  const nodeFile = (dir: string): string | null => NODE_FILE_PRECEDENCE.map(name => path.join(dir, name)).find(file => fs.existsSync(file)) ?? null;
  let allQueue: ReportQueueRecord[] = [];
  try { allQueue = queue?.list({ activeOnly: false, limit: 10001, compact: false }).map(mapQueue) ?? []; }
  catch (error) { issues.push(`Queue source unavailable: ${error instanceof Error ? error.message : String(error)}; authored inventory retained`); }
  if (!queue) issues.push("Queue source unavailable; authored inventory remains readable");
  if (allQueue.length > 10000) issues.push("Queue snapshot limited to newest 10000 rows; older membership and lineage may be missing");
  const queueRows = allQueue.slice(0, 10000);
  const missionNames = dirs(project.missionsRoot);
  const missionClaims = new Map<string, string[]>();
  const missionHeaders = new Map<string,
    { kind: "readable"; source: string; id: string | null; status: string | null } | { kind: "unavailable"; source: string; reason: string }>();
  for (const name of missionNames) {
    const source = nodeFile(path.join(project.missionsRoot, name));
    if (!source) { missionHeaders.set(name, { kind: "unavailable", source: path.join(project.missionsRoot, name), reason: "Mission authored source unavailable" }); continue; }
    try {
      const fm = frontmatter(read(withinMission(source, path.join(project.missionsRoot, name))));
      const id = string(fm.id);
      missionHeaders.set(name, { kind: "readable", source, id, status: string(fm.status) });
      if (id) missionClaims.set(id, [...(missionClaims.get(id) ?? []), name]);
    } catch (error) { missionHeaders.set(name, { kind: "unavailable", source, reason: error instanceof Error ? error.message : String(error) }); }
  }
  const names = input.mission ? [input.mission] : missionNames;
  const missions: MissionWorkReport[] = [];
  for (const mission of names) {
    const missionDir = path.join(project.missionsRoot, mission);
    const diagnostics: ReportDiagnostic[] = [];
    const sourceGap = (source: string, reason: string) => diagnostics.push({ kind: "source", key: source, source, reason, queue: null });
    const nodes: ReportNode[] = [];
    let missionId: string | null = null;
    let manifest: unknown = {};
    const header = missionHeaders.get(mission);
    const missionSource = nodeFile(missionDir);
    if (header?.kind === "readable") missionId = header.id;
    else sourceGap(header?.source ?? missionDir, header?.kind === "unavailable" ? header.reason : "Mission source unavailable");
    const manifestPath = path.join(missionDir, "mission.yaml");
    try { if (fs.existsSync(manifestPath)) manifest = parse(read(withinMission(manifestPath, missionDir))); }
    catch (error) { sourceGap(manifestPath, error instanceof Error ? error.message : String(error)); }
    const uniqueMissionId = missionId && missionClaims.get(missionId)?.length === 1 ? missionId : null;
    if (missionId && !uniqueMissionId) sourceGap(missionSource ?? missionDir, "Canonical mission ID is ambiguous across authored missions");
    const association = parseReportAssociation(manifest, uniqueMissionId, `${manifestPath}#reporting.queue_association`);
    if (association.kind === "invalid") sourceGap(association.source, association.reason);
    const declared = new Set<string>();
    if (object(manifest) && object(manifest.composition) && Array.isArray(manifest.composition.slices)) {
      for (const member of manifest.composition.slices) {
        if (!object(member) || typeof member.ref !== "string") { sourceGap(manifestPath, "Malformed composition member"); continue; }
        const target = path.resolve(missionDir, member.ref);
        const relative = path.relative(missionDir, target);
        if (path.isAbsolute(member.ref) || relative.startsWith("..") || path.isAbsolute(relative)) { sourceGap(manifestPath, "Composition member escapes mission root"); continue; }
        declared.add(path.dirname(target));
      }
    }
    const addNode = (dir: string, parent: string | null, isDeclared: boolean): void => {
      const source = nodeFile(dir);
      let canonicalDir: string;
      try {
        canonicalDir = fs.existsSync(dir) ? insideProject(project.root, dir) : path.resolve(dir);
        const relativeMission = path.relative(fs.realpathSync(missionDir), canonicalDir);
        if (relativeMission === ".." || relativeMission.startsWith(`..${path.sep}`) || path.isAbsolute(relativeMission)) { sourceGap(dir, "Work source escapes the canonical mission root"); return; }
      } catch (error) { sourceGap(dir, error instanceof Error ? error.message : String(error)); return; }
      const key = path.relative(project.root, canonicalDir);
      const existing = nodes.find(node => node.key === key);
      if (existing) { existing.aliases = [...new Set([...existing.aliases, path.basename(dir)])]; return; }
      if (!source && !isDeclared) { sourceGap(dir, "Directory has no recognized authored source or composition declaration"); return; }
      try {
        if (fs.existsSync(dir)) insideProject(project.root, dir);
        const text = source ? read(withinMission(source, missionDir)) : "";
        const fm = frontmatter(text);
        const acceptance = unknownReportFact("No current attributed acceptance judgment");
        const node: ReportNode = { key, id: string(fm.id), parent, source: source ?? dir, title: string(fm.title) ?? text.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(dir),
          aliases: [path.basename(dir)], status: string(fm.status), stage: string(fm.stage), intent: string(fm.intent) ?? "", owner: string(fm.owner),
          nextAction: string(fm.next_action), blocker: string(fm.blocker), acceptance, integration: unknownReportFact("Integration not established by a revision-bound receipt") };
        if (source && path.basename(path.dirname(dir)) === "slices") {
          try {
            const readiness = readSliceReadiness(dir, undefined, undefined, project.root, file => { if (fs.existsSync(file)) read(file); });
            if (readiness.state === "ready") node.acceptance = { kind: "reported", value: "Current proof items accepted", evidence: readiness.items.flatMap(item => item.judgment ? [{ source: `${dir}/proof/judgments/${String(item.judgment.sequence).padStart(8, "0")}.md`, label: item.judgment.reason, at: item.judgment.at }] : []) };
            if (readiness.issues.length) sourceGap(dir, readiness.issues.join("; "));
          } catch (error) { sourceGap(dir, `Acceptance source unavailable: ${error instanceof Error ? error.message : String(error)}`); }
        }
        nodes.push(node);
        if (!source) sourceGap(dir, "Declared work has no authored source; status and details unknown");
        for (const child of dirs(path.join(dir, "sub-slices"))) addNode(path.join(dir, "sub-slices", child), key, false);
      } catch (error) {
        sourceGap(source ?? dir, error instanceof Error ? error.message : String(error));
        if (isDeclared) nodes.push({ key, id: null, parent, title: path.basename(dir), source: source ?? dir, aliases: [path.basename(dir)], status: null, stage: null, intent: "", owner: null, nextAction: null, blocker: null,
          acceptance: unknownReportFact("Authored source is unreadable"), integration: unknownReportFact("No revision-bound integration evidence") });
      }
    };
    const sliceRoot = path.join(missionDir, "slices");
    const children = new Set([...dirs(sliceRoot).map(name => path.join(sliceRoot, name)), ...declared]);
    for (const child of [...children].sort()) addNode(child, null, declared.has(child));
    for (const child of dirs(missionDir).filter(name => !["slices", "proof", "closed"].includes(name))) {
      const dir = path.join(missionDir, child);
      if (children.has(dir)) continue;
      if (nodeFile(dir)) addNode(dir, null, false);
      else sourceGap(dir, "Additional source directory is not declared as an authored work node");
    }
    if (!nodes.length && (missionSource || (object(manifest) && manifest.kind === "mission"))) addNode(missionDir, null, true);
    const aliases = new Set([mission, ...(missionId ? [missionId] : [])]);
    const candidates = queueRows.filter(row => [...reportTags(row.tags)].some(tag => tag.startsWith("mission:") && aliases.has(tag.slice(8))));
    const emptyTimecard = buildReportTimecard({ commands: [], transitions: [], asOf });
    const manifestStatus = object(manifest) && object(manifest.metadata) ? string(manifest.metadata.status) : null;
    const missionStatus = (header?.kind === "readable" ? header.status : null) ?? manifestStatus;
    const report = projectMissionReport({ projectId: project.id, mission, missionId: uniqueMissionId, missionStatus, asOf, association, nodes, rows: candidates, emptyTimecard, diagnostics });
    const timecardFor = (attempts: readonly ReportQueueRecord[]) => {
      const commands: ReportInterval[] = [];
      const timingIssues: string[] = [];
      const integrations: NonNullable<ReturnType<typeof recordedPrIntegration>>[] = [];
      const primaryEvidence = new Set(attempts.flatMap(row => row.evidenceRef ? [path.resolve(missionDir, row.evidenceRef)] : []));
      const refs = attempts.flatMap(row => [row.evidenceRef, ...[...row.body.matchAll(/(?:^|[\s`(])([^\s`<>()[\],;]+\.json)(?=$|[\s`),;])/gm)].map(match => match[1])])
        .filter((ref): ref is string => typeof ref === "string")
        .map(ref => ({ file: path.isAbsolute(ref) ? ref : path.resolve(missionDir, ref), depth: 0 }));
      const visited = new Set<string>();
      for (let index = 0; index < refs.length && index < 128; index++) {
        const reference = refs[index];
        if (!reference || visited.has(reference.file)) continue;
        visited.add(reference.file);
        try {
          if (reference.file.includes("#")) { timingIssues.push(`${reference.file}: addressed source is not an item-level command interval record`); continue; }
          if (!fs.existsSync(reference.file)) { timingIssues.push(`${reference.file}: linked source unavailable`); continue; }
          const text = read(reference.file);
          if (reference.file.endsWith(".json")) {
            const value: unknown = JSON.parse(text);
            const integration = primaryEvidence.has(reference.file) ? recordedPrIntegration(value, reference.file) : null;
            if (integration) integrations.push(integration);
            if (Array.isArray(value) && value.some(row => object(row) && "started_at" in row)) {
              const parsed = readCommandIntervals(value, reference.file); commands.push(...parsed.intervals); timingIssues.push(...parsed.issues);
            }
            if (object(value) && reference.depth < 2) {
              for (const field of ["proofs", "receipts", "evidence"]) {
                const values = value[field];
                if (!Array.isArray(values)) continue;
                for (const entry of values) {
                  const ref = typeof entry === "string" ? entry : object(entry) ? string(entry.ref) : null;
                  if (ref && !/^https?:/.test(ref)) refs.push({ file: path.resolve(path.dirname(reference.file), ref.split("#")[0] ?? ref), depth: reference.depth + 1 });
                }
              }
            }
          } else if (/\.md$/.test(reference.file) && reference.depth < 2) {
            for (const match of text.matchAll(/(?:^|[\s`(])([^\s`<>()[\],;]+\.json)(?=$|[\s`),;])/gm)) {
              const ref = match[1];
              if (ref && !/^https?:/.test(ref)) refs.push({ file: path.resolve(path.dirname(reference.file), ref), depth: reference.depth + 1 });
            }
          }
        } catch (error) { timingIssues.push(`${reference.file}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (refs.length > 128) timingIssues.push("Linked source read limited to 128 references; further evidence remains unevaluated");
      const transitions = attempts.flatMap(row => {
        try { return queue?.transitionLog.listForQitem(row.qitemId) ?? []; }
        catch (error) { timingIssues.push(`queue:${row.qitemId}: lifecycle source unavailable: ${error instanceof Error ? error.message : String(error)}`); return []; }
      });
      integrations.sort((a, b) => (a.evidence[0]?.at ?? "").localeCompare(b.evidence[0]?.at ?? ""));
      return { timecard: buildReportTimecard({ commands, transitions, asOf, issues: timingIssues }), integration: integrations.at(-1) };
    };
    for (const item of report.items) {
      const evidence = timecardFor(item.attempts); item.timecard = evidence.timecard;
      if (evidence.integration) item.integration = evidence.integration;
    }
    const intervalClaims = new Map<string, Set<string>>();
    for (const item of report.items) for (const command of item.timecard.commands) {
      const identity = `${command.source}|${command.start}|${command.end}`;
      const owners = intervalClaims.get(identity) ?? new Set<string>(); owners.add(item.key); intervalClaims.set(identity, owners);
    }
    for (const item of report.items) {
      if (item.timecard.commands.some(command => (intervalClaims.get(`${command.source}|${command.start}|${command.end}`)?.size ?? 0) > 1)) {
        item.timecard.commandTime = { kind: "unknown", reason: "Command evidence is linked to multiple logical work units; unique allocation is not established" };
        item.timecard.byActor = [];
        item.timecard.issues.push("Shared command intervals remain visible but are not allocated to task totals");
      }
    }
    for (const diagnostic of report.diagnostics) if (diagnostic.kind !== "source") diagnostic.timecard = timecardFor([diagnostic.queue]).timecard;
    missions.push(report);
  }
  const represented = new Set(missions.flatMap(mission => [...mission.items.flatMap(item => item.attempts.map(row => row.qitemId)), ...mission.diagnostics.flatMap(diagnostic => diagnostic.queue ? [diagnostic.queue.qitemId] : [])]));
  const unmappedQueue = queueRows.filter(row => reportTags(row.tags).has(`project:${project.id}`) && !represented.has(row.qitemId));
  sources.sort((a, b) => a.path.localeCompare(b.path));
  const revision = createHash("sha256").update(JSON.stringify({ sources, queue: queueRows.map(row => [row.qitemId, row.tsUpdated, row.state]) })).digest("hex");
  return { project: { id: project.id, root: project.root, name: project.name }, asOf, revision, missions, sources, issues, unmappedQueue,
    coverage: "partial" };
}
