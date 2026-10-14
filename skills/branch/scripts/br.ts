#!/usr/bin/env bun
// Branch manager: integration target, branch names, plain branches, worktrees under
// ~/worktrees/<project>/<name>, pushes and gh stacks from a plan. Backs the branch skill: the skill
// maps intent to a subcommand, this script owns every git and gh sequence.
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ghEnv, localRepo, originRepo, repoConventions, stackOf, useAccountFor, type Target } from "../../../bin/gh-activity.ts";
import { openLine } from "../../../bin/launch.ts";

const HOME = homedir();
const WT_ROOT = join(HOME, "worktrees");
const ENV_SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", ".turbo"]);
// Lives in the worktree's private git dir, so `git worktree remove` cleans it up.
const ENV_SOURCE_FILE = "br-env-source";
const CODEGEN_SCRIPTS = ["codegen", "generate", "db:generate", "prisma:generate"];
const MIGRATION_LIKE = /drizzle-kit\s+(generate|migrate|push)|prisma\s+(migrate|db\s+push)|\bmigrat/i;
// `db:generate` is ambiguous (drizzle uses it for migrations); only run it when it is plainly prisma client generation.
const isCodegen = (name: string, body: string) =>
  !MIGRATION_LIKE.test(body) && (name !== "db:generate" || /prisma\s+generate/.test(body));
const DEFAULT_STALE_DAYS = 30;
const VALUE_FLAGS = new Set(["--base", "--name", "--detach", "--stale", "--type", "--desc", "--ticket", "--cap", "--from"]);
// Branch type -> accepted prefixes, canonical first. `br name` picks whichever the repo uses most.
const BRANCH_TYPES: Record<string, string[]> = {
  feature: ["feature", "feat"],
  fix: ["fix", "bugfix", "hotfix"],
  chore: ["chore"],
  docs: ["docs", "doc"],
  test: ["test", "tests"],
  poc: ["poc", "spike"],
  refactor: ["refactor"],
};
const PREFIXES = new Set(Object.values(BRANCH_TYPES).flat());
const BRANCH_TICKET_RE = /^[\w.-]+\/([A-Za-z]{2,10}-\d+)(?=$|[-_/])/;
const DEFAULT_PR_CAP = 5;

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

// ---------- where ----------

