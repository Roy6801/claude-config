#!/usr/bin/env bun
// Worktree manager: worktrees under ~/worktrees/<project>/<name>, env file sync, install and codegen,
// listing, removal and pruning. Backs the worktree skill: the skill maps intent to a subcommand, this
// script owns every git and gh sequence.
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ghEnv, localRepo, originRepo, repoConventions, useAccountFor, type Target } from "../../../bin/gh-activity.ts";
import { openLine } from "../../../bin/launch.ts";

const HOME = homedir();
const WT_ROOT = join(HOME, "worktrees");
const ENV_SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", ".turbo"]);
// Lives in the worktree's private git dir, so `git worktree remove` cleans it up.
const ENV_SOURCE_FILE = "wt-env-source";
const LEGACY_ENV_SOURCE_FILE = "br-env-source";
const CODEGEN_SCRIPTS = ["codegen", "generate", "db:generate", "prisma:generate"];
const MIGRATION_LIKE = /drizzle-kit\s+(generate|migrate|push)|prisma\s+(migrate|db\s+push)|\bmigrat/i;
// `db:generate` is ambiguous (drizzle uses it for migrations); only run it when it is plainly prisma client generation.
const isCodegen = (name: string, body: string) =>
  !MIGRATION_LIKE.test(body) && (name !== "db:generate" || /prisma\s+generate/.test(body));
const DEFAULT_STALE_DAYS = 30;
const VALUE_FLAGS = new Set(["--base", "--name", "--detach", "--stale", "--from"]);

type Repo = {
  project: string;
  mainRoot: string;
  commonDir: string;
  hasOrigin: boolean;
  defaultBranch: string;
  baseRef: string;
  target?: Target;
};
type Conventions = Awaited<ReturnType<typeof repoConventions>>;
type GitHub = { slug: string | null; env: Record<string, string>; conventions: Conventions | null; error: string | null };
type Entry = { path: string; head: string; branch: string | null; locked: boolean; prunable: boolean };
type Pr = { number: number; state: string; url: string; isDraft: boolean; base: string };
type Row = {
  project: string;
  name: string;
  path: string;
  branch: string | null;
  head: string | null;
  dirty: number | null;
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
  lastCommit: number | null;
  pr: Pr | null;
  flags: string[];
};
type Args = { pos: string[]; flags: Map<string, string | true> };

class UserError extends Error {}

const warnings: string[] = [];
function warn(msg: string) {
  if (warnings.includes(msg)) return;
  warnings.push(msg);
  console.error(`warning: ${msg}`);
}

const tilde = (p: string) => (p === HOME || p.startsWith(HOME + sep) ? "~" + p.slice(HOME.length) : p);
const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const tail = (s: string, n = 15) => s.trim().split("\n").slice(-n).join("\n");
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);

