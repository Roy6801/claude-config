#!/usr/bin/env bun
// Initiative state for brainstorm/handoff: one dir per initiative under state/work/<slug>/
// (roadmap.md, decisions.md, handoff.md) plus active.json mapping a cwd to its initiative.
// Deterministic file ops only; the skills write the prose.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { launcher, resumeLines, startLine } from "./launch.ts";

const STATE_DIR = join(import.meta.dir, "..", "state", "work");
const ACTIVE_FILE = join(STATE_DIR, "active.json");
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = ["todo", "active", "done", "skipped"];
const VALUE_FLAGS = new Set(["--title", "--cwd", "--chosen", "--why", "--options", "--by", "--file", "--mode", "--focus", "--resume"]);

type Args = { pos: string[]; flags: Map<string, string | true> };
type Active = Record<string, { slug: string; updatedAt: string }>;
type Step = { n: number; step: string; status: string };
type Info = {
  slug: string;
  title: string;
  dir: string;
  roadmap: string;
  decisions: string;
  handoff: string | null;
  step: Step | null;
  updatedAt: string;
};

class UserError extends Error {}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) pos.push(a);
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UserError(`${a} needs a value`);
      flags.set(a, v);
    } else flags.set(a, true);
  }
  return { pos, flags };
}

function allowFlags(args: Args, allowed: string[]) {
  for (const f of args.flags.keys()) if (f !== "--json" && !allowed.includes(f)) throw new UserError(`unknown flag ${f}`);
}

const str = (args: Args, flag: string) => {
  const v = args.flags.get(flag);
  return typeof v === "string" ? v : undefined;
};
const need = (args: Args, flag: string) => {
  const v = str(args, flag)?.trim();
  if (!v) throw new UserError(`${flag} is required`);
  return v;
};
const cwdOf = (args: Args) => real(str(args, "--cwd") ?? process.cwd());

