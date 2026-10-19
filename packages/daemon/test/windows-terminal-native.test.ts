import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { renderWindowsLaunch } from "../src/adapters/windows-launch.js";
import { pathToFileURL } from "node:url";
import { createWindowsPsmuxNativeFixture, withWindowsPsmuxNativeFixture, SERVER_OBSERVER_BUDGET_MS } from "./helpers/windows-psmux-native-fixture.js";

const enabled = process.platform === "win32" && !!process.env.OPENRIG_TEST_PSMUX;
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
// Protocol budget fit: checked-create allows 35s; each other backend command
// allows 5s. Include serial body commands, every potentially owned cleanup,
// marker polling + failure capture, and 10s filesystem/harness reserve.
// These are outer deadlines, not retries or relaxed delivery assertions.
const CREATE_MS = 35_000;
const COMMAND_MS = 5_000;
const MARKER_5S_MS = 5_000 + 50 + COMMAND_MS;
const HARNESS_RESERVE_MS = 10_000;
const MULTILINE_MS = CREATE_MS + (5 + 1) * COMMAND_MS + 2 * MARKER_5S_MS + HARNESS_RESERVE_MS + SERVER_OBSERVER_BUDGET_MS;
const ARGV_MS = 2 * CREATE_MS + (7 + 2) * COMMAND_MS + (12_000 + 50 + COMMAND_MS) + HARNESS_RESERVE_MS + 3 * SERVER_OBSERVER_BUDGET_MS;
const STALE_EPOCH_MS = 3 * CREATE_MS + (12 + 3) * COMMAND_MS + 2 * MARKER_5S_MS + HARNESS_RESERVE_MS + 4 * SERVER_OBSERVER_BUDGET_MS;

function nativeFixture() {
  const binary = process.env.OPENRIG_TEST_PSMUX!;
  if (!path.isAbsolute(binary)) throw new Error("OPENRIG_TEST_PSMUX must name an absolute qualified binary path");
  return createWindowsPsmuxNativeFixture({ binary });
}

async function withNativeFixture(run: (fixture: ReturnType<typeof nativeFixture>) => Promise<void>) {
  return withWindowsPsmuxNativeFixture(nativeFixture(), run);
}

async function waitForFile(file: string, adapter: TmuxAdapter, target: string, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return readFileSync(file, "utf8"); } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  const screen = await adapter.capturePaneScreen(target);
  throw new Error(`receiver did not produce ${path.basename(file)}; fixture screen: ${screen?.slice(-1200) ?? "unavailable"}`);
}

