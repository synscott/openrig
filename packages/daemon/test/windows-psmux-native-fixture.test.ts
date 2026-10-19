import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createWindowsPsmuxNativeFixture, type NativeFixtureExec } from "./helpers/windows-psmux-native-fixture.js";

describe("native psmux fixture isolation", () => {
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
