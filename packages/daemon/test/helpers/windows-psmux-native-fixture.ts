import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TmuxAdapter, defaultTmuxFileOps, type ArgvExecOptions, type NativeCreationReceipt } from "../../src/adapters/tmux.js";

const execFileAsync = promisify(execFile);

type NativeExecOptions = {
  cwd: string;
  env: Record<string, string>;
  windowsHide: boolean;
  shell: false;
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
};

export type NativeFixtureExec = (
  binary: string,
  args: string[],
  options: NativeExecOptions,
) => Promise<{ stdout: string }>;

type FixtureDiagnostics = {
  root: string;
  pendingAttempts: string[];
  ownedReceipts: NativeCreationReceipt[];
  acknowledgedStopReceipts: NativeCreationReceipt[];
};

function errorDiagnostic(error: unknown) {
  const codes = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "ENOENT", "guard_target_changed", "guard_target_unknown", "kill_unverified", "native_create_unknown"]);
  const protocol = (value: unknown) => typeof value !== "string" ? undefined
    : value.includes("checked stop route unavailable") ? "route_unavailable"
    : value.includes("checked stop identity rejected") ? "identity_rejected"
    : value.includes("checked stop completion unknown") ? "completion_unknown" : undefined;
  const value = (input: unknown) => {
    if (typeof input === "number" || typeof input === "boolean") return input;
    if (typeof input === "string") {
      const epoch = /^psmux:v2:[A-Za-z0-9_-]+:(%\d+):(\d+):(\d+):(\d+)$/.exec(input);
      return epoch ? { pane: epoch[1], sid: epoch[2], pid: epoch[3], birth: epoch[4] } : undefined;
    }
    if (!input || typeof input !== "object") return undefined;
    const object = input as Record<string, unknown>;
    return { ok: typeof object.ok === "boolean" ? object.ok : undefined,
      code: typeof object.code === "string" && codes.has(object.code) ? object.code : undefined,
      protocol: protocol(object.message) };
  };
  try {
    const object = error && typeof error === "object" ? error as Record<string, unknown> : {};
    return { type: object.name === "AssertionError" ? "AssertionError" : "Error",
      code: typeof object.code === "string" && codes.has(object.code) ? object.code : undefined,
      protocol: protocol(object.message), actual: value(object.actual), expected: value(object.expected) };
  } catch { return { type: "uninspectable" }; }
}

export async function withWindowsPsmuxNativeFixture<T extends { close(): Promise<void>; diagnostics(): FixtureDiagnostics }>(
  fixture: T, run: (fixture: T) => Promise<void>,
) {
  const errors: unknown[] = [];
  let bodyFailed = false;
  try { await run(fixture); } catch (error) { bodyFailed = true; errors.push(error); }
  try { await fixture.close(); } catch (error) { errors.push(error); }
  if (!errors.length) return;
  const state = fixture.diagnostics();
  const receipt = (item: NativeCreationReceipt) => ({ attempt: item.attempt, name: item.name, root: item.root, pane: item.pane });
  const diagnostic = JSON.stringify({ body: bodyFailed ? errorDiagnostic(errors[0]) : undefined,
    cleanup: errors.length > (bodyFailed ? 1 : 0) ? errorDiagnostic(errors.at(-1)) : undefined,
    fixture: { root: state.root, pendingAttempts: state.pendingAttempts.slice(0, 4),
      ownedReceipts: state.ownedReceipts.slice(0, 4).map(receipt), acknowledgedStopReceipts: state.acknowledgedStopReceipts.slice(0, 4).map(receipt) } });
  // Vitest's JSON reporter omits AggregateError.errors. Keep both originals,
  // but put only allowlisted synthetic diagnostics in its serialized message.
  throw new AggregateError(errors, `Native fixture failed; ${diagnostic}`.slice(0, 8192));
}

