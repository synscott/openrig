import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter, defaultTmuxFileOps, type TmuxFileOps, type ArgvExecFn } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
const attempt = "11111111-1111-4111-8111-111111111111";
const root = "/fixture/private-psmux";
const pane = "psmux:v2:c2VhdEBmaXh0dXJl:%1:7:10:11";
function fixture() {
  vi.stubEnv("PSMUX_DATA_DIR", root);
  const files = new Map<string, string>();
  const commands: Array<{ argv: string[]; options: unknown }> = [];
  const requests: Array<Record<string, unknown>> = [];
  let serial = 0;
  let onDispatch = () => {};
  let reply: ((request: Record<string, unknown>) => string) | undefined;
  const fs: TmuxFileOps & { canonicalDirectory(path: string): string | null } = {
    canonicalDirectory: path => path === root ? root : null,
    writeFile: async (path, value, options) => { expect(options).toEqual({ mode: 0o600, flag: "wx" }); files.set(path, value); },
    unlink: async path => { files.delete(path); },
    tmpName: () => `/fixture/request-${++serial}`, bufferName: () => { throw Error("No buffers"); },
  };
  const argv: ArgvExecFn = async (args, options) => {
    commands.push({ argv: args, options });
    if (args[1] === "kill-session") return "CHECKED-STOP COMPLETE\n";
    if (args[1] !== "checked-create") throw Error("No legacy creation, maintenance, or name polling");
    const request = JSON.parse(files.get(args[3]!)!); requests.push(request);
    onDispatch();
    if (reply) return reply(request);
    return JSON.stringify({ version: 1, status: "created", attempt: request.attempt, name: request.name, sid: "7", pid: "10", birth: "11", pane: "%1" }) + "\n";
  };
  return { adapter: new TmuxAdapter(async () => { throw Error("No shell"); }, fs, argv, "psmux"), files, commands, requests,
    onDispatch: (callback: () => void) => { onDispatch = callback; },
    reply: (callback: (request: Record<string, unknown>) => string) => { reply = callback; } };
}
function launcherFixture() {
  const f = fixture();
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
  const rig = rigRepo.createRig("fixture");
  const node = rigRepo.addNode(rig.id, "seat", { role: "worker", runtime: "codex", cwd: "C:/workspace" });
  const launcher = () => new NodeLauncher({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: f.adapter });
  return { ...f, db, rig, node, registry, eventBus, launcher };
}
afterEach(() => vi.unstubAllEnvs());
describe("native checked creation through the public adapter", () => {
  it("removes inherited parent identity inside the request before child initialization", async () => {
    const f = fixture(); vi.stubEnv("CLAUDE_CODE_SESSION_ID", "private-fixture-parent");
    expect(await f.adapter.createSession("seat@fixture", "C:/workspace", {}, { attempt, root })).toMatchObject({ ok: true });
    expect(f.requests[0]!.unset).toContain("CLAUDE_CODE_SESSION_ID");
    expect(JSON.stringify(f.requests[0])).not.toContain("private-fixture-parent");
  });
  it("returns only its own creation receipt and bypasses legacy env repair/name observation", async () => {
    const f = fixture();
    const result = await f.adapter.createSession("seat@fixture", "C:/workspace", { OPENRIG_NODE_ID: "node" }, { attempt, root });
    expect(result).toMatchObject({ ok: true, creation: { attempt, root, name: "seat@fixture", pane } });
    expect(f.requests).toEqual([{ version: 1, attempt, name: "seat@fixture", cwd: "C:/workspace", env: { OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "", OPENRIG_NODE_ID: "node" }, unset: [] }]);
    expect(f.commands).toEqual([{ argv: ["tmux", "checked-create", "--file", "/fixture/request-1"], options: { timeoutMs: 35000, psmuxDataDir: root } }]);
    expect(f.files.size).toBe(0);
  });
});
describe("native checked creation through NodeLauncher", () => {
  it("journals before dispatch and binds the returned original epoch without a name observation", async () => {
    const f = launcherFixture();
    try {
      f.onDispatch(() => {
        const rows = f.db.prepare("SELECT payload FROM events WHERE type='native.creation_attempt'").all() as Array<{ payload: string }>;
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.payload)).toMatchObject({ name: "seat@fixture", root, attempt: f.requests[0]!.attempt });
        expect(rows[0]!.payload).not.toContain("OPENRIG_NODE_ID");
      });
      const result = await f.launcher().launchNode(f.rig.id, "seat", { sessionName: "seat@fixture" });
      expect(result.ok).toBe(true);
      expect(f.registry.getBindingForNode(f.node.id)?.tmuxPane).toBe(pane);
      expect(f.commands.map(command => command.argv[1])).toEqual(["checked-create"]);
    } finally { f.db.close(); }
  });
  it("retains lost-ACK uncertainty across a new launcher without retry or binding", async () => {
    const f = launcherFixture();
    try {
      f.reply(() => { throw Object.assign(new Error("transport lost"), { code: 3, stdout: "" }); });
      expect(await f.launcher().launchNode(f.rig.id, "seat", { sessionName: "seat@fixture" })).toMatchObject({ ok: false });
      expect(f.registry.getBindingForNode(f.node.id)).toBeNull();
      expect(await f.launcher().launchNode(f.rig.id, "seat", { sessionName: "seat@fixture" })).toMatchObject({ ok: false, code: "native_create_unresolved" });
      expect(f.commands).toHaveLength(1);
    } finally { f.db.close(); }
  });
  it("refuses before dispatch when the durable attempt cannot be written", async () => {
    const f = launcherFixture();
    try {
      vi.spyOn(f.eventBus, "emit").mockImplementation(() => { throw Error("journal unavailable"); });
      expect(await f.launcher().launchNode(f.rig.id, "seat", { sessionName: "seat@fixture" })).toMatchObject({ ok: false, code: "native_creation_journal_failed" });
      expect(f.commands).toEqual([]);
    } finally { f.db.close(); }
  });
  it("refuses unsupported one-off environment cleanup before creation", async () => {
    const f = launcherFixture();
    try {
      expect(await f.launcher().launchNode(f.rig.id, "seat", { sessionName: "seat@fixture", env: { SECRET: "fixture" } })).toMatchObject({ ok: false, code: "native_one_off_env_unsupported" });
      expect(f.commands).toEqual([]);
    } finally { f.db.close(); }
  });
  it.each(["extra", "duplicate", "mismatch", "truncated"])("does not bind a %s completion", async kind => {
    const f = launcherFixture();
    try {
      f.reply(request => {
        const complete = JSON.stringify({ version: 1, status: "created", attempt: request.attempt, name: request.name, sid: "7", pid: "10", birth: "11", pane: "%1" });
        if (kind === "extra") return complete + "\nnoise\n";
        if (kind === "duplicate") return complete.replace('"sid":"7"', '"sid":"7","sid":"8"') + "\n";
        if (kind === "mismatch") return complete.replace(String(request.attempt), attempt) + "\n";
        return complete;
      });
      expect(await f.launcher().launchNode(f.rig.id, "seat", { sessionName: "seat@fixture" })).toMatchObject({ ok: false });
      expect(f.registry.getBindingForNode(f.node.id)).toBeNull();
      expect(f.commands).toHaveLength(1);
    } finally { f.db.close(); }
  });

  it("compensates a binding failure only against its original receipt and frozen root", async () => {
    const f = launcherFixture();
    try {
      vi.spyOn(f.registry, "updateBinding").mockImplementation(() => { throw Error("fixture binding failure"); });
      f.onDispatch(() => vi.stubEnv("PSMUX_DATA_DIR", "/replacement-root"));
      expect(await f.launcher().launchNode(f.rig.id, "seat", { sessionName: "seat@fixture" })).toMatchObject({ ok: false, code: "db_error" });
      expect(f.commands[1]).toEqual({ argv: ["tmux", "kill-session", "-t", "$7", "-G", "10:11"], options: { psmuxDataDir: root } });
      expect(f.commands).toHaveLength(2);
      expect(f.registry.getBindingForNode(f.node.id)).toBeNull();
    } finally { f.db.close(); }
  });
  it("accepts only the exact collision exit and permits a later deliberate attempt", async () => {
    const f = launcherFixture();
    try {
      f.reply(request => { throw Object.assign(new Error("fixture collision"), { code: 2, stdout: JSON.stringify({ version: 1, status: "collision", attempt: request.attempt, name: request.name }) + "\n" }); });
      for (let i = 0; i < 2; i++) expect(await f.launcher().launchNode(f.rig.id, "seat", { sessionName: "seat@fixture" })).toMatchObject({ ok: false, code: "duplicate_session" });
      expect(f.commands).toHaveLength(2);
      expect(f.registry.getBindingForNode(f.node.id)).toBeNull();
    } finally { f.db.close(); }
  });
  it("does not publish a binding when pre-binding retirement fails", async () => {
    const f = launcherFixture();
    try {
      const result = await f.launcher().launchNode(f.rig.id, "seat", { sessionName: "seat@fixture", beforeNativeBinding: () => { throw Error("fixture retirement failure"); } });
      expect(result).toMatchObject({ ok: false, code: "native_retirement_failed" });
      expect(f.registry.getBindingForNode(f.node.id)).toBeNull();
      expect(f.commands[1]!.argv).toEqual(["tmux", "kill-session", "-t", "$7", "-G", "10:11"]);
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='node.launched'").get()).toEqual({ n: 0 });
    } finally { f.db.close(); }
  });

});

