export type ReportAssociation =
  | { kind: "none" }
  | { kind: "declared"; missionId: string; legacyProjectIds: string[]; source: string }
  | { kind: "invalid"; reason: string; source: string };

export type ReportMembership =
  | { kind: "member"; basis: "catalog" }
  | { kind: "member"; basis: "legacy"; source: string; originalProject: string }
  | { kind: "excluded"; reason: "mission_missing" | "mission_conflict" | "project_missing" | "project_conflict" | "project_mismatch" };

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseReportAssociation(manifest: unknown, missionId: string | null, source: string): ReportAssociation {
  if (!mapping(manifest) || manifest.reporting === undefined) return { kind: "none" };
  const reporting = manifest.reporting;
  const invalid = (reason: string): ReportAssociation => ({ kind: "invalid", reason, source });
  if (!mapping(reporting)) return invalid("reporting must be a mapping");
  if (reporting.queue_association === undefined) return { kind: "none" };
  const association = reporting.queue_association;
  if (!mapping(association)) return invalid("reporting.queue_association must be a mapping");
  if (Object.keys(association).some(key => key !== "mission_id" && key !== "legacy_project_ids")) return invalid("Unknown queue_association field");
  if (!missionId || association.mission_id !== missionId) return invalid("queue_association.mission_id must match the canonical authored mission ID");
  const ids: unknown = association.legacy_project_ids;
  if (!Array.isArray(ids) || !ids.length || !ids.every((id): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id))) {
    return invalid("legacy_project_ids must be a nonempty list of project IDs");
  }
  if (new Set(ids).size !== ids.length) return invalid("legacy_project_ids must be unique");
  return { kind: "declared", missionId, legacyProjectIds: [...ids].sort(), source };
}

export function reportTags(raw: readonly string[] | null): Set<string> {
  return new Set((raw ?? []).flatMap(tag => tag.split(",").map(value => value.trim())).filter(Boolean));
}

export function reportMembership(input: {
  tags: readonly string[] | null;
  projectId: string;
  missionId: string | null;
  missionName: string;
  association: ReportAssociation;
}): ReportMembership {
  const tags = reportTags(input.tags);
  const missions = [...tags].filter(tag => tag.startsWith("mission:")).map(tag => tag.slice(8));
  const aliases = new Set([input.missionName, ...(input.missionId ? [input.missionId] : [])]);
  if (!missions.length) return { kind: "excluded", reason: "mission_missing" };
  if (!missions.every(mission => aliases.has(mission))) return { kind: "excluded", reason: "mission_conflict" };
  const projects = [...tags].filter(tag => tag.startsWith("project:")).map(tag => tag.slice(8));
  if (!projects.length) return { kind: "excluded", reason: "project_missing" };
  if (projects.length !== 1) return { kind: "excluded", reason: "project_conflict" };
  const project = projects[0];
  if (project === input.projectId) return { kind: "member", basis: "catalog" };
  if (project && input.association.kind === "declared" && input.association.missionId === input.missionId && input.association.legacyProjectIds.includes(project)) {
    return { kind: "member", basis: "legacy", source: input.association.source, originalProject: project };
  }
  return { kind: "excluded", reason: "project_mismatch" };
}
