#!/usr/bin/env bun
// Spec files for the spec skill: state/work/<slug>/spec.md. Validates the format documented in
// references/template.md, emits ACs as JSON for pair/ship/review/qa/done, flips the status.
// Deterministic file ops only; the skill writes the prose.
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORK_DIR = process.env.SPEC_WORK_DIR || join(import.meta.dir, "..", "..", "..", "state", "work");
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_KEYS = ["slug", "size", "status", "prd", "ticket"];
const TAGS = ["happy", "edge", "error", "perm", "empty", "perf", "a11y"];
const BASE_SECTIONS = ["Problem", "Acceptance criteria", "Non-goals", "Definition of done", "Open questions", "Grilled"];
const PRD_SECTIONS = ["Journey", "MVP", "Success metric", "Risks and constraints", "Demo milestones", "Release notes"];
const PLACEHOLDER = /^(tbd|todo|none|n\/a|-|\?|assumption|assumed|<.*>)\.?$/i;
// Implementation details that belong in Source, never in the AC text itself.
const IMPL_DETAIL = /\b[\w./-]+\.(?:tsx?|jsx?|mjs|py|go|rb|sql|css|graphql)\b|\b\w+\(\)|\b[\w-]*[./][\w./-]*:\d+\b/;

type Args = { pos: string[]; flags: Map<string, string | true> };
type FrontMatter = Record<string, string>;
type AC = {
  id: string;
  n: number;
  title: string;
  tags: string[];
  kind: "behaviour" | "check";
  given: string | null;
  when: string | null;
  then: string | null;
  check: string | null;
  source: string | null;
  verify: string | null;
  superseded: boolean;
  reason: string | null;
  line: number;
};
type Parsed = { fm: FrontMatter; fmEnd: number; lines: string[]; acs: AC[]; problems: string[] };

class UserError extends Error {}

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (const a of argv) {
    if (a.startsWith("--")) flags.set(a, true);
    else pos.push(a);
  }
  return { pos, flags };
}

function allowFlags(args: Args, allowed: string[]) {
  for (const f of args.flags.keys()) if (f !== "--json" && !allowed.includes(f)) throw new UserError(`unknown flag ${f}`);
}

// A path that exists is a file; otherwise a kebab slug resolves to state/work/<slug>/spec.md.
function resolveSpec(raw: string | undefined): string {
  if (!raw) throw new UserError("missing <file|slug>");
  if (existsSync(raw)) return resolve(raw);
  if (SLUG_RE.test(raw)) {
    const file = join(WORK_DIR, raw, "spec.md");
    if (existsSync(file)) return file;
    throw new UserError(`no spec for "${raw}" at ${file}`);
  }
  throw new UserError(`no such file ${raw}`);
}