function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function loadActive(): Active {
  if (!existsSync(ACTIVE_FILE)) return {};
  if (lstatSync(ACTIVE_FILE).isSymbolicLink()) throw new UserError(`${ACTIVE_FILE} is a symlink, refusing`);
  try {
    const data = JSON.parse(readFileSync(ACTIVE_FILE, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    throw new UserError(`could not parse ${ACTIVE_FILE}`);
  }
}

function setActive(cwd: string, slug: string) {
  const active = loadActive();
  active[cwd] = { slug, updatedAt: new Date().toISOString() };
  writeAtomic(ACTIVE_FILE, JSON.stringify(active, null, 2) + "\n");
}

function findActive(cwd: string): { cwd: string; slug: string } | null {
  const active = loadActive();
  for (let d = cwd; ; d = dirname(d)) {
    const hit = active[d];
    if (hit && SLUG_RE.test(hit.slug)) return { cwd: d, slug: hit.slug };
    if (dirname(d) === d) return null;
  }
}

function validSlug(slug: string | undefined): string {
  if (!slug) throw new UserError("missing slug");
  if (!SLUG_RE.test(slug) || slug.length > 64) throw new UserError(`invalid slug "${slug}" (kebab-case, a-z 0-9, max 64)`);
  return slug;
}

function existing(slug: string): string {
  const dir = join(STATE_DIR, validSlug(slug));
  if (!existsSync(join(dir, "roadmap.md"))) throw new UserError(`no initiative "${slug}" (see: work list)`);
  return dir;
}

// "-" means the initiative active for --cwd (or the process cwd).
function resolveSlug(args: Args, raw: string | undefined): string {
  if (raw !== "-") return validSlug(raw);
  const hit = findActive(cwdOf(args));
  if (!hit) throw new UserError(`no active initiative for ${cwdOf(args)} (use: work use <slug>)`);
  return hit.slug;
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function stepsSection(lines: string[]): [number, number] {
  const start = lines.findIndex((l) => /^##\s+Steps\b/.test(l));
  if (start < 0) return [-1, -1];
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return [start, end];
}

function parseSteps(md: string): Step[] {
  const lines = md.split("\n");
  const [start, end] = stepsSection(lines);
  const steps: Step[] = [];
  for (let i = start + 1; i > 0 && i < end; i++) {
    const c = cells(lines[i]!);
    if (lines[i]!.trim().startsWith("|") && /^\d+$/.test(c[0] ?? "")) {
      steps.push({ n: Number(c[0]), step: c[1] ?? "", status: (c[c.length - 1] ?? "").toLowerCase() });
    }
  }
  return steps;
}

const currentStep = (steps: Step[]) =>
  steps.find((s) => s.status === "active") ?? steps.find((s) => s.status === "todo") ?? null;
const stepLine = (s: Step | null, steps: Step[]) =>
  s ? `step ${s.n}/${steps.length}: ${s.step} [${s.status}]` : steps.length ? "all steps done" : "no steps yet";

function info(slug: string): Info {
  const dir = existing(slug);
  const roadmap = join(dir, "roadmap.md");
  const handoff = join(dir, "handoff.md");
  const md = readFileSync(roadmap, "utf8");
  const mtimes = readdirSync(dir).map((f) => statSync(join(dir, f)).mtimeMs);
  return {
    slug,
    title: md.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug,
    dir,
    roadmap,
    decisions: join(dir, "decisions.md"),
    handoff: existsSync(handoff) ? handoff : null,
    step: currentStep(parseSteps(md)),
    updatedAt: new Date(Math.max(...mtimes)).toISOString(),
  };
}

function roadmapSkeleton(slug: string, title: string) {
  return `# ${title}
Slug: ${slug} · Created: ${stamp().slice(0, 10)} · Source: <ticket/thread/user narration>

## Problem
<2–4 sentences: what the user asked (Y) and the underlying problem (X)>

## Sub-problems
1. <sub-problem> → <workflow>

## Steps
| # | Step | Skill / agents | Produces | User involvement | Effort | Status |
|---|------|----------------|----------|------------------|--------|--------|

## Fresh-session points
- after step N: <why>

## Risks / open questions
- …
`;
}

function emit(json: boolean, data: unknown, human: () => void) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

// ---------- commands ----------

function cmdNew(args: Args) {
  allowFlags(args, ["--title", "--cwd"]);
  const slug = validSlug(args.pos[0]);
  const title = need(args, "--title");
  const dir = join(STATE_DIR, slug);
  if (existsSync(dir)) throw new UserError(`initiative "${slug}" already exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "roadmap.md"), roadmapSkeleton(slug, title));
  writeFileSync(join(dir, "decisions.md"), `# Decisions: ${title}\n`);
  const cwd = cwdOf(args);
  setActive(cwd, slug);
  emit(args.flags.has("--json"), { slug, dir, cwd }, () => {
    console.log(`created ${slug} at ${dir}`);
    console.log(`active for ${cwd}`);
  });
}

function cmdList(args: Args) {
  allowFlags(args, []);
  const active = loadActive();
  const slugs = existsSync(STATE_DIR)
    ? readdirSync(STATE_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && SLUG_RE.test(e.name) && existsSync(join(STATE_DIR, e.name, "roadmap.md")))
        .map((e) => e.name)
    : [];
  const rows = slugs.map((slug) => {
    const i = info(slug);
    const steps = parseSteps(readFileSync(i.roadmap, "utf8"));
    const cwds = Object.entries(active).filter(([, v]) => v.slug === slug).map(([k]) => k);
    return { slug, title: i.title, step: stepLine(i.step, steps), updatedAt: i.updatedAt, activeCwds: cwds };
  });
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  emit(args.flags.has("--json"), rows, () => {
    if (!rows.length) return console.log("no initiatives");
    for (const r of rows) {
      console.log(`${r.slug}  ${r.title}`);
      console.log(`  ${r.step} · updated ${r.updatedAt}`);
      for (const c of r.activeCwds) console.log(`  active in ${c}`);
    }
  });
}

function cmdUse(args: Args) {
  allowFlags(args, ["--cwd"]);
  const slug = validSlug(args.pos[0]);
  existing(slug);
  const cwd = cwdOf(args);
  setActive(cwd, slug);
  emit(args.flags.has("--json"), { slug, cwd }, () => console.log(`${slug} active for ${cwd}`));
}

function cmdCurrent(args: Args) {
  allowFlags(args, ["--cwd"]);
  const cwd = cwdOf(args);
  const hit = findActive(cwd);
  if (!hit) {
    return emit(args.flags.has("--json"), { slug: null, cwd }, () => console.log(`no active initiative for ${cwd}`));
  }
  const i = info(hit.slug);
  const steps = parseSteps(readFileSync(i.roadmap, "utf8"));
  emit(args.flags.has("--json"), { ...i, stepLine: stepLine(i.step, steps), activeFor: hit.cwd }, () => {
    console.log(`${i.title} (${i.slug})`);
    console.log(`current: ${stepLine(i.step, steps)}`);
    console.log(`roadmap: ${i.roadmap}`);
    console.log(`decisions: ${i.decisions}`);
    console.log(`handoff: ${i.handoff ?? "none yet"}`);
  });
}

function cmdDecide(args: Args) {
  allowFlags(args, ["--title", "--chosen", "--why", "--options", "--by", "--cwd"]);
  const slug = resolveSlug(args, args.pos[0]);
  const dir = existing(slug);
  const title = need(args, "--title");
  const chosen = need(args, "--chosen");
  const why = need(args, "--why");
  const by = str(args, "--by") ?? "user";
  if (by !== "user" && by !== "claude") throw new UserError(`--by must be user or claude`);
  const options = str(args, "--options")?.split("|").map((o) => o.trim()).filter(Boolean) ?? [];
  const entry = [
    `\n## ${stamp()} ${title}`,
    `- Options considered: ${options.length ? options.join(" | ") : "-"}`,
    `- Chosen: ${chosen}`,
    `- Why: ${why}`,
    `- Decided by: ${by === "user" ? "user" : "claude-with-approval"}`,
    "",
  ].join("\n");
  const file = join(dir, "decisions.md");
  writeAtomic(file, (existsSync(file) ? readFileSync(file, "utf8") : "") + entry);
  emit(args.flags.has("--json"), { slug, file, title }, () => console.log(`logged "${title}" in ${file}`));
}

function cmdStep(args: Args) {
  allowFlags(args, ["--cwd"]);
  const slug = resolveSlug(args, args.pos[0]);
  const [nRaw, status] = [args.pos[1], args.pos[2]];
  if (!nRaw || !/^\d+$/.test(nRaw)) throw new UserError("usage: work step <slug|-> <n> <todo|active|done|skipped>");
  if (!status || !STATUSES.includes(status)) throw new UserError(`status must be one of ${STATUSES.join(", ")}`);
  const file = join(existing(slug), "roadmap.md");
  const lines = readFileSync(file, "utf8").split("\n");
  const [start, end] = stepsSection(lines);
  if (start < 0) throw new UserError(`no "## Steps" section in ${file}`);
  const idx = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\|\\s*${Number(nRaw)}\\s*\\|`).test(l));
  if (idx < 0) {
    const count = parseSteps(lines.join("\n")).length;
    throw new UserError(`step ${nRaw} not found in ${slug} (${count ? `steps 1-${count}` : "no steps yet"})`);
  }
  const parts = lines[idx]!.trimEnd().split("|");
  // parts: ["", " n ", ..., " status ", ""]
  parts[parts.length - 2] = ` ${status} `;
  lines[idx] = parts.join("|");
  writeAtomic(file, lines.join("\n"));
  emit(args.flags.has("--json"), { slug, step: Number(nRaw), status }, () => console.log(`${slug} step ${nRaw} → ${status}`));
}

async function copy(text: string): Promise<boolean> {
  const pbcopy = Bun.which("pbcopy");
  if (!pbcopy) return false;
  const proc = Bun.spawn([pbcopy], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  proc.stdin.write(text);
  proc.stdin.end();
  return (await proc.exited) === 0;
}

async function cmdHandoff(args: Args) {
  allowFlags(args, ["--file", "--mode", "--focus", "--resume", "--cwd"]);
  const slug = resolveSlug(args, args.pos[0]);
  const dir = existing(slug);
  const mode = str(args, "--mode") ?? "handoff";
  if (mode !== "handoff" && mode !== "compact") throw new UserError("--mode must be handoff or compact");
  const src = str(args, "--file");
  if (mode === "handoff" && !src) throw new UserError("--file is required in handoff mode");
  const focus = mode === "compact" ? need(args, "--focus") : undefined;

  let archived: string | null = null;
  let written: string | null = null;
  if (src) {
    if (!existsSync(src) || !statSync(src).isFile()) throw new UserError(`no such file ${src}`);
    const body = readFileSync(src, "utf8");
    if (!body.trim()) throw new UserError(`${src} is empty`);
    written = join(dir, "handoff.md");
    if (existsSync(written)) {
      const d = new Date();
      const t = `${stamp(d).replace(/[-:]/g, "").replace(" ", "-")}${pad(d.getSeconds())}`;
      archived = join(dir, `handoff-${t}.md`);
      for (let i = 1; existsSync(archived); i++) archived = join(dir, `handoff-${t}-${i}.md`);
      renameSync(written, archived);
    }
    writeAtomic(written, body.endsWith("\n") ? body : body + "\n");
  }

  const l = mode === "compact" ? null : launcher();
  const starter = l ? startLine(str(args, "--resume") ?? `/brainstorm resume ${slug}`, l) : `/compact ${focus}`;
  const inSession = l ? resumeLines(slug, l).inSession : null;
  const copied = await copy(starter);
  emit(args.flags.has("--json"), { slug, mode, handoff: written, archived, starter, inSession, copied }, () => {
    if (archived) console.log(`archived previous handoff to ${archived}`);
    if (written) console.log(`wrote ${written}`);
    console.log(copied ? `copied to clipboard: ${starter}` : `pbcopy unavailable, copy this: ${starter}`);
    if (inSession) console.log(`in an open session: ${inSession}`);
  });
}

const USAGE = `usage: work <command>
  new <slug> --title "<t>" [--cwd <dir>]       create an initiative, mark it active for cwd
  list [--json]                                 initiatives with current step and active cwds
  use <slug> [--cwd <dir>]                      mark an initiative active for cwd
  current [--cwd <dir>] [--json]                active initiative for cwd (walks up parents)
  decide <slug|-> --title "…" --chosen "…" --why "…" [--options "a | b"] [--by user|claude]
  step <slug|-> <n> <todo|active|done|skipped>  set the Status of roadmap step n
  handoff <slug|-> --file <draft.md> [--mode handoff|compact] [--focus "…"] [--resume "<cmd>"]
  ("-" = the initiative active for cwd)`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "new":
      return cmdNew(args);
    case "list":
      return cmdList(args);
    case "use":
      return cmdUse(args);
    case "current":
      return cmdCurrent(args);
    case "decide":
      return cmdDecide(args);
    case "step":
      return cmdStep(args);
    case "handoff":
      return cmdHandoff(args);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`work: ${e instanceof UserError ? e.message : ((e as Error)?.message ?? e)}`);
  process.exit(1);
});
