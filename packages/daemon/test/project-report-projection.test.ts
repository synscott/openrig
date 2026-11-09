import { describe, expect, it } from "vitest";
import { projectMissionReport, unknownReportFact, type ReportNode, type ReportQueueRecord } from "../src/domain/workspace/report-projection.js";
import { buildReportTimecard } from "../src/domain/workspace/report-timecard.js";

const asOf = "2026-01-01T01:00:00.000Z";
const node = (key: string, status: string, parent: string | null = null): ReportNode => ({ key, id: key, parent, title: key, source: `${key}/SPEC.md`, aliases: [key], status, stage: null, intent: "A sourced intent", owner: null, nextAction: null, blocker: null, acceptance: unknownReportFact("Not judged"), integration: unknownReportFact("Not integrated") });
const row = (id: string, state: string, tags: string[], previous: string | null = null): ReportQueueRecord => ({ qitemId: id, state, tags, body: "", summary: id, destinationSession: "worker@fixture", sourceSession: "lead@fixture", blockedOn: null, handedOffFrom: previous, chainOfRecord: null, evidenceRef: null, tsCreated: asOf, tsUpdated: asOf, resolution: null });
const base = { projectId: "current", mission: "extract", missionId: "APP.99.0.1", asOf, association: { kind: "none" as const }, emptyTimecard: buildReportTimecard({ commands: [], transitions: [], asOf }) };
const tags = ["mission:APP.99.0.1", "project:current"];

describe("Projects whole-inventory projection", () => {
  it("counts authored unqueued leaves while excluding rollup parents", () => {
    const report = projectMissionReport({ ...base, nodes: [node("parent", "planned"), node("done", "done", "parent"), node("planned", "planned", "parent")], rows: [] });
    expect(report.totals).toEqual({ done: 1, inFlight: 0, leftToDo: 1, unresolved: 0, total: 2 });
    expect(report.items.find(item => item.key === "parent")?.counting).toBe("rollup");
    expect(report.items.find(item => item.key === "done")?.acceptance.kind).toBe("unknown");
  });

  it("collapses explicit handoffs and uses PR references only as evidence", () => {
    const first = row("source", "done", tags);
    first.evidenceRef = "https://example.test/pulls/123";
    const next = row("review", "blocked", tags, "source");
    const report = projectMissionReport({ ...base, nodes: [], rows: [first, next] });
    expect(report.totals).toEqual({ done: 0, inFlight: 1, leftToDo: 0, unresolved: 0, total: 1 });
    expect(report.items[0]?.attempts.map(attempt => attempt.qitemId)).toEqual(["review", "source"]);
    expect(report.items[0]?.integration.kind).toBe("unknown");
  });

  it("does not mistake queue closure for accepted or delivered work", () => {
    const report = projectMissionReport({ ...base, nodes: [node("unit", "planned")], rows: [row("terminal", "done", [...tags, "slice:unit"])] });
    expect(report.totals).toEqual({ done: 0, inFlight: 0, leftToDo: 0, unresolved: 1, total: 1 });
    expect(report.items[0]?.acceptance).toEqual({ kind: "unknown", reason: "Not judged" });
  });

  it("retains every excluded and ambiguous record outside item totals", () => {
    const report = projectMissionReport({ ...base, nodes: [node("unit", "planned")], rows: [row("unscoped", "done", ["mission:extract"]), row("wrong", "done", ["mission:extract", "project:other"]), row("ambiguous", "done", [...tags, "slice:unknown"])] });
    expect(report.queueCoverage).toEqual({ candidates: 3, members: 1, legacyMembers: 0, excluded: 2 });
    expect(report.diagnostics.map(item => [item.key, item.kind])).toEqual([["unscoped", "queue_association"], ["wrong", "queue_association"], ["ambiguous", "ambiguous_work"]]);
    expect(report.totals.total).toBe(1);
  });
});

