#!/usr/bin/env bun
// PR ladder for the pair skill: state/work/<slug>/pair.json (never in the repo or .git). Each slice is one PR.
// Validates and stores the ladder (rough from brainstorm, detailed per PR once its plan is approved), routes
// /pair to the right step, holds one PR per chat (CLAUDE_CODE_SESSION_ID), checks the working tree against the
// planned commit, commits what is staged with a reasoning message, verifies every commit passes its check,
// prints the walkthrough and records the shipped PR. Deterministic file and git ops only.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const STATE_DIR = process.env.PAIR_STATE_DIR || join(import.meta.dir, "..", "..", "..", "state", "work");
const WORK_TS = join(import.meta.dir, "..", "..", "..", "bin", "work.ts");
const SPEC_TS = join(import.meta.dir, "..", "..", "spec", "scripts", "spec.ts");
const BR_TS = join(import.meta.dir, "..", "..", "branch", "scripts", "br.ts");
const DB_GUARD = join(import.meta.dir, "..", "..", "..", "hooks", "db-guard.js");
const SESSION_ENV = "CLAUDE_CODE_SESSION_ID";
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AC_RE = /^(?:[A-Z][A-Z0-9]*-\d+\/)?AC-\d+$/;
const CC_TYPES = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
const TITLE_RE = new RegExp(`^(${CC_TYPES.join("|")})(\\([\\w./-]+\\))?!?: \\S.*$`);
const TITLE_MAX = 72;
const MAX_BUDGET = 500;
const DEFAULT_CAP = 5;
const EXIT_STOP = 2;
// "done" is the pre-ship status of older ladders (checkpoint passed, PR not opened); it reads as built.
const SLICE_STATUSES = ["todo", "active", "checkpoint", "done", "shipped"] as const;
const VALUE_FLAGS = new Set(["--slug", "--why", "--notes", "--alt", "--deviation", "--noticed", "--checked", "--slice", "--commit", "--title", "--pr", "--plan"]);
const CARRY_SLICE = ["test_script", "patterns", "exceptions", "green_check", "budget", "target_date", "prefactor", "why", "merge_point", "plan_file", "plan_approved_at"];
const CARRY_PROGRESS = ["status", "started_at", "done_at", "net_lines", "net_at", "pr", "shipped_at", "sessions"];
const CARRY_COMMIT = ["files", "check", "est_lines", "acs"];

type Args = { pos: string[]; flags: Map<string, string | true> };
type SliceStatus = (typeof SLICE_STATUSES)[number];
type Exception = { what: string; why: string; approved: boolean };
export type Commit = {
  n: number;
  title: string;
  why: string;
  files?: string[];
  est_lines?: number;
  check?: string;
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
  test_script?: string[];
  patterns: string[];
  exceptions: Exception[];
  est_days: number;
  target_date?: string;
  budget: { net_lines: number };
  merge_point: boolean;
  milestone?: string;
  ticket?: string;
  green_check?: string;
  prefactor?: boolean;
  why?: string;
  plan_file?: string;
  plan_approved_at?: string;
  status: SliceStatus;
  commits: Commit[];
  started_at?: string;
  done_at?: string;
  net_lines?: number;
  net_at?: string;
  pr?: number;
  shipped_at?: string;
  sessions?: string[];
};
export type Pair = { slug: string; repo: string; deadline?: string; cap: number; base: string; slices: Slice[] };
export type Change = { kind: "A" | "M" | "D" | "R" | "C" | "T"; path: string; from?: string };
export type Action = "plan" | "build" | "checkpoint" | "ship" | "fixes" | "refuse" | "no-plan" | "all-shipped";
export type Stage = "todo" | "planned" | "in-progress" | "checkpoint" | "shipped";
type Net = { ins: number; del: number; net: number };
type Obj = Record<string, unknown>;

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
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const prList = (ss: Slice[]) => ss.map((s) => `PR ${s.n}`).join(", ");
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

export const planned = (s: Slice) => s.commits.filter((c) => !c.extra);
const nextCommit = (s: Slice) => planned(s).find((c) => c.status === "todo") ?? null;
const sliceFiles = (s: Slice) => [...new Set(s.commits.flatMap((c) => c.files ?? []))];
const currentSlice = (p: Pair) => p.slices.find((s) => s.status === "active" || s.status === "checkpoint") ?? null;
export const isShipped = (s: Slice) => s.status === "shipped" || typeof s.pr === "number";
export const isBuilt = (s: Slice) => planned(s).length > 0 && planned(s).every((c) => c.status === "done");
const isStarted = (s: Slice) => s.status === "active" || s.commits.some((c) => c.status === "done");

// What the PR still needs before it can be built: a test script, and files, check and size on every commit.
export function planGaps(s: Slice): string[] {
  const gaps: string[] = [];
  if (!s.test_script?.length) gaps.push("no test script");
  for (const c of planned(s)) {
    const miss = [!c.files?.length && "files", !c.check && "check", c.est_lines === undefined && "est_lines"].filter(Boolean);
    if (miss.length) gaps.push(`commit ${c.n} has no ${miss.join(", ")}`);
  }
  return gaps;
}

export const isPlanned = (s: Slice) => Boolean(s.plan_approved_at) && !planGaps(s).length;
// Ready to build: an approved plan, or a half-built PR from before approvals were recorded.
const isBuildable = (s: Slice) => !planGaps(s).length && (Boolean(s.plan_approved_at) || isStarted(s));
const progressed = (s: Slice) => !isShipped(s) && (isBuilt(s) || isBuildable(s));
const commitCount = (s: Slice) => `${planned(s).filter((c) => c.status === "done").length} of ${planned(s).length} commits`;

export function stageOf(s: Slice): Stage {
  if (isShipped(s)) return "shipped";
  if (isBuilt(s)) return "checkpoint";
  if (isStarted(s)) return "in-progress";
  if (isPlanned(s)) return "planned";
  return "todo";
}

export function stateOf(s: Slice): string {
  if (isShipped(s)) return s.pr ? `draft #${s.pr}` : "shipped";
  if (isBuilt(s)) return "built, not shipped";
  if (isStarted(s)) return `in progress, ${commitCount(s)}`;
  if (isPlanned(s)) return "plan approved, not built";
  return "not planned yet";
}

// The chat starter for a PR: implement once its plan is approved or it is (half) built, else plan.
export function starterFor(p: Pair, s: Slice): string {
  if (progressed(s)) return `/pair implement ${p.slug}`;
  const first = p.slices.find((x) => !isShipped(x));
  return `/pair plan ${p.slug}${first === s ? "" : ` ${s.n}`}`;
}

export function roadmapStatus(p: Pair, s: Slice, current: string | null): string {
  if (isShipped(s)) return current === "live" ? "live" : s.pr ? `draft #${s.pr}` : "shipped";
  if (isBuilt(s) || isStarted(s)) return `in progress, ${commitCount(s)}`;
  if (isPlanned(s)) return "plan approved";
  return p.slices.find((x) => !isShipped(x)) === s ? "next" : "not started";
}

const HEADING_RE = /^(\*\*PR (\d+): .+?\*\*) \(([^)]*)\)[ \t]*$/;
const NEXT_UP_RE = /^\*\*Next up:.*$/;
// Written by the done skill once every PR is live; kept while nothing is left to ship.
const DONE_RE = /^\*\*Next up: nothing; every PR is live\. This roadmap is done\.\*\*$/;

