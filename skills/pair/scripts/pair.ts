#!/usr/bin/env bun
// Slice ladder for the pair skill: state/work/<slug>/pair.json (never in the repo or .git). Validates and
// stores the plan, reports status and the timeline, checks the working tree against the planned commit,
// commits what is staged with a reasoning message, verifies every commit of a slice passes its check, and
// prints the walkthrough. Deterministic file and git ops only; the skill and the builder agent write code.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const STATE_DIR = process.env.PAIR_STATE_DIR || join(import.meta.dir, "..", "..", "..", "state", "work");
const WORK_TS = join(import.meta.dir, "..", "..", "..", "bin", "work.ts");
const SPEC_TS = join(import.meta.dir, "..", "..", "spec", "scripts", "spec.ts");
const BR_TS = join(import.meta.dir, "..", "..", "branch", "scripts", "br.ts");
const DB_GUARD = join(import.meta.dir, "..", "..", "..", "hooks", "db-guard.js");
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CC_TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
const TITLE_RE = new RegExp(`^(${CC_TYPES.join("|")})(\\([\\w./-]+\\))?!?: \\S.*$`);
const TITLE_MAX = 72;
const MAX_BUDGET = 500;
const DEFAULT_CAP = 5;
const EXIT_STOP = 2;
const SLICE_STATUSES = ["todo", "active", "checkpoint", "done"] as const;
const VALUE_FLAGS = new Set(["--slug", "--why", "--notes", "--alt", "--deviation", "--noticed", "--checked", "--slice", "--commit", "--title"]);

type Args = { pos: string[]; flags: Map<string, string | true> };
type SliceStatus = (typeof SLICE_STATUSES)[number];
type Exception = { what: string; why: string; approved: boolean };
export type Commit = {
  n: number;
  title: string;
  why: string;
  files: string[];
  est_lines: number;
  check: string;
  acs: string[];
  status: "todo" | "done";
  sha?: string;
  done_at?: string;
  extra?: boolean;
};
export type Slice = {
  n: number;
  title: string;
  goal: string;
  after: string;
  branch: string;
  acs: string[];
  test_script: string[];
  patterns: string[];
  exceptions: Exception[];
  est_days: number;
  target_date?: string;
  budget: { net_lines: number };
  milestone?: string;
  ticket?: string;
  green_check?: string;
  prefactor?: boolean;
  why?: string;
  status: SliceStatus;
  commits: Commit[];
  started_at?: string;
  done_at?: string;
  net_lines?: number;
  net_at?: string;
};
export type Pair = { slug: string; repo: string; mode: "on" | "off"; deadline?: string; cap: number; base: string; slices: Slice[] };
export type Change = { kind: "A" | "M" | "D" | "R" | "C" | "T"; path: string; from?: string };
type Net = { ins: number; del: number; net: number };

class UserError extends Error {}

