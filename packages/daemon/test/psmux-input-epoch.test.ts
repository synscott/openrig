import { describe, expect, it } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { observeSolePane } from "../src/domain/pane-binding-observation.js";
const original = "psmux:v2:d29ya2VyQGZpeHR1cmU:%1:7:10:11";
const complete = "CHECKED-INPUT COMPLETE\n";
// External boundaries only. Legacy name-routed input would reach E2; the actor
// model accepts only its own expected tuple and records its input queue.
function fixture() {
  const files = new Map<string, string>();
  const received: { mode: string; value: string }[] = [];
  const commands: string[][] = [];
  let server = "10:11", sid = "7", pane = "%1", serial = 0, ack = complete;
  let failure: Error | undefined;
  let onStage = () => {};
  const fileOps: TmuxFileOps = {
    tmpName: () => `/inert/payload-${++serial}`,
    bufferName: () => { throw Error("No legacy buffer"); },
    writeFile: async (path, value, options) => {
      expect(options).toEqual({ mode: 0o600, flag: "wx" }); files.set(path, value); onStage();
    },
    unlink: async path => { files.delete(path); },
  };
  const adapter = new TmuxAdapter(async () => { throw Error("No shell"); }, fileOps, async args => {
    commands.push(args);
    const value = (key: string) => args[args.indexOf(key) + 1];
    if (args.includes("list-panes")) {
      const [pid, birth] = server.split(":");
      return `worker@fixture|$${sid}|${pid}|${birth}|${pane}|0|/inert|80|24|1\n`;
    }
    if (args.includes("display-message")) return "pwsh";
    if (args[1] === "checked-input") {
      if (value("--session") !== sid || value("--server") !== server || value("--pane") !== pane) throw Error("checked input identity rejected");
      const payload = value("--mode") === "copy-cancel" ? "" : files.get(value("--file")!);
      if (payload === undefined) throw Error("payload missing");
      received.push({ mode: value("--mode")!, value: payload });
      if (failure) throw failure;
      return ack;
    }
    if (args.includes("kill-session")) return "CHECKED-STOP COMPLETE\n";
    if (args.includes("send-keys") || args.includes("paste-buffer")) {
      received.push({ mode: "legacy", value: "replacement received input" }); return "";
    }
    throw Error("Unexpected native operation");
  }, "psmux");
  return { adapter, files, received, commands,
    replace: (next: { sid?: string; server?: string; pane?: string }) => { sid = next.sid ?? sid; server = next.server ?? server; pane = next.pane ?? pane; },
    onStage: (fn: () => void) => { onStage = fn; }, ack: (value: string) => { ack = value; },
    fail: (error: Error) => { failure = error; } };
}
async function managedFixture() {
  const f = fixture();
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('r','fixture');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('a','r','worker');
    INSERT INTO bindings(id,node_id,tmux_session) VALUES ('b','a','worker@fixture');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('s','a','worker@fixture','running');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g','a',1,'g1','fresh');`);
  const registry = new SessionRegistry(db);
  f.adapter.deliveryGuard = new SeatDeliveryGuard(db, value => resolveGuardTarget(db, value));
  const observed = await observeSolePane(f.adapter, "worker@fixture");
  if (!observed.ok) throw Error(observed.detail);
  registry.updateBinding("a", { tmuxPane: observed.pane });
  f.commands.length = 0;
  return { ...f, db, registry };
}
describe("native input effect-bound epoch", () => {
  it("rejects E2 after a real managed guard observed E1, preserving its persisted binding", async () => {
    const f = await managedFixture();
    try {
      f.onStage(() => f.replace({ sid: "8", server: "12:13" }));
      const result = await f.adapter.sendText("worker@fixture", "old occupant work");
      expect(f.received).toEqual([]);
      expect(result).toMatchObject({ ok: false });
      expect(f.commands.filter(args => args.includes("checked-input"))).toEqual([
        ["tmux", "checked-input", "--session", "7", "--server", "10:11", "--pane", "%1", "--mode", "auto", "--file", "/inert/payload-1"],
      ]);
      expect(f.registry.getBindingForNode("a")?.tmuxPane).toBe(original);
    } finally { f.db.close(); }
  });
  it("rechecks the real managed occupant after awaited staging before input dispatch", async () => {
    const f = await managedFixture();
    try {
      f.onStage(() => f.db.exec("INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('g2','a',2,'g2','adopt')"));
      expect(await f.adapter.sendKeys("worker@fixture", ["Enter"])).toMatchObject({ ok: false, code: "guard_target_changed" });
      expect(f.received).toEqual([]);
      expect(f.commands.some(args => args.includes("checked-input"))).toBe(false);
      expect(f.files.size).toBe(0);
    } finally { f.db.close(); }
  });
  it("queues exact Unicode/multiline/BOM text in the original actor using auto mode", async () => {
    const f = fixture();
    expect(await f.adapter.sendText(original, "hello\n世界\n\uFEFF")).toEqual({ ok: true });
    expect(f.received).toEqual([{ mode: "auto", value: "hello\n世界\n\uFEFF" }]);
    expect(f.commands).toEqual([["tmux", "checked-input", "--session", "7", "--server", "10:11", "--pane", "%1", "--mode", "auto", "--file", "/inert/payload-1"]]);
    expect(f.files.size).toBe(0);
  });
  it("preserves unbracketed answers as raw data", async () => {
    const f = fixture();
    expect(await f.adapter.sendText(original, "1; literal\n", undefined, { bracketed: false })).toEqual({ ok: true });
    expect(f.received).toEqual([{ mode: "raw", value: "1; literal\n" }]);
  });
  it("stages a PowerShell launch through checked text and checked Enter, without claiming script consumption", async () => {
    const f = fixture();
    expect(await f.adapter.sendShellCommand(original, "Write-Output 'harmless'")).toEqual({ ok: true });
    expect(f.received).toEqual([
      { mode: "auto", value: "& ([scriptblock]::Create([IO.File]::ReadAllText('/inert/payload-1')))" },
      { mode: "keys", value: '["Enter"]' },
    ]);
    expect([...f.files.values()]).toEqual(["Remove-Item -LiteralPath '/inert/payload-1'\nWrite-Output 'harmless'\n"]);
  });
  it("does not submit a staged shell launch to a replaced actor", async () => {
    const f = fixture(); let staged = 0;
    f.onStage(() => { if (++staged === 2) f.replace({ server: "12:13" }); });
    expect(await f.adapter.sendShellCommand(original, "Write-Output 'harmless'")).toMatchObject({ ok: false });
    expect(f.received).toEqual([]);
    expect(f.commands.filter(args => args.includes("checked-input"))).toHaveLength(1);
    expect(f.files.size).toBe(0);
  });
  it("queues ordered literal keys without command or PID lookup", async () => {
    const f = fixture();
    expect(await f.adapter.sendKeys(original, ["C-u", "Enter"])).toEqual({ ok: true });
    expect(f.received).toEqual([{ mode: "keys", value: '["C-u","Enter"]' }]);
    expect(f.commands).toHaveLength(1); expect(f.files.size).toBe(0);
  });
  it("cancels native copy mode through an explicit fileless actor operation", async () => {
    const f = fixture();
    expect(await f.adapter.cancelPaneMode(original)).toEqual({ ok: true });
    expect(f.received).toEqual([{ mode: "copy-cancel", value: "" }]);
    expect(f.commands).toEqual([["tmux", "checked-input", "--session", "7", "--server", "10:11", "--pane", "%1", "--mode", "copy-cancel"]]);
    expect(f.files.size).toBe(0);
  });
  it("does not promote a failed process with complete stdout or retry its partial effect", async () => {
    const f = fixture(); f.fail(Object.assign(Error("failed"), { code: 1, stdout: complete }));
    expect(await f.adapter.sendText(original, "once")).toMatchObject({ ok: false, code: "native_input_unverified" });
    expect(f.received).toEqual([{ mode: "auto", value: "once" }]);
    expect(f.commands).toHaveLength(1); expect(f.files.size).toBe(0);
  });
  it("never falls back to a shell-string executor for native writes", async () => {
    const effects: string[] = [];
    const adapter = new TmuxAdapter(async command => { effects.push(command); return complete; }, undefined, undefined, "psmux");
    expect(await adapter.sendKeys(original, ["Enter"])).toMatchObject({ ok: false, code: "native_input_unverified" });
    expect(effects).toEqual([]);
  });
  it.each([{ sid: "8" }, { server: "12:11" }, { server: "10:12" }, { pane: "%2" }])(
    "refuses replacement after staging with no input/retry: %j", async next => {
      const f = fixture(); f.onStage(() => f.replace(next));
      expect(await f.adapter.sendText(original, "private payload")).toMatchObject({ ok: false });
      expect(f.received).toEqual([]); expect(f.commands).toHaveLength(1);
      expect(f.commands[0]).toContain("10:11"); expect(f.files.size).toBe(0);
    });
  it("checks registry/occupant callback after awaited key staging", async () => {
    const f = fixture(); let stale = false; f.onStage(() => { stale = true; });
    expect(await f.adapter.sendKeys(original, ["Enter"], () => { if (stale) throw Error("occupant changed"); })).toMatchObject({ ok: false });
    expect(f.commands).toEqual([]); expect(f.received).toEqual([]); expect(f.files.size).toBe(0);
  });
  it.each(["", "OK\n", complete.trimEnd(), `${complete}extra`, "CHECKED-INPUT REJECTED\n"])(
    "does not retry ambiguous acceptance %j", async ack => {
      const f = fixture(); f.ack(ack);
      expect(await f.adapter.sendText(original, "once")).toMatchObject({ ok: false, code: "native_input_unverified" });
      expect(f.received).toEqual([{ mode: "auto", value: "once" }]); expect(f.commands).toHaveLength(1); expect(f.files.size).toBe(0);
    });
  it.each(["worker@fixture", "psmux:d29ya2VyQGZpeHR1cmU:%1"])("never upgrades %s", async target => {
    const f = fixture();
    expect(await f.adapter.sendKeys(target, ["Enter"])).toMatchObject({ ok: false, code: "guard_target_unknown" });
    expect(f.commands).toEqual([]); expect(f.files.size).toBe(0);
  });
  it("bounds bytes and key count before staging", async () => {
    const f = fixture();
    expect(await f.adapter.sendText(original, "x".repeat(1024 * 1024 + 1))).toMatchObject({ ok: false });
    expect(await f.adapter.sendKeys(original, Array(4097).fill("Enter"))).toMatchObject({ ok: false });
    expect(f.commands).toEqual([]); expect(f.files.size).toBe(0);
  });
  it("retains POSIX input", async () => {
    const effects: string[][] = [];
    const adapter = new TmuxAdapter(async () => "", undefined, async args => { effects.push(args); return ""; });
    expect(await adapter.sendKeys("%1", ["Enter"])).toEqual({ ok: true });
    expect(effects).toEqual([["tmux", "send-keys", "-t", "%1", "Enter"]]);
  });
  it("preserves checked stop and its original tuple", async () => {
    const f = fixture(); expect(await f.adapter.killSession(original)).toEqual({ ok: true });
    expect(f.commands).toEqual([["tmux", "kill-session", "-t", "$7", "-G", "10:11"]]);
  });
});
