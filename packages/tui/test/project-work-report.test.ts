import { describe, expect, it } from "vitest";
import type { ProjectWorkReport, ReportItem } from "@openrig/daemon/project-report";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";

const asOf = "2026-01-01T00:00:00Z";
const work: ReportItem = { key: "unit", id: "APP.99.0.1.1", parent: null, title: "Preserve retry behavior", source: "SPEC.md", counting: "unit", bucket: "left_to_do", classification: "Authored planned work", authoredStatus: "planned", owner: null, stage: null, progress: "Planned source", nextAction: null, blocker: null, acceptance: { kind: "unknown", reason: "No judgment" }, integration: { kind: "unknown", reason: "Not integrated" }, attempts: [], evidence: [], warnings: [], timecard: { commands: [], lifecycle: [], commandTime: { kind: "unknown", reason: "No commands" }, waiting: { kind: "unknown", reason: "No history" }, effort: { kind: "unknown", reason: "Unmeasured" }, byActor: [], issues: [] } };
const report: ProjectWorkReport = { project: { id: "sample", root: "/fixture", name: "Sample" }, asOf, revision: "snapshot", sources: [], issues: [], unmappedQueue: [], coverage: "partial", missions: [{ mission: "extract", missionId: "APP.99.0.1", authoredStatus: null, asOf, items: [work], totals: { done: 0, inFlight: 0, leftToDo: 1, total: 1 }, diagnostics: [], queueCoverage: { candidates: 0, members: 0, legacyMembers: 0, excluded: 0 } }] };

describe("Projects report TUI path", () => {
  it.each([[160, 55], [80, 24]])("filters and drills through the normal client and grammar at %ix%i", async(cols, rows) => {
    const requests: Array<{ url: URL; method: string }> = [];
    const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: async(input, init) => {
      const url = new URL(String(input)); requests.push({ url, method: init?.method ?? "GET" });
      if (url.pathname === "/api/scopes/projects") return Response.json({ capabilities: ["work-report"], catalogPath: "workspace.yaml", projects: [report.project] });
      if (url.pathname === "/api/scopes/report") return Response.json(report);
      if (url.pathname === "/api/scopes") return Response.json({ missions: [{ mission: "extract", slices: [] }] });
      if (url.pathname === "/api/views/execution") return Response.json({ rows: [] });
      if (url.pathname === "/api/files/roots") return Response.json({ roots: [] });
      throw new Error(`Unexpected request ${url.pathname}`);
    } });
    let snapshot = emptySnapshot();
    const view = createViewState({ instanceId: "report", getSnapshot: () => snapshot });
    const refresh = async() => { snapshot = await hydrateSnapshot(client, undefined, view.get().scopesMission, null, null, view.get()); };
    view.dispatch(parseCommand("projects")); await refresh();
    view.dispatch(parseCommand("project sample")); await refresh();
    view.dispatch(parseCommand("mission extract")); await refresh();
    const text = () => renderScreen(view.get(), snapshot, { cols, rows }).lines.join("\n");
    expect(text()).toContain("WORK REPORT");
    expect(text()).toContain("Left to do 1");
    view.dispatch(parseCommand("work APP.99.0.1.1")); await refresh();
    expect(view.get().executionOpen).toBe("report:APP.99.0.1.1");
    if (cols === 160) expect(text()).toContain("TIMECARD");
    expect(snapshot.projectWorkReport?.missions[0]?.items[0]?.timecard.commandTime.kind).toBe("unknown");
    expect(requests.every(request => request.method === "GET")).toBe(true);
    for (const request of requests.filter(request => request.url.pathname === "/api/scopes/report")) {
      expect(request.url.searchParams.get("project")).toBe("sample");
      expect(request.url.searchParams.get("projectRoot")).toBe("/fixture");
    }
  });
});
