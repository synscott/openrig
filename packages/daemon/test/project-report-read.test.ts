import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { scopesRoutes } from "../src/routes/scopes.js";
import { readProjectWorkReport } from "../src/domain/workspace/project-report.js";

let root: string;
let db: ReturnType<typeof createDb>;
let queue: QueueRepository;
const at = "2026-01-01T00:00:00.000Z";
function file(ref: string, text: string) { const target = path.join(root, ref); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
function project() { return { id: "current", root, name: "Fixture", sourcePath: path.join(root, "SPEC.md"), missionsRoot: path.join(root, "missions") }; }
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "report-source-")));
  file("project.yaml", "kind: project\nmissions:\n  root: missions\n"); file("SPEC.md", "# Fixture project\n");
  file("workspace.yaml", "projects:\n  - id: current\n    root: .\n");
  file("missions/extract/SPEC.md", "---\nid: APP.99.0.1\n---\n# Extraction\n");
  file("missions/extract/mission.yaml", "kind: mission\nreporting:\n  queue_association:\n    mission_id: APP.99.0.1\n    legacy_project_ids: [old]\ncomposition:\n  slices: []\n");
  file("missions/extract/slices/01-unit/SPEC.md", "---\nid: APP.99.0.1.1\nstatus: planned\nintent: Preserve complete behavior\n---\n# A planned unit\n");
  db = createDb(); migrate(db, ALL_MIGRATIONS); queue = new QueueRepository(db, new EventBus(db));
  const insert = db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,tags,body) VALUES(?,?,?,?,?,'in-progress','normal',?,?)");
  insert.run("legacy", at, at, "lead@fixture", "worker@fixture", JSON.stringify(["mission:APP.99.0.1", "project:old", "slice:APP.99.0.1.1"]), "Existing work");
  insert.run("unscoped", at, at, "lead@fixture", "worker@fixture", JSON.stringify(["mission:APP.99.0.1"]), "Unscoped work");
  insert.run("neighbor", at, at, "lead@fixture", "worker@fixture", JSON.stringify(["mission:APP.99.0.2", "project:old"]), "Neighbor work");
});
afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("Projects source read", () => {
  it("joins the exact declared legacy mission and keeps neighboring and unscoped records out of totals", () => {
    const report = readProjectWorkReport({ project: project(), queue, asOf: at });
    expect(report.missions[0]?.totals).toEqual({ done: 0, inFlight: 1, leftToDo: 0, unresolved: 0, total: 1 });
    expect(report.missions[0]?.queueCoverage).toEqual({ candidates: 2, members: 1, legacyMembers: 1, excluded: 1 });
    expect(report.missions[0]?.items[0]?.warnings).toEqual([expect.stringContaining("project:old")]);
    expect(report.missions[0]?.diagnostics.map(row => row.key)).toEqual(["unscoped"]);
    expect(JSON.stringify(report)).not.toContain("Neighbor work");
  });

  it("refreshes source bytes and retains malformed siblings and declared missing work as coverage", () => {
    const before = readProjectWorkReport({ project: project(), queue: undefined, asOf: at });
    file("missions/extract/slices/02-bad/SPEC.md", "---\nid: [broken\n---\n");
    file("missions/extract/slices/01-unit/SPEC.md", "---\nid: APP.99.0.1.1\nstatus: done\n---\n# Completed unit\n");
    const after = readProjectWorkReport({ project: project(), queue: undefined, asOf: at });
    expect(after.revision).not.toBe(before.revision);
    expect(after.missions[0]?.totals).toEqual({ done: 1, inFlight: 0, leftToDo: 0, unresolved: 1, total: 2 });
    expect(after.missions[0]?.diagnostics.some(row => row.source.endsWith("02-bad/SPEC.md"))).toBe(true);
    expect(after.missions[0]?.items[0]?.acceptance.kind).toBe("unknown");
  });

  it("serves GET without dispatching or writing queue/events and rejects changed roots", async () => {
    const app = new Hono(); app.use("*", async(c, next) => { c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? root : path.join(root, "workspace.yaml") }) }); c.set("queueRepo" as never, queue); await next(); }); app.route("/api/scopes", scopesRoutes());
    const changesBefore = db.prepare("SELECT total_changes() AS changes").get();
    const response = await app.request(`/api/scopes/report?project=current&projectRoot=${encodeURIComponent(root)}`);
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT total_changes() AS changes").get()).toEqual(changesBefore);
    expect((await app.request("/api/scopes/report?project=current&projectRoot=/different")).status).toBe(409);
    expect((await app.request("/api/scopes/report")).status).toBe(400);
  });
});

