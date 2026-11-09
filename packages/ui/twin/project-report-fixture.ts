import type { ProjectWorkReport, ReportItem, ReportTimecard } from "@openrig/daemon/project-report";

const asOf = "2026-01-01T12:00:00.000Z";
const timecard: ReportTimecard = {
  commands: [{ identity: "fixture-command", start: "2026-01-01T11:00:00.000Z", end: "2026-01-01T11:02:00.000Z", actor: "builder@sample", source: "commands.json[0]", label: "Behavior checks", result: "exit 0" }],
  events: [], lifecycle: [], commandTime: { kind: "partial", milliseconds: 120000, reason: "Recorded command interval" },
  waiting: { kind: "unknown", reason: "No waiting history" }, effort: { kind: "unknown", reason: "Command wall time is not continuous effort" },
  byActor: [{ actor: "builder@sample", commandMilliseconds: 120000 }], issues: [],
};
function item(key: string, title: string, bucket: ReportItem["bucket"]): ReportItem {
  return { key, id: key, parent: null, title, source: `missions/sample/slices/${key}/SPEC.md`, counting: "unit", bucket,
    classification: "Authored execution status", authoredStatus: bucket === "done" ? "done" : bucket === "in_flight" ? "in-progress" : "planned", owner: "builder@sample", stage: "wip",
    progress: "The public behavior checks are recorded.", nextAction: "Read acceptance evidence", blocker: null,
    acceptance: { kind: "unknown", reason: "No attributed judgment" }, integration: { kind: "reported", value: "Published PR is unmerged", evidence: [{ source: "pr-status.json", label: "PR status", at: asOf }] },
    attempts: [], evidence: [{ source: `missions/sample/slices/${key}/SPEC.md`, label: "Authored source", at: asOf }], warnings: [], timecard };
}
export const projectReportFixture: ProjectWorkReport = {
  project: { id: "sample", root: "/fixture/sample", name: "Sample project" }, asOf, revision: "fixture-revision", coverage: "partial", sources: [], issues: [], unmappedQueue: [],
  missions: [{ mission: "sample-mission", missionId: "APP.99.0.1", authoredStatus: "active", asOf,
    items: [item("APP.99.0.1.1", "Preserve delivery behavior", "done"), item("APP.99.0.1.2", "Verify retry handling", "in_flight"), item("APP.99.0.1.3", "Document empty state", "left_to_do")],
    totals: { done: 1, inFlight: 1, leftToDo: 1, unresolved: 0, total: 3 }, queueCoverage: { candidates: 0, members: 0, legacyMembers: 0, excluded: 0 },
    diagnostics: [{ kind: "source", key: "unclassified", source: "missions/sample/additional-artifacts", reason: "No authored identity declaration", queue: null }] }],
};

declare global { interface Window { __PROJECT_REPORT_FIXTURE__?: ProjectWorkReport; __PROJECT_REPORT_BASE_URL__?: string; __PROJECT_REPORT_REQUESTS__?: Array<{ path: string; method: string }> } }
