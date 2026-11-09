import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tanstack/react-router", async (original) => ({
  ...await original<typeof import("@tanstack/react-router")>(), useNavigate: () => vi.fn(),
}));
vi.mock("@tanstack/react-table", async (original) => {
  const actual = await original<typeof import("@tanstack/react-table")>();
  return { ...actual, useReactTable: vi.fn(actual.useReactTable) };
});
vi.mock("../src/lib/topology-activity.js", async (original) => {
  const actual = await original<typeof import("../src/lib/topology-activity.js")>();
  return { ...actual, buildTopologySessionIndex: vi.fn(actual.buildTopologySessionIndex) };
});

import { useReactTable } from "@tanstack/react-table";
import { buildTopologySessionIndex } from "../src/lib/topology-activity.js";
import { resetTopologyActivityStoreForTests } from "../src/hooks/useTopologyActivity.js";
import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

const tableSpy = vi.mocked(useReactTable);
const indexSpy = vi.mocked(buildTopologySessionIndex);
const node = (logicalId: string, podNamespace = "dev", runtime = "codex") => ({
  logicalId, podNamespace, canonicalSessionName: `${logicalId}@fixture`, runtime,
  sessionStatus: "running", startupStatus: "ready", contextUsage: null,
});
let client: QueryClient;
const renderTable = (props: { rigIdScope?: string; podNameScope?: string } = {}) => (
  <QueryClientProvider client={client}><TopologyTableView {...props} /></QueryClientProvider>
);
const rows = () => screen.queryAllByTestId(/^topology-table-row-/).map((row) => row.getAttribute("data-testid"));
const tableData = () => tableSpy.mock.calls.at(-1)![0].data;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["rigs", "summary", "local"], [{ id: "r1", name: "alpha" }, { id: "r2", name: "beta" }]);
  client.setQueryData(["rig", "r1", "nodes", "local"], [node("alpha.worker"), node("alpha.ops", "ops")]);
  client.setQueryData(["rig", "r2", "nodes", "local"], [node("beta.worker")]);
  resetTopologyActivityStoreForTests();
  tableSpy.mockClear();
  indexSpy.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected fetch in seeded-cache fixture"); }));
});
afterEach(() => { cleanup(); client.clear(); vi.unstubAllGlobals(); });

describe("table derivation invalidation", () => {
  it("reuses derived rows through real filtering and sorting when query data is unchanged", () => {
    render(renderTable());
    expect(rows()).toHaveLength(3);
    const initialData = tableData();
    const initialBuilds = indexSpy.mock.calls.length;
    const search = screen.getByTestId("topology-table-search");
    for (const value of ["alpha", "beta", "codex", "running", "zzz", ""]) {
      fireEvent.change(search, { target: { value } });
      expect(rows()).toHaveLength(value === "zzz" ? 0 : value === "alpha" ? 2 : value === "beta" ? 1 : 3);
    }
    const rigHeader = screen.getByRole("columnheader", { name: /^Rig/ });
    fireEvent.click(rigHeader);
    expect(rows()[0]).toBe("topology-table-row-alpha.worker");
    fireEvent.click(rigHeader);
    expect(rows()[0]).toBe("topology-table-row-beta.worker");
    console.info("TABLE_DERIVATION_COUNTS", JSON.stringify({
      initialBuilds, afterInteractions: indexSpy.mock.calls.length, renders: tableSpy.mock.calls.length,
      tableDataChanges: tableSpy.mock.calls.filter(([options]) => options.data !== initialData).length,
    }));
    expect(tableData()).toBe(initialData);
    expect(indexSpy).toHaveBeenCalledTimes(initialBuilds);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes node rows and activity baseline after a genuine cache update", async () => {
    render(renderTable());
    const initialData = tableData();
    const initialBuilds = indexSpy.mock.calls.length;
    await act(async () => {
      client.setQueryData(["rig", "r1", "nodes", "local"], [{ ...node("alpha.new", "dev", "claude-code"), terminalActive: true }]);
    });
    await waitFor(() => expect(rows()).toEqual(["topology-table-row-alpha.new", "topology-table-row-beta.worker"]));
    expect(tableData()).not.toBe(initialData);
    expect(indexSpy.mock.calls.length).toBeGreaterThan(initialBuilds);
    expect(tableData()).toEqual(expect.arrayContaining([expect.objectContaining({ logicalId: "alpha.new", runtime: "claude-code" })]));
    expect(screen.getByTestId("topology-table-activity-ring-alpha.new").getAttribute("data-activity-ring-state")).toBe("active");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes derivation for rig/pod scopes and summary reorder/rename", async () => {
    const view = render(renderTable());
    view.rerender(renderTable({ rigIdScope: "r1", podNameScope: "ops" }));
    expect(rows()).toEqual(["topology-table-row-alpha.ops"]);
    view.rerender(renderTable({ rigIdScope: "r2" }));
    expect(rows()).toEqual(["topology-table-row-beta.worker"]);
    view.rerender(renderTable());
    await act(async () => {
      client.setQueryData(["rigs", "summary", "local"], [{ id: "r2", name: "renamed" }, { id: "r1", name: "alpha" }]);
    });
    await waitFor(() => expect(rows()[0]).toBe("topology-table-row-beta.worker"));
    expect(screen.getByText("renamed")).toBeTruthy();
    expect(rows()).toHaveLength(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the selected host query keys even for the same rig id", async () => {
    client.setQueryData(["rigs", "summary", "remote"], [{ id: "r1", name: "remote-rig" }]);
    client.setQueryData(["rig", "r1", "nodes", "remote"], [node("remote.worker")]);
    render(renderTable());
    act(() => { client.setQueryData(["hosts"], { selected: "remote", ownName: "fixture", hosts: [] }); });
    await waitFor(() => expect(rows()).toEqual(["topology-table-row-remote.worker"]));
    expect(screen.getByText("remote-rig")).toBeTruthy();
    act(() => { client.setQueryData(["hosts"], { selected: "local", ownName: "fixture", hosts: [] }); });
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()).not.toContain("topology-table-row-remote.worker");
    expect(fetch).not.toHaveBeenCalled();
  });
});
