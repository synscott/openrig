import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectWorkReport } from "../src/components/project/ProjectWorkReport.js";
import { projectReportFixture } from "../twin/project-report-fixture.js";

vi.mock("../src/hooks/useHosts.js", () => ({ useSelectedHostId: () => "local" }));
afterEach(() => vi.unstubAllGlobals());
function setup(mode: "normal" | "empty" | "error" = "normal") {
  let report = structuredClone(projectReportFixture);
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
