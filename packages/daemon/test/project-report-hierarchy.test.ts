import { describe, expect, it } from "vitest";
import { reportHierarchy, latestReportProgress } from "../src/domain/workspace/report-hierarchy.js";
import { projectMissionReport, unknownReportFact, type ReportNode } from "../src/domain/workspace/report-projection.js";
import { buildReportTimecard } from "../src/domain/workspace/report-timecard.js";

const at = "2026-01-01T00:00:00Z";
const node = (key: string, parent: string | null, status: string): ReportNode => ({ key, parent, id: key, title: key, source: `${key}/SPEC.md`, aliases: [], status, stage: null, intent: "", owner: null, nextAction: null, blocker: null, acceptance: unknownReportFact("No judgment"), integration: unknownReportFact("No receipt") });
describe("Projects hierarchy context", () => {
  it("retains nested parents for matching leaves without counting them", () => {
    const report = projectMissionReport({ projectId: "sample", mission: "sample", missionId: null, asOf: at, association: { kind: "none" }, nodes: [node("P", null, "planned"), node("A", "P", "done"), node("B", "P", "planned"), node("C", "B", "planned")], rows: [], emptyTimecard: buildReportTimecard({ commands: [], transitions: [], asOf: at }) });
    expect(report.totals).toEqual({ done: 1, inFlight: 0, leftToDo: 1, unresolved: 0, total: 2 });
    expect(reportHierarchy(report.items, "C").map(row => [row.item.key, row.depth, row.ancestors.map(parent => parent.key)])).toEqual([["P", 0, []], ["B", 1, ["P"]], ["C", 2, ["P", "B"]]]);
    expect(reportHierarchy(report.items, "P", "done").map(row => row.item.key)).toEqual(["P", "A"]);
    expect(reportHierarchy(report.items, "P", "left_to_do").map(row => row.item.key)).toEqual(["P", "B", "C"]);
  });
});

it("shows the latest declared section and tail instead of an old preamble", () => {
  const progress = `# Setup\nOld boilerplate\n## Current\n${"Earlier text ".repeat(80)}Verified final retry\nSource: /fixture/PROGRESS.md · modified yesterday`;
  expect(latestReportProgress(progress, 80)).toContain("Verified final retry");
  expect(latestReportProgress(progress, 80)).not.toContain("Old boilerplate");
});