// Rewrites only the status parts of roadmap.md: each "**PR <n>: <name>** (<status>)" heading and the
// "**Next up: …**" line. Everything else stays as brainstorm wrote it.
export function syncRoadmap(md: string, p: Pair): { md: string; changed: string[]; problems: string[] } {
  const changed: string[] = [];
  const problems: string[] = [];
  const names = new Map<number, string>();
  const seen = new Set<number>();
  let nextUpLines = 0;
  const lines = md.split("\n").map((line) => {
    const m = line.match(HEADING_RE);
    if (!m) return line;
    const n = Number(m[2]);
    names.set(n, m[1]!.replace(/^\*\*PR \d+: /, "").replace(/\*\*$/, ""));
    const s = p.slices.find((x) => x.n === n);
    if (!s) {
      problems.push(`roadmap PR ${n} is not in the ladder`);
      return line;
    }
    seen.add(n);
    const status = roadmapStatus(p, s, m[3]!.trim());
    if (status === m[3]!.trim()) return line;
    changed.push(`PR ${n}: ${m[3]} → ${status}`);
    return `${m[1]} (${status})`;
  });
  for (const s of p.slices) if (!seen.has(s.n)) problems.push(`ladder PR ${s.n} "${s.title}" has no "**PR ${s.n}: …** (…)" line in the roadmap`);
  const next = p.slices.find((x) => !isShipped(x)) ?? null;
  const nextUp = next
    ? `**Next up: PR ${next.n}, ${names.get(next.n) ?? next.title}.** Start it in a fresh chat with \`${starterFor(p, next)}\`.`
    : "**Next up: nothing; every PR in this roadmap is shipped.**";
  const out = lines.map((line) => {
    if (!NEXT_UP_RE.test(line)) return line;
    nextUpLines++;
    if (!next && DONE_RE.test(line)) return line;
    if (line !== nextUp) changed.push(`Next up → PR ${next?.n ?? "none"}`);
    return nextUp;
  });
  if (!nextUpLines) problems.push('roadmap has no "**Next up: …**" line');
  return { md: out.join("\n"), changed, problems };
}

// The PR that takes this one live: itself when it is a merge point, else the next merge point above it.
export function liveWith(p: Pair, s: Slice): Slice | null {
  if (s.merge_point) return s;
  return p.slices.find((x) => x.n > s.n && x.merge_point) ?? null;
}

export function builtUnshipped(p: Pair): Slice[] {
  return p.slices.filter((s) => isBuilt(s) && !isShipped(s));
}

export function shipFirstWarning(p: Pair): string | null {
  const waiting = builtUnshipped(p);
  if (waiting.length < 2) return null;
  return `${waiting.length} PRs are built but not shipped (${prList(waiting)}); ship PR ${waiting[0]!.n} first, one PR per chat`;
}

// specAcs: id -> superseded, or null when the initiative has no spec.
export function validatePlan(raw: unknown, ctx: { slug: string; repo: string | null; specAcs: Map<string, boolean> | null }) {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!isObj(raw)) return { plan: null, problems: ["plan must be a JSON object"], notes };
  const r = raw;
  if (r.slug !== undefined && r.slug !== ctx.slug) problems.push(`slug "${String(r.slug)}" does not match the initiative "${ctx.slug}"`);
  const repo = r.repo ?? ctx.repo;
  if (!isStr(repo) || !isAbsolute(repo)) problems.push("repo must be the absolute path of the main checkout");
  if (r.deadline !== undefined && !isDate(r.deadline)) problems.push(`deadline must be YYYY-MM-DD`);
  const cap = r.cap ?? DEFAULT_CAP;
  if (!Number.isInteger(cap) || (cap as number) < 1) problems.push("cap must be a positive integer");
  if (!isStr(r.base)) problems.push("base (the integration target from br target) is required");
  if (!Array.isArray(r.slices) || !r.slices.length) {
    problems.push("slices must be a non-empty array");
    return { plan: null, problems, notes };
  }
  const acProblem = (id: string): string | null => {
    if (!AC_RE.test(id)) return `"${id}" is not an AC id (AC-<n> or <TICKET>/AC-<n>)`;
    if (!ctx.specAcs || id.includes("/")) return null;
    if (!ctx.specAcs.has(id)) return `${id} is not in the spec`;
    if (ctx.specAcs.get(id)) return `${id} is superseded in the spec`;
    return null;
  };

  const branches = new Set<string>();
  const slices: Slice[] = r.slices.map((rawSlice, i) => {
    const s = (isObj(rawSlice) ? rawSlice : {}) as Obj;
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
        const p = acProblem(id);
        if (p) bad(p);
      }
    if (s.test_script !== undefined && (!strList(s.test_script) || !s.test_script.length)) bad("test_script needs at least one step");
    if (s.patterns !== undefined && !strList(s.patterns)) bad("patterns must be a list of strings");
    const exceptions = Array.isArray(s.exceptions) ? s.exceptions : s.exceptions === undefined ? [] : null;
    if (!exceptions) bad("exceptions must be a list");
    else
      exceptions.forEach((e, j) => {
        const x = (isObj(e) ? e : {}) as Obj;
        if (!isStr(x.what) || !isStr(x.why) || typeof x.approved !== "boolean") bad(`exceptions[${j}] needs what, why and approved (true/false)`);
        else if (!x.approved) notes.push(`${label}: exception "${x.what}" is not approved yet`);
      });
    if (typeof s.est_days !== "number" || !(s.est_days > 0)) bad("est_days must be a positive number");
    if (s.target_date !== undefined && !isDate(s.target_date)) bad("target_date must be YYYY-MM-DD");
    const budget = (s.budget as { net_lines?: unknown } | undefined)?.net_lines ?? MAX_BUDGET;
    if (!Number.isInteger(budget) || (budget as number) < 1) bad("budget.net_lines must be a positive integer");
    else if ((budget as number) > MAX_BUDGET) bad(`budget ${budget} net lines is over the ${MAX_BUDGET} limit; split the slice`);
    for (const k of ["milestone", "ticket", "green_check", "why", "plan_file", "plan_approved_at", "shipped_at"]) if (s[k] !== undefined && !isStr(s[k])) bad(`${k} must be a non-empty string`);
    if (s.merge_point !== undefined && typeof s.merge_point !== "boolean") bad("merge_point must be true or false");
    if (s.pr !== undefined && !(Number.isInteger(s.pr) && (s.pr as number) > 0)) bad("pr must be the PR number");
    if (s.sessions !== undefined && !strList(s.sessions)) bad("sessions must be a list of chat ids");
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
      const c = (isObj(rawCommit) ? rawCommit : {}) as Obj;
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
      const filesOk = c.files === undefined || (strList(c.files) && c.files.length > 0);
      if (!filesOk) cbad("files must list at least one path");
      else for (const f of (c.files as string[] | undefined) ?? []) if (isAbsolute(f) || f.startsWith("..")) cbad(`file "${f}" must be relative to the repo root`);
      const linesOk = c.est_lines === undefined || (Number.isInteger(c.est_lines) && (c.est_lines as number) >= 0);
      if (!linesOk) cbad("est_lines must be a non-negative integer");
      if (c.check !== undefined) {
        if (!isStr(c.check)) cbad("check must be the command that proves the commit");
        else {
          const refused = guardCheck(c.check);
          if (refused) cbad(refused);
        }
      }
      if (c.acs !== undefined && !strList(c.acs)) cbad("acs must be a list of AC ids");
      else
        for (const id of (c.acs as string[] | undefined) ?? []) {
          const p = acProblem(id);
          if (p) cbad(p);
          else if (strList(s.acs) && !s.acs.includes(id)) notes.push(`${label} commit ${j + 1}: ${id} is not one of the slice's ACs`);
        }
      if (c.status !== undefined && c.status !== "todo" && c.status !== "done") cbad("status must be todo or done");
      const out: Commit = {
        n: j + 1,
        title: String(c.title ?? ""),
        why: String(c.why ?? ""),
        acs: strList(c.acs) ? c.acs : [],
        status: c.status === "done" ? "done" : "todo",
      };
      if (filesOk && strList(c.files)) out.files = c.files;
      if (linesOk && c.est_lines !== undefined) out.est_lines = c.est_lines as number;
      if (isStr(c.check)) out.check = c.check;
      for (const k of ["sha", "done_at"] as const) if (isStr(c[k])) out[k] = c[k] as string;
      if (c.extra === true) out.extra = true;
      return out;
    });
    const est = commits.reduce((a, c) => a + (c.est_lines ?? 0), 0);
    if (Number.isInteger(budget) && est > (budget as number)) bad(`commits estimate ${est} net lines, over the slice budget ${budget}; split the slice`);

    const out: Slice = {
      n: i + 1,
      title: String(s.title ?? ""),
      goal: String(s.goal ?? ""),
      after: String(s.after ?? ""),
      branch: String(s.branch ?? ""),
      acs: strList(s.acs) ? s.acs : [],
      patterns: strList(s.patterns) ? s.patterns : [],
      exceptions: (exceptions ?? []) as Exception[],
      est_days: Number(s.est_days),
      budget: { net_lines: Number(budget) },
      merge_point: s.merge_point !== false,
      status: status as SliceStatus,
      commits,
    };
    if (strList(s.test_script) && s.test_script.length) out.test_script = s.test_script;
    for (const k of ["target_date", "milestone", "ticket", "green_check", "why", "plan_file", "plan_approved_at", "started_at", "done_at", "net_at", "shipped_at"] as const)
      if (isStr(s[k])) out[k] = s[k] as string;
    if (s.prefactor === true) out.prefactor = true;
    if (typeof s.net_lines === "number") out.net_lines = s.net_lines;
    if (Number.isInteger(s.pr) && (s.pr as number) > 0) out.pr = s.pr as number;
    if (strList(s.sessions) && s.sessions.length) out.sessions = s.sessions;
    if (out.status !== "todo") {
      const gaps = planGaps(out);
      if (gaps.length) bad(`is ${out.status} but its plan is incomplete: ${gaps.join("; ")}`);
    }
    return out;
  });

  const last = slices[slices.length - 1];
  if (last && !last.merge_point) notes.push(`slice ${last.n} "${last.title}" is not a merge point and nothing above it takes it live`);
  if (ctx.specAcs) {
    const covered = new Set(slices.flatMap((s) => s.acs));
    const missing = [...ctx.specAcs].filter(([id, sup]) => !sup && !covered.has(id)).map(([id]) => id);
    if (missing.length) notes.push(`ACs not covered by any slice: ${missing.join(", ")}`);
  }
  const plan: Pair = {
    slug: ctx.slug,
    repo: String(repo),
    ...(isDate(r.deadline) ? { deadline: r.deadline } : {}),
    cap: Number(cap),
    base: String(r.base ?? ""),
    slices,
  };
  return { plan, problems, notes };
}

