import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWindowsPsmuxNativeFixture, type NativeFixtureExec } from "./helpers/windows-psmux-native-fixture.js";

type CreationRequest = { attempt: string; name: string; env: Record<string, string> };
function created(request: CreationRequest) {
  return JSON.stringify({ version: 1, status: "created", attempt: request.attempt, name: request.name, sid: "7", pid: "100", birth: "123456", pane: "%1" }) + "\n";
}

describe("native psmux fixture isolation", () => {
  it("creates through the current checked-create protocol", async () => {
    const parentRoot = process.env.PSMUX_DATA_DIR;
    const calls: Parameters<NativeFixtureExec>[] = [];
    let fixture: ReturnType<typeof createWindowsPsmuxNativeFixture>;
    fixture = createWindowsPsmuxNativeFixture({ binary: "unused", environment: { PSMUX_DATA_DIR: "owner-root", USERPROFILE: "owner-profile" }, execute: async (...args) => {
      calls.push(args);
      const [, command, options] = args;
      expect(options.env.PSMUX_DATA_DIR).toBe(fixture.dataDir);
      expect(options.env.PSMUX_CONFIG_FILE).toBe(fixture.configFile);
      expect(options.env.PSMUX_NO_WARM).toBe("1");
      if (command[0] === "checked-create") {
        const request: CreationRequest = JSON.parse(readFileSync(command[2]!, "utf8"));
        const ledger = JSON.parse(readFileSync(path.join(fixture.dir, `creation-${request.attempt}.attempt.json`), "utf8"));
        expect(ledger).toEqual({ version: 1, attempt: request.attempt, name: "owned", root: fixture.dataDir });
        expect(Object.keys(request.env).some(key => /^(?:psmux|tmux)(?:_|$)/i.test(key))).toBe(false);
        expect(options.timeout).toBe(35000);
        return { stdout: created(request) };
      }
      expect(command).toEqual(["kill-session", "-t", "$7", "-G", "100:123456"]);
      return { stdout: "CHECKED-STOP COMPLETE\n" };
    } });
    try {
      const pane = await fixture.createSession("owned");
      expect(pane.id).toBe("psmux:v2:b3duZWQ:%1:7:100:123456");
      const receiptFile = readdirSync(fixture.dir).find(file => file.endsWith(".receipt.json"))!;
      expect(JSON.parse(readFileSync(path.join(fixture.dir, receiptFile), "utf8"))).toMatchObject({ version: 1, root: fixture.dataDir, name: "owned", pane: pane.id });
      await fixture.stop(pane.id);
      expect(calls.map(([, command]) => command[0])).toEqual(["checked-create", "kill-session"]);
      expect(process.env.PSMUX_DATA_DIR).toBe(parentRoot);
      await fixture.close();
      expect(existsSync(fixture.dir)).toBe(false);
    } finally { fixture.removeFiles(); }
  });

  it("honors the checked-create deadline and refuses a different root before dispatch", async () => {
    const calls: Parameters<NativeFixtureExec>[] = [];
    const fixture = createWindowsPsmuxNativeFixture({ binary: "unused", execute: async (...args) => { calls.push(args); return { stdout: "ok" }; } });
    try {
      await fixture.invoke(["tmux", "checked-create", "--file", "owned.json"], { timeoutMs: 35000, psmuxDataDir: fixture.dataDir });
      expect(calls[0]![2].timeout).toBe(35000);
      await expect(fixture.invoke(["tmux", "checked-create"], { psmuxDataDir: "other-root" })).rejects.toThrow("root");
      expect(calls).toHaveLength(1);
    } finally { fixture.removeFiles(); }
  });

  it("preserves an uncertain attempt without name lookup or cleanup", async () => {
    const calls: string[][] = [];
    const fixture = createWindowsPsmuxNativeFixture({ binary: "unused", execute: async (_binary, command) => { calls.push(command); return { stdout: "unverified" }; } });
    try {
      await expect(fixture.createSession("uncertain")).rejects.toThrow("native_create_unknown");
      await expect(fixture.close()).rejects.toThrow("cleanup unverified; preserved");
      expect(existsSync(fixture.dir)).toBe(true);
      expect(readdirSync(fixture.dir).filter(file => file.endsWith(".attempt.json"))).toHaveLength(1);
      expect(calls.map(command => command[0])).toEqual(["checked-create"]);
    } finally { fixture.removeFiles(); } // Inert transport proves no process was created.
  });

  it("does not stop a collision winner and preserves failed checked-stop evidence", async () => {
    let collision = true;
    const calls: string[][] = [];
    const fixture = createWindowsPsmuxNativeFixture({ binary: "unused", execute: async (_binary, command) => {
      calls.push(command);
      if (command[0] === "checked-create") {
        const request: CreationRequest = JSON.parse(readFileSync(command[2]!, "utf8"));
        if (collision) throw Object.assign(new Error("collision"), { code: 2, stdout: JSON.stringify({ version: 1, status: "collision", attempt: request.attempt, name: request.name }) + "\n" });
        return { stdout: created(request) };
      }
      expect(command).toEqual(["kill-session", "-t", "$7", "-G", "100:123456"]);
      return { stdout: "not verified" };
    } });
    try {
      await expect(fixture.createSession("collision")).rejects.toThrow("duplicate_session");
      expect(calls.map(command => command[0])).toEqual(["checked-create"]);
      collision = false;
      const pane = await fixture.createSession("owned");
      await expect(fixture.stop(pane.id)).rejects.toThrow("kill_unverified");
      await expect(fixture.close()).rejects.toThrow("cleanup unverified; preserved");
      expect(existsSync(fixture.dir)).toBe(true);
      expect(readdirSync(fixture.dir).filter(file => file.endsWith(".receipt.json"))).toHaveLength(1);
      expect(calls.map(command => command[0])).toEqual(["checked-create", "checked-create", "kill-session", "kill-session"]);
    } finally { fixture.removeFiles(); } // Only injected processes existed.
  });
  it("replaces inherited registry/config selectors for every client without replacing the OS profile", async () => {
    const parent = {
      USERPROFILE: "C:\\Users\\owner",
      SystemRoot: "C:\\Windows",
      Path: "C:\\Windows\\System32",
      PSMUX_DATA_DIR: "C:\\Users\\owner\\.psmux",
      psmux_data_dir: "C:\\inherited-registry",
      Psmux_Config_File: "C:\\owner.conf",
      psmux_no_warm: "0",
      PSMUX_OTHER_SELECTOR: "owner",
      TMUX: "owner-socket",
      tmux_pane: "%99",
    };
    const calls: Parameters<NativeFixtureExec>[] = [];
    const fixture = createWindowsPsmuxNativeFixture({
      binary: "C:\\private\\psmux.exe",
      environment: parent,
      execute: async (...args) => { calls.push(args); return { stdout: "fixture-only" }; },
    });
    try {
      expect(fixture.environment.PSMUX_DATA_DIR).toBe(fixture.dataDir);
      expect(fixture.environment.PSMUX_CONFIG_FILE).toBe(fixture.configFile);
      expect(fixture.environment.PSMUX_NO_WARM).toBe("1");
      expect(fixture.sessionEnv).toEqual({
        PSMUX_DATA_DIR: fixture.dataDir,
        PSMUX_CONFIG_FILE: fixture.configFile,
        PSMUX_NO_WARM: "1",
      });
      expect(Object.keys(fixture.environment).filter(key => /^(?:psmux|tmux)(?:_|$)/i.test(key)).sort())
        .toEqual(["PSMUX_CONFIG_FILE", "PSMUX_DATA_DIR", "PSMUX_NO_WARM"]);
      expect(fixture.environment.USERPROFILE).toBe("C:\\Users\\owner");
      expect(fixture.environment.SystemRoot).toBe("C:\\Windows");
      // The vendor's implicit PowerShell init manually sources profiles even
      // though it adds its own -NoProfile. Only this explicit shell argument
      // selects build_psrl_init_noprofile.
      expect(readFileSync(fixture.configFile, "utf8"))
        .toBe(`set -g default-shell '"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile'\n`);
      expect(readdirSync(fixture.dataDir)).toEqual([]);
      expect(await fixture.invoke(["tmux", "new-session", "-s", "same-name"])).toBe("fixture-only");
      expect(await fixture.invoke(["tmux", "list-panes", "-G", "-t", "=same-name:"])).toBe("fixture-only");
      expect(calls).toHaveLength(2);
      for (const [binary, , options] of calls) {
        expect(binary).toBe("C:\\private\\psmux.exe");
        expect(options.env.PSMUX_DATA_DIR).toBe(fixture.dataDir);
        expect(options.env.PSMUX_CONFIG_FILE).toBe(fixture.configFile);
        expect(options.env.PSMUX_NO_WARM).toBe("1");
        expect(options.env.USERPROFILE).toBe("C:\\Users\\owner");
        expect(options).toMatchObject({ cwd: fixture.dir, shell: false, timeout: 5_000 });
      }
      expect(parent.psmux_data_dir).toBe("C:\\inherited-registry");
      expect(parent.PSMUX_DATA_DIR).toBe("C:\\Users\\owner\\.psmux");
    } finally { fixture.removeFiles(); }
  });

  it("allocates separate registries and configs even with the same inherited selectors", () => {
    const options = { binary: "unused", environment: { PSMUX_DATA_DIR: "owner-registry", USERPROFILE: "owner-profile" } };
    const first = createWindowsPsmuxNativeFixture(options);
    const second = createWindowsPsmuxNativeFixture(options);
    try {
      expect(first.dir).not.toBe(second.dir);
      expect(first.dataDir).not.toBe(second.dataDir);
      expect(first.configFile).not.toBe(second.configFile);
      first.removeFiles();
      expect(readFileSync(second.configFile, "utf8"))
        .toBe(`set -g default-shell '"C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile'\n`);
      expect(readdirSync(second.dataDir)).toEqual([]);
      expect(second.environment.USERPROFILE).toBe("owner-profile");
    } finally {
      first.removeFiles();
      second.removeFiles();
    }
  });

  it("quotes the explicit no-profile shell under a case-insensitive SystemRoot with spaces", () => {
    const fixture = createWindowsPsmuxNativeFixture({
      binary: "unused", environment: { systemroot: "D:\\Windows Root", USERPROFILE: "owner-profile" },
    });
    try {
      expect(readFileSync(fixture.configFile, "utf8"))
        .toBe(`set -g default-shell '"D:/Windows Root/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile'\n`);
      expect(fixture.environment.USERPROFILE).toBe("owner-profile");
    } finally { fixture.removeFiles(); }
    for (const systemRoot of ["relative", "C:\\Windows'", 'C:\\Windows"', "C:\\Windows\nset -g other value"]) {
      expect(() => createWindowsPsmuxNativeFixture({ binary: "unused", environment: { SystemRoot: systemRoot } }))
        .toThrow("absolute, config-safe SystemRoot");
    }
  });
});