function readText(file: string): string {
  if (lstatSync(file).isSymbolicLink()) throw new UserError(`${file} is a symlink, refusing`);
  return readFileSync(file, "utf8");
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function parseFrontMatter(lines: string[], problems: string[]): [FrontMatter, number] {
  if (lines[0]?.trim() !== "---") {
    problems.push("front matter: missing (file must start with ---)");
    return [{}, -1];
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) {
    problems.push("front matter: no closing ---");
    return [{}, -1];
  }
  const fm: FrontMatter = {};
  for (let i = 1; i < end; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const m = l.match(/^([a-z]+):\s*(.*)$/);
    if (!m) {
      problems.push(`front matter line ${i + 1}: expected "key: value"`);
      continue;
    }
    const [, key, value] = m as unknown as [string, string, string];
    if (!FM_KEYS.includes(key)) problems.push(`front matter: unknown key "${key}" (allowed: ${FM_KEYS.join(", ")})`);
    else fm[key] = value.trim().replace(/^["']|["']$/g, "");
  }
  if (!fm.slug) problems.push("front matter: slug is required");
  else if (!SLUG_RE.test(fm.slug)) problems.push(`front matter: slug "${fm.slug}" is not kebab-case`);
  if (fm.size !== "ticket" && fm.size !== "prd") problems.push(`front matter: size must be ticket or prd (got "${fm.size ?? ""}")`);
  if (fm.status !== "draft" && fm.status !== "approved") {
    problems.push(`front matter: status must be draft or approved (got "${fm.status ?? ""}")`);
  }
  if (fm.prd && !/^https:\/\/\S+$/.test(fm.prd)) problems.push("front matter: prd must be an https URL");
  if (fm.prd !== undefined && fm.size === "ticket") problems.push("front matter: prd is only allowed with size: prd");
  if (fm.ticket !== undefined && !fm.ticket) problems.push("front matter: ticket is empty (remove the key or set it)");
  return [fm, end];
}

// Top-level "## <name>" sections -> [startLine, endLine) of their bodies.
function sections(lines: string[], from: number): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  let name: string | null = null;
  let start = 0;
  for (let i = from; i <= lines.length; i++) {
    const m = i < lines.length ? lines[i]!.match(/^##\s+(.+?)\s*$/) : [];
    if (!m) continue;
    if (name !== null && !out.has(name)) out.set(name, [start, i]);
    name = m[1] ?? null;
    start = i + 1;
  }
  return out;
}

const body = (lines: string[], [s, e]: [number, number]) => lines.slice(s, e).join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();

function parseAcs(lines: string[], range: [number, number], problems: string[]): AC[] {
  const acs: AC[] = [];
  let cur: AC | null = null;
  let last: "given" | "when" | "then" | null = null;
  for (let i = range[0]; i < range[1]; i++) {
    const l = lines[i]!;
    if (/^###\s/.test(l)) {
      const m = l.match(/^###\s+(~~)?\s*AC-(\d+)\b((?:\s*\[[^\]]*\])*)\s*(.*?)\s*(~~)?\s*$/);
      if (!m) {
        problems.push(`line ${i + 1}: AC heading must be "### AC-<n> [tag] <title>"`);
        cur = null;
        continue;
      }
      const [, s1, n, tagStr, title, s2] = m;
      if (Boolean(s1) !== Boolean(s2)) problems.push(`line ${i + 1}: AC-${n} strike-through needs ~~ on both ends`);
      cur = {
        id: `AC-${n}`,
        n: Number(n),
        title: (title ?? "").trim(),
        tags: [...(tagStr ?? "").matchAll(/\[([^\]]*)\]/g)].map((t) => t[1]!.trim().toLowerCase()),
        kind: "behaviour",
        given: null,
        when: null,
        then: null,
        check: null,
        source: null,
        verify: null,
        superseded: Boolean(s1 && s2),
        reason: null,
        line: i + 1,
      };
      acs.push(cur);
      last = null;
      continue;
    }
    if (!cur) continue;
    const field = l.match(/^\s*-\s+(Given|When|Then|And|Source:|Verify:|Superseded:)\s*(.*)$/i);
    const box = l.match(/^\s*-\s+\[[ xX]\]\s+(.*)$/);
    if (box) {
      if (cur.check !== null) problems.push(`${cur.id}: more than one checkbox statement`);
      cur.check = box[1]!.trim();
      cur.kind = "check";
      continue;
    }
    if (!field) continue;
    const key = field[1]!.toLowerCase().replace(":", "");
    const value = field[2]!.trim();
    if (key === "given" || key === "when" || key === "then") {
      if (cur[key] !== null) problems.push(`${cur.id}: "${field[1]}" appears twice (use "And" to extend it)`);
      cur[key] = value;
      last = key;
    } else if (key === "and") {
      if (!last) problems.push(`${cur.id}: "And" before any Given/When/Then`);
      else cur[last] = `${cur[last]} and ${value}`;
    } else if (key === "source") cur.source = value;
    else if (key === "verify") cur.verify = value;
    else if (key === "superseded") cur.reason = value;
  }
  return acs;
}

function checkAcs(acs: AC[], acBody: string, problems: string[]) {
  if (!acs.length) problems.push("Acceptance criteria: no ACs (### AC-1 ...)");
  const seen = new Set<number>();
  acs.forEach((ac, idx) => {
    if (seen.has(ac.n)) problems.push(`${ac.id}: duplicate id (line ${ac.line})`);
    else if (ac.n !== idx + 1) problems.push(`${ac.id}: ids must be sequential from AC-1 (expected AC-${idx + 1} at line ${ac.line})`);
    seen.add(ac.n);
    if (!ac.title) problems.push(`${ac.id}: missing title`);
    for (const t of ac.tags) if (!TAGS.includes(t)) problems.push(`${ac.id}: unknown tag [${t}] (allowed: ${TAGS.join(", ")})`);
    if (ac.superseded) {
      if (!ac.reason) problems.push(`${ac.id}: struck through without "- Superseded: <reason>"`);
      return;
    }
    if (ac.reason) problems.push(`${ac.id}: has "Superseded:" but the heading is not struck through`);
    const gwt = [ac.given, ac.when, ac.then].some((v) => v !== null);
    if (ac.kind === "check" && gwt) problems.push(`${ac.id}: mixes a checkbox with Given/When/Then (pick one)`);
    if (ac.kind === "behaviour") {
      if (!ac.tags.length) problems.push(`${ac.id}: behaviour AC needs at least one tag`);
      for (const k of ["given", "when", "then"] as const) {
        if (!ac[k]) problems.push(`${ac.id}: behaviour AC missing "${k[0]!.toUpperCase()}${k.slice(1)}"`);
      }
    }
    if (!ac.source) problems.push(`${ac.id}: missing "Source:" (no source means it is an assumption: move it to Open questions)`);
    else if (PLACEHOLDER.test(ac.source)) problems.push(`${ac.id}: Source "${ac.source}" is a placeholder (move it to Open questions)`);
    if (!ac.verify) problems.push(`${ac.id}: missing "Verify:"`);
    else if (PLACEHOLDER.test(ac.verify)) problems.push(`${ac.id}: Verify "${ac.verify}" is a placeholder`);
    for (const text of [ac.title, ac.given, ac.when, ac.then, ac.check]) {
      if (text && IMPL_DETAIL.test(text)) {
        problems.push(`${ac.id}: AC text names a file, function or line ("${text.match(IMPL_DETAIL)![0]}"); keep it in Source`);
        break;
      }
    }
  });
  const live = acs.filter((a) => !a.superseded);
  const hasEdge = live.some((a) => a.tags.includes("edge") || a.tags.includes("error"));
  if (live.length && !hasEdge && !/^\s*-?\s*waived:\s*\S/im.test(acBody)) {
    problems.push('Acceptance criteria: no [edge] or [error] AC (add one, or a "Waived: <reason>" line)');
  }
}

function parse(text: string): Parsed {
  const problems: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const [fm, fmEnd] = parseFrontMatter(lines, problems);
  const from = fmEnd + 1;
  if (!lines.slice(from).some((l) => /^#\s+\S/.test(l))) problems.push('missing "# <Title>" heading');
  const secs = sections(lines, from);
  const required = fm.size === "prd" ? [...BASE_SECTIONS, ...PRD_SECTIONS] : BASE_SECTIONS;
  for (const name of required) {
    const range = secs.get(name);
    if (!range) problems.push(`missing section "## ${name}"${PRD_SECTIONS.includes(name) ? " (required for size: prd)" : ""}`);
    else if (!body(lines, range)) problems.push(`section "## ${name}" is empty`);
  }
  const problem = secs.get("Problem");
  if (problem) {
    const b = body(lines, problem);
    if (!/^Asked:\s*\S/im.test(b) || !/^Real:\s*\S/im.test(b)) problems.push('Problem: needs both "Asked:" and "Real:" lines (XY check)');
  }
  const release = secs.get("Release notes");
  if (fm.size === "prd" && release) {
    const b = body(lines, release);
    for (const k of ["Rollback", "Flag"]) if (!new RegExp(`^-?\\s*${k}:\\s*\\S`, "im").test(b)) problems.push(`Release notes: missing "${k}:" line`);
  }
  const acRange = secs.get("Acceptance criteria");
  const acs = acRange ? parseAcs(lines, acRange, problems) : [];
  if (acRange) checkAcs(acs, body(lines, acRange), problems);
  return { fm, fmEnd, lines, acs, problems };
}

function fail(problems: string[], json: boolean, file: string): never {
  if (json) console.log(JSON.stringify({ file, ok: false, problems }, null, 2));
  else for (const p of problems) console.error(`spec: ${p}`);
  process.exit(1);
}

function cmdCheck(args: Args) {
  allowFlags(args, []);
  const file = resolveSpec(args.pos[0]);
  const p = parse(readText(file));
  const json = args.flags.has("--json");
  if (p.problems.length) fail(p.problems, json, file);
  const live = p.acs.filter((a) => !a.superseded).length;
  const summary = { file, ok: true, slug: p.fm.slug, size: p.fm.size, status: p.fm.status, acs: p.acs.length, live };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`ok ${p.fm.slug} (${p.fm.size}, ${p.fm.status}): ${live} ACs${p.acs.length > live ? `, ${p.acs.length - live} superseded` : ""}`);
}

function cmdAcs(args: Args) {
  allowFlags(args, []);
  const file = resolveSpec(args.pos[0]);
  const p = parse(readText(file));
  const json = args.flags.has("--json");
  if (p.problems.length) fail(p.problems, json, file);
  const out = p.acs.map(({ id, title, tags, kind, given, when, then, check, source, verify, superseded, reason }) => ({
    id, title, tags, kind, given, when, then, check, source, verify, superseded, reason,
  }));
  if (json) return console.log(JSON.stringify(out, null, 2));
  for (const a of out) {
    const head = `${a.id} [${a.tags.join("][")}] ${a.title}`;
    console.log(a.superseded ? `${head} (superseded: ${a.reason})` : head);
  }
}

function cmdStatus(args: Args) {
  allowFlags(args, []);
  const file = resolveSpec(args.pos[0]);
  const next = args.pos[1];
  if (next !== "approved" && next !== "draft") throw new UserError("usage: spec status <file|slug> <approved|draft>");
  const p = parse(readText(file));
  const json = args.flags.has("--json");
  if (next === "approved" && p.problems.length) fail(p.problems, json, file);
  if (p.fmEnd < 0) throw new UserError(`${file} has no front matter`);
  const idx = p.lines.findIndex((l, i) => i > 0 && i < p.fmEnd && /^status:/.test(l));
  if (idx < 0) throw new UserError(`${file} has no status key`);
  const prev = p.fm.status;
  p.lines[idx] = `status: ${next}`;
  if (prev !== next) writeAtomic(file, p.lines.join("\n"));
  if (json) console.log(JSON.stringify({ file, from: prev, to: next, changed: prev !== next }, null, 2));
  else console.log(prev === next ? `${file} already ${next}` : `${file}: ${prev} → ${next}`);
}

const USAGE = `usage: spec <command>  (<slug> resolves to $CLAUDE_CONFIG_DIR/state/work/<slug>/spec.md)
  check <file|slug> [--json]               validate front matter, sections, ACs; exit 1 with one line per problem
  acs <file|slug> [--json]                 ACs as [{id,title,tags,kind,given,when,then,check,source,verify,superseded,reason}]
  status <file|slug> <approved|draft>      flip front matter status (approved requires a passing check)
format: $CLAUDE_CONFIG_DIR/skills/spec/references/template.md`;

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "check":
      return cmdCheck(args);
    case "acs":
      return cmdAcs(args);
    case "status":
      return cmdStatus(args);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

try {
  main();
} catch (e) {
  console.error(`spec: ${e instanceof UserError ? e.message : ((e as Error)?.message ?? e)}`);
  process.exit(1);
}
