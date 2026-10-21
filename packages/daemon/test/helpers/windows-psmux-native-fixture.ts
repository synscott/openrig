import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { TmuxAdapter, defaultTmuxFileOps, type ArgvExecOptions, type NativeCreationReceipt } from "../../src/adapters/tmux.js";

const execFileAsync = promisify(execFile);
// Additional to checked-stop's existing5s command slot: ready5s + wait/report10s + hostclose5s.
export const SERVER_OBSERVER_BUDGET_MS = 20_000;
type ServerIdentity = { pid: string; birth: string };
type ServerObservation = { assertRetained?(): void; waitForExit(): Promise<"exited" | "timeout" | "unknown">; close(): Promise<void> };

// One process handle: query its exact FILETIME before stop, then wait on that
// SAME handle. No PID reopen, process enumeration, signal, or termination.
const SERVER_OBSERVER = String.raw`param([uint32]$TargetPid, [string]$ExpectedBirth)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct OpenRigOwnedFileTime {
  public uint Low; public uint High;
  public string Decimal() { return (((ulong)High << 32) | Low).ToString(System.Globalization.CultureInfo.InvariantCulture); }
}
public static class OpenRigOwnedServerHandle {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out OpenRigOwnedFileTime creation, out OpenRigOwnedFileTime exit, out OpenRigOwnedFileTime kernel, out OpenRigOwnedFileTime user);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
function Emit-Status([string]$Value) {
  [Console]::Out.WriteLine(([ordered]@{status=$Value;pid=$TargetPid.ToString();birth=$ExpectedBirth} | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
$handle = [IntPtr]::Zero
$status = 'unknown'
try {
  $handle = [OpenRigOwnedServerHandle]::OpenProcess(0x00101000, $false, $TargetPid)
  if ($handle -eq [IntPtr]::Zero) { $status = 'access_unknown' }
  else {
    $creation=New-Object OpenRigOwnedFileTime; $exit=New-Object OpenRigOwnedFileTime
    $kernel=New-Object OpenRigOwnedFileTime; $user=New-Object OpenRigOwnedFileTime
    if (-not [OpenRigOwnedServerHandle]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) { $status = 'access_unknown' }
    elseif ($creation.Decimal() -cne $ExpectedBirth) { $status = 'identity_mismatch' }
    else {
      Emit-Status 'ready'
      # Retain the handle until the parent requests WAIT/RELEASE or closes its
      # stdin pipe. An independent idle expiry must not close it before stop.
      $command = [Console]::In.ReadLine()
      if ($command -ceq 'WAIT') {
        $result = [OpenRigOwnedServerHandle]::WaitForSingleObject($handle, 5000)
        if ($result -eq 0) { $status = 'exited' }
        elseif ($result -eq 258) { $status = 'timeout' }
        else { $status = 'unknown' }
      } else { $status = 'released' }
    }
  }
} catch { $status = 'unknown' }
finally { if ($handle -ne [IntPtr]::Zero -and -not [OpenRigOwnedServerHandle]::CloseHandle($handle)) { $status = 'unknown' } }
Emit-Status $status
`;

async function observeOriginalServer(identity: ServerIdentity, dir: string, powershell: string, environment: Record<string, string>): Promise<ServerObservation> {
  if (!/^[1-9]\d*$/.test(identity.pid) || !/^[1-9]\d*$/.test(identity.birth)
    || BigInt(identity.pid) > 4294967295n || BigInt(identity.birth) > 18446744073709551615n) throw new Error("Original server identity unavailable");
  const script = path.join(dir, `observe-server-${randomUUID()}.ps1`);
  // Inspectable source artifact only; the bound block is executed encoded below.
  writeFileSync(script, SERVER_OBSERVER, { flag: "wx", mode: 0o600 });
  // Literal decimal identity only; no execution-policy or machine setting change.
  const encoded = Buffer.from(`& {\n${SERVER_OBSERVER}\n} -TargetPid ${identity.pid} -ExpectedBirth '${identity.birth}'`, "utf16le").toString("base64");
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { cwd: path.dirname(dir), env: environment, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let status = "starting", closed = false, exitCode: number | null = null, input = "";
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  child.stdin.on("error", () => { status = "unknown"; notify(); });
  child.stderr.resume(); // Never serialize compiler/host error output or environment.
  child.on("error", () => { status = "unknown"; notify(); });
  child.on("close", code => { closed = true; exitCode = code; notify(); });
  child.stdout.on("data", (chunk: Buffer) => {
    if (input.length + chunk.length > 4096) { status = "unknown"; notify(); return; }
    input += chunk.toString("utf8");
    let newline: number;
    while ((newline = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, newline); input = input.slice(newline + 1);
      try {
        const value: unknown = JSON.parse(line);
        const message = value as { status?: unknown; pid?: unknown; birth?: unknown } | null;
        status = message && message.pid === identity.pid && message.birth === identity.birth
          && typeof message.status === "string" && ["ready", "identity_mismatch", "access_unknown", "exited", "timeout", "unknown", "released"].includes(message.status) ? message.status : "unknown";
      } catch { status = "unknown"; }
      notify();
    }
  });
  const waitUntil = (done: () => boolean, milliseconds: number) => new Promise<boolean>(resolve => {
    const finish = (ok: boolean) => { clearTimeout(timer); listeners.delete(check); resolve(ok); };
    const check = () => { if (done()) finish(true); };
    const timer = setTimeout(() => finish(false), milliseconds);
    listeners.add(check); check();
  });
  const close = async () => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end("RELEASE\n");
    if (!await waitUntil(() => closed, 5000) || exitCode !== 0) throw Object.assign(new Error("native_server_observer_close_unknown"), { code: "observer_close_unknown" });
  };
  if (!await waitUntil(() => status !== "starting" || closed, 5000) || status !== "ready" || closed) {
    const reason = status === "identity_mismatch" ? status : "access_unknown";
    try { await close(); } catch { /* Unknown helper disposition also preserves the fixture. */ }
    throw Object.assign(new Error(`native_server_${reason}`), { code: reason });
  }
  return { close, assertRetained: () => {
    if (closed || status !== "ready") throw Object.assign(new Error("Original server observation handle unavailable"), { code: "access_unknown" });
  }, waitForExit: async () => {
    if (closed || status !== "ready") return "unknown";
    child.stdin.write("WAIT\n");
    if (!await waitUntil(() => status !== "ready" || closed, 10000)) return "unknown";
    return status === "exited" || status === "timeout" ? status : "unknown";
  } };
}

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
  serverObservations?: Array<{ pane: string; state: string }>;
};