describe("Projects evidence boundaries", () => {
  it("reads exact linked command results, retaining failed attempts and unknown actors", () => {
    file("missions/extract/commands.json", JSON.stringify([{ started_at: "2025-12-31T23:00:00Z", ended_at: "2025-12-31T23:00:10Z", label: "first attempt", exit: 1 }, { started_at: "2025-12-31T23:00:08Z", ended_at: "2025-12-31T23:00:20Z", label: "repair", actor: "worker@fixture", exit: 0 }]));
    db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = 'legacy'").run(path.join(root, "missions/extract/commands.json"));
    const report = readProjectWorkReport({ project: project(), queue, asOf: at });
    const card = report.missions[0]?.items[0]?.timecard;
    expect(card?.commandTime).toMatchObject({ kind: "partial", milliseconds: 20000 });
    expect(card?.commands.map(command => command.result)).toEqual(["exit 1", "exit 0"]);
    expect(card?.commands[0]?.actor).toBeNull();
    expect(card?.effort.kind).toBe("unknown");
  });

  it("does not apply a mission binding when canonical identity is duplicated", () => {
    file("missions/neighbor/SPEC.md", "---\nid: APP.99.0.1\n---\n# Different mission\n");
    const report = readProjectWorkReport({ project: project(), queue, mission: "extract", asOf: at });
    expect(report.missions[0]?.queueCoverage.members).toBe(0);
    expect(report.missions[0]?.diagnostics.some(row => row.reason.includes("ambiguous across"))).toBe(true);
  });
});


describe("Projects recorded integration", () => {
  it("reports an exact published-but-unmerged receipt without completing the unit", () => {
    file("missions/extract/pr-status.json", JSON.stringify({ pr: 17, head: "a".repeat(40), merged: false, state: "open", baseRef: "parent-branch", at }));
    db.prepare("UPDATE queue_items SET evidence_ref = ?, state = 'done' WHERE qitem_id = 'legacy'").run(path.join(root, "missions/extract/pr-status.json"));
    const report = readProjectWorkReport({ project: project(), queue, asOf: at });
    const item = report.missions[0]?.items[0];
    expect(item?.integration).toMatchObject({ kind: "reported", value: expect.stringContaining("not merged into parent-branch") });
    expect(item?.bucket).toBe("unresolved");
    expect(item?.warnings).toContain("Authored unstarted status conflicts with recorded progress, work stage or queue history; completion unresolved");
    expect(item?.acceptance.kind).toBe("unknown");
  });
});

describe("Projects unresolved sources", () => {
  it("retains project-tagged work with no mission instead of silently dropping it", () => {
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = 'neighbor'").run(JSON.stringify(["project:current"]));
    const report = readProjectWorkReport({ project: project(), queue, asOf: at });
    expect(report.unmappedQueue.map(row => row.qitemId)).toEqual(["neighbor"]);
    expect(report.missions[0]?.totals.total).toBe(1);
  });

  it("keeps declared malformed and missing work in the known inventory with unknown status", () => {
    file("missions/extract/mission.yaml", "kind: mission\ncomposition:\n  slices:\n    - ref: slices/02-bad/slice.yaml\n    - ref: slices/03-missing/slice.yaml\n");
    file("missions/extract/slices/02-bad/SPEC.md", "---\nid: [broken\n---\n");
    const report = readProjectWorkReport({ project: project(), queue: undefined, asOf: at });
    expect(report.missions[0]?.totals).toEqual({ done: 0, inFlight: 0, leftToDo: 1, unresolved: 2, total: 3 });
    expect(report.missions[0]?.diagnostics.filter(row => row.kind === "source")).toHaveLength(2);
  });
});

