import type { ReportBucket, ReportItem } from "./report-projection.js";

export interface ReportHierarchyRow {
  item: ReportItem;
  depth: number;
  ancestors: ReportItem[];
}

export function reportHierarchy(items: readonly ReportItem[], filter = "", bucket?: ReportBucket): ReportHierarchyRow[] {
  const byKey = new Map(items.map(item => [item.key, item]));
  const ancestry = (item: ReportItem): ReportItem[] => {
    const ancestors: ReportItem[] = [];
    const visited = new Set([item.key]);
    let parent = item.parent ? byKey.get(item.parent) : undefined;
    while (parent && !visited.has(parent.key)) {
      visited.add(parent.key); ancestors.unshift(parent);
      parent = parent.parent ? byKey.get(parent.parent) : undefined;
    }
    return ancestors;
  };
  const selected = new Set<string>();
  const query = filter.toLowerCase();
  for (const item of items) {
    if (item.counting !== "unit" || (bucket && item.bucket !== bucket)) continue;
    const context = [...ancestry(item), item];
    if (query && !context.some(row => `${row.title} ${row.owner ?? ""} ${row.stage ?? ""} ${row.id ?? ""}`.toLowerCase().includes(query))) continue;
    context.forEach(row => selected.add(row.key));
  }
  const children = new Map<string, ReportItem[]>();
  const roots: ReportItem[] = [];
  for (const item of items.filter(item => selected.has(item.key))) {
    if (item.parent && selected.has(item.parent) && item.parent !== item.key) {
      const siblings = children.get(item.parent) ?? []; siblings.push(item); children.set(item.parent, siblings);
    } else roots.push(item);
  }
  const rows: ReportHierarchyRow[] = [];
  const visited = new Set<string>();
  const append = (item: ReportItem, ancestors: ReportItem[]): void => {
    if (visited.has(item.key)) return;
    visited.add(item.key); rows.push({ item, depth: ancestors.length, ancestors });
    for (const child of children.get(item.key) ?? []) append(child, [...ancestors, item]);
  };
  roots.forEach(item => append(item, []));
  items.filter(item => selected.has(item.key)).forEach(item => append(item, []));
  return rows;
}