async function exec(cmd: string[], cwd?: string, env?: Record<string, string>) {
  let proc;
  try {
    proc = Bun.spawn(cmd, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
  } catch (e) {
    throw new UserError(`could not run ${cmd[0]}: ${(e as Error).message}`);
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
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

const refExists = async (cwd: string, ref: string) => (await gitOk(cwd, "show-ref", "--verify", "--quiet", ref)) !== null;

function tool(name: string, fallback: string[]): string[] {
  const found = Bun.which(name) ?? (existsSync(join(HOME, ".bun", "bin", name)) ? join(HOME, ".bun", "bin", name) : null);
  if (found) return [found];
  warn(`${name} not found, falling back to ${fallback.join(" ")}`);
  return fallback;
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
  for (const f of args.flags.keys()) if (f !== "--json" && !allowed.includes(f)) throw new UserError(`unknown flag ${f}`);
}

function parsePorcelain(out: string): Entry[] {
  return out
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const e: Entry = { path: "", head: "", branch: null, locked: false, prunable: false };
      for (const line of block.split("\n")) {
        const i = line.indexOf(" ");
        const [k, v] = i === -1 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
        if (k === "worktree") e.path = v;
        else if (k === "HEAD") e.head = v;
        else if (k === "branch") e.branch = v.replace(/^refs\/heads\//, "");
        else if (k === "locked") e.locked = true;
        else if (k === "prunable") e.prunable = true;
      }
      return e;
    });
}

const listEntries = async (repo: Repo) => parsePorcelain(await git(repo.mainRoot, "worktree", "list", "--porcelain"));

async function loadRepo(cwd: string): Promise<Repo> {
  const commonDir = real(await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const mainRoot = parsePorcelain(await git(cwd, "worktree", "list", "--porcelain"))[0]!.path;
  const origin = await gitOk(mainRoot, "remote", "get-url", "origin");
  const project = origin ? basename(origin.replace(/\/+$/, "")).replace(/\.git$/, "") : basename(mainRoot);
  if (!origin) warn(`${tilde(mainRoot)} has no origin remote; project name and base fall back to local values`);

  // The remote is the source of truth; a local origin/HEAD is only an offline fallback.
  const localHead = (await gitOk(mainRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"))?.replace(/^origin\//, "") || null;
  let def: string | null = null;
  if (origin) {
    const ls = await exec(["git", "ls-remote", "--symref", "origin", "HEAD"], mainRoot, { GIT_TERMINAL_PROMPT: "0" }).catch(() => null);
    def = ls?.code === 0 ? (/^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(ls.out)?.[1] ?? null) : null;
    if (!def) {
      // Private repo of another gh account: borrow that account's token for this process only.
      const slug = await localRepo(mainRoot).then((l) => (l ? originRepo(l) : null)).catch(() => null);
      if (slug) await useAccountFor(slug).catch(() => {});
      const view = ["gh", "repo", "view", ...(slug ? [slug] : []), "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"];
      const r = await exec(view, mainRoot, ghEnv()).catch(() => null);
      if (r?.code === 0 && r.out) def = r.out;
    }
    if (def && localHead && localHead !== def)
      warn(`local origin/HEAD says ${localHead} but the remote's HEAD is ${def}; using ${def} (refresh: git remote set-head origin --auto)`);
    if (!def && localHead) warn(`could not reach origin; using the local origin/HEAD (${localHead}), which may be stale`);
  }
  if (!def) def = localHead;
  if (!def) {
    for (const c of ["main", "master"])
      if ((await refExists(mainRoot, `refs/remotes/origin/${c}`)) || (await refExists(mainRoot, `refs/heads/${c}`))) {
        def = c;
        break;
      }
  }
  if (!def) throw new UserError(`could not determine the default branch of ${tilde(mainRoot)}`);
  const hasOriginRef = origin !== null && (await refExists(mainRoot, `refs/remotes/origin/${def}`));
  return {
    project,
    mainRoot,
    commonDir,
    hasOrigin: origin !== null,
    defaultBranch: def,
    baseRef: hasOriginRef ? `origin/${def}` : def,
  };
}

async function currentRepo(): Promise<Repo> {
  if ((await gitOk(process.cwd(), "rev-parse", "--git-dir")) === null) throw new UserError("not inside a git repository");
  return loadRepo(process.cwd());
}

const isSegment = (s: string) => s !== "" && s !== "." && s !== ".." && !s.includes("/") && !s.includes(sep);

function projectDir(repo: Repo) {
  if (!isSegment(repo.project)) throw new UserError(`project name "${repo.project}" (from the origin URL or folder) is not a usable folder name under ${tilde(WT_ROOT)}`);
  return join(WT_ROOT, repo.project);
}

// ---------- GitHub and integration target ----------

// gh-activity keeps the repo owner's token in module state, so lookups for different repos run one at a
// time and each repo keeps a snapshot of its env for later gh calls. Tokens never reach the output.
const githubCache = new Map<string, Promise<GitHub>>();
let githubQueue: Promise<unknown> = Promise.resolve();

function github(repo: Repo): Promise<GitHub> {
  const cached = githubCache.get(repo.commonDir);
  if (cached) return cached;
  const p = githubQueue.then(async (): Promise<GitHub> => {
    if (!repo.hasOrigin) return { slug: null, env: {}, conventions: null, error: "no origin remote" };
    try {
      const slug = await originRepo((await localRepo(repo.mainRoot))!);
      await useAccountFor(slug);
      const env = ghEnv();
      return { slug, env, conventions: await repoConventions(slug), error: null };
    } catch (e) {
      return { slug: null, env: {}, conventions: null, error: (e as Error).message };
    }
  });
  githubQueue = p;
  githubCache.set(repo.commonDir, p);
  return p;
}

const ghExec = async (repo: Repo, args: string[], cwd = repo.mainRoot) => exec(["gh", ...args], cwd, (await github(repo)).env);

// Where new work merges, for the repo as a whole (never the current branch's PR base or stack parent).
// Falls back to origin's default branch when gh or a GitHub remote is unavailable.
async function integrationTarget(repo: Repo): Promise<Target> {
  if (repo.target) return repo.target;
  const gh = await github(repo);
  let t = gh.conventions?.target ?? null;
  if (!t) {
    const why = gh.error ?? "GitHub reports no merged PRs and no default branch";
    warn(`integration target unavailable (${why}); using the default branch ${repo.defaultBranch}`);
    t = { branch: repo.defaultBranch, source: "local-default", evidence: `GitHub lookup failed (${why}); origin's default branch is ${repo.defaultBranch}` };
  }
  repo.target = t;
  return t;
}

// The ref new branches start from: origin/<integration target>, else the default base.
async function newWorkBase(repo: Repo): Promise<string> {
  const t = await integrationTarget(repo);
  if (!repo.hasOrigin) return repo.baseRef;
  const ref = `refs/remotes/origin/${t.branch}`;
  if (!(await refExists(repo.mainRoot, ref))) {
    const f = await exec(["git", "fetch", "--quiet", "origin", `+refs/heads/${t.branch}:${ref}`], repo.mainRoot, { GIT_TERMINAL_PROMPT: "0" });
    if (f.code !== 0) throw new UserError(`integration target origin/${t.branch} is not available locally and fetching it failed: ${firstLine(f.err)} (pass --base to choose explicitly)`);
  }
  return `origin/${t.branch}`;
}

async function fetchOrigin(repo: Repo) {
  if (!repo.hasOrigin) return;
  const f = await exec(["git", "fetch", "--prune", "--quiet", "origin"], repo.mainRoot);
  if (f.code !== 0) warn(`fetch failed, using local refs: ${firstLine(f.err)}`);
}

function emit(json: boolean, data: unknown, human: () => void) {
  if (json) console.log(JSON.stringify(Array.isArray(data) ? data : { ...(data as object), warnings }, null, 2));
  else human();
}

// ---------- ls ----------

async function fetchPrs(repo: Repo): Promise<Map<string, Pr> | null> {
  const gh = await github(repo);
  if (!gh.slug) {
    warn(`${repo.project}: PR state unavailable (${gh.error})`);
    return null;
  }
  const r = await ghExec(repo, ["pr", "list", "--state", "all", "--limit", "300", "--json", "number,state,headRefName,baseRefName,url,isDraft"]).catch(
    () => null,
  );
  if (!r || r.code !== 0) {
    warn(`${repo.project}: gh pr list failed${r ? `: ${firstLine(r.err)}` : ""}`);
    return null;
  }
  const byBranch = new Map<string, Pr>();
  // gh returns newest first; an open PR wins over older closed/merged ones.
  for (const p of JSON.parse(r.out) as (Pr & { headRefName: string; baseRefName: string })[]) {
    const cur = byBranch.get(p.headRefName);
    if (!cur || (p.state === "OPEN" && cur.state !== "OPEN"))
      byBranch.set(p.headRefName, { number: p.number, state: p.state, url: p.url, isDraft: p.isDraft, base: p.baseRefName });
  }
  return byBranch;
}

async function repoRows(repo: Repo, opts: { pr: boolean; staleDays: number }): Promise<Row[]> {
  const entries = await listEntries(repo);
  const target = await integrationTarget(repo);
  // Merged into the default branch or into the integration target, when they differ.
  const mergeRefs = [repo.baseRef];
  if (target.branch !== repo.defaultBranch && (await refExists(repo.mainRoot, `refs/remotes/origin/${target.branch}`)))
    mergeRefs.push(`origin/${target.branch}`);
  const [refs, merged, prs] = await Promise.all([
    git(repo.mainRoot, "for-each-ref", "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)", "refs/heads"),
    Promise.all(mergeRefs.map((ref) => git(repo.mainRoot, "branch", "--format=%(refname:short)", "--merged", ref))),
    opts.pr ? fetchPrs(repo) : Promise.resolve(null),
  ]);
  const upstreams = new Map(
    refs
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [name, up, track] = l.split("\t");
        return [name!, { up: up || null, track: track ?? "" }] as const;
      }),
  );
  const mergedSet = new Set(merged.flatMap((m) => m.split("\n").filter(Boolean)));
  const now = Date.now() / 1000;

  return Promise.all(
    entries.map(async (e, i): Promise<Row> => {
      const flags: string[] = [];
      const name = basename(e.path);
      if (i === 0) flags.push("main");
      if (!e.branch) flags.push("detached");
      if (name.startsWith("claude-") || e.branch?.startsWith("claude/")) flags.push("harness");
      if (e.locked) flags.push("locked");
      const missing = e.prunable || !existsSync(e.path);
      if (missing) flags.push("missing");

      const [status, ct] = missing
        ? [null, null]
        : await Promise.all([
            gitOk(e.path, "status", "--porcelain"),
            gitOk(e.path, "log", "-1", "--format=%ct", e.head),
          ]);
      const dirty = status === null ? null : status.split("\n").filter(Boolean).length;
      const lastCommit = ct ? Number(ct) : null;

      const up = e.branch ? upstreams.get(e.branch) : undefined;
      let ahead: number | null = null;
      let behind: number | null = null;
      if (up?.up) {
        if (up.track === "[gone]") flags.push("gone");
        else {
          ahead = Number(up.track.match(/ahead (\d+)/)?.[1] ?? 0);
          behind = Number(up.track.match(/behind (\d+)/)?.[1] ?? 0);
        }
      }
      const pr = e.branch ? (prs?.get(e.branch) ?? null) : null;
      // Ancestry alone also matches a fresh branch with no commits yet, so it only counts
      // once the branch was pushed (has an upstream). Squash merges show up via the PR.
      const isMerged =
        i !== 0 &&
        !!e.branch &&
        e.branch !== repo.defaultBranch &&
        e.branch !== target.branch &&
        ((mergedSet.has(e.branch) && !!up?.up) || pr?.state === "MERGED");
      if (isMerged) flags.push("merged");
      if (i !== 0 && lastCommit !== null && now - lastCommit > opts.staleDays * 86400) flags.push("stale");

      return {
        project: repo.project,
        name: i === 0 ? "(main)" : name,
        path: e.path,
        branch: e.branch,
        head: e.head ? e.head.slice(0, 8) : null,
        dirty,
        ahead,
        behind,
        upstream: up?.up ?? null,
        lastCommit,
        pr,
        flags,
      };
    }),
  );
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name));
  } catch {
    return [];
  }
}

