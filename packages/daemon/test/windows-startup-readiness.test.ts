import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const f = vi.hoisted(() => ({ serve: vi.fn(), createDaemon: vi.fn(), fetch: vi.fn(), close: vi.fn(),
  contextStart: vi.fn(), contextStop: vi.fn(), eventStop: vi.fn(), markStop: vi.fn() }));
vi.mock("@hono/node-server", () => ({ serve: f.serve }));
vi.mock("../src/startup.js", () => ({ createDaemon: f.createDaemon }));
vi.mock("../src/adapters/bounded-probe-exec.js", () => ({
  endProbeGroupsOnStartupSignal: () => () => {}, stopRuntimeProbes: async () => {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("required Windows control startup completion", () => {
  let before: { SIGINT: Function[]; SIGTERM: Function[] };
  let exit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    vi.clearAllMocks();
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    f.fetch.mockImplementation(async () => Response.json({ status: "ok", pid: process.pid }));
    f.close.mockImplementation((done: () => void) => done());
    f.serve.mockImplementation((_options, bound) => {
      queueMicrotask(() => bound({ port: 7441 }));
      return { prependListener: vi.fn(), close: f.close, closeIdleConnections: vi.fn() };
    });
    f.createDaemon.mockResolvedValue({
      app: { fetch: f.fetch }, contextMonitor: { start: f.contextStart, stop: f.contextStop },
      eventLoopMonitor: { stop: f.eventStop }, injectWebSocket: vi.fn(),
      deps: { rigRepo: { db: {} }, settingsStore: { resolveOne: () => ({ value: false }) },
        daemonLifecycleStore: { recordHeartbeat: vi.fn(), recordStop: f.markStop },
        tmuxAdapter: { closeControlClient: vi.fn() } },
    });
    process.env.OPENRIG_BIND_HOST = "127.0.0.1";
  });
  afterEach(async () => {
    for (const listener of process.listeners("SIGTERM")) {
      if (!before.SIGTERM.includes(listener)) (listener as () => void)();
    }
    // Existing shutdown phases are asynchronous, including the final receipt.
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      for (const listener of process.listeners(signal)) {
        if (!before[signal].includes(listener)) process.off(signal, listener as () => void);
      }
    }
    delete process.env.OPENRIG_BIND_HOST;
    exit.mockRestore();
  });

  it("keeps public health unadoptable until required control initialization completes", async () => {
    const { startServer } = await import("../src/index.js");
    const control = deferred<() => Promise<void>>();
    const closeControl = vi.fn(async () => {});
    let complete = false;
    const startup = startServer(7441, { windowsControlInitializer: () => control.promise });
    void startup.then(() => { complete = true; });
    await vi.waitFor(() => expect(f.serve).toHaveBeenCalledTimes(1));
    const response = await f.serve.mock.calls[0]![0].fetch(new Request("http://127.0.0.1:7441/healthz"));
    const completedBeforeControl = complete;
    control.resolve(closeControl);
    await startup;
    expect(response.status).toBe(503);
    expect(completedBeforeControl).toBe(false);
    expect(complete).toBe(true);
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.serve.mock.calls[0]![0].fetch(new Request("http://127.0.0.1:7441/healthz"))).status).toBe(200);
  });

  it("joins ordered owned-resource rollback when the required initializer rejects", async () => {
    const { startServer } = await import("../src/index.js");
    const control = deferred<() => Promise<void>>();
    void control.promise.catch(() => {});
    const startup = startServer(7441, { windowsControlInitializer: () => control.promise });
    const outcome = startup.then(() => undefined, error => error);
    await vi.waitFor(() => expect(f.serve).toHaveBeenCalledTimes(1));
    control.reject(new Error("ACL refused"));
    expect(await outcome).toMatchObject({ message: "ACL refused" });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.contextStop).toHaveBeenCalledTimes(1);
    expect(f.eventStop).toHaveBeenCalledTimes(1);
    expect(f.markStop).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    const { OPENRIG_HOME } = await import("../src/openrig-compat.js");
    expect(JSON.parse(readFileSync(path.join(OPENRIG_HOME, "daemon-shutdown.json"), "utf8")).outcome).toBe("failed");
  });

  it("aborts pending initialization and closes a late returned handle before rollback settles", async () => {
    const { startServer } = await import("../src/index.js");
    const control = deferred<() => Promise<void>>();
    const cancellation = new AbortController();
    let leafSignal: AbortSignal | undefined;
    const closeControl = vi.fn(async () => {});
    const startup = startServer(7441, { signal: cancellation.signal,
      windowsControlInitializer: (_home, _stop, signal) => { leafSignal = signal; return control.promise; } });
    const outcome = startup.then(() => undefined, error => error);
    await vi.waitFor(() => expect(f.serve).toHaveBeenCalledTimes(1));
    cancellation.abort();
    expect(leafSignal?.aborted).toBe(true);
    control.resolve(closeControl);
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/cancelled/) });
    expect(closeControl).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.markStop).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    const { OPENRIG_HOME } = await import("../src/openrig-compat.js");
    expect(JSON.parse(readFileSync(path.join(OPENRIG_HOME, "daemon-shutdown.json"), "utf8")).outcome).toBe("failed");
  });

  it("supports immediate public control stop after successful initialization", async () => {
    const { startServer } = await import("../src/index.js");
    const closeControl = vi.fn(async () => {});
    let stop!: () => void;
    await startServer(7441, { windowsControlInitializer: async (_home, shutdown) => { stop = shutdown; return closeControl; } });
    stop();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(closeControl).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.markStop).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === "win32")("preserves POSIX health and HTTP adapter environment without a Windows dependency", async () => {
    const { startServer } = await import("../src/index.js");
    await startServer(7441);
    const request = new Request("http://127.0.0.1:7441/healthz");
    const environment = { incoming: "fixture transport" };
    expect((await f.serve.mock.calls[0]![0].fetch(request, environment)).status).toBe(200);
    expect(f.fetch).toHaveBeenCalledWith(request, environment);
  });

  it("retains timed-out evidence when an initializer ignores abort, and disposes its late result", async () => {
    const { startServer } = await import("../src/index.js");
    const { OPENRIG_HOME } = await import("../src/openrig-compat.js");
    const control = deferred<() => Promise<void>>();
    const cancellation = new AbortController();
    const closeControl = vi.fn(async () => {});
    vi.useFakeTimers();
    try {
      const startup = startServer(7441, { signal: cancellation.signal, windowsControlInitializer: () => control.promise });
      const outcome = startup.then(() => undefined, error => error);
      await vi.waitFor(() => expect(f.serve).toHaveBeenCalledTimes(1));
      cancellation.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await outcome).toMatchObject({ message: expect.stringMatching(/cancelled/) });
      const receipt = JSON.parse(readFileSync(path.join(OPENRIG_HOME, "daemon-shutdown.json"), "utf8"));
      expect(receipt.outcome).toBe("timed-out");
      expect(receipt.phase).toBe("windows-control");
      expect(f.markStop).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
      control.resolve(closeControl);
      await vi.advanceTimersByTimeAsync(0);
      expect(closeControl).toHaveBeenCalledTimes(1);
      // Other cleanup was unverified at the deadline; do not invent clean exit.
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("self-exits direct entry after timed-out rollback without claiming clean cleanup", async () => {
    const { startServerDirect } = await import("../src/index.js");
    const { OPENRIG_HOME } = await import("../src/openrig-compat.js");
    const control = deferred<() => Promise<void>>();
    const cancellation = new AbortController();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const startup = startServerDirect(7441, { signal: cancellation.signal,
        windowsControlInitializer: () => control.promise });
      await vi.waitFor(() => expect(f.serve).toHaveBeenCalledTimes(1));
      cancellation.abort();
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      await startup;
      const receipt = JSON.parse(readFileSync(path.join(OPENRIG_HOME, "daemon-shutdown.json"), "utf8"));
      expect(receipt.outcome).toBe("timed-out");
      expect(receipt.phase).toBe("windows-control");
      expect(f.markStop).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledExactlyOnceWith(1);
      control.resolve(async () => {});
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
      report.mockRestore();
    }
  });

});
