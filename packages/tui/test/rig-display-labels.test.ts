import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { computeExplorerRows, createViewState, findRig } from "../src/state.js";

describe("dashboard rig display labels preserve canonical navigation", () => {
  it("uses the configured label in sidebar, Table and rig header with canonical actions", () => {
    const snap = demoSnapshot();
    const rig = snap.hosts[0]!.rigs[0]!;
    Object.assign(rig, { id: `01${"A".repeat(24)}`, displayLabel: "Development" });
    const view = createViewState({ instanceId: "labels", getSnapshot: () => snap });
    const row = computeExplorerRows(view.get(), snap).find((r) => r.key === "rig:vm-host/openrig-build");
    expect(row?.label).toContain("Development (openrig-build)");
    expect(row?.action).toEqual({ type: "drill", resource: "rig", name: "openrig-build", target: { host: "vm-host" } });
    expect(findRig(snap, "Development")).toBeNull();
    expect(findRig(snap, "openrig-build")?.rig.id).toBe(rig.id);

    view.dispatch(parseCommand("host vm-host"));
    expect(renderScreen(view.get(), snap, { cols: 220, rows: 60, colorMode: "none" }).lines.join("\n")).toContain("Development");
    view.dispatch({ type: "filter", text: "openrig-build" });
    expect(renderScreen(view.get(), snap, { cols: 220, rows: 60, colorMode: "none" }).contentTargets.some((t) =>
      t.action.type === "drill" && t.action.target?.rig === "openrig-build")).toBe(true);
    view.dispatch({ type: "filter", text: "Development" });
    expect(renderScreen(view.get(), snap, { cols: 220, rows: 60, colorMode: "none" }).contentTargets.some((t) =>
      t.action.type === "drill" && t.action.target?.rig === "openrig-build")).toBe(false);
    view.dispatch({ type: "filter", text: "" });
    view.dispatch(row!.action!);
    const screen = renderScreen(view.get(), snap, { cols: 220, rows: 60, colorMode: "none" });
    const text = screen.lines.join("\n");
    expect(text).toContain("rig Development (openrig-build)");
    expect(screen.contentTargets.some((t) => t.action.type === "act" && t.action.act === "open-terminal" && t.action.view === "rig:openrig-build")).toBe(true);
    expect(view.get().drill).toContainEqual({ kind: "rig", name: "openrig-build" });
    expect(rig.pods[0]!.agents[0]!.session).toBe("dev50-driver@openrig-build");
    view.dispatch({ type: "back" });
    expect(view.get().drill).toEqual([{ kind: "host", name: "vm-host" }]);
  });

  it("disambiguates duplicate and canonical-looking labels without alias routing", () => {
    const snap = demoSnapshot();
    const first = snap.hosts[0]!.rigs[0]!;
    Object.assign(first, { displayLabel: "Shared" });
    snap.hosts[0]!.rigs.push({ name: "other-rig", displayLabel: "Shared", pods: [] });
    const view = createViewState({ instanceId: "labels", getSnapshot: () => snap });
    let rows = computeExplorerRows(view.get(), snap);
    expect(rows.some((r) => r.label.includes("Shared (openrig-build)"))).toBe(true);
    expect(rows.some((r) => r.label.includes("Shared (other-rig)"))).toBe(true);
    Object.assign(first, { displayLabel: "other-rig" });
    rows = computeExplorerRows(view.get(), snap);
    expect(rows.some((r) => r.label.includes("other-rig (openrig-build)"))).toBe(true);
    expect(findRig(snap, "other-rig")?.rig.name).toBe("other-rig");
  });

  it.each([undefined, "", "bad\nlabel", "bad\u001b[2J"])("falls back to canonical name for absent or unsafe label %j", (displayLabel) => {
    const snap = demoSnapshot();
    Object.assign(snap.hosts[0]!.rigs[0]!, { displayLabel });
    const view = createViewState({ instanceId: "labels", getSnapshot: () => snap });
    const row = computeExplorerRows(view.get(), snap).find((r) => r.key === "rig:vm-host/openrig-build");
    expect(row?.label).toContain("openrig-build");
    expect(row?.label).not.toContain("bad");
    expect(row?.label).not.toContain("undefined");
  });
});