// Repos that own a worktree under ~/worktrees, found from each folder's .git pointer.
async function reposUnderRoot(): Promise<Repo[]> {
  const dirs = childDirs(WT_ROOT).flatMap(childDirs);
  const repos = await Promise.all(
    dirs.map(async (d) => {
      const top = await gitOk(d, "rev-parse", "--show-toplevel");
      return top && real(top) === real(d) ? loadRepo(d).catch(() => null) : null;
    }),
  );
  return repos.filter((r): r is Repo => r !== null);
}

function orphanRows(projectDirs: string[], registered: Set<string>): Row[] {
  return projectDirs.flatMap((pd) =>
    childDirs(pd)
      .filter((d) => !registered.has(real(d)))
      .map((d) => ({
        project: basename(pd),
        name: basename(d),
        path: d,
        branch: null,
        head: null,
        dirty: null,
        ahead: null,
        behind: null,
        upstream: null,
        lastCommit: null,
        pr: null,
        flags: ["orphan"],
      })),
  );
}

async function discover(all: boolean) {
  const here = (await gitOk(process.cwd(), "rev-parse", "--git-dir")) !== null ? await loadRepo(process.cwd()) : null;
  if (!here && !all) throw new UserError("not inside a git repository (use --all to list every project)");
  const found = all ? await reposUnderRoot() : [];
  const byCommon = new Map<string, Repo>();
  for (const r of [here, ...found]) if (r && !byCommon.has(r.commonDir)) byCommon.set(r.commonDir, r);
  return { repos: [...byCommon.values()], projectDirs: all ? childDirs(WT_ROOT) : [projectDir(here!)] };
}

