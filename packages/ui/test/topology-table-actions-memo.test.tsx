import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
vi.mock("@tanstack/react-router", async (original) => ({
  ...await original<typeof import("@tanstack/react-router")>(), useNavigate: () => vi.fn(),
}));
vi.mock("../src/components/topology/TerminalPreviewPopover.js", async (original) => {
  const actual = await original<typeof import("../src/components/topology/TerminalPreviewPopover.js")>();
  return { ...actual, TerminalPreviewPopover: vi.fn(actual.TerminalPreviewPopover) };
});
vi.mock("../src/lib/topology-events.js", async (original) => {
  const actual = await original<typeof import("../src/lib/topology-events.js")>();
  return { ...actual, subscribeTopologyEvents: vi.fn(actual.subscribeTopologyEvents) };
});
import { TerminalPreviewPopover } from "../src/components/topology/TerminalPreviewPopover.js";
import { subscribeTopologyEvents } from "../src/lib/topology-events.js";
import { resetTopologyActivityStoreForTests } from "../src/hooks/useTopologyActivity.js";
import { LiveTerminalProvider } from "../src/components/terminal/LiveTerminalProvider.js";
import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";
const preview = vi.mocked(TerminalPreviewPopover);
const subscribe = vi.mocked(subscribeTopologyEvents);
const rigs = [{ id: "r1", name: "alpha" }, { id: "r2", name: "beta" }];
const nodes = (rig: number) => Array.from({ length: 24 }, (_, i) => ({
  logicalId: `worker.${rig}.${String(i).padStart(2, "0")}`, canonicalSessionName: `worker.${rig}.${i}@fixture`,
  runtime: "codex", sessionStatus: "running", startupStatus: "ready", podNamespace: "dev", contextUsage: null,
}));
let client: QueryClient;
let fetchSpy: ReturnType<typeof vi.fn>;
const mount = () => render(<QueryClientProvider client={client}><LiveTerminalProvider><TopologyTableView /></LiveTerminalProvider></QueryClientProvider>);
const rows = () => screen.getAllByTestId(/^topology-table-row-/);
const sort = () => fireEvent.click(screen.getByRole("columnheader", { name: /^Rig/ }));
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const host of ["local", "remote"]) {
    client.setQueryData(["rigs", "summary", host], rigs);
    client.setQueryData(["rig", "r1", "nodes", host], nodes(1));
    client.setQueryData(["rig", "r2", "nodes", host], nodes(2));
  }
  client.setQueryData(["settings"], { settings: {} });
  resetTopologyActivityStoreForTests(); preview.mockClear(); subscribe.mockClear();
  fetchSpy = vi.fn(async (input: string) => {
    if (input.endsWith("/open-cmux")) return new Response(JSON.stringify({ ok: true }));
    if (input.startsWith("/api/sessions/")) return new Response(JSON.stringify({ content: "fixture preview", lines: 1, capturedAt: "fixture", sessionName: "fixture" }));
    throw new Error("unexpected fixture request");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

describe("table action render reuse", () => {
  it("does not rerender 48 closed previews for unchanged-data sorting, while preserving row order", () => {
    mount(); expect(rows()).toHaveLength(48);
    expect(preview).toHaveBeenCalledTimes(48);
    const before = preview.mock.calls.length;
    sort(); expect(rows()[0].textContent).toContain("alpha");
    sort(); expect(rows()[0].textContent).toContain("beta");
    console.info("ACTION_RENDER_COUNTS", JSON.stringify({ rows: rows().length, before, after: preview.mock.calls.length }));
    expect(preview).toHaveBeenCalledTimes(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes changed session/preview and cmux targets, and activity baseline", async () => {
    mount();
    const updated = nodes(1); updated[0] = { ...updated[0]!, canonicalSessionName: "updated@fixture" };
    act(() => { client.setQueryData(["rig", "r1", "nodes", "local"], updated); });
    await waitFor(() => expect(preview.mock.calls.some(([props]) => props.logicalId === "worker.1.00" && props.sessionName === "updated@fixture")).toBe(true));
    const renamed = { ...updated[0]!, logicalId: "worker.renamed", terminalActive: true };
    act(() => { client.setQueryData(["rig", "r1", "nodes", "local"], [renamed, ...updated.slice(1)]); });
    await waitFor(() => expect(screen.getByTestId("topology-table-cmux-worker.renamed")).toBeTruthy());
    expect(screen.queryByTestId("topology-table-cmux-worker.1.00")).toBeNull();
    expect(screen.getByTestId("topology-table-activity-ring-worker.renamed").getAttribute("data-activity-ring-state")).toBe("active");
    fireEvent.click(screen.getByTestId("topology-table-cmux-worker.renamed"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/rigs/r1/nodes/worker.renamed/open-cmux", expect.objectContaining({ method: "POST" })));
  });

  it("honors remote/local gating even when host inventories contain identical row values", async () => {
    mount();
    act(() => { client.setQueryData(["hosts"], { selected: "remote", hosts: [], ownName: "fixture" }); });
    await waitFor(() => expect(screen.getByTestId("topology-table-actions-worker.1.00").getAttribute("data-remote-readonly")).toBe("true"));
    expect(screen.queryByTestId("topology-table-cmux-worker.1.00")).toBeNull();
    act(() => { client.setQueryData(["hosts"], { selected: "local", hosts: [], ownName: "fixture" }); });
    await waitFor(() => expect(screen.getByTestId("topology-table-cmux-worker.1.00")).toBeTruthy());
    expect(rows()).toHaveLength(48); expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps an open static preview through sorting and event-driven activity updates", async () => {
    mount();
    fireEvent.click(screen.getByTestId("topology-table-worker.1.00-terminal-open"));
    await waitFor(() => expect(screen.getByTestId("topology-table-worker.1.00-terminal-popover")).toBeTruthy());
    const pane = screen.getByTestId("topology-table-worker.1.00-preview-pane");
    expect(pane.getAttribute("data-session-name")).toBe("worker.1.0@fixture");
    sort(); sort();
    expect(screen.getByTestId("topology-table-worker.1.00-terminal-popover")).toBeTruthy();
    act(() => { subscribe.mock.calls[0]![0]({ type: "queue.claimed", destinationSession: "worker.1.0@fixture" }); });
    await waitFor(() => expect(screen.getByTestId("topology-table-activity-ring-worker.1.00").getAttribute("data-activity-ring-state")).toBe("active"));
    expect(screen.getByTestId("topology-table-worker.1.00-terminal-popover")).toBeTruthy();
    expect(screen.getByTestId("topology-table-worker.1.00-preview-pane").getAttribute("data-session-name")).toBe("worker.1.0@fixture");
  });
});
