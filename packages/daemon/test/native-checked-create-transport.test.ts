import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => [] as Array<{ file: string; args: string[]; options: Record<string, any> }>);
const behavior = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, execFile: Object.assign(() => { throw Error("callback route forbidden"); }, {
    [promisify.custom]: async (file: string, args: string[], options: Record<string, any>) => {
      calls.push({ file, args, options });
      if (behavior.error) throw behavior.error;
      return { stdout: "fixture\n", stderr: "" };
    },
  }) };
});
import { execArgvCommand } from "../src/adapters/tmux-exec.js";
afterEach(() => { vi.unstubAllEnvs(); calls.length = 0; behavior.error = null; });
describe("checked-create bounded transport with injected process boundary", () => {
  it("binds exactly one root selector and limits only the explicit creation deadline", async () => {
    vi.stubEnv("PSMUX_DATA_DIR", "/old"); vi.stubEnv("psmux_data_dir", "/conflicting");
    const before = process.env.PSMUX_DATA_DIR;
    await execArgvCommand(["tmux", "checked-create", "--file", "/fixture/request"], { timeoutMs: 99999, psmuxDataDir: "/frozen" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(-3)).toEqual(["checked-create", "--file", "/fixture/request"]);
    expect(calls[0]!.options.timeout).toBe(35000);
    const env = calls[0]!.options.env;
    expect(Object.keys(env).filter(key => key.toUpperCase() === "PSMUX_DATA_DIR")).toEqual(["PSMUX_DATA_DIR"]);
    expect(env.PSMUX_DATA_DIR).toBe("/frozen"); expect(process.env.PSMUX_DATA_DIR).toBe(before);
    await execArgvCommand(["tmux", "list-sessions"]);
    expect(calls[1]!.options).not.toHaveProperty("timeout"); expect(calls[1]!.options).not.toHaveProperty("env");
  });
  it("preserves exact exit/output without another dispatch", async () => {
    const error = Object.assign(new Error("fixture"), { code: 2, stdout: '{"status":"collision"}\n', stderr: "" });
    behavior.error = error;
    await expect(execArgvCommand(["tmux", "checked-create", "--file", "/fixture/request"], { timeoutMs: 35000, psmuxDataDir: "/frozen" })).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });
  it("rejects overrides for command chains and ordinary operations before process dispatch", async () => {
    await expect(execArgvCommand(["tmux", "checked-create", "--file", "/fixture/request", ";", "kill-server"], { timeoutMs: 35000, psmuxDataDir: "/frozen" })).rejects.toThrow();
    await expect(execArgvCommand(["tmux", "list-sessions"], { timeoutMs: 35000, psmuxDataDir: "/frozen" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
