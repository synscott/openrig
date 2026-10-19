import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
  const dataDir = path.join(dir, "psmux");
  const configFile = path.join(dir, "fixture.conf");
  mkdirSync(dataDir);
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
  const invoke = async (argv: string[]) => (await execute(options.binary, argv.slice(1), {
    cwd: dir,
    env: environment,
    windowsHide: true,
    shell: false,
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
  })).stdout;
  return {
    dir, dataDir, configFile, environment, sessionEnv, invoke,
    removeFiles: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
}
