import { parseProjectWorkReport, parseReportProjects } from "../src/domain/workspace/report-contract.js";
import { describe, expect, it } from "vitest";
import { parseReportAssociation, reportMembership } from "../src/domain/workspace/report-association.js";
import { parseReportWorkDirectories } from "../src/domain/workspace/report-work-directories.js";

const source = "/fixture/missions/extract/mission.yaml#reporting.queue_association";
const manifest = { reporting: { queue_association: { mission_id: "APP.99.0.1", legacy_project_ids: ["old"] } } };
const association = parseReportAssociation(manifest, "APP.99.0.1", source);
const selection = { projectId: "current", missionId: "APP.99.0.1", missionName: "extract", association };

describe("Projects mission queue association", () => {
  it("admits an explicitly declared legacy project only within the exact mission", () => {
    expect(reportMembership({ ...selection, tags: ["mission:APP.99.0.1", "project:old"] })).toEqual({ kind: "member", basis: "legacy", source, originalProject: "old" });
    expect(reportMembership({ ...selection, tags: ["mission:extract", "project:current"] })).toEqual({ kind: "member", basis: "catalog" });
    expect(reportMembership({ ...selection, tags: ["mission:APP.99.0.2", "project:old"] })).toEqual({ kind: "excluded", reason: "mission_conflict" });
  });

  it("retains unscoped and conflicting records as exclusions", () => {
    expect(reportMembership({ ...selection, tags: ["mission:extract"] })).toEqual({ kind: "excluded", reason: "project_missing" });
    expect(reportMembership({ ...selection, tags: ["mission:extract", "project:old", "project:neighbor"] })).toEqual({ kind: "excluded", reason: "project_conflict" });
    expect(reportMembership({ ...selection, tags: ["mission:extract", "mission:other", "project:old"] })).toEqual({ kind: "excluded", reason: "mission_conflict" });
    expect(reportMembership({ ...selection, tags: ["project:old"] })).toEqual({ kind: "excluded", reason: "mission_missing" });
  });

  it("never turns a missing or invalid binding into an alias", () => {
    expect(reportMembership({ ...selection, association: { kind: "none" }, tags: ["mission:extract", "project:old"] })).toEqual({ kind: "excluded", reason: "project_mismatch" });
    expect(parseReportAssociation(manifest, "APP.99.0.2", source)).toEqual({ kind: "invalid", source, reason: "queue_association.mission_id must match the canonical authored mission ID" });
    expect(parseReportAssociation({ reporting: { queue_association: { mission_id: "APP.99.0.1", legacy_project_ids: ["old", "old"] } } }, "APP.99.0.1", source)).toEqual({ kind: "invalid", source, reason: "legacy_project_ids must be unique" });
  });

  it("rejects delimiters and unknown fields rather than broadening membership", () => {
    const invalid = { reporting: { queue_association: { mission_id: "APP.99.0.1", legacy_project_ids: ["old,current"] } } };
    expect(parseReportAssociation(invalid, "APP.99.0.1", source).kind).toBe("invalid");
    expect(parseReportAssociation({ reporting: { queue_association: { ...manifest.reporting.queue_association, include_all: true } } }, "APP.99.0.1", source).kind).toBe("invalid");
  });
});

describe("Projects explicit work directories", () => {
  it("keeps typed work/container/artifacts references and rejects ambiguous or escaping entries", () => {
    expect(parseReportWorkDirectories({ reporting: { work_directories: [{ ref: "delivery", disposition: "work" }, { ref: "repairs", disposition: "container" }, { ref: "history", disposition: "artifacts" }] } })).toEqual({ entries: [{ ref: "delivery", disposition: "work" }, { ref: "repairs", disposition: "container" }, { ref: "history", disposition: "artifacts" }], issues: [] });
    const invalid = parseReportWorkDirectories({ reporting: { work_directories: [{ ref: "../neighbor", disposition: "work" }, { ref: "same", disposition: "work" }, { ref: "same", disposition: "artifacts" }] } });
    expect(invalid.entries).toEqual([]);
    expect(invalid.issues).toHaveLength(2);
  });
});


describe("Projects transport contract", () => {
  it("rejects malformed catalog and report payloads instead of rendering empty success", () => {
    expect(() => parseReportProjects([])).toThrow("invalid contract");
    expect(() => parseProjectWorkReport({ project: {} })).toThrow("invalid contract");
    expect(parseReportProjects({ catalogPath: "workspace.yaml", projects: [{ id: "a", root: "/fixture/a", name: "A" }] })).toEqual({ catalogPath: "workspace.yaml", projects: [{ id: "a", root: "/fixture/a", name: "A" }] });
  });

  it("accepts an explicitly empty report with known partial coverage", () => {
    const empty = { project: { id: "a", root: "/fixture/a", name: "A" }, asOf: "2026-01-01T00:00:00Z", revision: "empty", coverage: "partial", issues: [], sources: [], missions: [], unmappedQueue: [] };
    expect(parseProjectWorkReport(empty)).toEqual(empty);
  });
});