async function where(args: Args) {
  allowFlags(args, []);
  const repo = await currentRepo();
  const top = await git(process.cwd(), "rev-parse", "--show-toplevel");
  const branch = (await git(process.cwd(), "branch", "--show-current")) || null;
  const head = await git(process.cwd(), "rev-parse", "--short", "HEAD");
  const linked = real(top) !== real(repo.mainRoot);
  const target = await integrationTarget(repo);
  const newBranchBase = await newWorkBase(repo);
  const pr = branch ? await openPrFor(repo, branch) : null;
  const stack = stackOf({ root: top, commonDir: repo.commonDir, branch });
  const data = { ...repo, cwdWorktree: top, linked, branch, head, newBranchBase, pr, stack, worktreesDir: projectDir(repo) };
  emit(args.flags.has("--json"), data, () => {
    console.log(`project   ${repo.project}`);
    console.log(`main      ${tilde(repo.mainRoot)}`);
    console.log(`here      ${linked ? `linked worktree ${tilde(top)}` : "main checkout"}`);
    console.log(`branch    ${branch ?? `detached@${head}`}`);
    console.log(`default   ${repo.defaultBranch}`);
    console.log(`target    ${target.branch} (${target.source}): ${target.evidence}`);
    console.log(`new from  ${newBranchBase}`);
    console.log(`pr        ${pr ? `#${pr.number} -> ${pr.base}${pr.isDraft ? " (draft)" : ""}  ${pr.url}` : "none open"}`);
    if (stack) console.log(`stack     ${stack.number ? `#${stack.number} ` : ""}${stack.trunk} <- ${stack.branches.join(" <- ")} (parent ${stack.parent})`);
    console.log(`worktrees ${tilde(projectDir(repo))}`);
  });
}

async function openPrFor(repo: Repo, branch: string): Promise<Pr | null> {
  if (!(await github(repo)).slug) return null;
  const r = await ghExec(repo, ["pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", "number,state,url,isDraft,baseRefName"]);
  if (r.code !== 0) {
    warn(`gh pr list failed: ${firstLine(r.err)}`);
    return null;
  }
  const p = (JSON.parse(r.out) as (Pr & { baseRefName: string })[])[0];
  return p ? { number: p.number, state: p.state, url: p.url, isDraft: p.isDraft, base: p.baseRefName } : null;
}

async function target(args: Args) {
  allowFlags(args, []);
  const repo = await currentRepo();
  const t = await integrationTarget(repo);
  const newBranchBase = await newWorkBase(repo);
  emit(args.flags.has("--json"), { ...t, defaultBranch: repo.defaultBranch, newBranchBase, github: (await github(repo)).slug }, () => {
    console.log(`${t.branch} (${t.source})`);
    console.log(`  ${t.evidence}`);
    console.log(`  new branches start from ${newBranchBase}`);
  });
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

export type EnvSync = {
  missing: string[];
  copied: string[];
  same: string[];
  differs: string[];
  overwritten: { file: string; backup: string }[];
  extra: string[];
};
export type EnvMode = "check" | "copy" | "overwrite";

// Works by path only: copies with copyFile and compares with `cmp`, so contents never enter this process or its output.
// check writes nothing; copy fills in missing files and only reports ones that differ; overwrite also replaces those,
// moving the old copy under `backupDir`, which must sit outside the working tree so it can never be committed.
// `extra` lists env files the target has and the source lacks.
export function syncEnv(from: string, to: string, mode: EnvMode = "copy", backupDir?: string): EnvSync {
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
  if (r.missing.length) console.log(`${indent}br env copies the missing files`);
  if (r.differs.length) console.log(`${indent}files that differ were left alone; br env --overwrite replaces them with the source's copy`);
}

const worktreeGitDir = async (dir: string) => git(dir, "rev-parse", "--path-format=absolute", "--git-dir");

async function recordEnvSource(dir: string, source: string) {
  writeFileSync(join(await worktreeGitDir(dir), ENV_SOURCE_FILE), `${real(source)}\n`);
}

// The checkout a worktree takes its env files from: the one it was spawned from (recorded at creation or by
// `br env --from`), else the main checkout.
async function envSourceFor(dir: string, repo: Repo): Promise<{ path: string; how: string }> {
  const f = join(await worktreeGitDir(dir), ENV_SOURCE_FILE);
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

const NEW_USAGE =
  "usage: br new <branch> --here|--worktree [--base <ref>] [--name <dir>] [--no-install] | br new --worktree --detach <ref> [--name <dir>]";

async function newBranch(args: Args) {
  allowFlags(args, ["--here", "--worktree", "--base", "--name", "--detach", "--no-install"]);
  if (args.flags.has("--here") === args.flags.has("--worktree"))
    throw new UserError("pass exactly one of --here (switch this checkout) or --worktree (new folder under ~/worktrees)");
  const branch = args.pos[0];
  if (branch && (await gitOk(process.cwd(), "check-ref-format", "--branch", branch)) === null)
    throw new UserError(`invalid branch name: ${branch}`);
  return args.flags.has("--here") ? newHere(args) : newWorktree(args);
}

// Status lines go to stdout (like rm's refusals) so the user can see what blocks the switch.
function refuseDirty(json: boolean, data: Record<string, unknown>, status: string[], what: string): never {
  const reason = `${status.length} uncommitted change(s) in ${tilde(process.cwd())}; commit or stash them before ${what}`;
  emit(json, { ...data, refused: true, reason, status: status.slice(0, 30) }, () => {
    console.log(`refused: ${reason}`);
    for (const l of status.slice(0, 30)) console.log(`  ${l}`);
  });
  process.exit(1);
}

async function newHere(args: Args) {
  for (const f of ["--name", "--detach", "--no-install"]) if (args.flags.has(f)) throw new UserError(`${f} only applies with --worktree`);
  const branch = args.pos[0];
  if (!branch) throw new UserError(NEW_USAGE);
  const base = args.flags.get("--base") as string | undefined;
  const json = args.flags.has("--json");
  const repo = await currentRepo();
  const cwd = process.cwd();
  const top = await git(cwd, "rev-parse", "--show-toplevel");
  const show = (action: string, from: string | null) =>
    emit(json, { action, project: repo.project, path: top, branch, from }, () => {
      console.log(`${action} ${branch} in ${tilde(top)}`);
      if (from) console.log(`  from ${from}`);
      if (action === "created") console.log(`  no upstream yet; the first push is: br push`);
    });

  if ((await git(cwd, "branch", "--show-current")) === branch) return show("already on", null);
  const status = (await git(cwd, "status", "--porcelain")).split("\n").filter(Boolean);
  if (status.length) refuseDirty(json, { action: "refused", branch, path: top }, status, `switching to ${branch}`);
  await fetchOrigin(repo);

  if (await refExists(repo.mainRoot, `refs/heads/${branch}`)) {
    if (base) warn(`--base ignored: branch ${branch} already exists locally`);
    await git(cwd, "switch", branch);
    return show("switched to", "existing local branch");
  }
  if (repo.hasOrigin && (await refExists(repo.mainRoot, `refs/remotes/origin/${branch}`))) {
    if (base) warn(`--base ignored: branch ${branch} exists on origin`);
    await git(cwd, "switch", "--track", "-c", branch, `origin/${branch}`);
    return show("switched to", `origin/${branch} (tracking)`);
  }
  const start = base ?? (await newWorkBase(repo));
  if ((await gitOk(cwd, "rev-parse", "--verify", "--quiet", `${start}^{commit}`)) === null) throw new UserError(`unknown base ref: ${start}`);
  // --no-track: a new branch must not inherit the base as its push target.
  await git(cwd, "switch", "--no-track", "-c", branch, start);
  show("created", `${start} (new branch)`);
}

async function newWorktree(args: Args) {
  const branch = args.pos[0];
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
      console.error(`br: install failed in ${tilde(dir)}; worktree kept`);
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
      if (!existsSync(existing.path)) throw new UserError(`${branch} is registered at missing ${tilde(existing.path)}; run: br prune`);
      return done("reused", existing.path);
    }
  }

  const atDir = entries.find((e) => real(e.path) === real(dir));
  if (atDir) {
    if (detach) return done("reused", dir);
    throw new UserError(`${tilde(dir)} already holds ${atDir.branch ?? `detached@${atDir.head.slice(0, 8)}`}; pick another --name`);
  }
  if (existsSync(dir)) throw new UserError(`${tilde(dir)} exists but is not a registered worktree (orphan); inspect it, then: br rm ${dir} --force`);

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
    if (!existsSync(t.path)) throw new UserError(`${tilde(t.path)} is registered but missing; run: br prune`);
    path = t.path;
    repo = t.repo;
  } else {
    if (!here) throw new UserError("not inside a git repository; pass a worktree path");
    path = await git(process.cwd(), "rev-parse", "--show-toplevel");
    repo = here;
  }
  if (real(path) === real(repo.mainRoot))
    throw new UserError(`${tilde(path)} is the main checkout, the default env source; run br env in a worktree or name one`);

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

  const backupDir = join(await worktreeGitDir(path), "br-env-backup", new Date().toISOString().replace(/[:.]/g, "-"));
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
export function orphanRefusal(path: string, root = WT_ROOT): string | null {
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
export function removeEmptyParents(path: string, root = WT_ROOT) {
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
  if (args.pos.length === 0) throw new UserError("usage: br rm <name|path>... [--force] [--delete-branch]");
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
    console.log(`  br rm ${candidates.map((c) => c.path).join(" ")} [--delete-branch] [--force]`);
  });
}

// ---------- push ----------

type PushResult = { branch: string; remote: string; upToDate: boolean; forced: boolean };

// Never --force. --force-with-lease only when the caller passes it after the user agreed.
async function pushBranch(repo: Repo, branch: string, lease: boolean): Promise<PushResult> {
  if (!repo.hasOrigin) throw new UserError("no origin remote to push to");
  if (!(await refExists(repo.mainRoot, `refs/heads/${branch}`))) throw new UserError(`no local branch ${branch}`);
  const t = await integrationTarget(repo);
  if (branch === repo.defaultBranch || branch === t.branch)
    throw new UserError(`refusing to push ${branch}: it is the default branch or integration target; push a work branch`);
  const r = await exec(["git", "push", "--no-verify", "-u", ...(lease ? ["--force-with-lease"] : []), "origin", branch], repo.mainRoot);
  if (r.code !== 0) {
    if (lease && /stale info/.test(r.err))
      throw new UserError(`force-with-lease refused: origin/${branch} moved since the last fetch; fetch and review it before retrying`);
    if (/\[rejected\]|non-fast-forward|fetch first/.test(r.err))
      throw new UserError(
        `push of ${branch} rejected (non-fast-forward): origin/${branch} has commits this branch lacks; integrate them, or with the user's explicit consent rerun with --force-with-lease`,
      );
    const reason = r.err.split("\n").find((l) => /^(error|fatal|remote):/.test(l.trim())) ?? firstLine(r.err);
    throw new UserError(`push of ${branch} failed: ${reason.trim()}`);
  }
  return { branch, remote: "origin", upToDate: /Everything up-to-date/.test(r.err), forced: lease };
}

async function push(args: Args) {
  allowFlags(args, ["--force-with-lease"]);
  const repo = await currentRepo();
  const branch = args.pos[0] ?? ((await git(process.cwd(), "branch", "--show-current")) || null);
  if (!branch) throw new UserError("detached HEAD; pass the branch: br push <branch>");
  const r = await pushBranch(repo, branch, args.flags.has("--force-with-lease"));
  emit(args.flags.has("--json"), r, () =>
    console.log(`${r.upToDate ? "up to date" : r.forced ? "force-pushed (with lease)" : "pushed"} ${branch} -> origin/${branch} (upstream set)`),
  );
}

// ---------- name ----------

// Lowercase words joined by dashes, cut at a word boundary within 50 characters.
export function slugify(s: string) {
  const full = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (full.length <= 50) return full;
  const cut = full.slice(0, 51).lastIndexOf("-");
  return cut > 0 ? full.slice(0, cut) : full.slice(0, 50);
}

// Suggests <prefix>/<ticket>-<slug> from the repo's recent branch names. Never creates anything.
export function suggestName(type: string, desc: string, ticket: string | null, recent: string[]) {
  const options = BRANCH_TYPES[type];
  if (!options) throw new UserError(`--type must be one of ${Object.keys(BRANCH_TYPES).join(", ")}`);
  const slug = slugify(desc);
  if (!slug) throw new UserError("--desc needs at least one letter or digit");
  const evidence: string[] = [];
  const counts = options.map((o) => ({ prefix: o, count: recent.filter((b) => b.startsWith(`${o}/`)).length }));
  const best = counts.reduce((a, b) => (b.count > a.count ? b : a));
  evidence.push(
    best.count
      ? `prefix ${best.prefix}/: ${counts.map((c) => `${c.prefix}/ ${c.count}`).join(", ")} of ${recent.length} recent branches`
      : `no recent ${options.map((o) => `${o}/`).join(" or ")} branches; using the conventional ${best.prefix}/`,
  );

  let key = "";
  if (ticket) {
    const ticketed = recent.map((b) => ({ b, m: b.match(BRANCH_TICKET_RE)?.[1] })).filter((x): x is { b: string; m: string } => !!x.m);
    const lower = ticketed.filter((x) => x.m === x.m.toLowerCase());
    const useLower = ticketed.length === 0 || lower.length * 2 >= ticketed.length;
    key = `${useLower ? ticket.toLowerCase() : ticket.toUpperCase()}-`;
    const sample = (useLower ? lower : ticketed.filter((x) => x.m !== x.m.toLowerCase()))[0]?.b;
    evidence.push(
      ticketed.length
        ? `ticket: ${useLower ? lower.length : ticketed.length - lower.length} of ${ticketed.length} ticketed branches put a ${useLower ? "lowercase" : "uppercase"} key right after the prefix${sample ? ` (e.g. ${sample})` : ""}`
        : "no recent branch carries a ticket key after its prefix; using a lowercase key",
    );
  }
  return { name: `${best.prefix}/${key}${slug}`, evidence };
}

async function name(args: Args) {
  allowFlags(args, ["--type", "--desc", "--ticket"]);
  const type = args.flags.get("--type");
  const desc = args.flags.get("--desc");
  const ticket = args.flags.get("--ticket");
  if (typeof type !== "string" || typeof desc !== "string")
    throw new UserError(`usage: br name --type <${Object.keys(BRANCH_TYPES).join("|")}> --desc "<words>" [--ticket KEY-123]`);
  if (ticket !== undefined && (typeof ticket !== "string" || !/^[A-Za-z]{2,10}-\d+$/.test(ticket)))
    throw new UserError(`--ticket must look like KEY-123, got "${ticket}"`);
  const repo = await currentRepo();
  const gh = await github(repo);
  if (!gh.conventions) warn(`repo conventions unavailable (${gh.error}); suggesting from defaults`);
  const recent = gh.conventions?.recentBranches ?? [];
  const s = suggestName(type, desc, ticket ?? null, recent);
  if (ticket && gh.conventions) {
    const tp = gh.conventions.ticketPrefixes.find((p) => p.prefix === ticket.split("-")[0]!.toUpperCase());
    s.evidence.push(
      tp ? `${tp.prefix} appears in ${tp.count} recent PRs` : `${ticket.split("-")[0]!.toUpperCase()} is not among recent ticket prefixes (${gh.conventions.ticketPrefixes.map((p) => p.prefix).join(", ") || "none"})`,
    );
  }
  const exists = (await refExists(repo.mainRoot, `refs/heads/${s.name}`))
    ? "local"
    : repo.hasOrigin && (await refExists(repo.mainRoot, `refs/remotes/origin/${s.name}`))
      ? "origin"
      : null;
  if (exists) warn(`${s.name} already exists (${exists})`);
  emit(args.flags.has("--json"), { ...s, exists, recentSamples: recent.slice(0, 5) }, () => {
    console.log(s.name);
    for (const e of s.evidence) console.log(`  ${e}`);
    console.log(`  suggestion only; confirm the name, then: br new ${s.name} --here|--worktree`);
  });
}

// ---------- stack ----------

type PlanLayer = { name: string; title: string };
type Plan = { base?: string; branches: PlanLayer[] };
export type LayerState = { name: string; pr: { number: number; state: string } | null; hasCommits: boolean };

export function parsePlan(raw: unknown): Plan {
  const bad = (m: string) => new UserError(`invalid plan: ${m}`);
  if (!raw || typeof raw !== "object") throw bad("expected a JSON object");
  const { base, branches } = raw as Record<string, unknown>;
  if (base !== undefined && (typeof base !== "string" || !base)) throw bad("base must be a non-empty string");
  if (!Array.isArray(branches) || branches.length === 0) throw bad("branches must be a non-empty array");
  const seen = new Set<string>();
  const layers = branches.map((b, i) => {
    const { name, title } = (b ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !name) throw bad(`branches[${i}].name must be a non-empty string`);
    if (typeof title !== "string" || !title.trim()) throw bad(`branches[${i}].title must be a non-empty string`);
    if (!PREFIXES.has(name.split("/")[0]!) || !name.includes("/"))
      throw bad(`${name} lacks a conventional prefix (${[...PREFIXES].map((p) => `${p}/`).join(", ")})`);
    if (seen.has(name)) throw bad(`${name} appears twice`);
    seen.add(name);
    return { name, title: title.trim() };
  });
  return { ...(base ? { base } : {}), branches: layers };
}

// Which layers get a draft PR now. Bottom-up and contiguous: a layer waits while the one below has no
// PR. A layer needs commits (GitHub refuses empty PRs), and new PRs plus the user's open ones stay
// within the cap.
export function planPrs(layers: LayerState[], openCount: number, cap: number) {
  let room = Math.max(0, cap - openCount);
  const open: string[] = [];
  const waiting: { name: string; reason: string }[] = [];
  let blockedBy: string | null = null;
  for (const l of layers) {
    if (l.pr && l.pr.state !== "CLOSED") continue;
    if (blockedBy) waiting.push({ name: l.name, reason: blockedBy });
    else if (!l.hasCommits) {
      waiting.push({ name: l.name, reason: "no commits yet" });
      blockedBy = `layer below (${l.name}) has no PR yet`;
    } else if (room === 0) {
      waiting.push({ name: l.name, reason: `open-PR cap ${cap} reached (${openCount} open + ${open.length} new)` });
      blockedBy = `open-PR cap ${cap} reached`;
    } else {
      open.push(l.name);
      room--;
    }
  }
  return { open, waiting };
}

type Step = { cmd: string[]; why: string };

async function stack(args: Args) {
  if (args.pos[0] === "status") return stackStatus(args);
  allowFlags(args, ["--draft-prs", "--cap", "--dry-run"]);
  const file = args.pos[0];
  if (!file) throw new UserError("usage: br stack <plan.json> [--draft-prs] [--cap <n>] [--dry-run] | br stack status");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UserError(`cannot read plan ${file}: ${firstLine((e as Error).message)}`);
  }
  const plan = parsePlan(raw);
  const draftPrs = args.flags.has("--draft-prs");
  const capRaw = args.flags.get("--cap");
  if (capRaw !== undefined && !draftPrs) throw new UserError("--cap only applies with --draft-prs");
  const cap = capRaw === undefined ? DEFAULT_PR_CAP : Number(capRaw);
  if (!Number.isInteger(cap) || cap < 0) throw new UserError("--cap needs a whole number >= 0");
  const dry = args.flags.has("--dry-run");
  const json = args.flags.has("--json");

  const repo = await currentRepo();
  if (!repo.hasOrigin) throw new UserError("no origin remote; a stack needs one to push to");
  const cwd = process.cwd();
  const top = await git(cwd, "rev-parse", "--show-toplevel");
  const names = plan.branches.map((b) => b.name);
  for (const n of names) if ((await gitOk(cwd, "check-ref-format", "--branch", n)) === null) throw new UserError(`invalid branch name: ${n}`);
  const t = plan.base ? null : await integrationTarget(repo);
  const base = plan.base ?? t!.branch;
  const baseWhy = t ? `integration target (${t.source}): ${t.evidence}` : "from the plan";

  // Read-only state: remote heads, the local gh stack, local branches.
  const remote = new Map(
    (await git(repo.mainRoot, "ls-remote", "--heads", "origin", ...[base, ...names].map((n) => `refs/heads/${n}`)))
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, ref] = l.split("\t");
        return [ref!.replace(/^refs\/heads\//, ""), sha!] as const;
      }),
  );
  if (!remote.has(base)) throw new UserError(`origin has no branch ${base}`);
  const inStack = (n: string) => stackOf({ root: top, commonDir: repo.commonDir, branch: n });
  const existing = names.map(inStack).find((s) => s !== null) ?? null;
  let done = 0;
  if (existing) {
    const prefixOk = existing.branches.length <= names.length && existing.branches.every((b, i) => b === names[i]);
    if (!prefixOk || existing.trunk !== base)
      throw new UserError(
        `plan conflicts with the existing gh stack ${existing.trunk} <- ${existing.branches.join(" <- ")}; the plan must start with the same layers on ${base}`,
      );
    done = existing.branches.length;
  }
  const local = new Set<string>();
  for (const n of names) if (await refExists(repo.mainRoot, `refs/heads/${n}`)) local.add(n);
  for (const n of names.slice(done)) {
    if (inStack(n)) throw new UserError(`${n} already belongs to another gh stack`);
    if (remote.has(n)) throw new UserError(`${n} already exists on origin and is not in this stack; pick another name`);
    if (done > 0 && local.has(n)) throw new UserError(`local branch ${n} exists outside the stack; rename the layer or delete the branch`);
  }
  const status = (await git(cwd, "status", "--porcelain")).split("\n").filter(Boolean);

  const steps: Step[] = [{ cmd: ["git", "fetch", "--prune", "--quiet", "origin"], why: "refresh origin" }];
  if (done === 0) {
    if (!local.has(names[0]!))
      steps.push({ cmd: ["git", "branch", "--no-track", names[0]!, `origin/${base}`], why: `bottom layer starts from origin/${base}` });
    steps.push({ cmd: ["gh", "stack", "init", "--base", base, ...names], why: "create the stack; checks out the top layer" });
  } else if (done < names.length) {
    steps.push({ cmd: ["git", "switch", names[done - 1]!], why: "resume on the current top layer" });
    for (const n of names.slice(done)) steps.push({ cmd: ["gh", "stack", "add", n], why: "add the next layer on top" });
  }
  for (const n of names) steps.push({ cmd: ["git", "push", "--no-verify", "-u", "origin", n], why: "push the layer (never forced)" });

  const layersOut = plan.branches.map((b, i) => ({
    name: b.name,
    title: b.title,
    parent: i === 0 ? base : names[i - 1]!,
    state: i < done ? "in stack" : local.has(b.name) ? "adopt local branch" : "new",
  }));
  const report = (extra: Record<string, unknown>, prLines: string[]) =>
    emit(json, { dryRun: dry, base, baseWhy, layers: layersOut, steps: steps.map((s) => ({ ...s, cmd: s.cmd.join(" ") })), ...extra }, () => {
      console.log(`stack on ${base} (${baseWhy})`);
      layersOut.forEach((l, i) => console.log(`  ${i + 1}. ${l.name}  "${l.title}"  [${l.state}]`));
      console.log(dry ? "\ndry run, nothing ran. Steps:" : "\nran:");
      for (const s of steps) console.log(`  ${s.cmd.map((c) => (/[\s"]/.test(c) ? JSON.stringify(c) : c)).join(" ")}    # ${s.why}`);
      for (const l of prLines) console.log(l);
    });

  if (status.length) {
    if (!dry) refuseDirty(json, { action: "refused" }, status, "creating the stack (it switches branches)");
    warn(`${status.length} uncommitted change(s): the real run will refuse until the tree is clean`);
  }

  if (draftPrs && !dry && !(await github(repo)).slug)
    throw new UserError(`--draft-prs needs GitHub (${(await github(repo)).error}); nothing ran. Rerun without --draft-prs to create and push the stack only`);
  if (!dry) {
    for (const s of steps) {
      if (s.cmd[0] === "git" && s.cmd[1] === "push") await pushBranch(repo, s.cmd.at(-1)!, false);
      else {
        const r = await exec(s.cmd, cwd, s.cmd[0] === "gh" ? (await github(repo)).env : undefined);
        if (r.code !== 0) throw new UserError(`${s.cmd.slice(0, 3).join(" ")} failed (exit ${r.code}): ${firstLine(r.err) || firstLine(r.out)}`);
      }
    }
  }
  if (!draftPrs) return report({}, []);

  // Draft PRs: read-only lookups, then gh pr create per layer within the cap.
  const gh = await github(repo);
  let prs: Map<string, Pr> | null = null;
  let openCount = 0;
  if (gh.slug) {
    prs = await fetchPrs(repo);
    const mine = await ghExec(repo, ["pr", "list", "--author", "@me", "--state", "open", "--limit", "200", "--json", "number"]);
    if (mine.code === 0) openCount = (JSON.parse(mine.out) as unknown[]).length;
    else prs = null;
  }
  if (!prs) {
    if (!dry) throw new UserError(`cannot read PR state (gh pr list failed); the stack is pushed, no PRs opened`);
    warn(`PR state unavailable (${gh.error ?? "gh pr list failed"}); assuming 0 open PRs and no existing layer PRs`);
  }
  const layers: LayerState[] = [];
  for (const [i, n] of names.entries()) {
    const parentRef = i === 0 ? `origin/${base}` : names[i - 1]!;
    const exists = await refExists(repo.mainRoot, `refs/heads/${n}`);
    const ahead = exists ? await gitOk(repo.mainRoot, "rev-list", "--count", `${parentRef}..${n}`) : null;
    const pr = prs?.get(n);
    layers.push({ name: n, pr: pr ? { number: pr.number, state: pr.state } : null, hasCommits: Number(ahead ?? 0) > 0 });
  }
  const decision = planPrs(layers, openCount, cap);
  // A merged layer's branch may be gone; base each new PR on the nearest unmerged layer below.
  const prBase = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (layers[j]!.pr?.state !== "MERGED") return names[j]!;
    return base;
  };
  const opened: { name: string; url: string }[] = [];
  const prSteps = decision.open.map((n) => {
    const i = names.indexOf(n);
    const cmd = ["gh", "pr", "create", "--draft", "--base", prBase(i), "--head", n, "--title", plan.branches[i]!.title, "--body", `Layer ${i + 1} of ${names.length} in a stack on ${base}.`];
    return { name: n, cmd, why: "open a draft PR" };
  });
  const allHavePrs = layers.every((l) => (l.pr && l.pr.state !== "CLOSED") || decision.open.includes(l.name));
  const linkStep = allHavePrs && layers.length > 1 ? { cmd: ["gh", "stack", "link", "--base", base, ...names.filter((_, i) => layers[i]!.pr?.state !== "MERGED")], why: "link the PRs as a stack on GitHub (non-force push, keeps drafts)" } : null;
  steps.push(...prSteps.map(({ cmd, why }) => ({ cmd, why })), ...(linkStep ? [linkStep] : []));
  let linkWarning: string | null = null;
  if (!dry) {
    for (const s of prSteps) {
      const r = await exec(s.cmd, cwd, gh.env);
      if (r.code !== 0) throw new UserError(`gh pr create for ${s.name} failed: ${firstLine(r.err)} (opened so far: ${opened.map((o) => o.url).join(", ") || "none"})`);
      opened.push({ name: s.name, url: firstLine(r.out) });
    }
    if (linkStep) {
      const r = await exec(linkStep.cmd, cwd, gh.env);
      if (r.code === 9) linkWarning = "stacked PRs are not enabled on this repo; the drafts stay unlinked";
      else if (r.code !== 0) linkWarning = `gh stack link failed (exit ${r.code}): ${firstLine(r.err)}`;
      if (linkWarning) warn(linkWarning);
    }
  }
  const prLines = [
    `\nPRs: ${openCount} open by you, cap ${cap}${prs ? "" : " (PR state unavailable)"}`,
    ...layers.filter((l) => l.pr && l.pr.state !== "CLOSED").map((l) => `  ${l.name}: #${l.pr!.number} ${l.pr!.state.toLowerCase()}`),
    ...(dry ? decision.open.map((n) => `  ${n}: would open a draft PR`) : opened.map((o) => `  ${o.name}: opened draft ${o.url}`)),
    ...decision.waiting.map((w) => `  ${w.name}: waiting (${w.reason}); pushed, no PR. Rerun later to open it.`),
    ...(linkStep ? [] : [`  stack link on GitHub waits until every layer has a PR`]),
  ];
  report({ openCount, cap, toOpen: decision.open, opened, waiting: decision.waiting, linked: !!linkStep && !dry && !linkWarning }, prLines);
}