const warnings: string[] = [];
function warn(msg: string) {
  if (warnings.includes(msg)) return;
  warnings.push(msg);
  console.error(`warning: ${msg}`);
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const tail = (s: string, n: number) => s.trimEnd().split("\n").slice(-n).join("\n");
const short = (sha: string) => sha.slice(0, 7);
const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// Checks run through a shell (git rebase -x) that the PreToolUse db-guard never sees, since it only gets
// `bun pair.ts …`; so every check passes the same guard here before it is saved, recorded or run.
let dbGuard: { check: (tool: string, input: { command: string }) => string | null } | null = null;
export function guardCheck(cmd: string): string | null {
  if (!dbGuard) {
    try {
      dbGuard = createRequire(import.meta.url)(DB_GUARD);
    } catch (e) {
      throw new UserError(`cannot load the DB guard ${DB_GUARD}; refusing to accept check commands: ${(e as Error).message}`);
    }
  }
  const reason = dbGuard!.check("Bash", { command: cmd });
  return reason ? `check \`${cmd}\` is refused by the DB guard (${reason}); checks never touch a database` : null;
}

function assertCheck(cmd: string) {
  const refused = guardCheck(cmd);
  if (refused) throw new UserError(refused);
}

async function exec(cmd: string[], cwd?: string, env?: Record<string, string>) {
  let proc;
  try {
    proc = Bun.spawn(cmd, { cwd, env: env ? { ...process.env, ...env } : undefined, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (e) {
    throw new UserError(`could not run ${cmd[0]}: ${(e as Error).message}`);
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trimEnd(), err: err.trim() };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec(["git", ...args], cwd);
  if (r.code !== 0) throw new UserError(`git ${args[0]}: ${firstLine(r.err) || `exited ${r.code}`}`);
  return r.out;
}

async function gitOk(cwd: string, ...args: string[]): Promise<string | null> {
  const r = await exec(["git", ...args], cwd);
  return r.code === 0 ? r.out : null;
}

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
  for (const f of args.flags.keys()) if (f !== "--json" && f !== "--slug" && !allowed.includes(f)) throw new UserError(`unknown flag ${f}`);
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
const intFlag = (args: Args, flag: string) => {
  const v = str(args, flag);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UserError(`${flag} must be a number`);
  return Number(v);
};

function writeAtomic(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function readJson(file: string, what: string): unknown {
  if (!existsSync(file)) throw new UserError(`no such file ${file}`);
  if (lstatSync(file).isSymbolicLink()) throw new UserError(`${file} is a symlink, refusing`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UserError(`could not parse ${what} ${file}: ${(e as Error).message}`);
  }
}

function emit(json: boolean, data: unknown, human: () => void) {
  if (json) console.log(JSON.stringify(warnings.length ? { ...(data as object), warnings } : data, null, 2));
  else human();
}

// ---------- pure helpers (unit-tested) ----------

export function validTitle(title: string): string | null {
  if (!TITLE_RE.test(title)) return `"${title}" is not a Conventional Commit title (type(scope)?: summary; types: ${CC_TYPES.join(", ")})`;
  if (title.length > TITLE_MAX) return `"${title}" is ${title.length} chars (max ${TITLE_MAX})`;
  return null;
}

const isDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

// specAcs: id -> superseded, or null when the initiative has no spec.
export function validatePlan(raw: unknown, ctx: { slug: string; repo: string | null; specAcs: Map<string, boolean> | null }) {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { plan: null, problems: ["plan must be a JSON object"], notes };
  const r = raw as Record<string, unknown>;
  if (r.slug !== undefined && r.slug !== ctx.slug) problems.push(`slug "${String(r.slug)}" does not match the initiative "${ctx.slug}"`);
  const repo = r.repo ?? ctx.repo;
  if (!isStr(repo) || !isAbsolute(repo)) problems.push("repo must be the absolute path of the main checkout");
  const mode = r.mode ?? "on";
  if (mode !== "on" && mode !== "off") problems.push(`mode must be on or off`);
  if (r.deadline !== undefined && !isDate(r.deadline)) problems.push(`deadline must be YYYY-MM-DD`);
  const cap = r.cap ?? DEFAULT_CAP;
  if (!Number.isInteger(cap) || (cap as number) < 1) problems.push("cap must be a positive integer");
  if (!isStr(r.base)) problems.push("base (the integration target from br target) is required");
  if (!Array.isArray(r.slices) || !r.slices.length) {
    problems.push("slices must be a non-empty array");
    return { plan: null, problems, notes };
  }

  const branches = new Set<string>();
  const slices: Slice[] = r.slices.map((rawSlice, i) => {
    const s = (rawSlice ?? {}) as Record<string, unknown>;
    const label = `slice ${i + 1}${isStr(s.title) ? ` "${s.title}"` : ""}`;
    const bad = (m: string) => problems.push(`${label}: ${m}`);
    if (s.n !== i + 1) bad(`n must be ${i + 1} (slices are numbered 1..N in order; got ${JSON.stringify(s.n)})`);
    for (const k of ["title", "goal", "after", "branch"]) if (!isStr(s[k])) bad(`${k} is required`);
    if (isStr(s.branch)) {
      if (branches.has(s.branch)) bad(`branch ${s.branch} is used by another slice`);
      branches.add(s.branch);
    }
    if (s.prefactor !== undefined && typeof s.prefactor !== "boolean") bad("prefactor must be true or false");
    if (!strList(s.acs)) bad("acs must be a list of AC ids");
    else if (!s.acs.length) {
      if (s.prefactor !== true) bad("acs must list at least one AC id (a prefactor slice sets prefactor: true and why)");
      else if (!isStr(s.why)) bad("a prefactor slice with no ACs needs why (the reason it must come first)");
    } else
      for (const id of s.acs) {
        if (!/^AC-\d+$/.test(id)) bad(`"${id}" is not an AC id (AC-<n>)`);
        else if (ctx.specAcs && !ctx.specAcs.has(id)) bad(`${id} is not in the spec`);
        else if (ctx.specAcs?.get(id)) bad(`${id} is superseded in the spec`);
      }
    if (!strList(s.test_script) || !s.test_script.length) bad("test_script needs at least one step");
    if (s.patterns !== undefined && !strList(s.patterns)) bad("patterns must be a list of strings");
    const exceptions = Array.isArray(s.exceptions) ? s.exceptions : s.exceptions === undefined ? [] : null;
    if (!exceptions) bad("exceptions must be a list");
    else
      exceptions.forEach((e, j) => {
        const x = (e ?? {}) as Record<string, unknown>;
        if (!isStr(x.what) || !isStr(x.why) || typeof x.approved !== "boolean") bad(`exceptions[${j}] needs what, why and approved (true/false)`);
        else if (!x.approved) notes.push(`${label}: exception "${x.what}" is not approved yet`);
      });
    if (typeof s.est_days !== "number" || !(s.est_days > 0)) bad("est_days must be a positive number");
    if (s.target_date !== undefined && !isDate(s.target_date)) bad("target_date must be YYYY-MM-DD");
    const budget = (s.budget as { net_lines?: unknown } | undefined)?.net_lines ?? MAX_BUDGET;
    if (!Number.isInteger(budget) || (budget as number) < 1) bad("budget.net_lines must be a positive integer");
    else if ((budget as number) > MAX_BUDGET) bad(`budget ${budget} net lines is over the ${MAX_BUDGET} limit; split the slice`);
    for (const k of ["milestone", "ticket", "green_check", "why"]) if (s[k] !== undefined && !isStr(s[k])) bad(`${k} must be a non-empty string`);
    if (isStr(s.green_check)) {
      const refused = guardCheck(s.green_check);
      if (refused) bad(`green_check: ${refused}`);
    }
    const status = s.status ?? "todo";
    if (!SLICE_STATUSES.includes(status as SliceStatus)) bad(`status must be one of ${SLICE_STATUSES.join(", ")}`);

    const titles = new Set<string>();
    const rawCommits = Array.isArray(s.commits) ? s.commits : [];
    if (!rawCommits.length) bad("needs at least one planned commit");
    const commits: Commit[] = rawCommits.map((rawCommit, j) => {
      const c = (rawCommit ?? {}) as Record<string, unknown>;
      const cbad = (m: string) => bad(`commit ${j + 1}: ${m}`);
      if (c.n !== j + 1) cbad(`n must be ${j + 1}`);
      if (!isStr(c.title)) cbad("title is required");
      else {
        const t = validTitle(c.title);
        if (t) cbad(t);
        if (titles.has(c.title)) cbad(`title "${c.title}" appears twice in the slice`);
        titles.add(c.title);
      }
      if (!isStr(c.why)) cbad("why is required");
      if (!strList(c.files) || !c.files.length) cbad("files must list at least one path");
      else for (const f of c.files) if (isAbsolute(f) || f.startsWith("..")) cbad(`file "${f}" must be relative to the repo root`);
      if (!Number.isInteger(c.est_lines) || (c.est_lines as number) < 0) cbad("est_lines must be a non-negative integer");
      if (!isStr(c.check)) cbad("check (the command that proves it) is required");
      else {
        const refused = guardCheck(c.check);
        if (refused) cbad(refused);
      }
      if (c.acs !== undefined && !strList(c.acs)) cbad("acs must be a list of AC ids");
      else
        for (const id of (c.acs as string[] | undefined) ?? []) {
          if (ctx.specAcs && !ctx.specAcs.has(id)) cbad(`${id} is not in the spec`);
          else if (strList(s.acs) && !s.acs.includes(id)) notes.push(`${label} commit ${j + 1}: ${id} is not one of the slice's ACs`);
        }
      if (c.status !== undefined && c.status !== "todo" && c.status !== "done") cbad("status must be todo or done");
      const out: Commit = {
        n: j + 1,
        title: String(c.title ?? ""),
        why: String(c.why ?? ""),
        files: strList(c.files) ? c.files : [],
        est_lines: Number(c.est_lines ?? 0),
        check: String(c.check ?? ""),
        acs: strList(c.acs) ? c.acs : [],
        status: c.status === "done" ? "done" : "todo",
      };
      for (const k of ["sha", "done_at"] as const) if (isStr(c[k])) out[k] = c[k] as string;
      if (c.extra === true) out.extra = true;
      return out;
    });
    const est = commits.reduce((a, c) => a + c.est_lines, 0);
    if (Number.isInteger(budget) && est > (budget as number)) bad(`commits estimate ${est} net lines, over the slice budget ${budget}; split the slice`);

    const out: Slice = {
      n: i + 1,
      title: String(s.title ?? ""),
      goal: String(s.goal ?? ""),
      after: String(s.after ?? ""),
      branch: String(s.branch ?? ""),
      acs: strList(s.acs) ? s.acs : [],
      test_script: strList(s.test_script) ? s.test_script : [],
      patterns: strList(s.patterns) ? s.patterns : [],
      exceptions: (exceptions ?? []) as Exception[],
      est_days: Number(s.est_days),
      budget: { net_lines: Number(budget) },
      status: status as SliceStatus,
      commits,
    };
    for (const k of ["target_date", "milestone", "ticket", "green_check", "why", "started_at", "done_at", "net_at"] as const)
      if (isStr(s[k])) out[k] = s[k] as string;
    if (s.prefactor === true) out.prefactor = true;
    if (typeof s.net_lines === "number") out.net_lines = s.net_lines;
    return out;
  });

  if (ctx.specAcs) {
    const covered = new Set(slices.flatMap((s) => s.acs));
    const missing = [...ctx.specAcs].filter(([id, sup]) => !sup && !covered.has(id)).map(([id]) => id);
    if (missing.length) notes.push(`ACs not covered by any slice: ${missing.join(", ")}`);
  }
  const plan: Pair = {
    slug: ctx.slug,
    repo: String(repo),
    mode: mode as "on" | "off",
    ...(isDate(r.deadline) ? { deadline: r.deadline } : {}),
    cap: Number(cap),
    base: String(r.base ?? ""),
    slices,
  };
  return { plan, problems, notes };
}

// Carries progress from the stored plan into a replacement: slice status and timestamps by slice n,
// done commits by slice n + commit title, extra (unplanned) commits appended. Returns a readable diff.
export function mergePlan(old: Pair | null, next: Pair): { plan: Pair; diff: string[]; dropped: string[] } {
  if (!old) {
    const commits = next.slices.reduce((a, s) => a + s.commits.length, 0);
    return { plan: next, diff: [`new plan: ${next.slices.length} slices, ${commits} commits`], dropped: [] };
  }
  const diff: string[] = [];
  const dropped: string[] = [];
  for (const s of next.slices) {
    const o = old.slices.find((x) => x.n === s.n);
    if (!o) {
      diff.push(`+ slice ${s.n} "${s.title}"`);
      continue;
    }
    for (const k of ["title", "branch", "after"] as const) if (o[k] !== s[k]) diff.push(`~ slice ${s.n}: ${k} "${o[k]}" → "${s[k]}"`);
    if (o.budget.net_lines !== s.budget.net_lines) diff.push(`~ slice ${s.n}: budget ${o.budget.net_lines} → ${s.budget.net_lines}`);
    if (o.est_days !== s.est_days) diff.push(`~ slice ${s.n}: est_days ${o.est_days} → ${s.est_days}`);
    if (o.acs.join(",") !== s.acs.join(",")) diff.push(`~ slice ${s.n}: acs ${o.acs.join(", ")} → ${s.acs.join(", ")}`);
    if (s.status === "todo" && o.status !== "todo") s.status = o.status;
    for (const k of ["started_at", "done_at", "net_at"] as const) if (o[k] && !s[k]) s[k] = o[k];
    if (o.net_lines !== undefined && s.net_lines === undefined) s.net_lines = o.net_lines;
    for (const c of s.commits) {
      const oc = o.commits.find((x) => x.title === c.title);
      if (!oc) diff.push(`  slice ${s.n}: + commit "${c.title}"`);
      else if (oc.status === "done" && c.status === "todo") {
        c.status = "done";
        if (oc.sha) c.sha = oc.sha;
        if (oc.done_at) c.done_at = oc.done_at;
      }
    }
    for (const oc of o.commits) {
      if (s.commits.some((c) => c.title === oc.title)) continue;
      if (oc.extra) {
        s.commits.push({ ...oc, n: s.commits.length + 1 });
        continue;
      }
      diff.push(`  slice ${s.n}: - commit "${oc.title}"`);
      if (oc.status === "done") dropped.push(`slice ${s.n} commit "${oc.title}" (${oc.sha ? short(oc.sha) : "no sha"}) is done but no longer planned`);
    }
  }
  for (const o of old.slices) {
    if (next.slices.some((s) => s.n === o.n)) continue;
    diff.push(`- slice ${o.n} "${o.title}"`);
    for (const oc of o.commits) if (oc.status === "done") dropped.push(`slice ${o.n} commit "${oc.title}" is done but its slice was removed`);
  }
  if (!diff.length) diff.push("no plan changes");
  return { plan: next, diff, dropped };
}

export function stackPlan(p: Pair) {
  return { base: p.base, branches: p.slices.map((s) => ({ name: s.branch, title: s.title })) };
}

// `git diff --name-status -z [-M]` output.
export function parseNameStatus(out: string): Change[] {
  const t = out.split("\0").filter((x) => x !== "");
  const changes: Change[] = [];
  for (let i = 0; i < t.length; ) {
    const code = t[i++]!;
    const kind = code[0] as Change["kind"];
    if (kind === "R" || kind === "C") {
      const from = t[i++]!;
      changes.push({ kind, from, path: t[i++]! });
    } else if ("AMDT".includes(kind)) changes.push({ kind, path: t[i++]! });
    else throw new UserError(`unsupported change "${code}" for ${t[i]} (resolve conflicts first)`);
  }
  return changes;
}

// `git status --porcelain=v1 -z --untracked-files=all` -> every path touched (both sides of a rename).
export function parsePorcelainPaths(out: string): string[] {
  const t = out.split("\0").filter((x) => x !== "");
  const paths: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const entry = t[i]!;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") paths.push(t[++i]!);
  }
  return [...new Set(paths)];
}

export function parseShortstat(out: string): Net {
  const ins = Number(out.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0);
  const del = Number(out.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0);
  return { ins, del, net: ins - del };
}

// A planned entry is an exact path, a directory ending in "/", or a glob.
export function inPlan(path: string, planned: string[]): boolean {
  return planned.some((p) => p === path || (p.endsWith("/") && path.startsWith(p)) || (/[*?[{]/.test(p) && new Bun.Glob(p).match(path)));
}

export function noteFor(notes: Record<string, unknown>, c: Change): string | null {
  const keys = c.from ? [c.path, `${c.from} → ${c.path}`, c.from] : [c.path];
  for (const k of keys) if (isStr(notes[k])) return (notes[k] as string).trim();
  return null;
}

export function buildMessage(m: {
  title: string;
  why: string;
  changes: (Change & { note: string })[];
  alt?: string;
  deviation?: string;
  noticed?: string;
  checked: string;
  acs: string[];
}): string {
  const groups: [string, (Change & { note: string })[]][] = [
    ["Added", m.changes.filter((c) => c.kind === "A" || c.kind === "C")],
    ["Modified", m.changes.filter((c) => c.kind === "M" || c.kind === "T" || c.kind === "R")],
    ["Deleted", m.changes.filter((c) => c.kind === "D")],
  ];
  const files = groups
    .filter(([, cs]) => cs.length)
    .flatMap(([name, cs]) => [`${name}:`, ...cs.map((c) => `- ${c.kind === "R" ? `${c.from} → ${c.path}` : c.path} — ${c.note}`)]);
  return [
    m.title,
    "",
    `Why: ${m.why}`,
    "",
    ...files,
    "",
    `Alternatives: ${m.alt?.trim() || "none considered"}`,
    `Deviation: ${m.deviation?.trim() || "none"}`,
    `Noticed (out of scope): ${m.noticed?.trim() || "nothing"}`,
    `Checked with: ${m.checked}`,
    `ACs: ${m.acs.length ? m.acs.join(", ") : "none"}`,
    "",
  ].join("\n");
}

const ymd = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const isWeekday = (d: Date) => d.getDay() !== 0 && d.getDay() !== 6;

// Weekdays from `from` through `to`, both inclusive (local dates).
export function workingDays(from: Date, to: Date): number {
  let n = 0;
  for (let d = ymd(from); d <= ymd(to); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) if (isWeekday(d)) n++;
  return n;
}

// Elapsed weekday time in days (24h each); weekends do not count.
export function elapsedWorkingDays(start: Date, now: Date): number {
  let ms = 0;
  for (let t = start.getTime(); t < now.getTime(); ) {
    const d = new Date(t);
    const next = Math.min(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(), now.getTime());
    if (isWeekday(d)) ms += next - t;
    t = next;
  }
  return ms / 86_400_000;
}

// At risk when more than 80% of the estimate is used with less than 80% of the planned commits done.
export function atRisk(elapsed: number, est: number, done: number, planned: number): boolean {
  return est > 0 && planned > 0 && elapsed > 0.8 * est && done < 0.8 * planned;
}

export function timeline(p: Pair, today: Date) {
  const planned = p.slices.reduce((a, s) => a + s.est_days, 0);
  const remaining = p.slices.filter((s) => s.status !== "done").reduce((a, s) => a + s.est_days, 0);
  const available = p.deadline ? workingDays(today, new Date(`${p.deadline}T00:00:00`)) : null;
  const gap = available === null ? null : remaining - available;
  return { planned, remaining, deadline: p.deadline ?? null, available, gap, atRisk: gap !== null && gap > 0 };
}

export const greenCheck = (s: Slice) => s.green_check ?? [...new Set(s.commits.map((c) => c.check).filter(Boolean))].join(" && ");
const planned = (s: Slice) => s.commits.filter((c) => !c.extra);
const nextCommit = (s: Slice) => planned(s).find((c) => c.status === "todo") ?? null;
const sliceFiles = (s: Slice) => [...new Set(s.commits.flatMap((c) => c.files))];
const currentSlice = (p: Pair) => p.slices.find((s) => s.status === "active" || s.status === "checkpoint") ?? null;

// ---------- state ----------

async function resolveSlug(args: Args): Promise<string> {
  const flag = str(args, "--slug");
  if (flag) {
    if (!SLUG_RE.test(flag)) throw new UserError(`invalid slug "${flag}"`);
    return flag;
  }
  const r = await exec([process.execPath, WORK_TS, "current", "--json"], process.cwd());
  if (r.code !== 0) throw new UserError(`work current failed: ${firstLine(r.err)}`);
  const slug = (JSON.parse(r.out) as { slug: string | null }).slug;
  if (!slug) throw new UserError(`no active initiative for ${process.cwd()} (work use <slug>, or pass --slug)`);
  return slug;
}

async function initiative(args: Args) {
  const slug = await resolveSlug(args);
  const dir = join(STATE_DIR, slug);
  if (!existsSync(dir)) throw new UserError(`no initiative directory ${dir}`);
  return { slug, dir, file: join(dir, "pair.json") };
}

async function load(args: Args) {
  const init = await initiative(args);
  if (!existsSync(init.file)) throw new UserError(`no plan for ${init.slug} yet (pair plan save <file>)`);
  const pair = readJson(init.file, "pair state") as Pair;
  if (!Array.isArray(pair?.slices)) throw new UserError(`${init.file} has no slices`);
  return { ...init, pair };
}

const save = (file: string, pair: Pair) => writeAtomic(file, JSON.stringify(pair, null, 2) + "\n");

function sliceArg(pair: Pair, raw: number | string | undefined, fallback: Slice | null): Slice {
  if (raw === undefined) {
    if (!fallback) throw new UserError("no active slice (pair slice start <n>), or pass --slice <n>");
    return fallback;
  }
  const n = Number(raw);
  const s = pair.slices.find((x) => x.n === n);
  if (!s) throw new UserError(`slice ${raw} not found (slices 1-${pair.slices.length})`);
  return s;
}

async function specAcs(dir: string): Promise<Map<string, boolean> | null> {
  const file = join(dir, "spec.md");
  if (!existsSync(file)) return null;
  const r = await exec([process.execPath, SPEC_TS, "acs", file, "--json"]);
  if (r.code !== 0) {
    let problems = [firstLine(r.err)];
    try {
      problems = (JSON.parse(r.out) as { problems: string[] }).problems;
    } catch {}
    throw new UserError(`the spec at ${file} does not pass spec check; fix it first: ${problems.slice(0, 3).join("; ")}`);
  }
  return new Map((JSON.parse(r.out) as { id: string; superseded: boolean }[]).map((a) => [a.id, a.superseded]));
}

// ---------- git ----------

// The checkout git runs in: the cwd's worktree, which must belong to the plan's repo.
async function checkout(pair: Pair): Promise<string> {
  const top = await gitOk(process.cwd(), "rev-parse", "--show-toplevel");
  if (top === null) throw new UserError(`not in a git checkout; run pair from ${pair.repo} or one of its worktrees`);
  const common = await git(top, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const planCommon = await gitOk(pair.repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (planCommon === null || real(common) !== real(planCommon)) throw new UserError(`${top} is not a checkout of ${pair.repo}`);
  return top;
}

const resolves = async (top: string, ref: string) => (await gitOk(top, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) !== null;

// Slice n stacks on slice n-1's branch; slice 1 on the integration target (origin first: br branches from it).
async function sliceBase(top: string, pair: Pair, s: Slice): Promise<string> {
  const prev = pair.slices.find((x) => x.n === s.n - 1);
  const target = pair.base.startsWith("origin/") ? [pair.base] : [`origin/${pair.base}`, pair.base];
  const cands = prev ? [prev.branch, `origin/${prev.branch}`, ...target] : target;
  for (const c of cands) if (await resolves(top, c)) return c;
  throw new UserError(`cannot resolve the base of slice ${s.n} (tried ${cands.join(", ")})`);
}

function countLines(file: string): number {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > 5_000_000) return 0;
    const buf = readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return 0;
    const text = buf.toString("utf8");
    if (!text) return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}

// Net lines from the slice base to the working tree: committed, staged, unstaged and untracked.
async function netLines(top: string, base: string): Promise<Net> {
  const mb = await git(top, "merge-base", base, "HEAD");
  const n = parseShortstat(await git(top, "diff", "--shortstat", mb));
  const untracked = (await git(top, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean);
  const extra = untracked.reduce((a, f) => a + countLines(join(top, f)), 0);
  return { ins: n.ins + extra, del: n.del, net: n.net + extra };
}

async function storeNet(top: string, pair: Pair, s: Slice): Promise<Net> {
  const net = await netLines(top, await sliceBase(top, pair, s));
  s.net_lines = net.net;
  s.net_at = new Date().toISOString();
  return net;
}

const branchOf = async (top: string) => (await gitOk(top, "branch", "--show-current")) || null;

// ---------- commands ----------

async function cmdPlanSave(args: Args) {
  allowFlags(args, []);
  const src = args.pos[1];
  if (!src) throw new UserError("usage: pair plan save <file.json>");
  const raw = readJson(resolve(src), "plan");
  const init = await initiative(args);
  const acs = await specAcs(init.dir);
  if (!acs) warn(`no spec for ${init.slug} (${join(init.dir, "spec.md")}); AC ids are not checked`);
  let repo: string | null = null;
  if (!(raw as Record<string, unknown>)?.repo) {
    const common = await gitOk(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir");
    repo = common && common.endsWith("/.git") ? dirname(common) : null;
  }
  const { plan, problems, notes } = validatePlan(raw, { slug: init.slug, repo, specAcs: acs });
  if (plan && !problems.length) {
    try {
      const { parsePlan } = await import(BR_TS);
      parsePlan(stackPlan(plan));
    } catch (e) {
      problems.push(`branches would not pass br stack: ${(e as Error).message}`);
    }
  }
  const json = args.flags.has("--json");
  if (problems.length || !plan) {
    if (json) console.log(JSON.stringify({ ok: false, problems }, null, 2));
    else for (const p of problems) console.error(`pair: ${p}`);
    process.exit(1);
  }
  for (const n of notes) warn(n);
  const old = existsSync(init.file) ? (readJson(init.file, "pair state") as Pair) : null;
  const { plan: merged, diff, dropped } = mergePlan(old, plan);
  for (const d of dropped) warn(d);
  save(init.file, merged);
  const stackFile = join(init.dir, "stack.json");
  writeAtomic(stackFile, JSON.stringify(stackPlan(merged), null, 2) + "\n");
  emit(json, { ok: true, file: init.file, stack: stackFile, slices: merged.slices.length, diff }, () => {
    console.log(`saved ${init.file}`);
    console.log(`stack plan ${stackFile} (br stack ${stackFile} --dry-run)`);
    for (const d of diff) console.log(d);
  });
}

async function cmdPlanShow(args: Args) {
  allowFlags(args, []);
  const { pair, dir } = await load(args);
  const acs = await specAcs(dir);
  const tl = timeline(pair, new Date());
  const ids = acs ? [...acs].filter(([, sup]) => !sup).map(([id]) => id) : [...new Set(pair.slices.flatMap((s) => s.acs))];
  const coverage = ids.map((id) => ({ id, slices: pair.slices.filter((s) => s.acs.includes(id)).map((s) => s.n) }));
  const uncovered = coverage.filter((c) => !c.slices.length).map((c) => c.id);
  const rows = pair.slices.map((s) => ({
    n: s.n,
    title: s.title,
    milestone: s.milestone ?? null,
    status: s.status,
    branch: s.branch,
    after: s.after,
    acs: s.acs,
    prefactor: Boolean(s.prefactor),
    est_days: s.est_days,
    target_date: s.target_date ?? null,
    budget: s.budget.net_lines,
    est_lines: s.commits.reduce((a, c) => a + c.est_lines, 0),
    commits: `${planned(s).filter((c) => c.status === "done").length}/${planned(s).length}`,
    exceptions: s.exceptions,
  }));
  emit(args.flags.has("--json"), { slug: pair.slug, mode: pair.mode, base: pair.base, cap: pair.cap, timeline: tl, slices: rows, coverage, uncovered, specAcs: Boolean(acs) }, () => {
    console.log(`${pair.slug} · base ${pair.base} · mode ${pair.mode} · open-PR cap ${pair.cap}`);
    let milestone: string | null | undefined;
    for (const r of rows) {
      if (r.milestone !== milestone) {
        milestone = r.milestone;
        console.log(`\n${milestone ?? "(no milestone)"}`);
      }
      console.log(`  ${r.n}. [${r.status}] ${r.title}  (${r.branch})`);
      console.log(`     after this you can ${r.after.replace(/^after this you can\s*/i, "")}`);
      console.log(`     ${r.acs.length ? `ACs ${r.acs.join(", ")}` : r.prefactor ? "prefactor (no AC)" : "no ACs"} · ${r.est_days}d${r.target_date ? ` by ${r.target_date}` : ""} · est ${r.est_lines}/${r.budget} net lines · commits ${r.commits}`);
      for (const e of r.exceptions) console.log(`     exception${e.approved ? "" : " (NOT APPROVED)"}: ${e.what} — ${e.why}`);
    }
    console.log("");
    if (tl.deadline === null) console.log(`timeline: ${tl.planned}d planned, ${tl.remaining}d remaining, no deadline`);
    else
      console.log(
        `timeline: ${tl.remaining}d remaining of ${tl.planned}d planned; ${tl.available} working days to ${tl.deadline}` +
          (tl.atRisk ? ` · AT RISK: ${tl.gap}d over (cut scope, flag, follow-up slice, or move the date)` : " · on track"),
      );
    console.log(`AC coverage${acs ? "" : " (no spec; plan ACs only)"}:`);
    for (const c of coverage) console.log(`  ${c.id} → ${c.slices.length ? `slice ${c.slices.join(", ")}` : "UNCOVERED"}`);
  });
}

async function cmdStatus(args: Args) {
  allowFlags(args, []);
  const { pair, file } = await load(args);
  const s = currentSlice(pair);
  const json = args.flags.has("--json");
  if (!s) {
    const next = pair.slices.find((x) => x.status === "todo");
    const data = { slug: pair.slug, mode: pair.mode, slice: null, next: next ? { n: next.n, title: next.title } : null };
    return emit(json, data, () => {
      console.log(`${pair.slug} · mode ${pair.mode} · no active slice`);
      console.log(next ? `next: pair slice start ${next.n} ("${next.title}")` : "all slices done");
    });
  }
  let net: Net | null = null;
  let head: string | null = null;
  try {
    const top = await checkout(pair);
    head = await branchOf(top);
    net = await storeNet(top, pair, s);
    save(file, pair);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    warn(`net lines not measured (${e.message}); showing the stored value`);
  }
  const plannedCommits = planned(s);
  const done = plannedCommits.filter((c) => c.status === "done").length;
  const next = nextCommit(s);
  const elapsed = s.started_at ? elapsedWorkingDays(new Date(s.started_at), new Date()) : null;
  const risk = elapsed !== null && atRisk(elapsed, s.est_days, done, plannedCommits.length);
  const data = {
    slug: pair.slug,
    mode: pair.mode,
    slice: { n: s.n, of: pair.slices.length, title: s.title, status: s.status, branch: s.branch, head },
    commit: next ? { n: next.n, title: next.title, files: next.files, check: next.check } : null,
    commits: { done, planned: plannedCommits.length, extra: s.commits.length - plannedCommits.length },
    net_lines: net?.net ?? s.net_lines ?? null,
    net_measured: Boolean(net),
    insertions: net?.ins ?? null,
    deletions: net?.del ?? null,
    budget: s.budget.net_lines,
    elapsed_days: elapsed === null ? null : Math.round(elapsed * 10) / 10,
    est_days: s.est_days,
    at_risk: risk,
  };
  emit(json, data, () => {
    console.log(`${pair.slug} · mode ${pair.mode}`);
    console.log(`slice ${s.n}/${pair.slices.length} "${s.title}" [${s.status}] on ${s.branch}${head && head !== s.branch ? ` (HEAD is ${head})` : ""}`);
    console.log(next ? `commit ${next.n}/${plannedCommits.length} next: ${next.title}` : `all ${plannedCommits.length} planned commits done${s.status === "active" ? "" : " · checkpoint"}`);
    console.log(`commits ${done}/${plannedCommits.length} done${data.commits.extra ? ` (+${data.commits.extra} extra)` : ""}`);
    const n = data.net_lines;
    console.log(`net lines ${n === null ? "unknown" : signed(n)}/${s.budget.net_lines}${net ? ` (+${net.ins} −${net.del})` : " (stored)"}`);
    console.log(elapsed === null ? `time: not started (est ${s.est_days}d)` : `time ${data.elapsed_days} of ${s.est_days} working days${risk ? " · AT RISK (>80% time used, <80% commits done)" : ""}`);
  });
}

async function cmdCheck(args: Args) {
  allowFlags(args, []);
  const { pair } = await load(args);
  const s = sliceArg(pair, undefined, currentSlice(pair));
  const top = await checkout(pair);
  const head = await branchOf(top);
  if (head !== s.branch) warn(`HEAD is ${head ?? "detached"}, slice ${s.n} is on ${s.branch}`);
  const commit = nextCommit(s);
  const plannedFiles = commit ? commit.files : sliceFiles(s);
  const changed = parsePorcelainPaths(await git(top, "status", "--porcelain=v1", "-z", "--untracked-files=all"));
  const outOfPlan = changed.filter((p) => !inPlan(p, plannedFiles));
  const net = await netLines(top, await sliceBase(top, pair, s));
  const over = net.net > s.budget.net_lines;
  const ok = !outOfPlan.length && !over;
  const target = commit ? `commit ${commit.n} "${commit.title}"` : `slice ${s.n} (checkpoint: any planned file of the slice)`;
  emit(args.flags.has("--json"), { ok, slice: s.n, commit: commit?.n ?? null, planned: plannedFiles, changed, outOfPlan, net: net.net, budget: s.budget.net_lines, over }, () => {
    if (ok) {
      console.log(`ok: ${changed.length} changed file(s) within ${target}; net lines ${signed(net.net)}/${s.budget.net_lines}`);
      return;
    }
    console.log(`STOP: ask the user before going on`);
    if (outOfPlan.length) {
      console.log(`files outside ${target}:`);
      for (const p of outOfPlan) console.log(`  ${p}`);
      console.log(`planned: ${plannedFiles.join(", ")}`);
    }
    if (over) console.log(`budget: ${signed(net.net)}/${s.budget.net_lines} net lines, over by ${net.net - s.budget.net_lines}`);
    console.log(`options: split the work, move it to another commit or slice, or raise the limit with a recorded reason`);
  });
  if (!ok) process.exit(EXIT_STOP);
}

async function cmdCommit(args: Args) {
  allowFlags(args, ["--why", "--notes", "--alt", "--deviation", "--noticed", "--checked", "--title"]);
  const why = need(args, "--why");
  const notesFile = need(args, "--notes");
  const extraTitle = str(args, "--title")?.trim();
  const deviation = str(args, "--deviation")?.trim();
  const { pair, file } = await load(args);
  const s = currentSlice(pair);
  if (!s) throw new UserError("no active slice (pair slice start <n>)");
  const top = await checkout(pair);
  const head = await branchOf(top);
  if (head !== s.branch) throw new UserError(`HEAD is ${head ?? "detached"}; slice ${s.n} commits go on ${s.branch} (br new ${s.branch} --here)`);

  let commit: Commit | null = null;
  if (extraTitle) {
    const bad = validTitle(extraTitle);
    if (bad) throw new UserError(bad);
  } else {
    commit = nextCommit(s);
    if (!commit) throw new UserError(`every planned commit of slice ${s.n} is done; pass --title "<type(scope): summary>" for an extra commit`);
  }
  const staged = parseNameStatus(await git(top, "diff", "--cached", "--name-status", "-z", "-M"));
  if (!staged.length) throw new UserError("nothing staged; stage the planned files explicitly (git add <path>…)");
  const plannedFiles = commit ? commit.files : sliceFiles(s);
  const outside = [...new Set(staged.flatMap((c) => (c.from ? [c.from, c.path] : [c.path])))].filter((p) => !inPlan(p, plannedFiles));
  if (outside.length && !deviation)
    throw new UserError(`staged files outside the planned commit: ${outside.join(", ")} (unstage them, or pass --deviation "<why>")`);
  const notes = readJson(resolve(notesFile), "notes") as Record<string, unknown>;
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) throw new UserError(`${notesFile} must map each staged path to a one-line note`);
  const missing = staged.filter((c) => !noteFor(notes, c)).map((c) => c.path);
  if (missing.length) throw new UserError(`no note for staged path(s): ${missing.join(", ")}`);
  const stagedKeys = new Set(staged.flatMap((c) => (c.from ? [c.path, c.from, `${c.from} → ${c.path}`] : [c.path])));
  for (const k of Object.keys(notes)) if (!stagedKeys.has(k)) warn(`note for ${k} ignored: not staged`);

  const title = commit ? commit.title : extraTitle!;
  const acs = commit ? commit.acs : [];
  const checked = str(args, "--checked")?.trim() || commit?.check || greenCheck(s);
  assertCheck(checked);
  const message = buildMessage({
    title,
    why,
    changes: staged.map((c) => ({ ...c, note: noteFor(notes, c)! })),
    alt: str(args, "--alt"),
    deviation,
    noticed: str(args, "--noticed"),
    checked,
    acs,
  });
  const tmp = mkdtempSync(join(tmpdir(), "pair-msg-"));
  const msgFile = join(tmp, "COMMIT_MSG");
  writeFileSync(msgFile, message);
  try {
    const r = await exec(["git", "commit", "-F", msgFile], top);
    if (r.code !== 0) throw new UserError(`git commit failed (exit ${r.code}); nothing recorded:\n${tail(`${r.out}\n${r.err}`, 20)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const sha = await git(top, "rev-parse", "HEAD");
  const doneAt = new Date().toISOString();
  if (commit) Object.assign(commit, { status: "done", sha, done_at: doneAt });
  else {
    s.commits.push({
      n: s.commits.length + 1,
      title,
      why,
      files: staged.map((c) => c.path),
      est_lines: 0,
      check: checked,
      acs: [],
      status: "done",
      sha,
      done_at: doneAt,
      extra: true,
    });
  }
  const next = nextCommit(s);
  if (!next && s.status === "active") s.status = "checkpoint";
  const net = await storeNet(top, pair, s);
  save(file, pair);
  const done = planned(s).filter((c) => c.status === "done").length;
  emit(args.flags.has("--json"), { sha, title, slice: s.n, status: s.status, commits: { done, planned: planned(s).length }, net_lines: net.net, budget: s.budget.net_lines, next: next ? { n: next.n, title: next.title } : null }, () => {
    console.log(`committed ${short(sha)} ${title}`);
    console.log(`slice ${s.n}: ${done}/${planned(s).length} planned commits · net lines ${signed(net.net)}/${s.budget.net_lines}`);
    console.log(next ? `next: commit ${next.n} ${next.title}` : `all planned commits done: slice ${s.n} is at its checkpoint`);
  });
}

async function cmdGreen(args: Args) {
  allowFlags(args, ["--slice"]);
  const { pair } = await load(args);
  const s = sliceArg(pair, intFlag(args, "--slice"), currentSlice(pair));
  const top = await checkout(pair);
  const head = await branchOf(top);
  if (head !== s.branch) throw new UserError(`HEAD is ${head ?? "detached"}; switch to ${s.branch} first (br new ${s.branch} --here)`);
  const dirty = (await git(top, "status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean);
  if (dirty.length) throw new UserError(`green needs a clean tree (${dirty.length} change(s), untracked included); commit or stash first`);
  for (const d of ["rebase-merge", "rebase-apply"])
    if (existsSync(resolve(top, await git(top, "rev-parse", "--git-path", d)))) throw new UserError("a rebase is already in progress");
  const base = await sliceBase(top, pair, s);
  const check = greenCheck(s);
  if (!check) throw new UserError(`slice ${s.n} has no check command`);
  assertCheck(check);
  if (await git(top, "rev-list", "--merges", `${base}..HEAD`)) throw new UserError(`${s.branch} has merge commits since ${base}; green replays a linear history only`);
  const shas = (await git(top, "rev-list", "--reverse", `${base}..HEAD`)).split("\n").filter(Boolean);
  if (!shas.length) throw new UserError(`no commits on ${s.branch} since ${base}`);
  const before = await git(top, "rev-parse", "HEAD");
  const tmp = mkdtempSync(join(tmpdir(), "pair-green-"));
  const log = join(tmp, "check.log");
  const json = args.flags.has("--json");
  try {
    const r = await exec(["git", "rebase", "--keep-base", "-x", `(${check}) >${shq(log)} 2>&1`, base], top, { GIT_EDITOR: "true" });
    if (r.code === 0) {
      const after = await git(top, "rev-parse", "HEAD");
      if (after !== before) warn(`HEAD moved ${short(before)} → ${short(after)}; restore with: git reset --hard ${before} (do not force-push)`);
      return emit(json, { ok: true, slice: s.n, base, check, commits: shas.length, unchanged: after === before }, () =>
        console.log(`green: all ${shas.length} commit(s) of slice ${s.n} pass \`${check}\` (base ${base}); SHAs unchanged`),
      );
    }
    const stopped = existsSync(resolve(top, await git(top, "rev-parse", "--git-path", "rebase-merge")));
    const failing = stopped ? await git(top, "rev-parse", "HEAD") : null;
    const subject = failing ? await git(top, "log", "-1", "--format=%s", failing) : null;
    const output = existsSync(log) ? tail(readFileSync(log, "utf8"), 20) : tail(`${r.out}\n${r.err}`, 20);
    if (stopped) await git(top, "rebase", "--abort");
    const restored = (await git(top, "rev-parse", "HEAD")) === before;
    const index = failing ? shas.indexOf(failing) + 1 : null;
    emit(json, { ok: false, slice: s.n, base, check, failing: failing && { sha: failing, title: subject, index }, output, aborted: stopped, restored }, () => {
      console.log(failing ? `not green: commit ${index}/${shas.length} ${short(failing)} ${subject} fails \`${check}\`` : `not green: git rebase failed before running the check`);
      console.log(`last ${Math.min(20, output.split("\n").length)} lines:`);
      console.log(output.replace(/^/gm, "  "));
      console.log(stopped ? `rebase aborted; HEAD ${restored ? "back at" : "NOT back at"} ${short(before)}` : "");
    });
    process.exit(1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function cmdWalk(args: Args) {
  allowFlags(args, ["--slice", "--commit"]);
  const { pair } = await load(args);
  const top = await checkout(pair);
  const sha = str(args, "--commit");
  if (sha && args.flags.has("--slice")) throw new UserError("pass --slice or --commit, not both");
  let s: Slice;
  let shas: string[];
  let base: string | null = null;
  if (sha) {
    const full = await gitOk(top, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`);
    if (!full) throw new UserError(`unknown commit ${sha}`);
    s = pair.slices.find((x) => x.commits.some((c) => c.sha === full)) ?? sliceArg(pair, undefined, currentSlice(pair));
    shas = [full];
  } else {
    const fallback = currentSlice(pair) ?? [...pair.slices].reverse().find((x) => x.status !== "todo") ?? null;
    s = sliceArg(pair, intFlag(args, "--slice"), fallback);
    const ref = (await resolves(top, s.branch)) ? s.branch : (await resolves(top, `origin/${s.branch}`)) ? `origin/${s.branch}` : null;
    if (!ref) throw new UserError(`branch ${s.branch} not found locally or on origin`);
    base = await sliceBase(top, pair, s);
    shas = (await git(top, "rev-list", "--reverse", `${base}..${ref}`)).split("\n").filter(Boolean);
    if (!shas.length) throw new UserError(`no commits on ${s.branch} since ${base}`);
  }
  type Walked = { sha: string; title: string; body: string; planned: { n: number; extra: boolean } | null; recorded: string | null; deviation: string | null; show: string };
  const commits: Walked[] = [];
  for (const c of shas) {
    const subject = await git(top, "log", "-1", "--format=%s", c);
    const body = await git(top, "log", "-1", "--format=%b", c);
    const bySha = s.commits.find((x) => x.sha === c);
    const byTitle = bySha ?? s.commits.find((x) => x.title === subject && x.status === "done");
    const recorded = bySha ? "recorded" : byTitle ? "title matches a recorded commit, sha differs (amended or rebased?)" : null;
    const dev = body.match(/^Deviation:\s*(.*)$/m)?.[1]?.trim() ?? null;
    const show = await git(top, "show", "--stat", "--patch", "--format=", c);
    commits.push({ sha: c, title: subject, body, planned: byTitle ? { n: byTitle.n, extra: Boolean(byTitle.extra) } : null, recorded, deviation: dev && dev !== "none" ? dev : null, show });
  }
  const deviations = commits
    .filter((c) => c.deviation || !c.planned || (c.recorded && c.recorded !== "recorded"))
    .map((c) => ({ sha: c.sha, title: c.title, reason: !c.planned ? "unplanned commit, no reasoning recorded" : c.deviation ? `Deviation: ${c.deviation}` : c.recorded! }));
  emit(args.flags.has("--json"), { slice: s.n, branch: s.branch, base, deviations, commits }, () => {
    console.log(`Walkthrough: slice ${s.n} "${s.title}" (${s.branch}${base ? ` on ${base}` : ""}, ${commits.length} commit(s))`);
    console.log("");
    console.log(deviations.length ? "Deviations:" : "Deviations: none");
    for (const d of deviations) console.log(`- ${short(d.sha)} ${d.title} — ${d.reason}`);
    commits.forEach((c, i) => {
      console.log(`\n=== ${i + 1}/${commits.length} ${short(c.sha)} ${c.title}${c.planned ? "" : " [UNPLANNED]"} ===`);
      console.log(c.body.trim() ? c.body.trimEnd() : "(no message body: no reasoning recorded)");
      console.log("");
      console.log(c.show);
    });
  });
}

async function cmdMode(args: Args) {
  allowFlags(args, []);
  const mode = args.pos[0];
  if (mode !== "on" && mode !== "off") throw new UserError("usage: pair mode on|off");
  const { pair, file } = await load(args);
  const prev = pair.mode;
  pair.mode = mode;
  save(file, pair);
  emit(args.flags.has("--json"), { mode, changed: prev !== mode }, () =>
    console.log(prev === mode ? `pair already ${mode}` : `pair ${mode}${mode === "off" ? ": no per-commit ceremony; commits stay atomic with the same message format" : ""}`),
  );
}

async function cmdSlice(args: Args) {
  allowFlags(args, ["--force"]);
  const [action, nRaw] = args.pos;
  if ((action !== "start" && action !== "done") || !nRaw || !/^\d+$/.test(nRaw)) throw new UserError("usage: pair slice start|done <n> [--force]");
  const { pair, file } = await load(args);
  const s = sliceArg(pair, nRaw, null);
  const force = args.flags.has("--force");
  const json = args.flags.has("--json");
  if (action === "start") {
    const prev = pair.slices.find((x) => x.n === s.n - 1);
    if (prev && prev.status !== "done" && !force) throw new UserError(`slice ${prev.n} is ${prev.status}, not done (finish its checkpoint, or --force)`);
    const other = currentSlice(pair);
    if (other && other.n !== s.n && !force) throw new UserError(`slice ${other.n} is still ${other.status} (or --force)`);
    if (s.status === "done") throw new UserError(`slice ${s.n} is already done`);
    const changed = s.status === "todo";
    if (changed) {
      s.status = "active";
      s.started_at ??= new Date().toISOString();
      save(file, pair);
    }
    const base = prev ? prev.branch : pair.base.startsWith("origin/") ? pair.base : `origin/${pair.base}`;
    const cmd = `br new ${s.branch} --here --base ${base}`;
    const next = nextCommit(s);
    return emit(json, { slice: s.n, status: s.status, branch: s.branch, br: cmd, brWorktree: `br new ${s.branch} --worktree --base ${base}`, next: next && { n: next.n, title: next.title } }, () => {
      console.log(changed ? `slice ${s.n} "${s.title}" started` : `slice ${s.n} is already ${s.status}`);
      console.log(`switch to its branch: ${cmd}   (or --worktree instead of --here)`);
      if (next) console.log(`first commit: ${next.n} ${next.title}`);
    });
  }
  const todo = planned(s).filter((c) => c.status !== "done");
  if (todo.length && !force) throw new UserError(`slice ${s.n} has ${todo.length} planned commit(s) not done (or --force)`);
  const changed = s.status !== "done";
  if (changed) {
    s.status = "done";
    s.done_at = new Date().toISOString();
    save(file, pair);
  }
  const next = pair.slices.find((x) => x.status === "todo");
  emit(json, { slice: s.n, status: s.status, next: next ? { n: next.n, title: next.title } : null }, () => {
    console.log(changed ? `slice ${s.n} "${s.title}" done` : `slice ${s.n} already done`);
    console.log(next ? `next: pair slice start ${next.n} ("${next.title}")` : "all slices done");
  });
}

const USAGE = `usage: pair <command> [--slug <slug>] [--json]   (default slug: work current for the cwd)
  plan save <file.json>            validate and store the slice ladder; writes pair.json and stack.json
  plan show                        ladder by milestone, timeline vs deadline, AC coverage
  status                           current slice and commit, net lines vs budget, time vs estimate
  check                            working tree vs the planned commit's files and the slice budget (exit 2: stop and ask)
  commit --why "…" --notes <file.json> [--alt "…"] [--deviation "…"] [--noticed "…"] [--checked "<cmd>"] [--title "<extra commit title>"]
                                   commit what is staged as the next planned commit (or an extra one with --title)
  green [--slice <n>]              every commit of the slice passes its check (rebase --keep-base -x; SHAs unchanged)
  walk [--slice <n> | --commit <sha>]   commit-by-commit walkthrough, deviations first
  mode on|off                      interactive pairing on or off
  slice start|done <n> [--force]   slice status transitions`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "plan":
      if (args.pos[0] === "save") return cmdPlanSave(args);
      if (args.pos[0] === "show") return cmdPlanShow(args);
      break;
    case "status":
      return cmdStatus(args);
    case "check":
      return cmdCheck(args);
    case "commit":
      return cmdCommit(args);
    case "green":
      return cmdGreen(args);
    case "walk":
      return cmdWalk(args);
    case "mode":
      return cmdMode(args);
    case "slice":
      return cmdSlice(args);
  }
  console.error(USAGE);
  process.exit(1);
}

if (import.meta.main)
  main().catch((e) => {
    console.error(`pair: ${e instanceof UserError ? e.message : ((e as Error)?.message ?? e)}`);
    process.exit(1);
  });