describe.skipIf(!enabled)("native psmux PowerShell staging", () => {
  it("delivers a multiline block as one runner submission", async () => {
    await withNativeFixture(async fixture => {
      const { dir, adapter, sessionEnv } = fixture;
      const session = `openrig-input-${randomUUID()}`;
      const output = path.join(dir, "result.json"), ready = path.join(dir, "ready");
      const script = path.join(dir, "receiver.mjs");
      const runner = pathToFileURL(path.resolve(import.meta.dirname, "../dist/adapters/pi-runner.js")).href;
      writeFileSync(script, `import fs from 'node:fs'; import {createRunnerInput} from ${JSON.stringify(runner)};
        createRunnerInput(process.stdin, process.stdout, block => { fs.writeFileSync(${JSON.stringify(output + ".tmp")}, JSON.stringify(block)); fs.renameSync(${JSON.stringify(output + ".tmp")}, ${JSON.stringify(output)}); process.exit(0); });
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`);
      const pane = await fixture.createSession(session);
      expect(await adapter.sendShellCommand(pane.id, renderWindowsLaunch([process.execPath, script].map(quote).join(" "), sessionEnv))).toEqual({ ok: true });
      await waitForFile(ready, adapter, pane.id);
      const message = "first line\nsecond line; 中文";
      expect(await adapter.sendText(pane.id, message)).toEqual({ ok: true });
      expect(await adapter.sendKeys(pane.id, ["Enter"])).toEqual({ ok: true });
      expect(JSON.parse(await waitForFile(output, adapter, pane.id))).toBe(message);
    });
  }, MULTILINE_MS);

  it("delivers exact native argv and environment through a real pane", async () => {
    await withNativeFixture(async fixture => {
      const { dir, adapter, sessionEnv } = fixture;
      const session = `openrig-test-${randomUUID()}`;
      const decoy = `${session}-other`;
      const output = path.join(dir, "result.json");
      const script = path.join(dir, "echo args.js");
      writeFileSync(script, `const fs = require('fs'); const output = process.argv[2];
        fs.writeFileSync(output + '.tmp', JSON.stringify({args: process.argv.slice(3), marker: process.env.OPENRIG_TEST_MARKER,
          dataDir: process.env.PSMUX_DATA_DIR, configFile: process.env.PSMUX_CONFIG_FILE, noWarm: process.env.PSMUX_NO_WARM, userProfile: process.env.USERPROFILE}));
        fs.renameSync(output + '.tmp', output);`);
      const pane = await fixture.createSession(session);
      const other = await fixture.createSession(decoy);
      expect(other.id).not.toBe(pane.id);
      const args = ["space word", "a'b", "中文;$HOME", "", 'embedded"quote', "space trailing\\", "trailing\\"];
      const command = [process.execPath, script, output, ...args].map(quote).join(" ");
      expect(await adapter.sendShellCommand(pane.id, renderWindowsLaunch(command, { ...sessionEnv, OPENRIG_TEST_MARKER: "native-ok" }))).toEqual({ ok: true });
      expect(JSON.parse(await waitForFile(output, adapter, pane.id, 12_000))).toEqual({
        args, marker: "native-ok", dataDir: fixture.dataDir, configFile: fixture.configFile,
        noWarm: "1", userProfile: process.env.USERPROFILE,
      });
      await fixture.stop(pane.id);
      // A silent exit does not establish absence on pinned psmux 3.4.
      expect(await adapter.probeSession(session)).toEqual({
        state: "transport_unavailable",
        cause: "psmux has-session returned silent exit 1; session presence is unknown.",
      });
      expect((await adapter.listPanes(decoy))[0]?.id).toBe(other.id);
      expect((await adapter.probeSession(decoy)).state).toBe("present");
    });
  }, ARGV_MS);

  it("rejects a stopped server epoch after same-name replacement while both live sessions remain responsive", async () => {
    await withNativeFixture(async fixture => {
      const { dir, adapter, sessionEnv } = fixture;
      const session = `openrig-epoch-${randomUUID()}`;
      const siblingName = `${session}-sibling`;
      const original = await fixture.createSession(session);
      const sibling = await fixture.createSession(siblingName);
      await fixture.stop(original.id);
      const replacement = await fixture.createSession(session);
      expect(replacement.id).not.toBe(original.id);

      expect(await adapter.killSession(original.id)).toMatchObject({
        ok: false,
        code: "kill_unverified",
        // The original SID route was removed. This is a specific pre-actor
        // refusal, not an observation of the replacement actor's epoch guard.
        message: expect.stringContaining("checked stop route unavailable"),
      });
      expect((await adapter.listPanes(session))[0]?.id).toBe(replacement.id);
      expect((await adapter.listPanes(siblingName))[0]?.id).toBe(sibling.id);

      const script = path.join(dir, "consume-marker.js");
      writeFileSync(script, `const fs = require('fs'); fs.writeFileSync(process.argv[2] + '.tmp', process.argv[3]); fs.renameSync(process.argv[2] + '.tmp', process.argv[2]);`);
      for (const [pane, marker] of [[replacement, "replacement-consumed"], [sibling, "sibling-consumed"]] as const) {
        const output = path.join(dir, `${marker}.txt`);
        expect(await adapter.sendShellCommand(pane.id, renderWindowsLaunch([process.execPath, script, output, marker].map(quote).join(" "), sessionEnv))).toEqual({ ok: true });
        expect(await waitForFile(output, adapter, pane.id)).toBe(marker);
      }
      expect((await adapter.listPanes(session))[0]?.id).toBe(replacement.id);
      expect((await adapter.listPanes(siblingName))[0]?.id).toBe(sibling.id);
    });
  }, STALE_EPOCH_MS);
});