async function collectRows(repos: Repo[], projectDirs: string[], opts: { pr: boolean; staleDays: number }) {
  for (const r of repos) await integrationTarget(r);
  const rows = (await Promise.all(repos.map((r) => repoRows(r, opts)))).flat();
  const registered = new Set(rows.map((r) => real(r.path)));
  rows.push(...orphanRows(projectDirs, registered));
  return rows;
}

function fmtAge(unix: number | null): string {
  if (unix === null) return "-";
  const s = Date.now() / 1000 - unix;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / (86400 * 30))}mo`;
}

function table(header: string[], body: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  return [header, ...body].map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd());
}

function printRows(repos: Repo[], rows: Row[], showPr: boolean) {
  const byProject = Map.groupBy(rows, (r) => r.project);
  for (const [project, prow] of byProject) {
    const repo = repos.find((r) => r.project === project);
    const linked = prow.filter((r) => !r.flags.includes("main") && !r.flags.includes("orphan")).length;
    console.log(
      `${project}${repo ? `  ${tilde(repo.mainRoot)}  target ${repo.target?.branch ?? repo.defaultBranch}` : ""}  (${linked} linked worktree${linked === 1 ? "" : "s"})`,
    );
    const header = ["NAME", "BRANCH", "DIRTY", "UP +/-", "AGE", ...(showPr ? ["PR"] : []), "FLAGS"];
    const body = prow.map((r) => [
      r.name,
      r.branch ?? (r.head ? `detached@${r.head}` : "-"),
      r.dirty === null ? "-" : String(r.dirty),
      r.ahead === null ? "-" : `+${r.ahead}/-${r.behind}`,
      fmtAge(r.lastCommit),
      ...(showPr ? [r.pr ? `#${r.pr.number} ${r.pr.isDraft && r.pr.state === "OPEN" ? "draft" : r.pr.state.toLowerCase()}` : "-"] : []),
      r.flags.filter((f) => f !== "main").join(","),
    ]);
    for (const l of table(header, body)) console.log(`  ${l}`);
    console.log();
  }
  if (rows.length === 0) console.log("no worktrees");
}

async function ls(args: Args) {
  allowFlags(args, ["--all", "--pr"]);
  const showPr = args.flags.has("--pr");
  const { repos, projectDirs } = await discover(args.flags.has("--all"));
  const rows = await collectRows(repos, projectDirs, { pr: showPr, staleDays: DEFAULT_STALE_DAYS });
  emit(args.flags.has("--json"), { repos, worktrees: rows }, () => printRows(repos, rows, showPr));
}

// ---------- new ----------

function findEnvFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // Nested repos and harness worktrees carry their own .git; their env files are not ours.
        if (!ENV_SKIP_DIRS.has(e.name) && !existsSync(join(p, ".git"))) walk(p);
      } else if (e.isFile() && e.name.startsWith(".env")) found.push(relative(root, p));
    }
  };
  walk(root);
  return found;
}

type EnvSync = {
  missing: string[];
  copied: string[];
  same: string[];
  differs: string[];
  overwritten: { file: string; backup: string }[];
  extra: string[];
};
type EnvMode = "check" | "copy" | "overwrite";

