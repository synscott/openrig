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
  const pending = new Set<string>();
  const stop = async (pane: string) => {
    const receipt = owned.get(pane);
    if (!receipt) throw new Error("Native fixture has no original creation receipt for this pane");
    const result = await adapter.stopCreatedSession(receipt, "native-fixture");
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    owned.delete(pane);
  };
  return {
    dir, dataDir, configFile, environment, sessionEnv, invoke, adapter, stop,
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
