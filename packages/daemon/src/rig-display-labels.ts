/** Cosmetic dashboard labels never participate in rig addressing or identity. */

/** Only stable rig IDs may key a dashboard label, not canonical names or paths. */
export function parseRigDisplayLabelKey(key: string): { rigId: string } | null {
  const match = /^dashboard\.rig_labels\.([0-7][0-9A-HJKMNP-TV-Z]{25})$/.exec(key);
  return match ? { rigId: match[1]! } : null;
}

/** Accept bounded, single-line text that cannot inject terminal control sequences. */
export function readRigDisplayLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim();
  if (!label || [...label].length > 64 || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(raw)) return null;
  return label;
}

/** Validate an operator write before changing persisted configuration. */
export function requireRigDisplayLabel(raw: string): string {
  const label = readRigDisplayLabel(raw);
  if (label === null) throw new Error("display label must contain 1–64 characters of single-line text without terminal or directional controls");
  return label;
}

/** Keep canonical identity visible even when two rigs share a cosmetic label. */
export function formatRigDisplayName(rig: { name: string; displayLabel?: unknown }): string {
  const label = readRigDisplayLabel(rig.displayLabel);
  return label && label !== rig.name ? `${label} (${rig.name})` : rig.name;
}