// Works by path only: copies with copyFile and compares with `cmp`, so contents never enter this process or its output.
// check writes nothing; copy fills in missing files and only reports ones that differ; overwrite also replaces those,
// moving the old copy under `backupDir`, which must sit outside the working tree so it can never be committed.
// `extra` lists env files the target has and the source lacks.
function syncEnv(from: string, to: string, mode: EnvMode = "copy", backupDir?: string): EnvSync {
  if (mode === "overwrite" && !backupDir) throw new Error("overwrite needs a backup dir");
  const res: EnvSync = { missing: [], copied: [], same: [], differs: [], overwritten: [], extra: [] };
  const sourceFiles = findEnvFiles(from);
  for (const rel of sourceFiles) {
    const src = join(from, rel);
    const dst = join(to, rel);
    if (!lstatSync(dst, { throwIfNoEntry: false })) {
      if (mode === "check") {
        res.missing.push(rel);
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
      res.copied.push(rel);
    } else if (Bun.spawnSync(["cmp", "-s", src, dst]).exitCode === 0) res.same.push(rel);
    else if (mode !== "overwrite") res.differs.push(rel);
    else {
      const backup = join(backupDir!, rel);
      mkdirSync(dirname(backup), { recursive: true });
      renameSync(dst, backup);
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
      res.overwritten.push({ file: rel, backup });
    }
  }
  const known = new Set(sourceFiles);
  res.extra = findEnvFiles(to).filter((rel) => !known.has(rel));
  return res;
}

function printEnv(r: EnvSync, indent = "  ") {
  const line = (label: string, files: string[]) => {
    if (files.length) console.log(`${indent}${label.padEnd(12)}${files.join(", ")}`);
  };
  line("missing", r.missing);
  line("copied", r.copied);
  line("same", r.same);
  line("differs", r.differs);
  line("overwritten", r.overwritten.map((o) => o.file));
  line("only here", r.extra);
  if (r.missing.length) console.log(`${indent}wt env copies the missing files`);
  if (r.differs.length) console.log(`${indent}files that differ were left alone; wt env --overwrite replaces them with the source's copy`);
}

const worktreeGitDir = async (dir: string) => git(dir, "rev-parse", "--path-format=absolute", "--git-dir");

async function recordEnvSource(dir: string, source: string) {
  writeFileSync(join(await worktreeGitDir(dir), ENV_SOURCE_FILE), `${real(source)}\n`);
}

// The checkout a worktree takes its env files from: the one it was spawned from (recorded at creation or by
// `wt env --from`), else the main checkout.
async function envSourceFor(dir: string, repo: Repo): Promise<{ path: string; how: string }> {
  const f = join(await worktreeGitDir(dir), ENV_SOURCE_FILE);
  const legacy = join(dirname(f), LEGACY_ENV_SOURCE_FILE);
  if (!existsSync(f) && existsSync(legacy)) renameSync(legacy, f);
  const recorded = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
  if (recorded && real(recorded) !== real(dir)) {
    if (existsSync(recorded)) return { path: recorded, how: "spawned from" };
    warn(`recorded env source ${tilde(recorded)} is gone; using the main checkout`);
  }
  return { path: repo.mainRoot, how: "main checkout" };
}

async function install(dir: string) {
  if (!existsSync(join(dir, "package.json"))) return { ran: false, ok: true, command: null, codegen: null };
  // NI_DEFAULT_AGENT only applies when there is no lockfile; keeps ni from prompting.
  const env = process.env.NI_DEFAULT_AGENT ? undefined : { NI_DEFAULT_AGENT: "bun" };
  const ni = tool("ni", ["bun", "install"]);
  console.error(`installing in ${tilde(dir)} (${basename(ni[0]!)})...`);
  const r = await exec(ni, dir, env);
  const command = [basename(ni[0]!), ...ni.slice(1)].join(" ");
  if (r.code !== 0) return { ran: true, ok: false, command, error: tail(`${r.out}\n${r.err}`), codegen: null };

  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts ?? {};
  } catch {
    warn("could not parse package.json; skipping codegen");
  }
  // Skip scripts that write migrations or touch a database (e.g. drizzle's `db:generate`).
  const script = CODEGEN_SCRIPTS.find((s) => s in scripts && isCodegen(s, scripts[s]!));
  if (!script) return { ran: true, ok: true, command, codegen: null };
  const nr = tool("nr", ["bun", "run"]);
  console.error(`codegen: ${basename(nr[0]!)} ${script}...`);
  const g = await exec([...nr, script], dir, env);
  if (g.code !== 0) warn(`codegen "${script}" failed (worktree kept):\n${tail(`${g.out}\n${g.err}`)}`);
  return { ran: true, ok: true, command, codegen: { script, ok: g.code === 0 } };
}

const NEW_USAGE = "usage: wt new <branch> [--base <ref>] [--name <dir>] [--no-install] | wt new --detach <ref> --name <dir> [--no-install]";

async function newWorktree(args: Args) {
  allowFlags(args, ["--base", "--name", "--detach", "--no-install"]);
  const branch = args.pos[0];
  if (branch && (await gitOk(process.cwd(), "check-ref-format", "--branch", branch)) === null)
    throw new UserError(`invalid branch name: ${branch}`);
  const detach = args.flags.get("--detach") as string | undefined;
  const base = args.flags.get("--base") as string | undefined;
  if (!branch && !detach) throw new UserError(NEW_USAGE);
  if (branch && detach) throw new UserError("pass either <branch> or --detach <ref>, not both");

  const repo = await currentRepo();
  await fetchOrigin(repo);

  const entries = await listEntries(repo);
  const name = (args.flags.get("--name") as string | undefined) ?? (branch ?? `detached-${detach}`).replaceAll("/", "-");
  if (name.includes("/") || name === "." || name === "..") throw new UserError(`invalid folder name: ${name}`);
  const dir = join(projectDir(repo), name);
  const json = args.flags.has("--json");
  const here = await git(process.cwd(), "rev-parse", "--show-toplevel");

  const done = async (action: string, dir: string, extra: Record<string, unknown> = {}) => {
    if (action !== "reused" && real(here) !== real(repo.mainRoot)) await recordEnvSource(dir, here);
    const envFrom = real(here) === real(dir) ? (await envSourceFor(dir, repo)).path : here;
    const env = syncEnv(envFrom, dir);
    const inst = action !== "reused" && !args.flags.has("--no-install") ? await install(dir) : null;
    const data = { action, project: repo.project, path: dir, branch: branch ?? null, ...extra, envFrom, env, install: inst, next: openLine(dir) };
    emit(json, data, () => {
      console.log(`${action} ${tilde(dir)}${branch ? ` [${branch}]` : ` (detached at ${detach})`}`);
      if (extra.from) console.log(`  from ${extra.from}`);
      console.log(`  env files from ${tilde(envFrom)}:`);
      printEnv(env, "    ");
      if (inst?.ran) {
        console.log(`  install: ${inst.ok ? "ok" : "FAILED"} (${inst.command})`);
        if (inst.codegen) console.log(`  codegen: ${inst.codegen.script} ${inst.codegen.ok ? "ok" : "FAILED"}`);
        if (!inst.ok) console.log(`${inst.error}\n  retry: cd ${dir} && ${inst.command}`);
      } else if (action !== "reused") console.log(`  install: skipped`);
      console.log(`\nopen a new terminal and run:\n  ${data.next}`);
    });
    if (inst && !inst.ok) {
      console.error(`wt: install failed in ${tilde(dir)}; worktree kept`);
      process.exit(1);
    }
  };

  if (branch) {
    const existing = entries.find((e) => e.branch === branch);
    if (existing && real(existing.path) === real(repo.mainRoot))
      throw new UserError(
        `${branch} is checked out in the main checkout ${tilde(repo.mainRoot)}; use a new branch with --name, or --detach ${branch}`,
      );
    if (existing) {
      if (!existsSync(existing.path)) throw new UserError(`${branch} is registered at missing ${tilde(existing.path)}; run: wt prune`);
      return done("reused", existing.path);
    }
  }

  const atDir = entries.find((e) => real(e.path) === real(dir));
  if (atDir) {
    if (detach) return done("reused", dir);
    throw new UserError(`${tilde(dir)} already holds ${atDir.branch ?? `detached@${atDir.head.slice(0, 8)}`}; pick another --name`);
  }
  if (existsSync(dir)) throw new UserError(`${tilde(dir)} exists but is not a registered worktree (orphan); inspect it, then: wt rm ${dir} --force`);

  mkdirSync(dirname(dir), { recursive: true });
  let from: string;
  if (detach) {
    if ((await gitOk(repo.mainRoot, "rev-parse", "--verify", "--quiet", `${detach}^{commit}`)) === null)
      throw new UserError(`unknown ref: ${detach}`);
    await git(repo.mainRoot, "worktree", "add", "--detach", dir, detach);
    from = `${detach} (detached)`;
  } else if (await refExists(repo.mainRoot, `refs/heads/${branch}`)) {
    if (base) warn(`--base ignored: branch ${branch} already exists locally`);
    await git(repo.mainRoot, "worktree", "add", dir, branch!);
    from = "existing local branch";
  } else if (repo.hasOrigin && (await refExists(repo.mainRoot, `refs/remotes/origin/${branch}`))) {
    if (base) warn(`--base ignored: branch ${branch} exists on origin`);
    await git(repo.mainRoot, "worktree", "add", "--track", "-b", branch!, dir, `origin/${branch}`);
    from = `origin/${branch} (tracking)`;
  } else {
    const start = base ?? (await newWorkBase(repo));
    if ((await gitOk(repo.mainRoot, "rev-parse", "--verify", "--quiet", `${start}^{commit}`)) === null)
      throw new UserError(`unknown base ref: ${start}`);
    // --no-track: a new branch must not inherit the base as its push target.
    await git(repo.mainRoot, "worktree", "add", "--no-track", "-b", branch!, dir, start);
    from = `${start} (new branch)`;
  }
  await done("created", dir, { from });
}

