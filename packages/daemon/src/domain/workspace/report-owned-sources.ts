import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import type { ReportEvidence, ReportFact } from "./report-projection.js";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function readOwnedWorkSources(input: { dir: string; read: (file: string) => string }): { refs: string[]; progress: string | undefined; acceptance: ReportFact | null; nextAction: string | null; evidence: ReportEvidence[]; issues: string[] } {
  const refs: string[] = [], evidence: ReportEvidence[] = [], issues: string[] = [];
  let progress: string | undefined;
  let acceptance: ReportFact | null = null;
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
        progress = `${text.slice(0, 16000)}\nSource: ${source} · modified ${fs.statSync(source).mtime.toISOString()}`;
      }
    } catch (error) { issues.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!fs.existsSync(input.dir)) return { refs, progress, acceptance, nextAction, evidence, issues };
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
          if (!progress) progress = `Recorded disposition from ${target}:\n${text.slice(0, 8000)}`;
          const record: unknown = JSON.parse(text);
          if (object(record) && typeof record.next_custody === "string" && record.next_custody.trim()) nextAction = record.next_custody;
          if (object(record) && typeof record.head === "string" && /^[a-f0-9]{40,64}$/i.test(record.head) && object(record.reader_status) && record.reader_status.qa === "ACCEPT" && record.reader_status.review === "ACCEPT" && Array.isArray(record.receipts) && record.receipts.length >= 2 && record.receipts.every((ref): ref is string => typeof ref === "string" && !!ref && !/^https?:/.test(ref))) {
            const receipts = record.receipts.map(ref => ({ source: path.resolve(input.dir, ref), label: "Linked recorded acceptance receipt", at: null }));
            for (const receipt of receipts) input.read(receipt.source);
            const at = typeof record.recorded_at === "string" ? record.recorded_at : typeof record.at === "string" ? record.at : null;
            acceptance = { kind: "reported", value: `Recorded QA and review ACCEPT for candidate ${record.head}; bounded source acceptance, not integration or whole-mission acceptance`, evidence: [{ source: target, label: "Recorded candidate-bound reader acceptance", at }, ...receipts] };
          }
        }
      } else if (/^(?:terminal-return|publication-return|publication-handoff|closeout)\.md$/.test(file.name)) {
        const text = capture(target, "Owned narrative disposition; not a structured acceptance judgment");
        if (!progress) progress = `Recorded disposition from ${target}:\n${text.slice(0, 8000)}`;
      }
    } catch (error) { issues.push(`${target}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { refs, progress, acceptance, nextAction, evidence, issues };
}
