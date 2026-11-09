import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectWorkReport } from "../src/components/project/ProjectWorkReport.js";
import { projectReportFixture } from "../twin/project-report-fixture.js";

vi.mock("../src/hooks/useHosts.js", () => ({ useSelectedHostId: () => "local" }));
afterEach(() => vi.unstubAllGlobals());
function setup(mode: "normal" | "empty" | "error" = "normal", input = projectReportFixture) {
  let report = structuredClone(input);
  if (mode === "empty") report.missions = [];
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async(input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://fixture"); calls.push({ url: url.pathname, method: init?.method ?? "GET" });
    if (url.pathname === "/api/scopes/projects") return Response.json({ projects: [{ ...report.project }], catalogPath: "workspace.yaml" });
    return mode === "error" ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json(report);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<QueryClientProvider client={client}><ProjectWorkReport /></QueryClientProvider>);
  return { calls, refreshData: () => { report = { ...report, asOf: "2026-01-01T12:10:00.000Z", missions: report.missions.map(mission => ({ ...mission, totals: { ...mission.totals, done: 2, inFlight: 0 }, items: mission.items.map(item => item.bucket === "in_flight" ? { ...item, bucket: "done" } : item) })) }; } };
}

describe("Projects work report", () => {
  it("renders shared counts, filters and opens actual item timecards using only reads", async () => {
    const { calls } = setup();
    await screen.findByText("3 known work units");
    expect(screen.getByText("Done 1 · In flight 1 · Left to do 1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter work"), { target: { value: "retry" } });
    expect(screen.getByText("Showing 1 of 3 known work units")).toBeTruthy();
    const title = screen.getByText("Verify retry handling"); const summary = title.closest("summary"); if (!summary) throw new Error("Work title has no accessible summary"); fireEvent.click(summary);
    expect(screen.getByText("Timecard")).toBeTruthy();
    expect(screen.getByText(/Command wall time: 2.0 min recorded/)).toBeTruthy();
    expect(calls.every(call => call.method === "GET")).toBe(true);
  });

  it("refreshes source totals and labels the finite snapshot", async () => {
    const { refreshData } = setup(); await screen.findByText("3 known work units"); refreshData();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Done 2 · In flight 0 · Left to do 1");
    expect(screen.getByText(/As of/)).toBeTruthy();
  });

  it("makes empty coverage useful without fabricating units", async () => {
    setup("empty"); await screen.findByText("0 known work units");
    expect(screen.getByText("No work units match these filters. Source gaps remain below.")).toBeTruthy();
  });

  it("shows source failures and offers refresh without dispatch", async () => {
    const { calls } = setup("error");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Projects source unavailable (503)"));
    expect(calls.every(call => call.method === "GET")).toBe(true);
  });
});


it("keeps parent context and recorded failure/repair narrative while counting leaves only", async () => {
  const nested = structuredClone(projectReportFixture);
  const mission = nested.missions[0]; const first = mission?.items[0]; const second = mission?.items[1];
  if (!mission || !first || !second) throw new Error("Fixture lacks hierarchy leaves");
  const parent = { ...first, key: "parent", id: "APP.99.0.P", title: "Parent campaign", parent: null, counting: "rollup" as const, timecard: { ...first.timecard, events: [] } };
  first.parent = "parent"; second.parent = "parent";
  first.timecard = { ...first.timecard, events: [{ transitionId: 1, qitemId: "review", at: nested.asOf, state: "in-progress", actor: "reviewer@sample", note: "QA failed" }, { transitionId: 2, qitemId: "review", at: nested.asOf, state: "in-progress", actor: "builder@sample", note: "Repair verified" }] };
  mission.items = [parent, first, second]; mission.totals = { done: 1, inFlight: 1, leftToDo: 0, unresolved: 0, total: 2 };
  setup("normal", nested);
  await screen.findByText("2 known work units");
  expect(screen.getAllByText("Parent campaign").length).toBe(2);
  expect(screen.getAllByText("Parent rollup · not counted").length).toBe(2);
  fireEvent.change(screen.getByLabelText("Filter work"), { target: { value: "Parent campaign" } });
  expect(screen.getByText("Showing 2 of 2 known work units")).toBeTruthy();
  const summary = screen.getByText(first.title).closest("summary"); if (!summary) throw new Error("Missing child summary"); fireEvent.click(summary);
  expect(screen.getAllByText("Within Parent campaign").length).toBe(2);
  expect(screen.getByText(/reviewer@sample.*QA failed/)).toBeTruthy();
  expect(screen.getByText(/builder@sample.*Repair verified/)).toBeTruthy();
  expect(screen.getByText("Done 1 · In flight 1 · Left to do 0")).toBeTruthy();
});

 it("surfaces open ambiguous records and the latest progress without adding units", async () => {
  const input = structuredClone(projectReportFixture); const mission = input.missions[0]; const first = mission?.items[0];
  if (!mission || !first) throw new Error("Missing fixture work");
  first.progress = `# Setup\nOld preamble\n## Latest\n${"Earlier detail ".repeat(80)}Final retry verified`;
  mission.diagnostics.push({ kind: "ambiguous_work", key: "open-qa", reason: "Exact work identity unresolved", source: "queue:open-qa", queue: { qitemId: "open-qa", tags: [], body: "", summary: "Unbound current QA", state: "blocked", destinationSession: "reviewer@sample", sourceSession: "lead@sample", blockedOn: "identity decision", handedOffFrom: null, chainOfRecord: null, evidenceRef: null, tsCreated: input.asOf, tsUpdated: input.asOf, resolution: null }, timecard: first.timecard });
  setup("normal", input);
  await screen.findByText("3 known work units");
  expect(screen.getByText("0 excluded queue records · 1 ambiguous work records · 1 open")).toBeTruthy();
  expect(screen.getByText(/Ambiguous work: Unbound current QA/)).toBeTruthy();
  expect(screen.getAllByText(/Final retry verified/).length).toBeGreaterThan(0);
 });