// ---------- env ----------

async function env(args: Args) {
  allowFlags(args, ["--overwrite", "--check", "--from"]);
  const check = args.flags.has("--check");
  const overwrite = args.flags.has("--overwrite");
  if (check && overwrite) throw new UserError("pass either --check or --overwrite, not both");
  const here = (await gitOk(process.cwd(), "rev-parse", "--git-dir")) === null ? null : await loadRepo(process.cwd());

  let path: string;
  let repo: Repo;
  if (args.pos[0]) {
    const t = await resolveTarget(args.pos[0], here);
    if (!t.repo || !t.entry) throw new UserError(`${tilde(t.path)} is not a registered worktree`);
    if (!existsSync(t.path)) throw new UserError(`${tilde(t.path)} is registered but missing; run: wt prune`);
    path = t.path;
    repo = t.repo;
  } else {
    if (!here) throw new UserError("not inside a git repository; pass a worktree path");
    path = await git(process.cwd(), "rev-parse", "--show-toplevel");
    repo = here;
  }
  if (real(path) === real(repo.mainRoot))
    throw new UserError(`${tilde(path)} is the main checkout, the default env source; run wt env in a worktree or name one`);

  let source: { path: string; how: string };
  const fromArg = args.flags.get("--from");
  if (fromArg !== undefined) {
    if (fromArg === true) throw new UserError("--from needs a worktree name, branch or path");
    const f = await resolveTarget(fromArg, repo);
    if (!f.repo || !f.entry || real(f.repo.commonDir) !== real(repo.commonDir))
      throw new UserError(`${tilde(f.path)} is not a checkout of ${repo.project}`);
    if (!existsSync(f.path)) throw new UserError(`${tilde(f.path)} is registered but missing`);
    source = { path: f.path, how: "--from" };
  } else source = await envSourceFor(path, repo);
  if (real(source.path) === real(path)) throw new UserError(`${tilde(path)} cannot be its own env source`);

  const backupDir = join(await worktreeGitDir(path), "wt-env-backup", new Date().toISOString().replace(/[:.]/g, "-"));
  const r = syncEnv(source.path, path, check ? "check" : overwrite ? "overwrite" : "copy", backupDir);
  // --from becomes the remembered source once it is used for a real sync.
  if (!check && source.how === "--from") {
    if (real(source.path) === real(repo.mainRoot)) rmSync(join(await worktreeGitDir(path), ENV_SOURCE_FILE), { force: true });
    else await recordEnvSource(path, source.path);
  }
  emit(args.flags.has("--json"), { path, from: source.path, source: source.how, mode: check ? "check" : overwrite ? "overwrite" : "copy", ...r }, () => {
    console.log(`env ${tilde(path)} from ${tilde(source.path)} (${source.how})${check ? ", check only" : ""}`);
    if (Object.values(r).every((v) => v.length === 0)) console.log("  no .env* files in either checkout");
    else printEnv(r);
    if (r.overwritten.length) console.log(`  old copies kept in ${tilde(backupDir)}`);
  });
}

// ---------- rm ----------

type RmTarget = { path: string; repo: Repo | null; entry: Entry | null };

