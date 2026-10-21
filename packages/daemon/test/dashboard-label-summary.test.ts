import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../cli/src/config-store.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import { createFullTestDb } from "./helpers/test-app.js";

describe("rig summary cosmetic labels", () => {
  it("reloads config by stable ID while preserving canonical identity and lifecycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "dashboard-summary-"));
    const configPath = join(root, "config.json");
    const db = createFullTestDb();
    try {
      const repo = new RigRepository(db);
      const rig = repo.createRig("canonical-build");
      const settings = new SettingsStore(configPath);
      const api = new Hono();
      api.use("*", async (c, next) => {
        c.set("rigRepo" as never, repo as never);
        c.set("settingsStore" as never, settings as never);
        await next();
      });
      api.route("/api/rigs", rigsRoutes);
      const before = await (await api.request("/api/rigs/summary")).json();
      new ConfigStore(configPath).set(`dashboard.rig_labels.${rig.id}`, "Build Ω");
      const response = await api.request("/api/rigs/summary");
      expect(response.status).toBe(200);
      const after = await response.json();
      expect(after).toEqual([{ ...before[0], displayLabel: "Build Ω" }]);
      expect(after[0].id).toBe(rig.id);
      expect(after[0].name).toBe("canonical-build");
      expect(repo.getRig(rig.id)?.rig.name).toBe("canonical-build");

      writeFileSync(configPath, "{ broken JSON");
      const unavailable = await api.request("/api/rigs/summary");
      expect(unavailable.status).toBe(200);
      expect(await unavailable.json()).toEqual([{ ...before[0], displayLabelError: true }]);

      const other = repo.createRig("canonical-ci");
      writeFileSync(configPath, JSON.stringify({ dashboard: { rigLabels: { [rig.id]: "Build Ω", [other.id]: "bad\u001b[2J" } } }));
      const partial = await (await api.request("/api/rigs/summary")).json();
      expect(partial.find((r: { id: string }) => r.id === rig.id)).toMatchObject({ name: "canonical-build", displayLabel: "Build Ω", displayLabelError: true });
      expect(partial.find((r: { id: string }) => r.id === other.id)).toMatchObject({ name: "canonical-ci", displayLabelError: true });
      expect(partial.find((r: { id: string }) => r.id === other.id)).not.toHaveProperty("displayLabel");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