function errorDiagnostic(error: unknown) {
  const codes = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "ENOENT", "guard_target_changed", "guard_target_unknown", "kill_unverified", "native_create_unknown",
    "identity_mismatch", "access_unknown", "server_exit_timeout", "server_exit_unknown", "observer_close_unknown"]);
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
      ownedReceipts: state.ownedReceipts.slice(0, 4).map(receipt), acknowledgedStopReceipts: state.acknowledgedStopReceipts.slice(0, 4).map(receipt),
      serverObservations: state.serverObservations?.slice(0, 4) } });
  // Vitest's JSON reporter omits AggregateError.errors. Keep both originals,
  // but put only allowlisted synthetic diagnostics in its serialized message.
  throw new AggregateError(errors, `Native fixture failed; ${diagnostic}`.slice(0, 8192));
}

export function createWindowsPsmuxNativeFixture(options: {
  binary: string;
  environment?: NodeJS.ProcessEnv;
  execute?: NativeFixtureExec;
  observeServer?: (identity: ServerIdentity) => Promise<ServerObservation>;
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
  const observations = new Map<string, string>();
  const pending = new Set<string>();
  const stop = async (pane: string) => {
    const receipt = owned.get(pane);
    if (!receipt) throw new Error("Native fixture has no original creation receipt for this pane");
    if (observations.get(pane) !== "created") throw new Error("Native fixture will not repeat an original stop or reopen its process identity");
    observations.set(pane, "observing");
    const epoch = /^psmux:v2:[A-Za-z0-9_-]+:%\d+:\d+:(\d+):(\d+)$/.exec(receipt.pane);
    if (!epoch) { observations.set(pane, "unknown"); throw new Error("Original server identity unavailable"); }
    let handle: ServerObservation | undefined;
    const failures: unknown[] = [];
    try {
      const identity = { pid: epoch[1]!, birth: epoch[2]! };
      handle = await (options.observeServer?.(identity) ?? observeOriginalServer(identity, dir, powershell, environment));
      handle.assertRetained?.();
      observations.set(pane, "stop_dispatched");
      const result = await adapter.stopCreatedSession(receipt, "native-fixture");
      if (!result.ok) throw Object.assign(new Error(`${result.code}: ${result.message}`), { code: result.code });
      acknowledgedStops.push(receipt);
      observations.set(pane, "logical_stop_acknowledged");
      writeFileSync(path.join(dir, `creation-${receipt.attempt}.stop-ack.json`), JSON.stringify({ ...receipt, logicalStopAcknowledged: true, serverExit: "unverified" }), { flag: "wx", mode: 0o600 });
      const exit = await handle.waitForExit();
      if (exit !== "exited") throw Object.assign(new Error(`Original server exit ${exit}; fixture preserved`), { code: `server_exit_${exit}` });
    } catch (error) { failures.push(error); }
    try { await handle?.close(); } catch (error) { failures.push(error); }
    if (failures.length) {
      observations.set(pane, "unknown");
      throw failures.length === 1 ? failures[0] : new AggregateError(failures, "Original server observation and observer close failed");
    }
    writeFileSync(path.join(dir, `creation-${receipt.attempt}.server-exit.json`), JSON.stringify({ ...receipt, serverExit: "exited", descendants: "unverified" }), { flag: "wx", mode: 0o600 });
    observations.set(pane, "server_exited"); // No child/ConPTY exit claim.
  };
  return {
    dir, dataDir, configFile, environment, sessionEnv, invoke, adapter, stop,
    diagnostics: (): FixtureDiagnostics => ({ root: dataDir, pendingAttempts: [...pending], ownedReceipts: [...owned.values()], acknowledgedStopReceipts: [...acknowledgedStops],
      serverObservations: [...observations].map(([pane, state]) => ({ pane, state })) }),
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
      observations.set(receipt.pane, "created");
      writeFileSync(`${ledger}.receipt.json`, JSON.stringify({ version: 1, ...receipt }), { flag: "wx", mode: 0o600 });
      pending.delete(context.attempt);
      return { id: receipt.pane };
    },
    async close() {
      const failures: string[] = [];
      for (const pane of owned.keys()) {
        if (observations.get(pane) === "server_exited") continue;
        if (observations.get(pane) !== "created") { failures.push("Original server exit remains unknown; no second stop attempted"); continue; }
        try { await stop(pane); } catch (error) { failures.push(String(error)); }
      }
      if (pending.size || failures.length) {
        throw new Error(`Native fixture cleanup unverified; preserved ${dir}; pending attempts: ${[...pending].join(", ")}; ${failures.join("; ")}`);
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      owned.clear(); // Retire ownership only after strict directory deletion.
    },
    removeFiles: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
