import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLiteralLaunchWords, powershellQuote, renderWindowsLaunch, hasOnlyWindowsTerminalResponseDraft } from "../src/adapters/windows-launch.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

describe("literal Windows launch rendering", () => {
  it("recognises only an entirely terminal-response current draft", () => {
    const reply = "]10;rgb:cccc/cccc/cccc\\]11;rgb:0c0c/0c0c/0c0c\\";
    expect(hasOnlyWindowsTerminalResponseDraft(`header\n› ${reply}\n\n footer`)).toBe(true);
    expect(hasOnlyWindowsTerminalResponseDraft(`› ${reply}my draft\n\n`)).toBe(false);
    expect(hasOnlyWindowsTerminalResponseDraft(`› ${reply}\n  my second line\n\n`)).toBe(false);
    expect(hasOnlyWindowsTerminalResponseDraft(`› ${reply}\n\nold answer\n› current draft\n\n`)).toBe(false);
    expect(hasOnlyWindowsTerminalResponseDraft("› normal draft\n\n")).toBe(false);
  });
  it("preserves generated POSIX words, including empty, Unicode and apostrophe arguments", () => {
    expect(parseLiteralLaunchWords(`node 'C:\\project space\\runner.js' '' 'a'"'"'b' '中文;$HOME'`))
      .toEqual(["node", "C:\\project space\\runner.js", "", "a'b", "中文;$HOME"]);
    const launch = renderWindowsLaunch(`node 'C:\\project space\\runner.js' 'x;y'`, { OPENRIG_SESSION_NAME: "seat@rig", PATH: "C:\\bin;C:\\two" });
    expect(launch).toContain("$openrigStart.EnvironmentVariables['OPENRIG_SESSION_NAME']='seat@rig'");
    expect(launch).toContain("$openrigStart.EnvironmentVariables['PATH']='C:\\bin;C:\\two'");
    expect(launch).toContain("$openrigStart.FileName = 'node'");
    expect(launch).toContain('$openrigStart.Arguments = \'"C:\\project space\\runner.js" "x;y"\'');
    expect(powershellQuote("a'b")).toBe("'a''b'");
  });
  it("does not interpret shell syntax as native argv", () => {
    for (const command of ["node x; whoami", "node $(whoami)", 'node "$HOME"', "node x | whoami", "node 'unterminated", ""])
      expect(() => parseLiteralLaunchWords(command)).toThrow();
    expect(() => renderWindowsLaunch("node x", { "BAD;KEY": "x" })).toThrow();
  });
});

