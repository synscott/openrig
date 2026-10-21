import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWindowsPsmuxNativeFixture, withWindowsPsmuxNativeFixture, type NativeFixtureExec } from "./helpers/windows-psmux-native-fixture.js";

type CreationRequest = { attempt: string; name: string; env: Record<string, string> };
const exitedServer = async () => ({ waitForExit: async () => "exited" as const, close: async () => {} });
function created(request: CreationRequest) {
  return JSON.stringify({ version: 1, status: "created", attempt: request.attempt, name: request.name, sid: "7", pid: "100", birth: "123456", pane: "%1" }) + "\n";
}

describe("native psmux fixture isolation", () => {
  it("holds the original full-precision server identity before one stop and waits before deletion", async () => {
    const events: string[] = [];
    const fixture = createWindowsPsmuxNativeFixture({ binary: "unused",
      observeServer: async identity => {
        expect(identity).toEqual({ pid: "100", birth: "123456" });
        events.push("open");
        return { waitForExit: async () => { events.push("wait"); return "exited"; }, close: async () => { events.push("release"); } };
      },
      execute: async (_binary, command) => {
        if (command[0] === "checked-create") return { stdout: created(JSON.parse(readFileSync(command[2]!, "utf8"))) };
        events.push("stop");
        return { stdout: "CHECKED-STOP COMPLETE\n" };
      },
    });
    try {
      const pane = await fixture.createSession("owned");
      await fixture.stop(pane.id);
      expect(events).toEqual(["open", "stop", "wait", "release"]);
      expect(fixture.diagnostics().ownedReceipts).toHaveLength(1);
      expect(existsSync(fixture.dir)).toBe(true);
      await fixture.close();
      expect(events).toEqual(["open", "stop", "wait", "release"]);
      expect(existsSync(fixture.dir)).toBe(false);
    } finally { fixture.removeFiles(); }
  });

  it("preserves receipt and directory on identity/access/exit uncertainty without a second stop", async () => {
    for (const outcome of ["identity_mismatch", "access_unknown", "handle_lost", "timeout", "unknown", "observer_close_unknown"] as const) {
      let stops = 0;
      const fixture = createWindowsPsmuxNativeFixture({ binary: "unused",
        observeServer: async () => {
          if (outcome === "identity_mismatch" || outcome === "access_unknown") throw Object.assign(new Error(outcome), { code: outcome });
          return { assertRetained: () => { if (outcome === "handle_lost") throw new Error("handle_lost"); },
            waitForExit: async () => outcome === "observer_close_unknown" || outcome === "handle_lost" ? "exited" : outcome,
            close: async () => { if (outcome === "observer_close_unknown") throw new Error("observer_close_unknown"); } };
        },
        execute: async (_binary, command) => {
          if (command[0] === "checked-create") return { stdout: created(JSON.parse(readFileSync(command[2]!, "utf8"))) };
          stops += 1; return { stdout: "CHECKED-STOP COMPLETE\n" };
        },
      });
      try {
        const pane = await fixture.createSession("owned");
        await expect(fixture.stop(pane.id)).rejects.toThrow();
        await expect(fixture.close()).rejects.toThrow("cleanup unverified; preserved");
        expect(stops).toBe(outcome === "identity_mismatch" || outcome === "access_unknown" || outcome === "handle_lost" ? 0 : 1);
        expect(fixture.diagnostics().ownedReceipts).toHaveLength(1);
        expect(existsSync(fixture.dir)).toBe(true);
        expect(readdirSync(fixture.dir).filter(file => file.endsWith(".receipt.json"))).toHaveLength(1);
      } finally { fixture.removeFiles(); }
    }
  });

  it("passes the original birth FILETIME above JavaScript's safe integer range without rounding", async () => {
    const birth = "134368656404675219";
    const fixture = createWindowsPsmuxNativeFixture({ binary: "unused",
      observeServer: async identity => { expect(identity).toEqual({ pid: "100", birth }); return exitedServer(); },
      execute: async (_binary, command) => {
        if (command[0] === "checked-create") {
          const request: CreationRequest = JSON.parse(readFileSync(command[2]!, "utf8"));
          return { stdout: JSON.stringify({ ...JSON.parse(created(request)), birth }) + "\n" };
        }
        expect(command).toEqual(["kill-session", "-t", "$7", "-G", `100:${birth}`]);
        return { stdout: "CHECKED-STOP COMPLETE\n" };
      },
    });
    try {
      const pane = await fixture.createSession("owned");
      await fixture.stop(pane.id);
      expect(fixture.diagnostics().acknowledgedStopReceipts[0]!.pane.endsWith(`:${birth}`)).toBe(true);
      await fixture.close();
    } finally { fixture.removeFiles(); }
  });

  it("distinguishes missing original route from actor rejection and generic transport failure", async () => {
    for (const [message, code] of [["checked stop route unavailable", "kill_unverified"], ["checked stop identity rejected", "guard_target_changed"], ["transport failed", "kill_unverified"]]) {
      const fixture = createWindowsPsmuxNativeFixture({ binary: "unused", execute: async (_binary, command) => {
        expect(command).toEqual(["kill-session", "-t", "$0", "-G", "100:123456"]);
        throw new Error(message);
      } });
      try {
        expect(await fixture.adapter.killSession("psmux:v2:b3duZWQ:%1:0:100:123456"))
          .toEqual({ ok: false, code, message });
      } finally { fixture.removeFiles(); }
    }
  });
  it("serializes bounded refusal and cleanup diagnostics while preserving both original errors", async () => {
    const secret = "DO-NOT-REPORT-ENVIRONMENT-CONTENT";
    const assertion = Object.assign(new Error(secret), {
      name: "AssertionError", actual: { ok: false, code: "kill_unverified", message: `checked stop route unavailable ${secret}` },
      expected: { ok: false, code: "guard_target_changed" },
    });
    const cleanup = Object.assign(new Error(secret), { code: "EPERM" });
    const fixture = {
      close: async () => { throw cleanup; },
      diagnostics: () => ({ root: "fixture-root", pendingAttempts: ["pending-attempt"], ownedReceipts: [], acknowledgedStopReceipts: [] }),
    };
    const result = await withWindowsPsmuxNativeFixture(fixture, async () => { throw assertion; }).catch(error => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toEqual([assertion, cleanup]);
    expect(result.message).toContain("kill_unverified");
    expect(result.message).toContain("guard_target_changed");
    expect(result.message).toContain("route_unavailable");
    expect(result.message).toContain("EPERM");
    expect(result.message).toContain("pending-attempt");
    expect(result.message).not.toContain(secret);
    expect(result.message.length).toBeLessThanOrEqual(8192);
  });

  it("keeps body-only, cleanup-only and falsy failures failing at the lifetime boundary", async () => {
    const body = new Error("body");
    const cleanup = Object.assign(new Error("cleanup"), { code: "EPERM" });
    for (const [bodyFails, bodyError, cleanupError] of [[true, body, undefined], [false, undefined, cleanup], [true, undefined, undefined]] as const) {
      const fixture = {
        close: async () => { if (cleanupError) throw cleanupError; },
        diagnostics: () => ({ root: "fixture-root", pendingAttempts: [], ownedReceipts: [], acknowledgedStopReceipts: [] }),
      };
      const result = await withWindowsPsmuxNativeFixture(fixture, async () => { if (bodyFails) throw bodyError; }).catch(error => error);
      expect(result).toBeInstanceOf(AggregateError);
      expect(result.errors).toEqual([bodyFails ? bodyError : cleanupError]);
      expect(result.message).toContain(bodyFails ? '"body"' : '"cleanup"');
    }
  });
  it("creates through the current checked-create protocol", async () => {
    const parentRoot = process.env.PSMUX_DATA_DIR;
    const calls: Parameters<NativeFixtureExec>[] = [];
    let fixture: ReturnType<typeof createWindowsPsmuxNativeFixture>;
    fixture = createWindowsPsmuxNativeFixture({ binary: "unused", observeServer: exitedServer, environment: { PSMUX_DATA_DIR: "owner-root", USERPROFILE: "owner-profile" }, execute: async (...args) => {
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
      expect(fixture.diagnostics().ownedReceipts).toHaveLength(1);
      expect(fixture.diagnostics().acknowledgedStopReceipts).toHaveLength(1);
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
    const fixture = createWindowsPsmuxNativeFixture({ binary: "unused", observeServer: exitedServer, execute: async (_binary, command) => {
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
      expect(calls.map(command => command[0])).toEqual(["checked-create", "checked-create", "kill-session"]);
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