describe("Projects canonical source containment", () => {
  it("does not admit a composition symlink into a neighboring mission", () => {
    file("missions/neighbor/SPEC.md", "---\nid: APP.99.0.2\nstatus: done\n---\n# Neighbor source\n");
    fs.symlinkSync(path.join(root, "missions/neighbor"), path.join(root, "missions/extract/foreign"), "dir");
    file("missions/extract/mission.yaml", "kind: mission\ncomposition:\n  slices:\n    - ref: foreign/slice.yaml\n");
    const report = readProjectWorkReport({ project: project(), queue: undefined, mission: "extract", asOf: at });
    expect(report.missions[0]?.totals.total).toBe(1);
    expect(report.missions[0]?.diagnostics.some(row => row.reason === "Work source escapes the canonical mission root")).toBe(true);
    expect(report.missions[0]?.items.some(row => row.id === "APP.99.0.2")).toBe(false);
  });
});

describe("Projects partial source failure", () => {
  it("retains authored inventory when the queue source cannot be read", () => {
    db.exec("ALTER TABLE queue_items RENAME TO unavailable_queue");
    const report = readProjectWorkReport({ project: project(), queue, asOf: at });
    expect(report.missions[0]?.totals).toEqual({ done: 0, inFlight: 0, leftToDo: 1, unresolved: 0, total: 1 });
    expect(report.issues.some(issue => issue.includes("Queue source unavailable"))).toBe(true);
  });
});


describe("Projects mission rollup provenance", () => {
  it("preserves manifest metadata status without classifying child completion from it", () => {
    const target = path.join(root, "missions/extract/mission.yaml");
    fs.appendFileSync(target, "metadata:\n  status: planned\n");
    const report = readProjectWorkReport({ project: project(), queue, asOf: at });
    expect(report.missions[0]?.authoredStatus).toBe("planned");
    expect(report.missions[0]?.totals).toEqual({ done: 0, inFlight: 1, leftToDo: 0, unresolved: 0, total: 1 });
    file("missions/extract/SPEC.md", "---\nid: APP.99.0.1\nstatus: active\n---\n# Extraction\n");
    expect(readProjectWorkReport({ project: project(), queue, asOf: at }).missions[0]?.authoredStatus).toBe("active");
  });
});