describe.each(["win32", "linux"])("psmux PowerShell launch staging (%s)", platform => {
  const hostPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => Object.defineProperty(process, "platform", { ...hostPlatform, value: platform }));
  afterEach(() => Object.defineProperty(process, "platform", hostPlatform));
  it("scopes duplicate psmux pane IDs to the session's server", async () => {
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => "", undefined, async argv => {
      calls.push(argv);
      return argv.includes("list-panes") ? "seat-a|$7|4242|134368264782225092|%1|0|C:\\cwd|80|24|1\n" : "pwsh";
    }, "psmux");
    const pane = (await adapter.listPanes("seat-a"))[0]!;
    expect(pane.id).toBe("psmux:v2:c2VhdC1h:%1:7:4242:134368264782225092");
    await adapter.getPaneCommand(pane.id);
    expect(calls.at(-1)?.slice(0, 3)).toEqual(["tmux", "-t", "=seat-a"]);
    expect(calls.at(-1)).toContain("%1");
    expect(await adapter.readAllPaneProcesses()).toBeNull();
  });
  it("selects only the requested variable from psmux's full environment response", async () => {
    const adapter = new TmuxAdapter(async () => "", undefined,
      async () => "OTHER=private\r\nOPENRIG_NODE_ID=node\r\nOPENRIG_SESSION_NAME=seat@rig\r\n", "psmux");
    expect(await adapter.getSessionEnv("seat@rig", "OPENRIG_NODE_ID")).toBe("node");
    expect(await adapter.getSessionEnv("seat@rig", "MISSING")).toBeUndefined();
  });
  const originalPane = "psmux:v2:c2VhdA:%1:7:4242:134368264782225092";
  function stagingFixture(ack: string | ((argv: string[]) => string) = "CHECKED-INPUT COMPLETE\n") {
    const calls: string[][] = [];
    let nextFile = 0;
    const fileOps = {
      writeFile: vi.fn(async (_path: string, _text: string, _options?: { mode: number; flag: "wx" }) => {}),
      unlink: vi.fn(async (_path: string) => {}),
      tmpName: () => `C:\\temp space\\launch-${++nextFile}.txt`,
      bufferName: () => { throw new Error("Native checked input must not use legacy buffers"); },
    };
    const adapter = new TmuxAdapter(async () => { throw new Error("no POSIX exec"); }, fileOps, async argv => {
      calls.push(argv);
      if (argv.includes("display-message")) return "pwsh";
      if (argv[1] === "checked-input") return typeof ack === "string" ? ack : ack(argv);
      throw new Error("Unexpected legacy input or name lookup");
    }, "psmux");
    return { adapter, calls, fileOps };
  }
  it("stages a native script and sends only its short invocation to the original epoch", async () => {
    const { adapter, calls, fileOps } = stagingFixture();
    const command = `& 'node' @('${"literal-payload".repeat(100)}')`;
    expect(await adapter.sendShellCommand(originalPane, command)).toEqual({ ok: true });
    const [script, invocation, enter] = fileOps.writeFile.mock.calls;
    expect(script?.[1]).toBe(`Remove-Item -LiteralPath '${script?.[0]}'\n${command}\n`);
    expect(script?.[1]).not.toContain("/bin/");
    expect(invocation?.[1]).toBe(`& ([scriptblock]::Create([IO.File]::ReadAllText('${script?.[0]}')))`);
    expect(Buffer.byteLength(invocation![1], "utf8")).toBeLessThanOrEqual(512);
    expect(invocation?.[1]).not.toContain("literal-payload");
    expect(enter?.[1]).toBe('["Enter"]');
    const input = calls.filter(argv => argv[1] === "checked-input");
    expect(input).toEqual([
      ["tmux", "checked-input", "--session", "7", "--server", "4242:134368264782225092", "--pane", "%1", "--mode", "auto", "--file", invocation![0]],
      ["tmux", "checked-input", "--session", "7", "--server", "4242:134368264782225092", "--pane", "%1", "--mode", "keys", "--file", enter![0]],
    ]);
    expect(new Set(fileOps.writeFile.mock.calls.map(([path]) => path)).size).toBe(3);
    for (const [, , options] of fileOps.writeFile.mock.calls) expect(options).toEqual({ mode: 0o600, flag: "wx" });
    expect(fileOps.unlink.mock.calls).toEqual([[invocation![0]], [enter![0]]]);
    // Queue acceptance is not consumption: the staged script owns its deletion.
    expect(fileOps.unlink).not.toHaveBeenCalledWith(script![0]);
  });
  it.each(["pwsh", "CHECKED-INPUT COMPLETE", "CHECKED-INPUT COMPLETE\nextra\n"])("refuses incomplete or unexpected checked-input acknowledgment %j", async ack => {
    const { adapter, calls, fileOps } = stagingFixture(ack);
    expect(await adapter.sendShellCommand(originalPane, "& 'node' @('-v')")).toMatchObject({ ok: false, code: "native_input_unverified" });
    expect(calls.filter(argv => argv[1] === "checked-input")).toHaveLength(1);
    expect(fileOps.writeFile).toHaveBeenCalledTimes(2); // script and invocation; no Enter/retry
    expect(fileOps.unlink.mock.calls).toEqual([[fileOps.writeFile.mock.calls[1]![0]], [fileOps.writeFile.mock.calls[0]![0]]]);
  });
  it("removes the unconsumed script when Enter is not acknowledged, without retry", async () => {
    const { adapter, calls, fileOps } = stagingFixture(argv => argv.includes("keys") ? "incomplete" : "CHECKED-INPUT COMPLETE\n");
    expect(await adapter.sendShellCommand(originalPane, "& 'node' @('-v')")).toMatchObject({ ok: false, code: "native_input_unverified" });
    expect(calls.filter(argv => argv[1] === "checked-input")).toHaveLength(2);
    expect(fileOps.unlink.mock.calls).toEqual([
      [fileOps.writeFile.mock.calls[1]![0]], [fileOps.writeFile.mock.calls[2]![0]], [fileOps.writeFile.mock.calls[0]![0]],
    ]);
  });
  it("refuses unqualified input without dispatch and removes its unconsumed script", async () => {
    const { adapter, calls, fileOps } = stagingFixture();
    expect(await adapter.sendShellCommand("seat", "& 'node' @('-v')")).toMatchObject({ ok: false, code: "guard_target_unknown" });
    expect(calls.filter(argv => argv[1] === "checked-input")).toEqual([]);
    expect(fileOps.writeFile).toHaveBeenCalledTimes(1);
    expect(fileOps.unlink).toHaveBeenCalledWith(fileOps.writeFile.mock.calls[0]![0]);
  });
  it("rejects an unsupported pane before typing a native command", async () => {
    const fileOps = { writeFile: vi.fn(async () => {}), unlink: vi.fn(async () => {}), tmpName: () => "C:\\temp\\launch.txt", bufferName: () => "buf" };
    const adapter = new TmuxAdapter(async () => "", fileOps, async () => "cmd", "psmux");
    expect(await adapter.sendShellCommand("seat", "node -v")).toMatchObject({ ok: false, code: "unsupported_windows_pane" });
    expect(fileOps.writeFile).not.toHaveBeenCalled();
  });
});
