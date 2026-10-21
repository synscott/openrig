import { describe, expect, it, vi } from "vitest";
import { TmuxAdapter, type ArgvExecFn, type ExecFn, type TmuxFileOps } from "../src/adapters/tmux.js";

// Policy regression on dajiaohuang's PR #1309, exact head 5bdb158b761383deb45d3776844c238cd383a90c.
// Missing registry and unreachable port are source-backed simulations of the
// same output, not observations from Windows or a running psmux server.
function silentFailure(extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("Command failed: tmux has-session -t =worker@lab"), {
    code: 1, stdout: "", stderr: "", ...extra,
  });
}

function fixture(error?: Error, kind: "tmux" | "psmux" = "psmux") {
  const forbidden = () => { throw new Error("Unexpected product filesystem or shell activity"); };
  const exec = vi.fn<ExecFn>(forbidden);
  const fileOps: TmuxFileOps = {
    writeFile: vi.fn(forbidden), unlink: vi.fn(forbidden),
    tmpName: vi.fn(forbidden), bufferName: vi.fn(forbidden),
  };
  const argvExec = vi.fn<ArgvExecFn>(async () => { if (error) throw error; return ""; });
  const adapter = new TmuxAdapter(exec, fileOps, argvExec, kind);
  return { adapter, argvExec, exec, fileOps };
}

describe("psmux session probe evidence", () => {
  it.each(["missing registry simulation", "unreachable port simulation"])(
    "keeps presence unknown for silent exit 1: %s", async () => {
      const { adapter, argvExec, exec, fileOps } = fixture(silentFailure());
      const result = await adapter.probeSession("worker@lab");
      expect(result).toMatchObject({ state: "transport_unavailable" });
      if (result.state !== "transport_unavailable") throw new Error("Ambiguous probe became absence");
      expect(result.cause).toMatch(/silent.*exit.*1/i);
      expect(result.cause).toMatch(/presence.*unknown/i);
      expect(argvExec.mock.calls).toEqual([[["tmux", "has-session", "-t", "=worker@lab"]]]);
      expect(exec).not.toHaveBeenCalled();
      for (const operation of Object.values(fileOps)) expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each(["tmux", "psmux"] as const)("retains successful presence for %s", async kind => {
    expect(await fixture(undefined, kind).adapter.probeSession("worker@lab")).toEqual({ state: "present" });
  });

  it.each(["tmux", "psmux"] as const)("retains positive absence diagnostics for %s", async kind => {
    const error = Object.assign(new Error("can't find session: =worker@lab"), {
      code: 1, stdout: "", stderr: "can't find session: =worker@lab",
    });
    expect(await fixture(error, kind).adapter.probeSession("worker@lab")).toEqual({ state: "absent" });
  });

  it("preserves the existing no-server transport classification", async () => {
    const error = new Error("no server running on private-test-socket");
    expect(await fixture(error).adapter.probeSession("worker@lab"))
      .toEqual({ state: "transport_unavailable", cause: error.message });
  });

  it("does not broaden silent-exit handling to normal tmux", async () => {
    const error = silentFailure();
    await expect(fixture(error, "tmux").adapter.probeSession("worker@lab")).rejects.toBe(error);
  });

  it.each([
    ["string exit code", { code: "1" }],
    ["other exit code", { code: 2 }],
    ["missing exit code", { code: undefined }],
    ["permission denied", { code: "EACCES" }],
    ["operation not permitted", { code: "EPERM" }],
    ["stdout present", { stdout: "unexpected output" }],
    ["stderr present", { stderr: "unexpected diagnostic" }],
    ["whitespace stderr", { stderr: "\n" }],
    ["missing stdout", { stdout: undefined }],
    ["missing stderr", { stderr: undefined }],
    ["signal", { signal: "SIGTERM" }],
    ["killed timeout", { killed: true }],
  ] as const)("preserves refusal for %s", async (_label, extra) => {
    const error = silentFailure(extra);
    const { adapter, argvExec } = fixture(error);
    await expect(adapter.probeSession("worker@lab")).rejects.toBe(error);
    expect(argvExec).toHaveBeenCalledOnce();
  });
});
