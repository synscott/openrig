import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigStore } from "../../cli/src/config-store.js";
import { configCommand } from "../../cli/src/commands/config.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { configRoutes } from "../src/routes/config.js";

const rigId = `01${"A".repeat(24)}`;
const otherRigId = `01${"B".repeat(24)}`;
const key = `dashboard.rig_labels.${rigId}`;
let root: string;
let configPath: string;

function app(): Hono {
  const api = new Hono();
  const store = new SettingsStore(configPath);
  api.use("*", async (c, next) => { c.set("settingsStore" as never, store as never); await next(); });
  api.route("/api/config", configRoutes());
  return api;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dashboard-labels-"));
  configPath = join(root, "config.json");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("persistent rig display labels through config API and CLI", () => {
  it("persists a stable-ID label across store reload and resets it without changing other settings", async () => {
    const cli = new ConfigStore(configPath);
    cli.set("daemon.port", "7440");
    const response = await app().request(`/api/config/${key}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "Development" }),
    });
    expect(response.status).toBe(200);
    expect(new ConfigStore(configPath).get(key)).toBe("Development");
    const read = await app().request(`/api/config/${key}`);
    expect(await read.json()).toEqual({ value: "Development", source: "file", defaultValue: "" });
    cli.set(`dashboard.rig_labels.${otherRigId}`, "CI");
    expect((await app().request(`/api/config/${key}`, { method: "DELETE" })).status).toBe(200);
    expect(new ConfigStore(configPath).get(key)).toBe("");
    expect(new ConfigStore(configPath).get(`dashboard.rig_labels.${otherRigId}`)).toBe("CI");
    expect(new ConfigStore(configPath).get("daemon.port")).toBe(7440);
  });

  it("uses the existing config set/get/reset commands for labels", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const invoke = (...args: string[]) => configCommand(configPath, { probeDaemonRunning: async () => false }).parseAsync(["node", "rig", ...args]);
    await invoke("set", key, "Build Ω");
    expect(error).not.toHaveBeenCalled();
    await invoke("get", key, "--json");
    expect(output).toHaveBeenLastCalledWith(JSON.stringify({ value: "Build Ω", source: "file", defaultValue: "" }, null, 2));
    await invoke("reset", key);
    expect(new ConfigStore(configPath).get(key)).toBe("");
  });

  it.each(["", "  ", "bad\nlabel", "bad\u001b[2J", "bad\u202elabel", "x".repeat(65)])("rejects unsafe or empty labels without overwriting a valid label: %j", async (value) => {
    const cli = new ConfigStore(configPath);
    cli.set(key, "Good");
    const before = readFileSync(configPath, "utf8");
    const response = await app().request(`/api/config/${key}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
    });
    expect(response.status).toBe(400);
    expect(() => cli.set(key, value)).toThrow();
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("rejects canonical names, prototype segments, and unrelated dynamic keys", async () => {
    for (const invalid of ["dashboard.rig_labels.some-rig", "dashboard.rig_labels.__proto__", `dashboard.rig_labels.${rigId}.other`]) {
      expect((await app().request(`/api/config/${invalid}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "Label" }),
      })).status).toBe(400);
      expect(() => new ConfigStore(configPath).set(invalid, "Label")).toThrow();
    }
  });
  it("ignores malformed stored labels independently of valid siblings", () => {
    writeFileSync(configPath, JSON.stringify({ dashboard: { rigLabels: { [rigId]: "bad\nlabel", [otherRigId]: "CI" } } }));
    const read = new SettingsStore(configPath).readRigDisplayLabels();
    expect([...read.labels]).toEqual([[otherRigId, "CI"]]);
    expect(read.invalid).toBe(true);
    expect(new ConfigStore(configPath).get(key)).toBe("");
  });
  it("reports malformed configuration as a config error", async () => {
    writeFileSync(configPath, "{ broken JSON");
    const response = await app().request(`/api/config/${key}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  });
});