async function resolveTarget(arg: string, here: Repo | null): Promise<RmTarget> {
  const expanded = arg.startsWith("~/") ? join(HOME, arg.slice(2)) : arg;
  let path: string | null = null;
  if (isAbsolute(expanded) || expanded.startsWith("./") || expanded.startsWith("../")) path = resolve(expanded);
  else if (here) {
    const byName = isSegment(arg) ? join(projectDir(here), arg) : null;
    if (byName && existsSync(byName)) path = byName;
    else {
      const e = (await listEntries(here)).find((x) => x.branch === arg || basename(x.path) === arg);
      if (e) path = e.path;
    }
  }
  if (!path) throw new UserError(here ? `no worktree named ${arg} in ${tilde(projectDir(here))}` : `${arg}: pass an absolute path outside a repo`);

  // Registered but deleted from disk: only the current repo can know about it.
  if (!existsSync(path)) {
    const e = here ? (await listEntries(here)).find((x) => real(x.path) === real(path!)) : undefined;
    if (e) return { path, repo: here, entry: e };
    throw new UserError(`${tilde(path)} does not exist`);
  }
  const top = await gitOk(path, "rev-parse", "--show-toplevel");
  if (top && real(top) === real(path)) {
    const repo = await loadRepo(path);
    const entry = (await listEntries(repo)).find((x) => real(x.path) === real(path!)) ?? null;
    return { path, repo, entry };
  }
  return { path, repo: null, entry: null };
}

function countFiles(dir: string): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        dirs++;
        walk(join(d, e.name));
      } else files++;
    }
  };
  walk(dir);
  return { files, dirs };
}

async function processesUsing(path: string): Promise<string[]> {
  // cwd-only lsof: `lsof +D` walks node_modules and takes minutes on a monorepo.
  const r = await exec(["lsof", "-a", "-d", "cwd", "-F", "pcn"]).catch(() => null);
  if (!r || !r.out) return [];
  const hits: string[] = [];
  let pid = "";
  let cmd = "";
  for (const l of r.out.split("\n")) {
    if (l[0] === "p") pid = l.slice(1);
    else if (l[0] === "c") cmd = l.slice(1);
    else if (l[0] === "n" && within(l.slice(1), real(path)) && pid !== String(process.pid)) hits.push(`${cmd} (pid ${pid})`);
  }
  return hits;
}

// An orphan folder is deleted only when it is a real directory exactly <project>/<name> below the real
// worktrees root and not a repository of its own (a worktree has a .git file, a clone a .git directory).
function orphanRefusal(path: string, root = WT_ROOT): string | null {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return `${tilde(path)} does not exist`;
  if (st.isSymbolicLink()) return `${tilde(path)} is a symlink; refusing to delete it or its target`;
  if (!st.isDirectory()) return `${tilde(path)} is not a directory; refusing`;
  if (!existsSync(root)) return `${tilde(root)} does not exist; refusing`;
  const target = realpathSync(path);
  const parts = relative(realpathSync(root), target).split(sep);
  if (parts.length !== 2 || !parts.every(isSegment))
    return `${tilde(path)} is not a registered worktree and not a folder ${tilde(root)}/<project>/<name>; refusing`;
  if (lstatSync(join(target, ".git"), { throwIfNoEntry: false })?.isDirectory())
    return `${tilde(path)} has a .git directory (a repository, not a worktree); refusing`;
  return null;
}

// Removes the now-empty folders above a deleted worktree, stopping strictly below the worktrees root.
function removeEmptyParents(path: string, root = WT_ROOT) {
  const top = real(root);
  for (let d = real(dirname(path)); within(d, top) && d !== top; d = dirname(d)) {
    try {
      rmdirSync(d);
    } catch {
      break;
    }
  }
}

async function rmOne(arg: string, here: Repo | null, force: boolean, deleteBranch: boolean) {
  const t = await resolveTarget(arg, here);
  const res: Record<string, unknown> = { target: arg, path: t.path };
  if (within(real(process.cwd()), real(t.path))) throw new UserError(`${tilde(t.path)}: current directory is inside it; cd out first`);

  if (!t.entry) {
    const refused = orphanRefusal(t.path);
    if (refused) throw new UserError(refused);
    const target = realpathSync(t.path);
    const c = countFiles(target);
    Object.assign(res, { kind: "orphan", ...c });
    if (!force) return { ...res, removed: false, reason: `orphan folder with ${c.files} files in ${c.dirs} dirs; rerun with --force to delete it` };
    rmSync(target, { recursive: true, force: true });
    removeEmptyParents(target);
    return { ...res, removed: true };
  }

  const repo = t.repo!;
  if (real(t.entry.path) === real(repo.mainRoot)) throw new UserError(`${tilde(t.path)} is the main checkout; refusing`);
  Object.assign(res, { kind: "worktree", project: repo.project, branch: t.entry.branch });

  if (existsSync(t.path)) {
    const status = (await git(t.path, "status", "--porcelain")).split("\n").filter(Boolean);
    const users = await processesUsing(t.path);
    if (users.length) warn(`${tilde(t.path)} is the working directory of: ${users.join(", ")}`);
    Object.assign(res, { dirty: status.length, status: status.slice(0, 30), processes: users });
    if (status.length && !force)
      return { ...res, removed: false, reason: `${status.length} uncommitted change(s); rerun with --force to discard them` };
    const forceArgs = status.length || t.entry.locked ? (t.entry.locked ? ["-f", "-f"] : ["-f"]) : [];
    await git(repo.mainRoot, "worktree", "remove", ...forceArgs, t.path);
  }
  await git(repo.mainRoot, "worktree", "prune");
  removeEmptyParents(t.path);
  res.removed = true;

  if (deleteBranch && t.entry.branch) {
    const b = await exec(["git", "branch", "-d", t.entry.branch], repo.mainRoot);
    res.branchDeleted = b.code === 0;
    if (b.code !== 0) {
      res.branchNote = firstLine(b.err);
      warn(`branch ${t.entry.branch} kept: ${firstLine(b.err)}`);
    }
  }
  return res;
}