async function stackStatus(args: Args) {
  allowFlags(args, []);
  const repo = await currentRepo();
  const top = await git(process.cwd(), "rev-parse", "--show-toplevel");
  const branch = args.pos[1] ?? ((await git(process.cwd(), "branch", "--show-current")) || null);
  if (!branch) throw new UserError("detached HEAD; pass a branch: br stack status <branch>");
  const s = stackOf({ root: top, commonDir: repo.commonDir, branch });
  if (!s) throw new UserError(`${branch} is not in a gh stack`);
  const prs = await fetchPrs(repo);
  const trunkRef = (await refExists(repo.mainRoot, `refs/remotes/origin/${s.trunk}`)) ? `origin/${s.trunk}` : s.trunk;
  const layers = await Promise.all(
    s.branches.map(async (b, i) => {
      const parent = i === 0 ? trunkRef : s.branches[i - 1]!;
      const counts = (await gitOk(repo.mainRoot, "rev-list", "--left-right", "--count", `${parent}...${b}`))?.split(/\s+/).map(Number);
      const pr = prs?.get(b) ?? null;
      return { branch: b, parent, behind: counts?.[0] ?? null, ahead: counts?.[1] ?? null, pr };
    }),
  );
  emit(args.flags.has("--json"), { trunk: s.trunk, number: s.number, current: branch, layers }, () => {
    console.log(`stack${s.number ? ` #${s.number}` : ""} on ${s.trunk}`);
    const body = layers.map((l, i) => [
      String(i + 1),
      `${l.branch}${l.branch === branch ? " *" : ""}`,
      l.parent,
      l.ahead === null ? "-" : `+${l.ahead}/-${l.behind}`,
      l.pr ? `#${l.pr.number} ${l.pr.state === "OPEN" && l.pr.isDraft ? "draft" : l.pr.state.toLowerCase()}` : "-",
    ]);
    for (const l of table(["#", "BRANCH", "PARENT", "+/- PARENT", "PR"], body)) console.log(`  ${l}`);
  });
}

const USAGE = `usage: br <command> [--json]
  where                                   repo, current worktree and branch, integration target, open PR, gh stack
  target                                  integration target for new work, with evidence
  name --type <type> --desc "<words>" [--ticket KEY-123]
                                          suggest a branch name from the repo's conventions (creates nothing)
                                          types: ${Object.keys(BRANCH_TYPES).join(", ")}
  new <branch> --here [--base <ref>]      create or switch to a branch in this checkout (clean tree only)
  new <branch> --worktree [--base <ref>] [--name <dir>] [--no-install]
  new --worktree --detach <ref> [--name <dir>] [--no-install]
  env [<name|branch|path>] [--from <name|branch|path>] [--check | --overwrite]
                                          sync .env* files (names only, values never read) from the checkout the
                                          worktree was spawned from, else the main checkout: copy missing, report
                                          differing; --check writes nothing; --overwrite replaces differing files,
                                          keeping old copies in the worktree's git dir; --from picks the source
                                          and remembers it
  push [<branch>] [--force-with-lease]    git push -u origin <branch> --no-verify; never --force
  ls [--all] [--pr]                       worktrees for this project (--all: every project + orphans)
  rm <name|path>... [--force] [--delete-branch]
  prune [--merged] [--gone] [--stale <days>] [--orphans] [--all]   dry run only
  stack <plan.json> [--draft-prs] [--cap <n>] [--dry-run]
                                          create or resume a gh stack from a plan, push every layer,
                                          optionally open draft PRs within the open-PR cap (default ${DEFAULT_PR_CAP})
  stack status [<branch>]                 layers, PRs, ahead/behind parent`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const args = parseArgs(rest);
  switch (cmd) {
    case "where":
      return where(args);
    case "target":
      return target(args);
    case "name":
      return name(args);
    case "new":
      return newBranch(args);
    case "env":
      return env(args);
    case "push":
      return push(args);
    case "ls":
      return ls(args);
    case "rm":
      return rm(args);
    case "prune":
      return prune(args);
    case "stack":
      return stack(args);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

if (import.meta.main)
  main().catch((e) => {
    console.error(`br: ${e instanceof UserError ? e.message : ((e as Error)?.message ?? e)}`);
    process.exit(1);
  });
