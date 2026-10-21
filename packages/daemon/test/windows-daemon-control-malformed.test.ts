import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  accept: undefined as undefined | ((socket: Client) => void),
  listen: undefined as undefined | (() => void),
  deferListen: false,
  deferAcl: false,
  finishAcl: undefined as undefined | ((error: Error | null) => void),
  close: vi.fn(),
  exec: vi.fn(),
}));
vi.mock("node:net", () => ({
  createServer: (accept: (socket: Client) => void) => {
    transport.accept = accept;
    return { once: vi.fn(), removeListener: vi.fn(), listen: (_pipe: string, ready: () => void) => {
      transport.listen = ready;
      if (!transport.deferListen) ready();
    }, close: (done?: () => void) => { transport.close(); done?.(); } };
  },
  createConnection: () => { throw new Error("No native connections in this test"); },
}));
vi.mock("node:child_process", () => ({
  execFile: (_file: string, _args: string[], options: { signal?: AbortSignal }, done: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    transport.exec();
    if (!transport.deferAcl) { done(null, "", ""); return; }
    transport.finishAcl = error => done(error, "", "");
    options.signal?.addEventListener("abort", () => done(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  },
}));
import { startWindowsDaemonControl } from "../src/windows-daemon-control.js";

class Client extends EventEmitter {
  destroyed = false;
  response = "";
  timeout?: () => void;
  setTimeout = vi.fn((_milliseconds: number, expire: () => void) => { this.timeout = expire; });
  destroy() { this.destroyed = true; return this; }
  end(response: string, done: () => void) { this.response += response; done(); return this; }
  send(input: string) { this.emit("data", Buffer.from(input)); }
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
beforeEach(() => { transport.deferAcl = false; transport.deferListen = false; transport.close.mockClear(); transport.exec.mockClear(); });

function privateHome() {
  const home = mkdtempSync(path.join(tmpdir(), "openrig-control-handler-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, "windows-control"));
  return home;
}

async function fixture() {
  const home = privateHome();
  const state = { pid: process.pid, startedAt: "2026-10-19T03:25:00.000Z" };
  writeFileSync(path.join(home, "daemon.json"), JSON.stringify(state));
  const shutdown = vi.fn();
  cleanup.push(await startWindowsDaemonControl(home, shutdown));
  const file = path.join(home, "windows-control/daemon-control.json");
  const record = JSON.parse(readFileSync(file, "utf8"));
  const request = { ...state, token: record.token };
  const connect = () => { const client = new Client(); transport.accept!(client); return client; };
  return { home, file, record, state, request, connect, shutdown };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("Windows drain actual socket handler with inert transport", () => {
  it("refuses malformed and unauthenticated clients then accepts the current capability", async () => {
    const f = await fixture();
    const rejected = ["null\n", "[]\n", "true\n", "1\n", '"text"\n', "{broken\n",
      ...[{}, { ...f.request, token: null }, { ...f.request, token: "wrong" },
        { ...f.request, pid: String(f.state.pid) }, { ...f.request, startedAt: {} },
        { ...f.request, startedAt: "stale" }].map(value => JSON.stringify(value) + "\n")];
    for (const input of rejected) {
      const client = f.connect();
      expect(() => client.send(input), input).not.toThrow();
      expect(client.destroyed, input).toBe(true);
      expect(client.response).toBe("");
    }
    await flush();
    expect(f.shutdown).not.toHaveBeenCalled();
    const valid = f.connect();
    valid.send(JSON.stringify(f.request) + "\n");
    expect(valid.response).toBe("accepted\n");
    await flush();
    expect(f.shutdown).toHaveBeenCalledTimes(1);
  });

  it("contains processing errors and consumes at most one frame per connection", async () => {
    const f = await fixture();
    const broken = f.connect();
    broken.end = () => { throw new Error("inert transport write failed"); };
    expect(() => broken.send(JSON.stringify(f.request) + "\n")).not.toThrow();
    expect(broken.destroyed).toBe(true);
    const valid = f.connect();
    const frame = JSON.stringify(f.request) + "\n";
    valid.send(frame.slice(0, 10));
    expect(valid.response).toBe("");
    valid.send(frame.slice(10));
    valid.send(frame);
    await flush();
    expect(f.shutdown).toHaveBeenCalledTimes(1);
  });

  it("bounds bytes and time, checks current identity, and preserves successor cleanup", async () => {
    const f = await fixture();
    const oversized = f.connect();
    oversized.send("é".repeat(2049));
    expect(oversized.destroyed).toBe(true);
    const idle = f.connect();
    expect(idle.setTimeout).toHaveBeenCalledWith(2000, expect.any(Function));
    idle.timeout!();
    expect(idle.destroyed).toBe(true);
    writeFileSync(path.join(f.home, "daemon.json"), JSON.stringify({ ...f.state, pid: f.state.pid + 1 }));
    const stale = f.connect();
    stale.send(JSON.stringify(f.request) + "\n");
    expect(stale.destroyed).toBe(true);
    expect(stale.response).toBe("");
    await flush();
    expect(f.shutdown).not.toHaveBeenCalled();
    writeFileSync(f.file, JSON.stringify({ ...f.record, token: "successor" }));
    await cleanup.pop()!();
    expect(existsSync(f.file)).toBe(true);
    expect(JSON.parse(readFileSync(f.file, "utf8")).token).toBe("successor");
  });
});

describe("Windows control startup cancellation", () => {
  it("rejects an already cancelled startup without invoking the ACL helper", async () => {
    const home = privateHome();
    const controller = new AbortController();
    controller.abort();
    await expect(startWindowsDaemonControl(home, vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(transport.exec).not.toHaveBeenCalled();
    expect(existsSync(path.join(home, "windows-control/daemon-control.json"))).toBe(false);
  });

  it("aborts the pending ACL helper without publishing a late capability", async () => {
    const home = privateHome();
    transport.deferAcl = true;
    const controller = new AbortController();
    const started = startWindowsDaemonControl(home, vi.fn(), controller.signal);
    const rejected = expect(started).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    transport.finishAcl!(null);
    await flush();
    expect(existsSync(path.join(home, "windows-control/daemon-control.json"))).toBe(false);
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("rejects a pending listen promptly and closes its late listener without removing a successor", async () => {
    const home = privateHome();
    const file = path.join(home, "windows-control/daemon-control.json");
    writeFileSync(file, JSON.stringify({ token: "successor" }));
    transport.deferListen = true;
    const controller = new AbortController();
    const started = startWindowsDaemonControl(home, vi.fn(), controller.signal);
    await flush();
    const rejected = expect(started).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(transport.close).toHaveBeenCalledTimes(1);
    transport.listen!();
    await flush();
    expect(transport.close).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ token: "successor" });
  });

  it("retains ACL failure refusal without publishing a capability", async () => {
    const home = privateHome();
    transport.deferAcl = true;
    const started = startWindowsDaemonControl(home, vi.fn());
    const rejected = expect(started).rejects.toThrow("Windows private control directory unavailable; no capability published");
    transport.finishAcl!(new Error("ACL denied"));
    await rejected;
    expect(existsSync(path.join(home, "windows-control/daemon-control.json"))).toBe(false);
  });
});