async function rm(args: Args) {
  allowFlags(args, ["--force", "--delete-branch"]);
  if (args.pos.length === 0) throw new UserError("usage: wt rm <name|path>... [--force] [--delete-branch]");
  const here = (await gitOk(process.cwd(), "rev-parse", "--git-dir")) !== null ? await loadRepo(process.cwd()) : null;
  const results: Record<string, unknown>[] = [];
  for (const a of args.pos) results.push(await rmOne(a, here, args.flags.has("--force"), args.flags.has("--delete-branch")));
  emit(args.flags.has("--json"), { results }, () => {
    for (const r of results) {
      if (r.removed) {
        const branch = r.branchDeleted ? `, branch ${r.branch} deleted` : r.branchNote ? `, branch kept (${r.branchNote})` : "";
        console.log(`removed ${tilde(r.path as string)}${branch}`);
      } else {
        console.log(`refused ${tilde(r.path as string)}: ${r.reason}`);
        for (const s of (r.status as string[] | undefined) ?? []) console.log(`  ${s}`);
      }
    }
  });
  if (results.some((r) => !r.removed)) process.exit(1);
}

// ---------- prune ----------

async function prune(args: Args) {
  allowFlags(args, ["--merged", "--gone", "--stale", "--orphans", "--all"]);
  const any = ["--merged", "--gone", "--stale", "--orphans"].some((f) => args.flags.has(f));
  const want = (f: string) => !any || args.flags.has(f);
  const staleRaw = args.flags.get("--stale");
  const staleDays = typeof staleRaw === "string" ? Number(staleRaw) : DEFAULT_STALE_DAYS;
  if (!Number.isFinite(staleDays) || staleDays <= 0) throw new UserError("--stale needs a positive number of days");
  const all = args.flags.has("--all");

  const { repos, projectDirs } = await discover(all);
  if (want("--gone"))
    await Promise.all(
      repos
        .filter((r) => r.hasOrigin)
        .map(async (r) => {
          const f = await exec(["git", "fetch", "--prune", "--quiet", "origin"], r.mainRoot);
          if (f.code !== 0) warn(`${r.project}: fetch failed, "gone" uses stale refs`);
        }),
    );
  const rows = await collectRows(repos, projectDirs, { pr: want("--merged"), staleDays });

  const candidates = rows
    .filter((r) => !r.flags.includes("main") && (all || !r.flags.includes("harness")))
    .map((r) => {
      const reasons: string[] = [];
      if (want("--merged") && r.flags.includes("merged")) reasons.push(r.pr?.state === "MERGED" ? `PR #${r.pr.number} merged` : "merged");
      if (want("--gone") && r.flags.includes("gone")) reasons.push("upstream gone");
      if (want("--stale") && r.flags.includes("stale")) reasons.push(`no commits in ${staleDays}d`);
      if (want("--orphans") && r.flags.includes("orphan")) reasons.push("orphan folder");
      if (r.flags.includes("missing")) reasons.push("folder missing");
      return { ...r, reasons };
    })
    .filter((r) => r.reasons.length > 0);

  emit(args.flags.has("--json"), { dryRun: true, candidates }, () => {
    if (candidates.length === 0) return console.log("no prune candidates");
    const body = candidates.map((c) => [
      `${c.project}/${c.name}`,
      c.branch ?? (c.head ? `detached@${c.head}` : "-"),
      c.dirty === null ? "-" : String(c.dirty),
      c.reasons.join(", "),
    ]);
    for (const l of table(["WORKTREE", "BRANCH", "DIRTY", "REASONS"], body)) console.log(l);
    console.log(`\ndry run, nothing removed. To remove after confirming:`);
    console.log(`  wt rm ${candidates.map((c) => c.path).join(" ")} [--delete-branch] [--force]`);
  });
}

const USAGE = `usage: wt <command> [--json]
  new <branch> [--base <ref>] [--name <dir>] [--no-install]
                                          worktree for a branch under ~/worktrees/<project>/<name>
  new --detach <ref> --name <dir> [--no-install]
                                          scratch checkout of a commit
  env [<name|branch|path>] [--from <name|branch|path>] [--check | --overwrite]
                                          sync .env* files (names only, values never read) from the checkout the
                                          worktree was spawned from, else the main checkout: copy missing, report
                                          differing; --check writes nothing; --overwrite replaces differing files,
                                          keeping old copies in the worktree's git dir; --from picks the source
                                          and remembers it
  ls [--all] [--pr]                       worktrees for this project (--all: every project + orphans)
  rm <name|path>... [--force] [--delete-branch]
  prune [--merged] [--gone] [--stale <days>] [--orphans] [--all]   dry run only`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(rest);
  switch (cmd) {
    case "new":
      return newWorktree(args);
    case "env":
      return env(args);
    case "ls":
      return ls(args);
    case "rm":
      return rm(args);
    case "prune":
      return prune(args);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

if (import.meta.main)
  main().catch((e) => {
    console.error(`wt: ${e instanceof UserError ? e.message : ((e as Error)?.message ?? e)}`);
    process.exit(1);
  });
