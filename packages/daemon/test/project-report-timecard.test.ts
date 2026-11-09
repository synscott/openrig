import { describe, expect, it } from "vitest";
import { buildReportTimecard, intervalMilliseconds, readCommandIntervals } from "../src/domain/workspace/report-timecard.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const command = (start: number, end: number, actor: string) => ({ identity: `${actor}-${start}-${end}`, start: at(start), end: at(end), actor, source: "commands.json", label: "check", result: "exit 0" });
const transition = (id: number, seconds: number, state: string) => ({ transitionId: id, qitemId: "work", ts: at(seconds), state, actorSession: "worker@fixture", transitionNote: "recorded" });

describe("Projects timecard", () => {
  it("unions overlapping command intervals while keeping per-actor totals separate", () => {
    const card = buildReportTimecard({ commands: [command(0, 10, "a"), command(5, 15, "a"), command(10, 20, "b")], transitions: [], asOf: at(30) });
    expect(card.commandTime).toMatchObject({ kind: "partial", milliseconds: 20000 });
    expect(card.byActor).toEqual([{ actor: "a", commandMilliseconds: 15000 }, { actor: "b", commandMilliseconds: 10000 }]);
    expect(card.effort.kind).toBe("unknown");
    expect(card.waiting.kind).toBe("unknown");
  });

  it("orders by transition ID and does not restart work on same-state notes", () => {
    const card = buildReportTimecard({ commands: [], transitions: [transition(4, 20, "done"), transition(2, 3, "in-progress"), transition(1, 0, "in-progress"), transition(3, 10, "blocked")], asOf: at(30) });
    expect(card.lifecycle.map(interval => [interval.state, interval.start, interval.end])).toEqual([
      ["in-progress", at(0), at(10)], ["blocked", at(10), at(20)], ["done", at(20), at(30)],
    ]);
    expect(card.waiting).toMatchObject({ kind: "partial", milliseconds: 10000 });
    expect(card.commandTime.kind).toBe("unknown");
  });

  it("retains failed attempts and unknown actors without inventing attribution", () => {
    const read = readCommandIntervals([{ started_at: at(0), ended_at: at(5), label: "first attempt", exit: 1 }, { started_at: at(6), ended_at: at(10), actor: "a", exit: 0 }], "results.json");
    expect(read.intervals.map(interval => [interval.actor, interval.result])).toEqual([[null, "exit 1"], ["a", "exit 0"]]);
    expect(intervalMilliseconds(read.intervals)).toBe(9000);
    expect(readCommandIntervals([{ started_at: at(10), ended_at: at(0) }], "broken.json").issues).toEqual(["broken.json[0]: invalid command interval"]);
  });

  it("marks missing clocks and future command evidence rather than measuring them", () => {
    const card = buildReportTimecard({ commands: [command(0, 40, "a")], transitions: [transition(1, 10, "blocked"), transition(2, 5, "done")], asOf: at(30) });
    expect(card.commandTime.kind).toBe("unknown");
    expect(card.issues).toEqual(["queue:work#1: invalid lifecycle clock", "Unclosed or future command intervals excluded from measured time"]);
  });
});


it("keeps same-state failure/repair events and actors without restarting residence", () => {
  const card = buildReportTimecard({ commands: [], transitions: [
    { ...transition(1, 0, "in-progress"), transitionNote: "claimed" },
    { ...transition(2, 3, "in-progress"), actorSession: "reviewer@fixture", transitionNote: "QA failed" },
    { ...transition(3, 8, "in-progress"), transitionNote: "repaired" },
    { ...transition(4, 10, "blocked"), transitionNote: "waiting" },
  ], asOf: at(20) });
  expect(card.events.map(event => [event.transitionId, event.actor, event.note])).toEqual([[1, "worker@fixture", "claimed"], [2, "reviewer@fixture", "QA failed"], [3, "worker@fixture", "repaired"], [4, "worker@fixture", "waiting"]]);
  expect(card.lifecycle[0]).toMatchObject({ start: at(0), end: at(10), state: "in-progress" });
  expect(card.waiting).toMatchObject({ milliseconds: 10000 });
  expect(card.effort.kind).toBe("unknown");
});

it("deduplicates repeated candidate command records while preserving different candidates", () => {
  const record = { head: "a".repeat(40), started_at: at(0), ended_at: at(5), argv: ["check"], exit: 0 };
  const first = readCommandIntervals([record], "a.json");
  const copy = readCommandIntervals([record, { ...record, head: "b".repeat(40) }], "b.json");
  const card = buildReportTimecard({ commands: [...first.intervals, ...copy.intervals], transitions: [], asOf: at(30) });
  expect(card.commands).toHaveLength(2);
  expect(card.commandTime).toMatchObject({ milliseconds: 5000 });
});
