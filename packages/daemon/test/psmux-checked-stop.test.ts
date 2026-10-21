import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { TmuxAdapter, type ArgvExecFn } from "../src/adapters/tmux.js";
import { observeSolePane } from "../src/domain/pane-binding-observation.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";

// Real adapter, existing binding observation/persistence and delivery guard.
// Terminal effects are injected; no daemon, provider, psmux or real shell.
function fixture() {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','fixture');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('a','r','worker');
    INSERT INTO bindings(id,node_id,tmux_session) VALUES ('b','a','worker@fixture');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s','a','worker@fixture','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g','a',1,'g1','fresh');`);
  let name = "worker@fixture", sid = "$7", pid = "10", birth = "11", result = "CHECKED-STOP COMPLETE\n";
  let onList = () => {};
  const exec = vi.fn(async () => { throw Error("No shell effects permitted"); });
  const argv = vi.fn<ArgvExecFn>(async args => {
    if (args.includes("list-panes")) {
      onList();
      return `${name}|${sid}|${pid}|${birth}|%1|0|/inert|80|24|1\n`;
    }
    if (args.includes("kill-session")) return result;
    throw Error("Unexpected command in provider-free fixture");
  });
  const forbidden = async () => { throw Error("No file effects permitted"); };
  const adapter = new TmuxAdapter(exec, { writeFile: forbidden, unlink: forbidden,
    tmpName: () => { throw Error("No temp files"); }, bufferName: () => { throw Error("No buffers"); } }, argv, "psmux");
  const registry = new SessionRegistry(db);
  adapter.deliveryGuard = new SeatDeliveryGuard(db, value => resolveGuardTarget(db, value));
  return { db, adapter, argv, exec, registry,
    current: (next: { name?: string; sid?: string; pid?: string; birth?: string; result?: string }) => {
      name = next.name ?? name; sid = next.sid ?? sid; pid = next.pid ?? pid;
      birth = next.birth ?? birth; result = next.result ?? result;
    }, onList: (callback: () => void) => { onList = callback; } };
}
async function bind(f: ReturnType<typeof fixture>) {
  const observed = await observeSolePane(f.adapter, "worker@fixture");
  if (!observed.ok) throw Error(observed.detail);
  f.registry.updateBinding("a", { tmuxPane: observed.pane });
  expect(f.registry.getBindingForNode("a")?.tmuxPane).toBe(observed.pane);
  f.argv.mockClear(); return observed.pane;
}
describe("checked native stop through existing binding", () => {
  it("persists one coherent server/pane observation and sends its original tuple", async () => {
    const f = fixture();
    try {
      const ref = await bind(f); expect(ref).toBe("psmux:v2:d29ya2VyQGZpeHR1cmU:%1:7:10:11");
      expect(await f.adapter.killSession("worker@fixture")).toEqual({ ok: true });
      expect(f.argv.mock.calls.map(([args]) => args)).toEqual([
        ["tmux", "list-panes", "-G", "-t", "=worker@fixture:"],
        ["tmux", "kill-session", "-t", "$7", "-G", "10:11"],
      ]);
      expect(f.exec).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it.each([{ sid: "$8" }, { pid: "12" }, { birth: "12" }, { name: "sibling@fixture" }])(
    "rejects same-name/local%%1 replacement BEFORE first stop observation: %j", async replacement => {
      const f = fixture(); try {
        const original = await bind(f); f.current(replacement);
        expect(await f.adapter.killSession("worker@fixture")).toMatchObject({ ok: false, code: "guard_target_unknown" });
        expect(f.argv.mock.calls.every(([args]) => args.includes("list-panes"))).toBe(true);
        expect(f.registry.getBindingForNode("a")?.tmuxPane).toBe(original);
      } finally { f.db.close(); }
    });
  it("never upgrades a legacy stored reference at stop", async () => {
    const f = fixture(); try {
      f.registry.updateBinding("a", { tmuxPane: "psmux:d29ya2VyQGZpeHR1cmU:%1" });
      expect(await f.adapter.killSession("worker@fixture")).toMatchObject({ ok: false, code: "guard_target_unknown" });
      expect(f.argv.mock.calls.some(([args]) => args.includes("kill-session"))).toBe(false);
    } finally { f.db.close(); }
  });
  it("distinguishes sibling local%1 and retains scoped argv translation", async () => {
    const f = fixture(); try {
      const first = await bind(f); f.current({ name: "sibling@fixture", sid: "$8", pid: "12", birth: "13" });
      const sibling = await observeSolePane(f.adapter, "sibling@fixture");
      expect(sibling.ok && sibling.pane).not.toBe(first);
      await f.adapter.listPanes(first);
      expect(f.argv.mock.calls.at(-1)?.[0].slice(0, 3)).toEqual(["tmux", "-t", "=worker@fixture"]);
    } finally { f.db.close(); }
  });
  it.each(["", "0", "not-a-time"])("refuses unqualified birth %j", async birth => {
    const f = fixture(); try {
      f.current({ birth }); expect((await observeSolePane(f.adapter, "worker@fixture")).ok).toBe(false);
      expect(f.argv.mock.calls.some(([args]) => args.includes("kill-session"))).toBe(false);
    } finally { f.db.close(); }
  });
  it("revalidates occupant after awaited observation before sending", async () => {
    const f = fixture(); try {
      await bind(f); f.onList(() => {
        f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g2','a',2,'g2','adopt')");
      });
      expect(await f.adapter.killSession("worker@fixture")).toMatchObject({ ok: false, code: "guard_target_changed" });
      expect(f.argv.mock.calls.some(([args]) => args.includes("kill-session"))).toBe(false);
    } finally { f.db.close(); }
  });
  it.each(["", "OK\n", "CHECKED-STOP COMPLETE", "CHECKED-STOP COMPLETE\nextra"])(
    "does not promote incomplete/malformed CLI result %j", async result => {
      const f = fixture(); try {
        await bind(f); f.current({ result });
        expect(await f.adapter.killSession("worker@fixture")).toMatchObject({ ok: false, code: "kill_unverified" });
        expect(f.argv.mock.calls.filter(([args]) => args.includes("kill-session"))).toHaveLength(1);
      } finally { f.db.close(); }
    });
  it.each(["checked stop identity rejected", "timed out", "connection reset"])(
    "keeps terminal rejection/loss honest without retry: %s", async message => {
      const f = fixture(); try {
        await bind(f);
        f.argv.mockImplementationOnce(async () => "worker@fixture|$7|10|11|%1|0|/inert|80|24|1\n")
          .mockRejectedValueOnce(new Error(message));
        expect(await f.adapter.killSession("worker@fixture")).toMatchObject({ ok: false,
          code: message.includes("identity rejected") ? "guard_target_changed" : "kill_unverified" });
        expect(f.argv.mock.calls.filter(([args]) => args.includes("kill-session"))).toHaveLength(1);
      } finally { f.db.close(); }
    });
  it("keeps POSIX detach/kill argv and results unchanged", async () => {
    const argv = vi.fn<ArgvExecFn>(async () => "");
    const adapter = new TmuxAdapter(async () => { throw Error("No shell"); }, undefined, argv, "tmux");
    expect(await adapter.killSession("worker@fixture")).toEqual({ ok: true });
    expect(argv.mock.calls.map(([args]) => args)).toEqual([
      ["tmux", "detach-client", "-s", "=worker@fixture"], ["tmux", "kill-session", "-t", "=worker@fixture"],
    ]);
  });
});
