import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { isPristineScaffoldSection } from "../scope/scaffold-placeholder.js";
import type { ReportEvidence } from "./report-projection.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function readOwnedWorkSources(input: { dir: string; read: (file: string) => string }): { refs: string[]; progress: string | undefined; recordedProgress: boolean; nextAction: string | null; evidence: ReportEvidence[]; issues: string[] } {
  const refs: string[] = [], evidence: ReportEvidence[] = [], issues: string[] = [];
  let progress: string | undefined;
  let recordedProgress = false;
  let dispositionProgress: string | undefined;
  let dispositionAt = Number.NEGATIVE_INFINITY;
  let nextAction: string | null = null;
  const capture = (file: string, label: string): string => {
    const text = input.read(file);
    evidence.push({ source: file, label, at: fs.statSync(file).mtime.toISOString() });
    return text;
  };
  const manifestPath = path.join(input.dir, "slice.yaml");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest: unknown = parse(input.read(manifestPath));
      const composition = object(manifest) ? manifest.composition : null;
      const markdown = object(composition) ? composition.slice_markdown : null;
      if (object(markdown) && typeof markdown.progress === "string") {
        if (markdown.progress.includes("#")) throw new Error("Addressed progress source requires an explicit section reader; not silently expanded");
        const source = path.resolve(input.dir, markdown.progress);
        const relative = path.relative(input.dir, source);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Declared progress escapes its work directory");
        const canonicalRelative = path.relative(fs.realpathSync(input.dir), fs.realpathSync(source));
        if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) throw new Error("Declared progress escapes its canonical work directory");
        const text = capture(source, "Declared progress source");
        let inSections = false;
        const body = text.split(/\r?\n/).filter(line => {
          if (/^##\s/.test(line)) inSections = true;
          return !/^#{1,6}\s/.test(line) && (inSections || !/^>/.test(line));
        }).join("\n").trim();
        recordedProgress = !!body && !isPristineScaffoldSection(body);
        progress = `${text}\nSource: ${source} · modified ${fs.statSync(source).mtime.toISOString()}`;
      }
    } catch (error) { issues.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!fs.existsSync(input.dir)) return { refs, progress, recordedProgress, nextAction, evidence, issues };
  const files = fs.readdirSync(input.dir, { withFileTypes: true }).filter(entry => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
  if (files.length > 512) issues.push(`${input.dir}: owned source scan limited to first 512 files`);
  for (const file of files.slice(0, 512)) {
    const target = path.join(input.dir, file.name);
    try {
      if (file.name.endsWith(".json")) {
        if (fs.statSync(target).size > 2 * 1024 * 1024) { issues.push(`${target}: source exceeds bounded read size`); continue; }
        const fd = fs.openSync(target, "r"), prefix = Buffer.alloc(256);
        let start: string;
        try { start = prefix.subarray(0, fs.readSync(fd, prefix, 0, prefix.length, 0)).toString("utf8").trimStart(); }
        finally { fs.closeSync(fd); }
        if (start.startsWith("[")) {
          const value: unknown = JSON.parse(input.read(target));
          if (Array.isArray(value) && value.some(row => object(row) && "started_at" in row)) refs.push(target);
        } else if (/^(?:final-disposition|publication-handoff|publication-readback|closeout)\.json$/.test(file.name)) {
          const text = capture(target, "Owned disposition record; verdict retained separately"); refs.push(target);
          const record: unknown = JSON.parse(text);
          const modified = fs.statSync(target).mtimeMs;
          if (modified >= dispositionAt) {
            dispositionAt = modified;
            const fields = object(record) ? ["summary", "status", "stage", "outcome", "result", "checks", "reader_status", "next_custody", "custody"].flatMap(key => record[key] === undefined ? [] : [`${key}: ${typeof record[key] === "string" ? record[key] : JSON.stringify(record[key])}`]) : [];
            dispositionProgress = `Recorded disposition (${file.name}; reported fields)\n${fields.length ? fields.join("\n") : "No named progress fields recorded; inspect linked source evidence."}`;
          }
          if (object(record) && typeof record.next_custody === "string" && record.next_custody.trim()) nextAction = record.next_custody;
          if (object(record) && Array.isArray(record.receipts)) {
            for (const ref of new Set(record.receipts.filter((ref): ref is string => typeof ref === "string" && !!ref))) {
              const source = /^https?:/.test(ref) ? ref : path.resolve(input.dir, ref);
              evidence.push({ source, label: "Disposition-linked receipt; subject and verdict unverified", at: null });
              if (!/^https?:/.test(ref)) {
                try { input.read(source); }
                catch (error) { issues.push(`${source}: ${error instanceof Error ? error.message : String(error)}`); }
              }
            }
          }
        }
      } else if (/^(?:terminal-return|publication-return|publication-handoff|closeout)\.md$/.test(file.name)) {
        const text = capture(target, "Owned narrative disposition; not a structured acceptance judgment");
        const modified = fs.statSync(target).mtimeMs;
        if (modified >= dispositionAt) {
          dispositionAt = modified;
          dispositionProgress = `Recorded disposition (${file.name}; narrative)\n${text}`;
        }
      }
    } catch (error) { issues.push(`${target}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { refs, progress: progress ?? dispositionProgress, recordedProgress, nextAction, evidence, issues };
}