describe("explicit immutable native backend root", () => {
  it("uses its real canonical selected root without changing inherited environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-root-boundary-"));
    try {
      const selected = realpathSync(dir), before = process.env.PSMUX_DATA_DIR;
      const backend = { psmuxDataDir: selected };
      const calls: unknown[] = [];
      const adapter = new TmuxAdapter(async () => { throw Error("no shell"); }, defaultTmuxFileOps(), async (argv, options) => {
        calls.push({ argv: argv.slice(0, 3), options });
        return JSON.stringify({ version: 1, status: "created", attempt, name: "seat@fixture", sid: "7", pid: "10", birth: "11", pane: "%1" }) + "\n";
      }, "psmux", backend);
      backend.psmuxDataDir = join(selected, "different-root");
      expect(adapter.nativeCreationRoot()).toBe(selected);
      expect(await adapter.createSession("seat@fixture", selected, {}, { attempt, root: selected })).toMatchObject({ ok: true, creation: { root: selected, pane } });
      expect(calls).toEqual([{ argv: ["tmux", "checked-create", "--file"], options: { timeoutMs: 35000, psmuxDataDir: selected } }]);
      expect(process.env.PSMUX_DATA_DIR).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses an uncanonical selected root before staging or dispatch", async () => {
    const argv = vi.fn();
    const adapter = new TmuxAdapter(async () => "", defaultTmuxFileOps(), argv, "psmux", { psmuxDataDir: "relative-root" });
    expect(adapter.nativeCreationRoot()).toBeNull();
    expect(await adapter.createSession("seat@fixture", "/fixture", {}, { attempt, root: "relative-root" })).toMatchObject({ ok: false, code: "native_creation_context_required" });
    expect(argv).not.toHaveBeenCalled();
  });
});