describe("Projects identity coverage", () => {
  it("collapses explicit lineage through an excluded attempt without assigning its execution facts", () => {
    const first = row("origin", "in-progress", ["mission:extract"]);
    const review = row("review", "done", tags, "origin");
    const publish = row("publish", "done", tags, "origin");
    const report = projectMissionReport({ ...base, nodes: [], rows: [publish, first, review] });
    expect(report.totals).toEqual({ done: 0, inFlight: 0, leftToDo: 0, unresolved: 1, total: 1 });
    expect(report.items[0]?.attempts.map(attempt => attempt.qitemId)).toEqual(["publish", "review"]);
    expect(report.queueCoverage.excluded).toBe(1);
  });

  it("does not count duplicate authored identities twice", () => {
    const duplicate = { ...node("other-path", "done"), id: "same" };
    const report = projectMissionReport({ ...base, nodes: [{ ...node("first-path", "done"), id: "same" }, duplicate], rows: [] });
    expect(report.totals.total).toBe(0);
    expect(report.diagnostics.map(row => row.kind)).toEqual(["source", "source"]);
  });
});


describe("Projects exact declarations and classification", () => {
  it("retains tag/body conflicts as ambiguity while accepting aliases of the same identity", () => {
    const a = { ...node("a", "planned"), aliases: ["alias-a"] };
    const conflicting = { ...row("conflict", "in-progress", [...tags, "slice:a"]), body: "Slice: b" };
    const equivalent = { ...row("same", "in-progress", [...tags, "slice:a"]), body: "Slice: alias-a" };
    const report = projectMissionReport({ ...base, nodes: [a, node("b", "planned")], rows: [conflicting, equivalent] });
    expect(report.items.find(item => item.key === "a")?.attempts.map(row => row.qitemId)).toEqual(["same"]);
    expect(report.diagnostics.map(row => [row.key, row.kind])).toEqual([["conflict", "ambiguous_work"]]);
  });

  it("keeps closed-unverified and unclassified work outside the three primary groups", () => {
    const report = projectMissionReport({ ...base, nodes: [node("unknown", ""), node("planned", "planned")], rows: [row("closed", "done", tags)] });
    expect(report.totals).toEqual({ done: 0, inFlight: 0, leftToDo: 1, unresolved: 2, total: 3 });
    expect(report.items.find(item => item.key === "queue:closed")?.classification).toContain("completion unverified");
  });

  it("classifies attributed accepted proof without inventing integration and warns on conflicting authored stage", () => {
    const accepted = { ...node("accepted", ""), acceptance: { kind: "reported" as const, value: "Current proof accepted", evidence: [{ source: "proof/judgments/1.md", label: "Judge", at: asOf }] } };
    const conflict = { ...node("conflict", "in-progress"), stage: "done" };
    const report = projectMissionReport({ ...base, nodes: [accepted, conflict], rows: [] });
    expect(report.items.find(item => item.key === "accepted")?.bucket).toBe("done");
    expect(report.items.find(item => item.key === "accepted")?.integration.kind).toBe("unknown");
    expect(report.items.find(item => item.key === "conflict")?.warnings).toContain("Authored status in-progress conflicts with stage done; status classifies execution");
  });

  it.each(["in-progress", "recorded-progress"])("keeps placeholder with %s evidence unresolved instead of unstarted", evidence => {
    const placeholder = { ...node("placeholder", "placeholder"), ...(evidence === "in-progress" ? { stage: "in-progress" } : { progress: "Latest recorded work", recordedProgress: true, evidence: [{ source: "PROGRESS.md", label: "Declared progress source", at: asOf }] }) };
    const report = projectMissionReport({ ...base, nodes: [placeholder, node("untouched", "planned")], rows: [] });
    expect(report.totals).toEqual({ done: 0, inFlight: 0, leftToDo: 1, unresolved: 1, total: 2 });
    expect(report.items[0]?.warnings).toContain("Authored unstarted status conflicts with recorded progress, work stage or queue history; completion unresolved");
    expect(report.items[0]?.acceptance.kind).toBe("unknown");
  });

  it("does not add an evidence-linked potential duplicate as a standalone work unit", () => {
    const report = projectMissionReport({ ...base, nodes: [node("a", "planned")], rows: [row("qa", "done", tags)], evidenceCandidates: new Map([["qa", ["a"]]]) });
    expect(report.totals.total).toBe(1);
    expect(report.diagnostics[0]).toMatchObject({ key: "qa", kind: "ambiguous_work" });
  });
});