export function createWindowsPsmuxNativeFixture(options: {
  binary: string;
  environment?: NodeJS.ProcessEnv;
  execute?: NativeFixtureExec;
}) {
  const inherited = options.environment ?? process.env;
  const systemRoot = Object.entries(inherited).find(([key]) => key.toLowerCase() === "systemroot")?.[1] ?? "C:\\Windows";
  if (!path.win32.isAbsolute(systemRoot) || /['"\r\n\0]/.test(systemRoot)) {
    throw new Error("Native fixture requires an absolute, config-safe SystemRoot");
  }
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe").replace(/\\/g, "/");
  const dir = mkdtempSync(path.join(os.tmpdir(), "openrig-native-psmux-"));
  const registry = path.join(dir, "psmux");
  const configFile = path.join(dir, "fixture.conf");
  mkdirSync(registry);
  const dataDir = realpathSync(registry);
  // psmux's implicit -NoProfile still manually sources profiles. An explicit
  // default-shell argument selects its profile-free initialization path.
  writeFileSync(configFile, `set -g default-shell '\"${powershell}\" -NoProfile'\n`, { flag: "wx" });
  const sessionEnv = Object.freeze({
    PSMUX_DATA_DIR: dataDir,
    PSMUX_CONFIG_FILE: configFile,
    PSMUX_NO_WARM: "1",
  });
  const environment = Object.freeze({
    ...Object.fromEntries(Object.entries(inherited)
      .filter((entry): entry is [string, string] => entry[1] !== undefined
        && !/^(?:psmux|tmux)(?:_|$)/i.test(entry[0]))),
    ...sessionEnv,
  });
  const execute: NativeFixtureExec = options.execute ?? (async (binary, args, execOptions) => {
    const { stdout } = await execFileAsync(binary, args, execOptions);
    return { stdout };
  });
  const invoke = async (argv: string[], execOptions?: ArgvExecOptions) => {
    if (execOptions?.psmuxDataDir !== undefined && execOptions.psmuxDataDir !== dataDir) {
      throw new Error("Native fixture refuses a different creation root");
    }
    return (await execute(options.binary, argv.slice(1), {
      cwd: dir,
      env: environment,
      windowsHide: true,
      shell: false,
      timeout: execOptions?.timeoutMs ?? 5_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    })).stdout;
  };
  const fileOps = { ...defaultTmuxFileOps(), tmpName: () => path.join(dir, `openrig-tmux-send-${process.pid}-${randomUUID()}.txt`) };
  const adapter = new TmuxAdapter(async () => { throw new Error("No POSIX transport"); }, fileOps, invoke, "psmux", { psmuxDataDir: dataDir });
  const owned = new Map<string, NativeCreationReceipt>();
  const acknowledgedStops: NativeCreationReceipt[] = [];
  const pending = new Set<string>();
  const stop = async (pane: string) => {
    const receipt = owned.get(pane);
    if (!receipt) throw new Error("Native fixture has no original creation receipt for this pane");
    const result = await adapter.stopCreatedSession(receipt, "native-fixture");
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    acknowledgedStops.push(receipt);
    owned.delete(pane);
  };
  return {
    dir, dataDir, configFile, environment, sessionEnv, invoke, adapter, stop,
    diagnostics: (): FixtureDiagnostics => ({ root: dataDir, pendingAttempts: [...pending], ownedReceipts: [...owned.values()], acknowledgedStopReceipts: [...acknowledgedStops] }),
    async createSession(name: string) {
      const context = { attempt: randomUUID(), root: dataDir };
      const ledger = path.join(dir, `creation-${context.attempt}`);
      writeFileSync(`${ledger}.attempt.json`, JSON.stringify({ version: 1, name, ...context }), { flag: "wx", mode: 0o600 });
      pending.add(context.attempt);
      // Backend controls belong to invoke's private environment, not the
      // checked-create request's reserved pane-environment namespace.
      const result = await adapter.createSession(name, dir, {}, context);
      if (!result.ok) {
        if (result.creationOutcome === "not_started" || result.creationOutcome === "collision") pending.delete(context.attempt);
        throw new Error(`${result.code}: ${result.message}`);
      }
      const receipt = result.creation;
      if (!receipt || receipt.attempt !== context.attempt || receipt.root !== dataDir || receipt.name !== name) {
        throw new Error("Native fixture creation receipt is unavailable; outcome remains unverified");
      }
      owned.set(receipt.pane, receipt);
      writeFileSync(`${ledger}.receipt.json`, JSON.stringify({ version: 1, ...receipt }), { flag: "wx", mode: 0o600 });
      pending.delete(context.attempt);
      return { id: receipt.pane };
    },
    async close() {
      const failures: string[] = [];
      for (const pane of owned.keys()) {
        try { await stop(pane); } catch (error) { failures.push(String(error)); }
      }
      if (pending.size || failures.length) {
        throw new Error(`Native fixture cleanup unverified; preserved ${dir}; pending attempts: ${[...pending].join(", ")}; ${failures.join("; ")}`);
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
    removeFiles: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