// Pairs each new slice with its stored slice: by branch first, then by title among stored slices whose
// branch left the ladder (a renamed branch). Slice numbers never match, so inserting a PR shifts nothing.
export function matchSlices(old: Slice[], next: { branch?: unknown; title?: unknown }[]): (Slice | null)[] {
  const byBranch = next.map((s) => old.find((o) => o.branch === s.branch) ?? null);
  const used = new Set(byBranch.filter((o): o is Slice => o !== null));
  const nextBranches = new Set(next.map((s) => s.branch));
  return next.map((s, i) => {
    if (byBranch[i]) return byBranch[i];
    const o = old.find((x) => !used.has(x) && !nextBranches.has(x.branch) && x.title === s.title) ?? null;
    if (o) used.add(o);
    return o;
  });
}

// Fills a raw replacement ladder from the stored one before validation: progress (status, timestamps, PR,
// chats), the slice fields the new file leaves out (a rough brainstorm re-save keeps the approved details),
// and per commit (matched by title inside the matched slice) its details and done markers. Extra commits
// that the new file does not list are appended.
export function carryOver(old: Pair | null, raw: unknown): unknown {
  if (!old || !isObj(raw) || !Array.isArray(raw.slices)) return raw;
  const top: Obj = { ...raw };
  for (const k of ["repo", "base", "cap", "deadline"] as const) if (top[k] === undefined && old[k] !== undefined) top[k] = old[k];
  const next = raw.slices.map((s) => (isObj(s) ? { ...s } : s));
  const matches = matchSlices(old.slices, next.map((s) => (isObj(s) ? s : {})));
  next.forEach((x, i) => {
    const o = matches[i] as (Slice & Obj) | null;
    if (!o || !isObj(x)) return;
    for (const k of CARRY_SLICE) if (x[k] === undefined && o[k] !== undefined) x[k] = o[k];
    for (const k of CARRY_PROGRESS) if (o[k] !== undefined && (x[k] === undefined || (k === "status" && x[k] === "todo"))) x[k] = o[k];
    const commits = (Array.isArray(x.commits) ? x.commits : []).map((c) => (isObj(c) ? { ...c } : c));
    for (const c of commits) {
      if (!isObj(c)) continue;
      const oc = o.commits.find((y) => y.title === c.title) as (Commit & Obj) | undefined;
      if (!oc) continue;
      for (const k of CARRY_COMMIT) if (c[k] === undefined && oc[k] !== undefined) c[k] = oc[k];
      if (oc.status === "done" && c.status !== "done") {
        c.status = "done";
        if (oc.sha) c.sha = oc.sha;
        if (oc.done_at) c.done_at = oc.done_at;
      }
    }
    for (const oc of o.commits) if (oc.extra && !commits.some((c) => isObj(c) && c.title === oc.title)) commits.push({ ...oc, n: commits.length + 1 });
    x.commits = commits;
  });
  return { ...top, slices: next };
}