describe("Projects canonical owned sources", () => {
  it("keeps an untouched real CLI scaffold Left, but changed progress and queue history are execution evidence", async () => {
    const templates = await import("../../cli/src/lib/scope/templates.js");
    const spec = templates.renderSliceTemplate("placeholder", { id: "APP.99.0.1.2", slice_number: "02", slug: "fresh", mission: "extract", title: "Fresh", created_date: "2026-01-01" });
    const progress = templates.renderSliceProgressTemplate("Fresh");
    file("missions/extract/slices/02-fresh/SPEC.md", spec);
    file("missions/extract/slices/02-fresh/slice.yaml", "kind: slice\ncomposition:\n  slice_markdown:\n    progress: PROGRESS.md\n");
    file("missions/extract/slices/02-fresh/PROGRESS.md", progress);
    const item = () => readProjectWorkReport({ project: project(), queue, asOf: at }).missions[0]?.items.find(item => item.key.endsWith("02-fresh"));
    expect(item()?.authoredStatus).toBe("placeholder"); expect(item()?.stage).toBe("wip");
    expect(item()?.bucket).toBe("left_to_do");
    file("missions/extract/slices/02-fresh/PROGRESS.md", progress + "\nA bounded implementation check failed and was repaired.\n");
    expect(item()?.bucket).toBe("unresolved"); expect(item()?.acceptance.kind).toBe("unknown");
    file("missions/extract/slices/02-fresh/PROGRESS.md", progress);
    db.prepare("UPDATE queue_items SET tags = ?, state = 'done' WHERE qitem_id = 'legacy'").run(JSON.stringify(["project:old", "mission:APP.99.0.1", "slice:APP.99.0.1.2"]));
    expect(item()?.bucket).toBe("unresolved"); expect(item()?.acceptance.kind).toBe("unknown");
  });

  it("includes direct slice locations without a standard document and reads their measured commands", () => {
    file("missions/extract/slices/02-source-only/records.json", JSON.stringify([{ started_at: "2025-12-31T23:00:00Z", ended_at: "2025-12-31T23:00:03Z", label: "actual owner check", exit: 1 }]));
    const report = readProjectWorkReport({ project: project(), queue: undefined, asOf: at });
    const item = report.missions[0]?.items.find(item => item.key.endsWith("02-source-only"));
    expect(item?.bucket).toBe("unresolved");
    expect(item?.timecard.commands.map(command => [command.label, command.result, command.actor])).toEqual([["actual owner check", "exit 1", null]]);
    expect(item?.timecard.commandTime).toMatchObject({ milliseconds: 3000 });
    expect(report.missions[0]?.totals).toEqual({ done: 0, inFlight: 0, leftToDo: 1, unresolved: 1, total: 2 });
  });

  it("reads declared progress with provenance and keeps goal intent distinct", () => {
    file("missions/extract/slices/01-unit/slice.yaml", "kind: slice\ncomposition:\n  slice_markdown:\n    progress: notes.md\n");
    file("missions/extract/slices/01-unit/notes.md", "# Progress\nThe retry was repaired; final acceptance is pending.\n");
    const report = readProjectWorkReport({ project: project(), queue: undefined, asOf: at });
    expect(report.missions[0]?.items[0]?.progress).toContain("The retry was repaired");
    expect(report.missions[0]?.items[0]?.evidence).toContainEqual({ source: path.join(root, "missions/extract/slices/01-unit/notes.md"), label: "Declared progress source", at: expect.any(String) });
    expect(report.sources.some(source => source.path.endsWith("notes.md"))).toBe(true);
    fs.unlinkSync(path.join(root, "missions/extract/slices/01-unit/slice.yaml"));
    expect(readProjectWorkReport({ project: project(), queue: undefined, asOf: at }).missions[0]?.items[0]?.progress).toBe("Intent: Preserve complete behavior");
  });

  it("uses explicit work directory dispositions without counting containers or artifacts", () => {
    file("missions/extract/mission.yaml", "kind: mission\nreporting:\n  work_directories:\n    - ref: delivery\n      disposition: work\n    - ref: history\n      disposition: artifacts\n    - ref: repairs\n      disposition: container\n");
    file("missions/extract/delivery/final-disposition.json", JSON.stringify({ head: "a".repeat(40), all_final_stages_zero: true }));
    file("missions/extract/history/records.json", "[]"); file("missions/extract/repairs/index.json", "{}");
    const report = readProjectWorkReport({ project: project(), queue: undefined, asOf: at });
    expect(report.missions[0]?.items.filter(item => item.counting === "unit").map(item => path.basename(item.key)).sort()).toEqual(["01-unit", "delivery"]);
    expect(report.missions[0]?.items.find(item => item.key.endsWith("delivery"))?.progress).toContain("Recorded disposition");
    expect(report.missions[0]?.diagnostics.filter(row => row.reason.startsWith("Declared "))).toHaveLength(2);
  });

  it("discloses evidence-only candidates instead of double-counting and removes unused queue bodies from transport", () => {
    db.prepare("UPDATE queue_items SET tags=?, evidence_ref=? WHERE qitem_id='legacy'").run(JSON.stringify(["mission:APP.99.0.1", "project:old"]), path.join(root, "missions/extract/slices/01-unit/qa.md"));
    const report = readProjectWorkReport({ project: project(), queue, asOf: at });
    expect(report.missions[0]?.totals.total).toBe(1);
    expect(report.missions[0]?.diagnostics.find(row => row.key === "legacy")?.kind).toBe("ambiguous_work");
    expect(report.missions[0]?.diagnostics.every(row => !row.queue || row.queue.body === "")).toBe(true);
  });

  it("rejects canonical work directory duplicates and neighboring-root symlinks", () => {
    file("missions/extract/extra/record.json", "{}");
    file("missions/neighbor/SPEC.md", "---\nid: APP.99.0.2\n---\n# Neighbor\n");
    fs.symlinkSync(path.join(root, "missions/extract/extra"), path.join(root, "missions/extract/alias"), "dir");
    fs.symlinkSync(path.join(root, "missions/neighbor"), path.join(root, "missions/extract/foreign"), "dir");
    file("missions/extract/mission.yaml", "kind: mission\nreporting:\n  work_directories:\n    - ref: extra\n      disposition: work\n    - ref: alias\n      disposition: artifacts\n    - ref: foreign\n      disposition: work\n");
    const report = readProjectWorkReport({ project: project(), queue: undefined, mission: "extract", asOf: at });
    expect(report.missions[0]?.totals.total).toBe(1);
    expect(report.missions[0]?.diagnostics.some(row => row.reason.includes("Canonical work directory duplicate/conflict"))).toBe(true);
    expect(report.missions[0]?.diagnostics.some(row => row.reason.includes("escapes the canonical mission root"))).toBe(true);
  });

  it.each([
    { name: "readable unbound receipts", qa: "Recorded QA acceptance", review: "Recorded source review acceptance", receipts: ["qa.md", "review.md"] },
    { name: "rejected candidate receipt", qa: `REJECT candidate ${"a".repeat(40)}`, review: `ACCEPT candidate ${"a".repeat(40)}`, receipts: ["qa.md", "review.md"] },
    { name: "different accepted candidate", qa: `ACCEPT candidate ${"a".repeat(40)}`, review: `ACCEPT candidate ${"b".repeat(40)}`, receipts: ["qa.md", "review.md"] },
    { name: "duplicate receipt path", qa: "Arbitrary readable file", review: "Unused", receipts: ["qa.md", "qa.md"] },
  ])("keeps $name as disposition provenance without acceptance-derived Done", ({ qa, review, receipts }) => {
    file("missions/extract/slices/02-packet/publication-handoff.json", JSON.stringify({ head: "a".repeat(40), reader_status: { qa: "ACCEPT", review: "ACCEPT" }, receipts, next_custody: "Read final integration evidence" }));
    file("missions/extract/slices/02-packet/qa.md", qa);
    file("missions/extract/slices/02-packet/review.md", review);
    const report = readProjectWorkReport({ project: project(), queue: undefined, asOf: at });
    const packet = report.missions[0]?.items.find(item => item.key.endsWith("02-packet"));
    expect(packet?.bucket).toBe("unresolved");
    expect(packet?.acceptance.kind).toBe("unknown");
    expect(packet?.integration.kind).toBe("unknown");
    expect(packet?.progress).toContain('reader_status: {"qa":"ACCEPT","review":"ACCEPT"}');
    expect(packet?.nextAction).toBe("Read final integration evidence");
    expect(packet?.evidence.filter(row => row.label === "Disposition-linked receipt; subject and verdict unverified").map(row => path.basename(row.source))).toEqual([...new Set(receipts)]);
  });

  it("preserves sourced authored completion without treating a disposition as acceptance", () => {
    file("missions/extract/slices/02-packet/SPEC.md", "---\nstatus: completed\n---\n# Completed authored work\n");
    file("missions/extract/slices/02-packet/publication-handoff.json", JSON.stringify({ head: "a".repeat(40), reader_status: { qa: "ACCEPT", review: "ACCEPT" }, receipts: ["qa.md", "qa.md"] }));
    file("missions/extract/slices/02-packet/qa.md", "REJECT candidate");
    const packet = readProjectWorkReport({ project: project(), queue: undefined, asOf: at }).missions[0]?.items.find(item => item.key.endsWith("02-packet"));
    expect(packet?.bucket).toBe("done");
    expect(packet?.classification).toBe("Authored status: completed");
    expect(packet?.acceptance.kind).toBe("unknown");
  });
});
