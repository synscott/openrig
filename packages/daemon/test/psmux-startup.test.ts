import { describe, expect, it } from "vitest";
import { TmuxAdapter, type ArgvExecFn } from "../src/adapters/tmux.js";
const capabilities = "OPENRIG-PSMUX 1 checked-input-v1 checked-create-v1 checked-stop-v1 observe-v1 lazy-session\n";
describe("native terminal startup capability", () => {
  it("recognizes lazy readiness without session probes, bootstrap, or maintenance", async () => {
    const effects: string[][] = [];
    const adapter = new TmuxAdapter(async () => { throw Error("No shell"); }, undefined, async args => {
      effects.push(args); return capabilities;
    }, "psmux");
    expect(await adapter.startServer()).toEqual({ ok: true });
    expect(effects).toEqual([["tmux", "openrig-capabilities"]]);
  });
  it.each(["", "tmux 3.4.0\n", capabilities.trimEnd(), `${capabilities}extra`, capabilities.replace("input-v1", "input-v2")])(
    "rejects incomplete or unsupported output %j", async output => {
      const adapter = new TmuxAdapter(async () => "", undefined, async () => output, "psmux");
      expect(await adapter.startServer()).toMatchObject({ ok: false, code: "native_readiness_unverified" });
    });
  it("keeps presence unknown after successful capability readiness", async () => {
    const argv: ArgvExecFn = async args => {
      if (args.includes("openrig-capabilities")) return capabilities;
      throw Object.assign(new Error("ambiguous probe"), { code: 1, stdout: "", stderr: "" });
    };
    const adapter = new TmuxAdapter(async () => { throw Error("No shell"); }, undefined, argv, "psmux");
    expect(await adapter.startServer()).toEqual({ ok: true });
    expect(await adapter.probeSession("missing@private")).toMatchObject({ state: "transport_unavailable" });
  });
  it("rejects nonzero capability execution even with complete stdout", async () => {
    const effects: string[][] = [];
    const adapter = new TmuxAdapter(async () => "", undefined, async args => {
      effects.push(args); throw Object.assign(Error("failed"), { stdout: capabilities, code: 1 });
    }, "psmux");
    expect(await adapter.startServer()).toMatchObject({ ok: false, code: "native_readiness_unverified" });
    expect(effects).toHaveLength(1);
  });
  it("retains POSIX readiness", async () => {
    const effects: string[] = [];
    const adapter = new TmuxAdapter(async command => { effects.push(command); return ""; });
    expect(await adapter.startServer()).toEqual({ ok: true });
    expect(effects).toHaveLength(1); expect(effects[0]).toContain("has-session");
  });
});