export function planDiff(old: Pair | null, next: Pair): { diff: string[]; dropped: string[] } {
  if (!old) {
    const commits = next.slices.reduce((a, s) => a + s.commits.length, 0);
    return { diff: [`new plan: ${next.slices.length} PRs, ${commits} commits`], dropped: [] };
  }
  const diff: string[] = [];
  const dropped: string[] = [];
  const matches = matchSlices(old.slices, next.slices);
  next.slices.forEach((s, i) => {
    const o = matches[i];
    if (!o) {
      diff.push(`+ PR ${s.n} "${s.title}"`);
      return;
    }
    if (o.n !== s.n) diff.push(`~ PR ${o.n} "${s.title}" is now PR ${s.n}`);
    for (const k of ["title", "branch", "after"] as const) if (o[k] !== s[k]) diff.push(`~ PR ${s.n}: ${k} "${o[k]}" → "${s[k]}"`);
    if (o.budget.net_lines !== s.budget.net_lines) diff.push(`~ PR ${s.n}: budget ${o.budget.net_lines} → ${s.budget.net_lines}`);
    if (o.est_days !== s.est_days) diff.push(`~ PR ${s.n}: est_days ${o.est_days} → ${s.est_days}`);
    if (o.acs.join(",") !== s.acs.join(",")) diff.push(`~ PR ${s.n}: acs ${o.acs.join(", ")} → ${s.acs.join(", ")}`);
    if ((o.merge_point ?? true) !== s.merge_point) diff.push(`~ PR ${s.n}: ${s.merge_point ? "now goes live on its own" : "now goes live with a later PR"}`);
    if (!o.plan_approved_at && s.plan_approved_at) diff.push(`~ PR ${s.n}: plan approved`);
    for (const c of s.commits) if (!o.commits.some((x) => x.title === c.title)) diff.push(`  PR ${s.n}: + commit "${c.title}"`);
    for (const oc of o.commits) {
      if (s.commits.some((c) => c.title === oc.title)) continue;
      diff.push(`  PR ${s.n}: - commit "${oc.title}"`);
      if (oc.status === "done") dropped.push(`PR ${s.n} commit "${oc.title}" (${oc.sha ? short(oc.sha) : "no sha"}) is done but no longer planned`);
    }
  });
  for (const o of old.slices) {
    if (matches.includes(o)) continue;
    diff.push(`- PR ${o.n} "${o.title}"`);
    if (isShipped(o)) dropped.push(`PR ${o.n} "${o.title}" is shipped${o.pr ? ` as #${o.pr}` : ""} but was removed from the ladder`);
    for (const oc of o.commits) if (oc.status === "done") dropped.push(`PR ${o.n} commit "${oc.title}" is done but its PR was removed`);
  }
  if (!diff.length) diff.push("no plan changes");
  return { diff, dropped };
}

export function stackPlan(p: Pair) {
  return { base: p.base, branches: p.slices.map((s) => ({ name: s.branch, title: s.title })) };
}

// One PR per chat: the chat that planned, started, committed to or shipped a PR holds it.
export function claimProblem(p: Pair, s: Slice, sid: string | null, batch = false): string | null {
  if (!sid || batch) return null;
  const other = p.slices.find((x) => x !== s && x.sessions?.includes(sid));
  if (!other) return null;
  return `this chat is on PR ${other.n} "${other.title}"; one PR per chat, so here it only takes fixes to PR ${other.n} and roadmap updates. Start PR ${s.n} "${s.title}" in a fresh chat with ${starterFor(p, s)} (run /handoff for the starter)`;
}

export function claim(s: Slice, sid: string | null) {
  if (sid && !s.sessions?.includes(sid)) s.sessions = [...(s.sessions ?? []), sid];
}

function phase(s: Slice, sid: string | null): Action {
  if (isShipped(s)) return "fixes";
  if (isBuilt(s)) {
    if (!sid) return s.status === "checkpoint" ? "checkpoint" : "ship";
    return s.sessions?.includes(sid) ? "checkpoint" : "ship";
  }
  return isBuildable(s) ? "build" : "plan";
}

// Routes /pair (no want), /pair <n> (want) and /pair implement (implement): which PR this chat works on and
// the step it takes. A chat that holds a PR stays on it; another PR is refused.
export function nextFor(p: Pair, sid: string | null, opts: { want?: number; implement?: boolean } = {}) {
  const held = sid ? p.slices.filter((s) => s.sessions?.includes(sid)) : [];
  const open = (except: Slice | null) => p.slices.find((s) => s !== except && !isShipped(s)) ?? null;
  const result = (action: Action, slice: Slice | null) => ({
    action,
    slice,
    held,
    earlier: slice ? p.slices.filter((s) => s.n < slice.n && !isShipped(s)) : [],
    next: open(slice),
  });
  if (opts.want !== undefined) {
    const target = p.slices.find((s) => s.n === opts.want);
    if (!target) throw new UserError(`PR ${opts.want} not found (PRs 1-${p.slices.length})`);
    if (held.length && !held.includes(target)) return result("refuse", target);
    return result(phase(target, sid), target);
  }
  const mine = held.find((s) => !isShipped(s)) ?? held[held.length - 1] ?? null;
  if (mine) return result(phase(mine, sid), mine);
  if (opts.implement) {
    const ready = p.slices.find(progressed) ?? null;
    return ready ? result(phase(ready, sid), ready) : result("no-plan", null);
  }
  const first = open(null);
  return first ? result(phase(first, sid), first) : result("all-shipped", null);
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
export function inPlan(path: string, plannedPaths: string[]): boolean {
  return plannedPaths.some((p) => p === path || (p.endsWith("/") && path.startsWith(p)) || (/[*?[{]/.test(p) && new Bun.Glob(p).match(path)));
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
    .flatMap(([name, cs]) => [`${name}:`, ...cs.map((c) => `- ${c.kind === "R" ? `${c.from} → ${c.path}` : c.path}: ${c.note}`)]);
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
export function atRisk(elapsed: number, est: number, done: number, plannedCount: number): boolean {
  return est > 0 && plannedCount > 0 && elapsed > 0.8 * est && done < 0.8 * plannedCount;
}

export function timeline(p: Pair, today: Date) {
  const total = p.slices.reduce((a, s) => a + s.est_days, 0);
  const remaining = p.slices.filter((s) => !isShipped(s) && !isBuilt(s)).reduce((a, s) => a + s.est_days, 0);
  const available = p.deadline ? workingDays(today, new Date(`${p.deadline}T00:00:00`)) : null;
  const gap = available === null ? null : remaining - available;
  return { planned: total, remaining, deadline: p.deadline ?? null, available, gap, atRisk: gap !== null && gap > 0 };
}

export const greenCheck = (s: Slice) => s.green_check ?? [...new Set(s.commits.map((c) => c.check).filter((c): c is string => Boolean(c)))].join(" && ");

// Older pair.json files carry `mode` (dropped) and no `merge_point` (every PR went live on its own).
export function migrate(p: Pair & { mode?: unknown }): Pair {
  delete p.mode;
  for (const s of p.slices) {
    s.merge_point ??= true;
    s.patterns ??= [];
    s.exceptions ??= [];
    for (const c of s.commits) c.acs ??= [];
  }
  return p;
}

// ---------- state ----------

function sessionId(): string | null {
  const sid = process.env[SESSION_ENV]?.trim() || null;
  if (!sid) warn(`${SESSION_ENV} is not set, so one PR per chat is not enforced`);
  return sid;
}

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

function readPair(file: string): Pair {
  const pair = readJson(file, "pair state") as Pair;
  if (!Array.isArray(pair?.slices)) throw new UserError(`${file} has no slices`);
  return migrate(pair);
}

async function load(args: Args) {
  const init = await initiative(args);
  if (!existsSync(init.file)) throw new UserError(`no ladder for ${init.slug} yet (brainstorm saves it with pair plan save <file>)`);
  return { ...init, pair: readPair(init.file) };
}

const save = (file: string, pair: Pair) => writeAtomic(file, JSON.stringify(pair, null, 2) + "\n");

// Keeps roadmap.md's status parts in line with the ladder after every transition. Without a roadmap
// (brainstorm writes it after the first ladder save) only the explicit command complains.
function syncRoadmapFile(dir: string, pair: Pair, explicit = false) {
  const file = join(dir, "roadmap.md");
  if (!existsSync(file)) {
    if (explicit) throw new UserError(`no roadmap at ${file} (brainstorm writes it)`);
    return { file: null, changed: [] as string[], problems: [] as string[] };
  }
  const md = readFileSync(file, "utf8");
  const r = syncRoadmap(md, pair);
  if (r.md !== md) writeAtomic(file, r.md);
  for (const p of r.problems) warn(p);
  return { file, changed: r.changed, problems: r.problems };
}

function sliceArg(pair: Pair, raw: number | string | undefined, fallback: Slice | null): Slice {
  if (raw === undefined) {
    if (!fallback) throw new UserError("no PR in progress here; pass --slice <n>");
    return fallback;
  }
  const n = Number(raw);
  const s = pair.slices.find((x) => x.n === n);
  if (!s) throw new UserError(`PR ${raw} not found (PRs 1-${pair.slices.length})`);
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
const branchOf = async (top: string) => (await gitOk(top, "branch", "--show-current")) || null;
const headSlice = async (top: string, pair: Pair) => {
  const head = await branchOf(top);
  return pair.slices.find((s) => s.branch === head) ?? null;
};

// Slice n stacks on slice n-1's branch; slice 1 on the integration target (origin first: br branches from it).
async function sliceBase(top: string, pair: Pair, s: Slice): Promise<string> {
  const prev = pair.slices.find((x) => x.n === s.n - 1);
  const target = pair.base.startsWith("origin/") ? [pair.base] : [`origin/${pair.base}`, pair.base];
  const cands = prev ? [prev.branch, `origin/${prev.branch}`, ...target] : target;
  for (const c of cands) if (await resolves(top, c)) return c;
  throw new UserError(`cannot resolve the base of PR ${s.n} (tried ${cands.join(", ")})`);
}

async function branchRef(top: string, s: Slice): Promise<string | null> {
  if (await resolves(top, s.branch)) return s.branch;
  if (await resolves(top, `origin/${s.branch}`)) return `origin/${s.branch}`;
  return null;
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

// The PR a commit belongs to: its recorded sha, else the PR whose branch range holds it, else a unique title.
async function sliceOfCommit(top: string, pair: Pair, sha: string, subject: string): Promise<Slice | null> {
  const recorded = pair.slices.find((x) => x.commits.some((c) => c.sha === sha));
  if (recorded) return recorded;
  for (const s of pair.slices) {
    const ref = await branchRef(top, s);
    if (!ref) continue;
    let base: string;
    try {
      base = await sliceBase(top, pair, s);
    } catch {
      continue;
    }
    const onBranch = (await gitOk(top, "merge-base", "--is-ancestor", sha, ref)) !== null;
    if (onBranch && (await gitOk(top, "merge-base", "--is-ancestor", sha, base)) === null) return s;
  }
  const byTitle = pair.slices.filter((x) => x.commits.some((c) => c.title === subject));
  return byTitle.length === 1 ? byTitle[0]! : null;
}

// ---------- commands ----------

async function cmdPlanSave(args: Args) {
  allowFlags(args, ["--slice", "--plan", "--batch"]);
  const src = args.pos[1];
  if (!src) throw new UserError("usage: pair plan save <file.json> [--slice <n> --plan <plan.md>]");
  let raw = readJson(resolve(src), "plan");
  const init = await initiative(args);
  const old = existsSync(init.file) ? readPair(init.file) : null;
  const n = intFlag(args, "--slice");
  const planMd = str(args, "--plan");
  if (planMd && n === undefined) throw new UserError("--plan goes with --slice <n> (one PR's approved plan)");
  let sid: string | null = null;
  if (n !== undefined) {
    if (!old) throw new UserError(`no ladder for ${init.slug} yet; brainstorm saves the whole ladder first`);
    if (!isObj(raw) || "slices" in raw) throw new UserError("--slice takes one PR's JSON object (its slice), not the whole ladder");
    if (!planMd) throw new UserError("--plan <plan.md> is required with --slice: the readable plan the user approved");
    if (!existsSync(resolve(planMd)) || !readFileSync(resolve(planMd), "utf8").trim()) throw new UserError(`plan file ${planMd} is missing or empty`);
    const target = sliceArg(old, n, null);
    sid = sessionId();
    const refused = claimProblem(old, target, sid, args.flags.has("--batch"));
    if (refused) throw new UserError(refused);
    const patch = raw;
    raw = { ...old, slices: old.slices.map((s) => (s.n === n ? { ...s, ...patch, n } : s)) };
  }
  const acs = await specAcs(init.dir);
  if (!acs) warn(`no spec for ${init.slug} (${join(init.dir, "spec.md")}); AC ids are only shape-checked`);
  raw = carryOver(old, raw);
  let repo: string | null = null;
  if (!(raw as Obj)?.repo) {
    const common = await gitOk(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir");
    repo = common && common.endsWith("/.git") ? dirname(common) : null;
  }
  const { plan, problems, notes } = validatePlan(raw, { slug: init.slug, repo, specAcs: acs });
  const target = plan && n !== undefined ? plan.slices[n - 1] : undefined;
  if (target) {
    const gaps = planGaps(target);
    if (gaps.length) problems.push(`PR ${n}'s plan is incomplete: ${gaps.join("; ")}`);
  }
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
  for (const note of notes) warn(note);
  if (target && planMd) {
    let dest = join(init.dir, `pr-${target.n}-plan.md`);
    if (plan.slices.some((s) => s !== target && s.plan_file === dest)) dest = join(init.dir, `pr-${target.n}-plan-${basename(target.branch)}.md`);
    if (real(resolve(planMd)) !== real(dest)) writeAtomic(dest, readFileSync(resolve(planMd), "utf8"));
    target.plan_file = dest;
    target.plan_approved_at = new Date().toISOString();
    claim(target, sid);
  }
  const { diff, dropped } = planDiff(old, plan);
  for (const d of dropped) warn(d);
  save(init.file, plan);
  const roadmap = syncRoadmapFile(init.dir, plan);
  const stackFile = join(init.dir, "stack.json");
  writeAtomic(stackFile, JSON.stringify(stackPlan(plan), null, 2) + "\n");
  emit(json, { ok: true, file: init.file, stack: stackFile, slices: plan.slices.length, plan_file: target?.plan_file ?? null, diff, roadmap: roadmap.changed }, () => {
    console.log(`saved ${init.file}`);
    if (target) console.log(`PR ${target.n}: plan approved and saved to ${target.plan_file}; build it here, or in a fresh chat with /pair implement ${plan.slug}`);
    for (const c of roadmap.changed) console.log(`roadmap: ${c}`);
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
  const extraIds = acs ? [...new Set(pair.slices.flatMap((s) => s.acs))].filter((id) => !acs.has(id)) : [];
  for (const id of extraIds) coverage.push({ id, slices: pair.slices.filter((s) => s.acs.includes(id)).map((s) => s.n) });
  const uncovered = coverage.filter((c) => !c.slices.length).map((c) => c.id);
  const rows = pair.slices.map((s) => ({
    n: s.n,
    title: s.title,
    milestone: s.milestone ?? null,
    status: s.status,
    state: stateOf(s),
    pr: s.pr ?? null,
    merge_point: s.merge_point,
    live_with: liveWith(pair, s)?.n ?? null,
    branch: s.branch,
    after: s.after,
    acs: s.acs,
    prefactor: Boolean(s.prefactor),
    planned: isPlanned(s),
    plan_file: s.plan_file ?? null,
    test_script: s.test_script ?? [],
    est_days: s.est_days,
    target_date: s.target_date ?? null,
    budget: s.budget.net_lines,
    est_lines: s.commits.reduce((a, c) => a + (c.est_lines ?? 0), 0),
    commits: `${planned(s).filter((c) => c.status === "done").length}/${planned(s).length}`,
    exceptions: s.exceptions,
  }));
  const shipFirst = shipFirstWarning(pair);
  if (shipFirst) warn(shipFirst);
  emit(args.flags.has("--json"), { slug: pair.slug, base: pair.base, cap: pair.cap, timeline: tl, slices: rows, coverage, uncovered, specAcs: Boolean(acs) }, () => {
    console.log(`${pair.slug} · base ${pair.base} · open-PR cap ${pair.cap}`);
    let milestone: string | null | undefined;
    for (const r of rows) {
      if (r.milestone !== milestone) {
        milestone = r.milestone;
        console.log(`\n${milestone ?? "(no milestone)"}`);
      }
      console.log(`  PR ${r.n}: ${r.title} (${r.state})`);
      console.log(`     ${/^after this\b/i.test(r.after) ? r.after : `After this you can ${r.after}`}`);
      if (!r.merge_point) console.log(r.live_with ? `     Goes live together with PR ${r.live_with}.` : "     Not a merge point, and no later PR takes it live.");
      console.log(`     ${r.acs.length ? `ACs ${r.acs.join(", ")}` : r.prefactor ? "prefactor (no AC)" : "no ACs"} · ${r.est_days}d${r.target_date ? ` by ${r.target_date}` : ""} · est ${r.est_lines}/${r.budget} net lines · commits ${r.commits} · ${r.branch}`);
      for (const e of r.exceptions) console.log(`     exception${e.approved ? "" : " (NOT APPROVED)"}: ${e.what} (${e.why})`);
    }
    console.log("");
    if (tl.deadline === null) console.log(`timeline: ${tl.planned}d planned, ${tl.remaining}d left to build, no deadline`);
    else
      console.log(
        `timeline: ${tl.remaining}d left to build of ${tl.planned}d planned; ${tl.available} working days to ${tl.deadline}` +
          (tl.atRisk ? ` · AT RISK: ${tl.gap}d over (cut scope, flag, follow-up PR, or move the date)` : " · on track"),
      );
    console.log(`AC coverage${acs ? "" : " (no spec; ladder ACs only)"}:`);
    for (const c of coverage) console.log(`  ${c.id} → ${c.slices.length ? `PR ${c.slices.join(", ")}` : "UNCOVERED"}`);
  });
}

function nextLine(p: Pair, r: ReturnType<typeof nextFor>): string {
  const s = r.slice;
  const name = s ? `PR ${s.n}, "${s.title}"` : "";
  const fresh = r.next ? `Next is PR ${r.next.n}, "${r.next.title}": start it in a fresh chat with ${starterFor(p, r.next)} (run /handoff for the starter).` : "Every other PR is shipped.";
  switch (r.action) {
    case "plan":
      return `${name}, has no approved plan yet${s && planGaps(s).length ? ` (${planGaps(s).join("; ")})` : ""}. Plan it in plan mode.`;
    case "build":
      return `${name}: plan approved${s?.plan_file ? ` (${s.plan_file})` : ""}, ${s ? commitCount(s) : ""} built. Build the rest.`;
    case "checkpoint":
      return `${name}, is built in this chat. Run the checkpoint, the walkthrough, then /ship.`;
    case "ship":
      return `${name}, was built in an earlier chat. Run green, the walkthrough, then /ship.`;
    case "fixes":
      return `${name}, is shipped${s?.pr ? ` as draft #${s.pr}` : ""}. This chat only takes fixes to it and roadmap updates. ${fresh}`;
    case "refuse":
      return `This chat is on ${prList(r.held)}. One PR per chat: start ${name} in a fresh chat with ${s ? starterFor(p, s) : "/pair"} (run /handoff for the starter).`;
    case "no-plan":
      return `No PR has an approved plan or a half-built branch. Run /pair plan ${p.slug} to plan the next one.`;
    case "all-shipped":
      return "Every PR in the ladder is shipped.";
  }
}

function warnOrder(pair: Pair, r: ReturnType<typeof nextFor>) {
  if (r.action !== "refuse" && r.earlier.length) warn(`earlier PRs are not shipped yet (${prList(r.earlier)}); ship them first unless the user chose this order`);
  const shipFirst = shipFirstWarning(pair);
  if (shipFirst) warn(shipFirst);
}

async function cmdNext(args: Args) {
  allowFlags(args, ["--implement"]);
  const { pair } = await load(args);
  const raw = args.pos[0];
  if (raw !== undefined && !/^\d+$/.test(raw)) throw new UserError("usage: pair next [<n>] [--implement]");
  if (raw !== undefined && args.flags.has("--implement")) throw new UserError("pass <n> or --implement, not both");
  const r = nextFor(pair, sessionId(), { want: raw === undefined ? undefined : Number(raw), implement: args.flags.has("--implement") });
  warnOrder(pair, r);
  const s = r.slice;
  const data = {
    action: r.action,
    slice: s && { n: s.n, title: s.title, branch: s.branch, status: s.status, state: stateOf(s), pr: s.pr ?? null, plan_file: s.plan_file ?? null, gaps: planGaps(s) },
    held: r.held.map((x) => x.n),
    earlier: r.earlier.map((x) => x.n),
    next: r.next && { n: r.next.n, title: r.next.title },
    message: nextLine(pair, r),
  };
  emit(args.flags.has("--json"), data, () => console.log(data.message));
}

async function cmdStatus(args: Args) {
  allowFlags(args, []);
  const { pair, file, dir } = await load(args);
  const json = args.flags.has("--json");
  const r = nextFor(pair, sessionId());
  warnOrder(pair, r);
  const shipped = pair.slices.filter(isShipped);
  const first = pair.slices.find((x) => !isShipped(x)) ?? null;
  const slices = pair.slices.map((s) => ({
    n: s.n,
    title: s.title,
    branch: s.branch,
    stage: stageOf(s),
    status: s.status,
    state: stateOf(s),
    commits: { done: planned(s).filter((c) => c.status === "done").length, planned: planned(s).length, extra: s.commits.length - planned(s).length },
    pr: s.pr ?? null,
    plan_file: s.plan_file ?? null,
    merge_point: s.merge_point,
  }));
  const s = r.slice && isStarted(r.slice) && !isShipped(r.slice) ? r.slice : null;
  let net: Net | null = null;
  let head: string | null = null;
  if (s) {
    try {
      const top = await checkout(pair);
      head = await branchOf(top);
      if (head === s.branch) {
        net = await storeNet(top, pair, s);
        save(file, pair);
      } else warn(`HEAD is ${head ?? "detached"}, not ${s.branch}; showing the stored net lines`);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      warn(`net lines not measured (${e.message}); showing the stored value`);
    }
  }
  const progress = s && (() => {
    const plannedCommits = planned(s);
    const done = plannedCommits.filter((c) => c.status === "done").length;
    const next = nextCommit(s);
    const elapsed = s.started_at ? elapsedWorkingDays(new Date(s.started_at), new Date()) : null;
    return {
      slice: { n: s.n, of: pair.slices.length, title: s.title, status: s.status, branch: s.branch, head },
      commit: next ? { n: next.n, title: next.title, files: next.files ?? [], check: next.check ?? null } : null,
      commits: { done, planned: plannedCommits.length, extra: s.commits.length - plannedCommits.length },
      net_lines: net?.net ?? s.net_lines ?? null,
      net_measured: Boolean(net),
      insertions: net?.ins ?? null,
      deletions: net?.del ?? null,
      budget: s.budget.net_lines,
      elapsed_days: elapsed === null ? null : Math.round(elapsed * 10) / 10,
      est_days: s.est_days,
      at_risk: elapsed !== null && atRisk(elapsed, s.est_days, done, plannedCommits.length),
    };
  })();
  const data = {
    slug: pair.slug,
    dir,
    shipped: shipped.length,
    of: pair.slices.length,
    slices,
    next: first && { n: first.n, title: first.title, stage: stageOf(first), starter: starterFor(pair, first) },
    chat: r.held.map((x) => x.n),
    action: r.action,
    next_step: nextLine(pair, r),
    ...(progress ?? { slice: null }),
  };
  emit(json, data, () => {
    console.log(`${pair.slug}: ${shipped.length} of ${pair.slices.length} PRs shipped.`);
    for (const l of slices) console.log(`PR ${l.n}: ${l.state} ("${l.title}")`);
    console.log("");
    if (r.held.length) console.log(`This chat is on ${prList(r.held)}.`);
    console.log(`Next step: ${data.next_step}`);
    if (first && !r.held.length) console.log(`Starter for a fresh chat: ${starterFor(pair, first)}`);
    if (!progress || !s) return;
    const p = progress;
    console.log(`PR ${s.n} is on ${s.branch}${head && head !== s.branch ? ` (HEAD is ${head})` : ""}: ${p.commits.done} of ${p.commits.planned} planned commits done${p.commits.extra ? `, plus ${p.commits.extra} extra` : ""}.`);
    if (p.commit) console.log(`Next commit: ${p.commit.n}, ${p.commit.title}.`);
    const n = p.net_lines;
    console.log(`Size: ${n === null ? "unknown" : signed(n)} of ${p.budget} net lines${net ? ` (+${net.ins} −${net.del})` : " (stored)"}.`);
    console.log(p.elapsed_days === null ? `Time: not started (estimate ${s.est_days}d).` : `Time: ${p.elapsed_days} of ${s.est_days} working days${p.at_risk ? "; AT RISK (over 80% of the time used, under 80% of the commits done)" : ""}.`);
  });
}

async function cmdCheck(args: Args) {
  allowFlags(args, []);
  const { pair } = await load(args);
  const top = await checkout(pair);
  const s = sliceArg(pair, undefined, (await headSlice(top, pair)) ?? currentSlice(pair));
  const head = await branchOf(top);
  if (head !== s.branch) warn(`HEAD is ${head ?? "detached"}, PR ${s.n} is on ${s.branch}`);
  const commit = nextCommit(s);
  const plannedFiles = commit ? (commit.files ?? []) : sliceFiles(s);
  const changed = parsePorcelainPaths(await git(top, "status", "--porcelain=v1", "-z", "--untracked-files=all"));
  const outOfPlan = changed.filter((p) => !inPlan(p, plannedFiles));
  const net = await netLines(top, await sliceBase(top, pair, s));
  const over = net.net > s.budget.net_lines;
  const ok = !outOfPlan.length && !over;
  const target = commit ? `commit ${commit.n} "${commit.title}"` : `PR ${s.n} (any planned file of the PR)`;
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
    console.log(`options: split the work, move it to another commit or PR, or raise the limit with a recorded reason`);
  });
  if (!ok) process.exit(EXIT_STOP);
}

async function cmdCommit(args: Args) {
  allowFlags(args, ["--why", "--notes", "--alt", "--deviation", "--noticed", "--checked", "--title", "--batch"]);
  const why = need(args, "--why");
  const notesFile = need(args, "--notes");
  const extraTitle = str(args, "--title")?.trim();
  const deviation = str(args, "--deviation")?.trim();
  const { pair, file } = await load(args);
  const top = await checkout(pair);
  const head = await branchOf(top);
  const s = await headSlice(top, pair);
  if (!s) {
    const cur = currentSlice(pair);
    throw new UserError(`HEAD is ${head ?? "detached"}, which is no PR's branch${cur ? `; PR ${cur.n} commits go on ${cur.branch} (br new ${cur.branch} --here)` : " (pair slice start <n> prints the br command)"}`);
  }
  if (s.status === "todo") throw new UserError(`PR ${s.n} is not started (pair slice start ${s.n})`);
  const sid = sessionId();
  const refused = claimProblem(pair, s, sid, args.flags.has("--batch"));
  if (refused) throw new UserError(refused);

  let commit: Commit | null = null;
  if (extraTitle) {
    const bad = validTitle(extraTitle);
    if (bad) throw new UserError(bad);
  } else {
    commit = nextCommit(s);
    if (!commit) throw new UserError(`every planned commit of PR ${s.n} is done; pass --title "<type(scope): summary>" for an extra commit`);
  }
  const staged = parseNameStatus(await git(top, "diff", "--cached", "--name-status", "-z", "-M"));
  if (!staged.length) throw new UserError("nothing staged; stage the planned files explicitly (git add <path>…)");
  const plannedFiles = commit ? (commit.files ?? []) : sliceFiles(s);
  const outside = [...new Set(staged.flatMap((c) => (c.from ? [c.from, c.path] : [c.path])))].filter((p) => !inPlan(p, plannedFiles));
  if (outside.length && !deviation)
    throw new UserError(`staged files outside the planned commit: ${outside.join(", ")} (unstage them, or pass --deviation "<why>")`);
  const notes = readJson(resolve(notesFile), "notes") as Record<string, unknown>;
  if (!isObj(notes)) throw new UserError(`${notesFile} must map each staged path to a one-line note`);
  const missing = staged.filter((c) => !noteFor(notes, c)).map((c) => c.path);
  if (missing.length) throw new UserError(`no note for staged path(s): ${missing.join(", ")}`);
  const stagedKeys = new Set(staged.flatMap((c) => (c.from ? [c.path, c.from, `${c.from} → ${c.path}`] : [c.path])));
  for (const k of Object.keys(notes)) if (!stagedKeys.has(k)) warn(`note for ${k} ignored: not staged`);

  const title = commit ? commit.title : extraTitle!;
  const acs = commit ? commit.acs : [];
  const checked = str(args, "--checked")?.trim() || commit?.check || greenCheck(s);
  if (!checked) throw new UserError(`PR ${s.n} has no check command; pass --checked "<cmd>"`);
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
  else
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
  claim(s, sid);
  const next = nextCommit(s);
  if (!next && s.status === "active") s.status = "checkpoint";
  const net = await storeNet(top, pair, s);
  save(file, pair);
  syncRoadmapFile(dirname(file), pair);
  const done = planned(s).filter((c) => c.status === "done").length;
  emit(args.flags.has("--json"), { sha, title, slice: s.n, status: s.status, commits: { done, planned: planned(s).length }, net_lines: net.net, budget: s.budget.net_lines, next: next ? { n: next.n, title: next.title } : null }, () => {
    console.log(`committed ${short(sha)} ${title}`);
    console.log(`PR ${s.n}: ${done}/${planned(s).length} planned commits · net lines ${signed(net.net)}/${s.budget.net_lines}`);
    if (next) console.log(`next: commit ${next.n} ${next.title}`);
    else if (isShipped(s)) console.log(`PR ${s.n} is shipped${s.pr ? ` as #${s.pr}` : ""}; push the fix with br push`);
    else console.log(`all planned commits done: PR ${s.n} is at its checkpoint`);
  });
}

async function cmdGreen(args: Args) {
  allowFlags(args, ["--slice"]);
  const { pair } = await load(args);
  const top = await checkout(pair);
  const s = sliceArg(pair, intFlag(args, "--slice"), (await headSlice(top, pair)) ?? currentSlice(pair));
  const head = await branchOf(top);
  if (head !== s.branch) throw new UserError(`HEAD is ${head ?? "detached"}; switch to ${s.branch} first (br new ${s.branch} --here)`);
  const dirty = (await git(top, "status", "--porcelain", "--untracked-files=all")).split("\n").filter(Boolean);
  if (dirty.length) throw new UserError(`green needs a clean tree (${dirty.length} change(s), untracked included); commit or stash first`);
  for (const d of ["rebase-merge", "rebase-apply"])
    if (existsSync(resolve(top, await git(top, "rev-parse", "--git-path", d)))) throw new UserError("a rebase is already in progress");
  const base = await sliceBase(top, pair, s);
  const check = greenCheck(s);
  if (!check) throw new UserError(`PR ${s.n} has no check command`);
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
        console.log(`green: all ${shas.length} commit(s) of PR ${s.n} pass \`${check}\` (base ${base}); SHAs unchanged`),
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
    const found = (await sliceOfCommit(top, pair, full, await git(top, "log", "-1", "--format=%s", full))) ?? (await headSlice(top, pair)) ?? currentSlice(pair);
    if (!found) throw new UserError(`commit ${short(full)} is on no PR branch of the ladder; pass --slice <n> to walk a whole PR`);
    s = found;
    shas = [full];
  } else {
    const fallback = (await headSlice(top, pair)) ?? currentSlice(pair) ?? [...pair.slices].reverse().find((x) => x.status !== "todo") ?? null;
    s = sliceArg(pair, intFlag(args, "--slice"), fallback);
    const ref = await branchRef(top, s);
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
  emit(args.flags.has("--json"), { slice: s.n, branch: s.branch, base, plan_file: s.plan_file ?? null, deviations, commits }, () => {
    console.log(`Walkthrough: PR ${s.n} "${s.title}" (${s.branch}${base ? ` on ${base}` : ""}, ${commits.length} commit(s))`);
    if (s.plan_file) console.log(`Approved plan: ${s.plan_file}`);
    console.log("");
    console.log(deviations.length ? "Deviations:" : "Deviations: none");
    for (const d of deviations) console.log(`- ${short(d.sha)} ${d.title}: ${d.reason}`);
    commits.forEach((c, i) => {
      console.log(`\n=== ${i + 1}/${commits.length} ${short(c.sha)} ${c.title}${c.planned ? "" : " [UNPLANNED]"} ===`);
      console.log(c.body.trim() ? c.body.trimEnd() : "(no message body: no reasoning recorded)");
      console.log("");
      console.log(c.show);
    });
  });
}

async function cmdSlice(args: Args) {
  allowFlags(args, ["--force", "--batch", "--pr"]);
  const [action, nRaw] = args.pos;
  if ((action !== "start" && action !== "ship") || !nRaw || !/^\d+$/.test(nRaw)) throw new UserError("usage: pair slice start <n> [--force] | pair slice ship <n> --pr <number> [--force]");
  const { pair, file } = await load(args);
  const s = sliceArg(pair, nRaw, null);
  const force = args.flags.has("--force");
  const json = args.flags.has("--json");
  const sid = sessionId();
  const refused = claimProblem(pair, s, sid, args.flags.has("--batch"));
  if (refused) throw new UserError(refused);
  const prev = pair.slices.find((x) => x.n === s.n - 1);
  const base = prev ? prev.branch : pair.base.startsWith("origin/") ? pair.base : `origin/${pair.base}`;
  const after = () => pair.slices.find((x) => x.n > s.n && !isShipped(x)) ?? pair.slices.find((x) => x !== s && !isShipped(x)) ?? null;

  if (action === "ship") {
    const pr = intFlag(args, "--pr");
    if (!pr) throw new UserError("--pr <number> is required (the draft PR /ship opened)");
    const todo = planned(s).filter((c) => c.status !== "done");
    if (todo.length && !force) throw new UserError(`PR ${s.n} has ${todo.length} planned commit(s) not done; build them first (or --force)`);
    if (s.pr && s.pr !== pr) warn(`PR ${s.n} was recorded as #${s.pr}; now #${pr}`);
    const changed = s.status !== "shipped" || s.pr !== pr;
    s.status = "shipped";
    s.pr = pr;
    s.shipped_at ??= new Date().toISOString();
    claim(s, sid);
    save(file, pair);
    const roadmap = syncRoadmapFile(dirname(file), pair);
    const next = after();
    const starter = next ? starterFor(pair, next) : null;
    const line = `PR ${s.n} is open as draft #${pr} and marked shipped in the ${roadmap.file ? "roadmap" : "ladder"}. ${next ? `Next is PR ${next.n}, ${next.title} (starter: ${starter}).` : "Every PR in the ladder is shipped."}`;
    return emit(json, { slice: s.n, status: s.status, pr, changed, next: next && { n: next.n, title: next.title, starter }, message: line }, () => console.log(line));
  }

  const cmd = `br new ${s.branch} --here --base ${base}`;
  const brWorktree = `br new ${s.branch} --worktree --base ${base}`;
  let message: string;
  if (isShipped(s)) message = `PR ${s.n} is shipped${s.pr ? ` as #${s.pr}` : ""}; this chat takes fixes to it and roadmap updates only`;
  else if (isBuilt(s)) message = `PR ${s.n} is built; next: green, the walkthrough, then /ship`;
  else {
    if (!isBuildable(s)) {
      const gaps = planGaps(s);
      throw new UserError(`PR ${s.n} has no approved plan yet${gaps.length ? ` (${gaps.join("; ")})` : ""}; plan it in plan mode (/pair plan ${pair.slug}${s === pair.slices.find((x) => !isShipped(x)) ? "" : ` ${s.n}`}), which saves it with pair plan save <file> --slice ${s.n} --plan <plan.md>`);
    }
    if (prev && !isBuilt(prev) && !isShipped(prev) && !force) throw new UserError(`PR ${prev.n} is not built yet and PR ${s.n} stacks on its branch; build PR ${prev.n} first (or --force)`);
    if (s.status !== "active") {
      s.status = "active";
      s.started_at ??= new Date().toISOString();
    }
    const next = nextCommit(s);
    message = `PR ${s.n} "${s.title}" is in progress${next ? `; next commit: ${next.n} ${next.title}` : ""}`;
  }
  const earlier = pair.slices.filter((x) => x.n < s.n && !isShipped(x));
  if (earlier.length && !isShipped(s)) warn(`earlier PRs are not shipped yet (${prList(earlier)}); ship them first unless the user chose this order`);
  const shipFirst = shipFirstWarning(pair);
  if (shipFirst) warn(shipFirst);
  claim(s, sid);
  save(file, pair);
  syncRoadmapFile(dirname(file), pair);
  const next = nextCommit(s);
  emit(json, { slice: s.n, status: s.status, state: stateOf(s), branch: s.branch, plan_file: s.plan_file ?? null, br: cmd, brWorktree, next: next && !isShipped(s) ? { n: next.n, title: next.title } : null, message }, () => {
    console.log(message);
    console.log(`switch to its branch: ${cmd}   (or --worktree instead of --here)`);
  });
}

async function cmdRoadmap(args: Args) {
  allowFlags(args, []);
  if (args.pos[0] !== "sync") throw new UserError("usage: pair roadmap sync");
  const { pair, dir } = await load(args);
  const r = syncRoadmapFile(dir, pair, true);
  emit(args.flags.has("--json"), { file: r.file, changed: r.changed, problems: r.problems }, () => {
    console.log(r.changed.length ? `updated ${r.file}` : `${r.file} already matches the ladder`);
    for (const c of r.changed) console.log(`  ${c}`);
  });
}

// Initiatives of this repo (every repo outside a checkout) whose ladder still has an unshipped PR.
async function cmdRoadmaps(args: Args) {
  allowFlags(args, []);
  const here = await gitOk(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir");
  const found: { slug: string; next: { n: number; title: string; state: string }; starter: string; next_up: string | null }[] = [];
  for (const slug of existsSync(STATE_DIR) ? readdirSync(STATE_DIR).sort() : []) {
    const file = join(STATE_DIR, slug, "pair.json");
    if (!SLUG_RE.test(slug) || !existsSync(file)) continue;
    let pair: Pair;
    try {
      pair = readPair(file);
    } catch {
      warn(`${file} could not be read; skipped`);
      continue;
    }
    if (here) {
      const common = await gitOk(pair.repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
      if (common === null || real(common) !== real(here)) continue;
    }
    const next = pair.slices.find((s) => !isShipped(s));
    if (!next) continue;
    const roadmap = join(STATE_DIR, slug, "roadmap.md");
    const nextUp = existsSync(roadmap) ? (readFileSync(roadmap, "utf8").split("\n").find((l) => NEXT_UP_RE.test(l)) ?? null) : null;
    found.push({ slug, next: { n: next.n, title: next.title, state: stateOf(next) }, starter: starterFor(pair, next), next_up: nextUp });
  }
  emit(args.flags.has("--json"), { repo: here ? dirname(here) : null, roadmaps: found }, () => {
    if (!found.length) console.log("No roadmap here has an unshipped PR.");
    for (const f of found) console.log(`${f.slug}: ${f.next_up ?? `PR ${f.next.n}, ${f.next.title} (${f.next.state})`} → ${f.starter}`);
  });
}

const USAGE = `usage: pair <command> [--slug <slug>] [--json]   (default slug: work current for the cwd)
  plan save <file.json>            validate and store the whole ladder (brainstorm); writes pair.json and stack.json
  plan save <slice.json> --slice <n> --plan <plan.md>
                                   store PR n's approved plan: detailed commits, the plan file (pr-<n>-plan.md), approval
  plan show                        ladder by milestone, state of each PR, timeline vs deadline, AC coverage
  next [<n>] [--implement]         what /pair (or /pair <n>, /pair implement) does now: plan, build, checkpoint, ship, fixes, refuse
  status                           every PR's state, this chat's PR, and the current PR's commits, size and time
  check                            working tree vs the planned commit's files and the PR budget (exit 2: stop and ask)
  commit --why "…" --notes <file.json> [--alt "…"] [--deviation "…"] [--noticed "…"] [--checked "<cmd>"] [--title "<extra commit title>"]
                                   commit what is staged as the next planned commit of HEAD's PR (or an extra one with --title)
  green [--slice <n>]              every commit of the PR passes its check (rebase --keep-base -x; SHAs unchanged)
  walk [--slice <n> | --commit <sha>]   commit-by-commit walkthrough, deviations first
  slice start <n> [--force]        this chat takes PR n (one PR per chat); prints the br command
  slice ship <n> --pr <number>     record the draft PR that /ship opened; prints the next PR and its starter
  roadmap sync                     rewrite the PR statuses and the Next up line of roadmap.md from the ladder
  roadmaps                         initiatives of this repo with an unshipped PR, their Next up line and starter
  --batch                          on plan save --slice, slice, commit: let this chat work on another PR (only on the user's explicit ask)`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "plan":
      if (args.pos[0] === "save") return cmdPlanSave(args);
      if (args.pos[0] === "show") return cmdPlanShow(args);
      break;
    case "next":
      return cmdNext(args);
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
    case "slice":
      return cmdSlice(args);
    case "roadmap":
      return cmdRoadmap(args);
    case "roadmaps":
      return cmdRoadmaps(args);
  }
  console.error(USAGE);
  process.exit(1);
}

if (import.meta.main)
  main().catch((e) => {
    console.error(`pair: ${e instanceof UserError ? e.message : ((e as Error)?.message ?? e)}`);
    process.exit(1);
  });
