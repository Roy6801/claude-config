#!/usr/bin/env bun
// PR mechanics for the ship skill: facts about a branch (base, commits, size, ticket, template,
// existing PR) and creating or editing its PR. `facts` only reads. `upsert` creates DRAFT PRs or
// edits an existing PR's title, body and base; it never marks a PR ready, merges, or pushes.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ghEnv, localRepo, originRepo, stackOf, ticketKey, useAccountFor, type Local } from "../../../bin/gh-activity.ts";

const BR = join(import.meta.dir, "..", "..", "branch", "scripts", "br.ts");
const WORK_DIR = process.env.SHIP_WORK_DIR || join(import.meta.dir, "..", "..", "..", "state", "work");
const VALUE_FLAGS = new Set(["--branch", "--cwd", "--title", "--body-file", "--base"]);
export const NET_BUDGET = 500;
// Not read line by line by a reviewer: lockfiles, generated files, changesets, snapshots.
const EXCLUDED = [/(^|\/)[^/]*\.lock$/, /(^|\/)[^/]*-lock\.(json|yaml)$/, /(^|\/)pnpm-lock\.yaml$/, /\.gen\.[^/]+$/, /(^|\/)__generated__\//, /(^|\/)\.changeset\/[^/]+\.md$/, /\.snap$/];
const ATTRIBUTION = [/claude\.ai\/code\/session/i, /Claude-Session:/i, /generated (with|by) (claude|ai)/i, /co-authored-by:\s*claude/i];

type Args = { pos: string[]; flags: Map<string, string | true>; attach: string[] };
type Base = { branch: string; source: "open-pr" | "gh-stack" | "integration-target" | "flag"; evidence: string };
export type Size = { files: number; added: number; deleted: number; net: number; excluded: string[]; budget: number; over: boolean };
export type Template = { path: string | null; choices: string[] };
type OpenPr = { number: number; url: string; isDraft: boolean; base: string; title: string };

class UserError extends Error {}

function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  const attach: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) pos.push(a);
    else if (a === "--attach") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UserError("--attach needs a value");
      attach.push(v);
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UserError(`${a} needs a value`);
      flags.set(a, v);
    } else flags.set(a, true);
  }
  return { pos, flags, attach };
}

function allowFlags(args: Args, allowed: string[]) {
  for (const f of args.flags.keys()) if (f !== "--json" && !allowed.includes(f)) throw new UserError(`unknown flag ${f}`);
}

const str = (args: Args, flag: string) => {
  const v = args.flags.get(flag);
  return typeof v === "string" ? v : undefined;
};
const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const warnings: string[] = [];
function warn(msg: string) {
  if (warnings.includes(msg)) return;
  warnings.push(msg);
  console.error(`warning: ${msg}`);
}

function emit(json: boolean, data: object, human: () => void) {
  if (json) console.log(JSON.stringify({ ...data, warnings }, null, 2));
  else human();
}

async function exec(cmd: string[], cwd: string) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...ghEnv(), GIT_TERMINAL_PROMPT: "0" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out.trimEnd(), err: err.trim() };
}

async function git(cwd: string, ...args: string[]) {
  const r = await exec(["git", ...args], cwd);
  if (r.code !== 0) throw new UserError(`git ${args[0]}: ${firstLine(r.err) || `exited ${r.code}`}`);
  return r.out;
}
const gitOk = async (cwd: string, ...args: string[]) => {
  const r = await exec(["git", ...args], cwd);
  return r.code === 0 ? r.out : null;
};
const hasRef = async (cwd: string, ref: string) => (await gitOk(cwd, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) !== null;

async function gh(cwd: string, args: string[]) {
  if (!Bun.which("gh")) throw new UserError("gh not found on PATH");
  const r = await exec(["gh", ...args], cwd);
  if (r.code !== 0) throw new UserError(`gh ${args.slice(0, 2).join(" ")} failed: ${firstLine(r.err) || `exit ${r.code}`}`);
  return r.out;
}

// ---------- pure logic (unit tested) ----------

export const isExcluded = (path: string) => EXCLUDED.some((re) => re.test(path));

// `git diff --numstat` lines: "<added>\t<deleted>\t<path>"; binary files show "-".
export function sizeOf(numstat: string, budget = NET_BUDGET): Size {
  let files = 0, added = 0, deleted = 0;
  const excluded: string[] = [];
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split("\t");
    // Renames print as "dir/{old => new}/f" or "old => new"; keep the new path.
    const path = rest.join("\t").replace(/\{[^}]* => ([^}]*)\}/, "$1").replace(/^.* => /, "").replace(/\/{2,}/g, "/");
    if (isExcluded(path)) {
      excluded.push(path);
      continue;
    }
    files++;
    if (a !== "-") added += Number(a);
    if (d !== "-") deleted += Number(d);
  }
  const net = added - deleted;
  return { files, added, deleted, net, excluded, budget, over: net > budget };
}

// Repo-relative paths at the head ref, root and .github/docs only. `.github/` wins over docs/ and root.
export function findTemplate(paths: string[]): Template {
  const lower = (p: string) => p.toLowerCase();
  const single = (dir: string) => paths.find((p) => lower(p) === `${dir}pull_request_template.md`);
  const dirChoices = paths.filter((p) => /^\.github\/pull_request_template\/[^/]+\.md$/i.test(p)).sort();
  const path = single(".github/") ?? (dirChoices.length === 1 ? dirChoices[0] : undefined) ?? single("docs/") ?? single("") ?? null;
  return { path: path ?? null, choices: path ? [] : dirChoices };
}

// The existing PR keeps its base; otherwise the gh stack parent; otherwise where new work merges.
export function chooseBase(pr: OpenPr | null, stack: { parent: string } | null, target: { branch: string; evidence: string } | null): Base | null {
  if (pr) return { branch: pr.base, source: "open-pr", evidence: `PR #${pr.number} targets ${pr.base}` };
  if (stack) return { branch: stack.parent, source: "gh-stack", evidence: `${stack.parent} is the layer below in the gh stack` };
  if (target) return { branch: target.branch, source: "integration-target", evidence: target.evidence };
  return null;
}

export type UpsertPlan = { action: "create" | "edit"; argv: string[]; notes: string[] };

// Decides the gh call for upsert. Never includes --ready, never toggles draft state.
export function planUpsert(o: {
  repo: string; branch: string; title: string; bodyFile: string; base: string | null;
  pr: OpenPr | null; inStack: boolean; remoteHead: boolean; attach?: string[];
}): UpsertPlan {
  const notes: string[] = [];
  if (!o.pr) {
    if (!o.base) throw new UserError("no base: pass --base <branch>");
    if (o.base === o.branch) throw new UserError(`base and head are both ${o.branch}`);
    if (!o.remoteHead) throw new UserError(`origin/${o.branch} does not exist; push first (br push ${o.branch})`);
    return {
      action: "create",
      argv: ["pr", "create", "--repo", o.repo, "--draft", "--assignee", "@me", "--head", o.branch, "--base", o.base, "--title", o.title, "--body-file", o.bodyFile, ...attachArgs(o.attach)],
      notes,
    };
  }
  const argv = ["pr", "edit", String(o.pr.number), "--repo", o.repo, "--add-assignee", "@me", "--title", o.title, "--body-file", o.bodyFile];
  if (o.base && o.base !== o.pr.base) {
    if (o.inStack) throw new UserError(`#${o.pr.number} is in a gh stack; its base belongs to gh stack, not upsert`);
    argv.push("--base", o.base);
    notes.push(`base changes ${o.pr.base} -> ${o.base}`);
  }
  if (!o.pr.isDraft) notes.push(`#${o.pr.number} is ready for review; editing title and body only, its draft state is untouched`);
  argv.push(...attachArgs(o.attach));
  return { action: "edit", argv, notes };
}

const attachArgs = (specs: string[] = []) => specs.flatMap((spec) => ["--attach", spec]);
const attachPath = (spec: string) => spec.split("#")[0]!;

// Attachments sit next to the body file and the body references each one as `./<name>`; gh
// uploads them and rewrites those references, so a reference left after upsert means it failed.
export function attachmentProblems(body: string, specs: string[]): string[] {
  return specs.flatMap((spec) => {
    const path = attachPath(spec);
    if (path !== `./${basename(path)}`) return [`--attach ${path}: use ./<file> next to the body file`];
    return body.includes(`](${path})`) ? [] : [`--attach ${path}: the body never references it as ](${path}), so gh appends it at the end instead of in the evidence section`];
  });
}

export function attributionProblems(text: string): string[] {
  return ATTRIBUTION.filter((re) => re.test(text)).map((re) => `contains ${re.source.replace(/\\/g, "")}`);
}

// ---------- repo helpers ----------

type Ctx = { local: Local; repo: string; branch: string; headRef: string };

async function context(args: Args): Promise<Ctx> {
  const cwd = resolve(str(args, "--cwd") ?? process.cwd());
  const local = await localRepo(cwd);
  if (!local) throw new UserError(`not a git repository: ${cwd}`);
  const repo = await originRepo(local);
  await useAccountFor(repo);
  const branch = str(args, "--branch") ?? local.branch;
  if (!branch) throw new UserError("detached HEAD; pass --branch <name>");
  const headRef = (await hasRef(local.root, `refs/heads/${branch}`)) ? branch : `origin/${branch}`;
  if (!(await hasRef(local.root, headRef))) throw new UserError(`no local or remote branch ${branch}`);
  return { local: { ...local, branch }, repo, branch, headRef };
}

async function openPr(ctx: Ctx): Promise<{ pr: OpenPr | null; others: number[] }> {
  const out = await gh(ctx.local.root, ["pr", "list", "--repo", ctx.repo, "--head", ctx.branch, "--state", "open", "--json", "number,url,isDraft,baseRefName,title"]);
  const list = (JSON.parse(out) as { number: number; url: string; isDraft: boolean; baseRefName: string; title: string }[]).map((p) => ({
    number: p.number, url: p.url, isDraft: p.isDraft, base: p.baseRefName, title: p.title,
  }));
  if (list.length > 1) warn(`several open PRs for ${ctx.branch}: ${list.map((p) => `#${p.number}`).join(", ")}; using #${list[0]!.number}`);
  return { pr: list[0] ?? null, others: list.slice(1).map((p) => p.number) };
}

async function integrationTarget(root: string) {
  const r = await exec(["bun", BR, "target", "--json"], root);
  if (r.code !== 0) {
    warn(`br target failed: ${firstLine(r.err)}`);
    return null;
  }
  const t = JSON.parse(r.out) as { branch: string; evidence: string; warnings?: string[] };
  for (const w of t.warnings ?? []) warn(`br: ${w}`);
  return t;
}

// The ref to diff against: the local branch for a stack parent (layers live locally), else origin/<base>.
async function baseRef(root: string, base: Base): Promise<string | null> {
  const order = base.source === "gh-stack" ? [base.branch, `origin/${base.branch}`] : [`origin/${base.branch}`, base.branch];
  // The remote is the source of truth: refresh only origin/<base> (a remote-tracking ref; nothing local moves).
  if (base.source !== "gh-stack") {
    const f = await exec(["git", "fetch", "--quiet", "origin", `+refs/heads/${base.branch}:refs/remotes/origin/${base.branch}`], root);
    if (f.code !== 0) warn(`could not fetch origin/${base.branch}; using the local copy`);
  }
  for (const ref of order) {
    if (!(await hasRef(root, ref))) continue;
    if (ref.startsWith("origin/")) {
      const remote = await exec(["git", "ls-remote", "origin", `refs/heads/${base.branch}`], root);
      const sha = remote.code === 0 ? remote.out.split(/\s+/)[0] : null;
      if (sha && sha !== (await gitOk(root, "rev-parse", ref))) warn(`${ref} is behind the remote; size and commits may be off (refresh: git fetch origin ${base.branch})`);
    }
    return ref;
  }
  warn(`${base.branch} is not available locally (fetch it: git fetch origin ${base.branch}); commits and size skipped`);
  return null;
}

async function templateAt(root: string, ref: string) {
  const out = (await gitOk(root, "ls-tree", "-r", "--name-only", ref, "--", ".github", "docs")) ?? "";
  const top = (await gitOk(root, "ls-tree", "--name-only", ref)) ?? "";
  return findTemplate([...out.split("\n"), ...top.split("\n")].filter(Boolean));
}

// The pair slice whose branch is this one, from any initiative's pair.json.
function sliceFor(branch: string) {
  if (!existsSync(WORK_DIR)) return null;
  for (const slug of readdirSync(WORK_DIR)) {
    const file = join(WORK_DIR, slug, "pair.json");
    if (!existsSync(file)) continue;
    try {
      const plan = JSON.parse(readFileSync(file, "utf8"));
      const s = (plan.slices ?? []).find((x: { branch?: string }) => x.branch === branch);
      if (s) return { slug, n: s.n as number, title: s.title as string, ticket: (s.ticket ?? null) as string | null, acs: (s.acs ?? []) as string[], status: s.status as string };
    } catch {
      warn(`${file} is not valid JSON`);
    }
  }
  return null;
}

async function remoteState(root: string, branch: string) {
  if (!(await hasRef(root, `origin/${branch}`))) return { exists: false, ahead: null, behind: null };
  if (!(await hasRef(root, `refs/heads/${branch}`))) return { exists: true, ahead: 0, behind: 0 };
  const lr = await git(root, "rev-list", "--left-right", "--count", `${branch}...origin/${branch}`);
  const [ahead, behind] = lr.split(/\s+/).map(Number);
  return { exists: true, ahead: ahead ?? 0, behind: behind ?? 0 };
}

async function checkoutOf(root: string, branch: string) {
  const out = await git(root, "worktree", "list", "--porcelain");
  for (const block of out.split("\n\n")) {
    if (block.includes(`\nbranch refs/heads/${branch}`)) return block.split("\n")[0]!.replace(/^worktree /, "");
  }
  return null;
}

// ---------- commands ----------

async function facts(args: Args) {
  allowFlags(args, ["--branch", "--cwd"]);
  const ctx = await context(args);
  const root = ctx.local.root;
  const stack = stackOf(ctx.local);
  const { pr, others } = await openPr(ctx);
  const target = pr || stack ? null : await integrationTarget(root);
  const base = chooseBase(pr, stack, target);
  if (!base) throw new UserError("could not resolve a base (no open PR, no gh stack, br target failed)");
  if (base.branch === ctx.branch) throw new UserError(`${ctx.branch} is its own base; ship a work branch`);
  const ref = await baseRef(root, base);
  let commits: { sha: string; subject: string }[] = [];
  let size: Size | null = null;
  if (ref) {
    const log = await git(root, "log", "--no-merges", "--format=%h%x09%s", `${ref}..${ctx.headRef}`);
    commits = log.split("\n").filter(Boolean).map((l) => ({ sha: l.split("\t")[0]!, subject: l.split("\t").slice(1).join("\t") }));
    size = sizeOf(await git(root, "diff", "--numstat", `${ref}...${ctx.headRef}`));
  }
  const slice = sliceFor(ctx.branch);
  const data = {
    repo: ctx.repo,
    branch: ctx.branch,
    headRef: ctx.headRef,
    checkout: await checkoutOf(root, ctx.branch),
    remote: await remoteState(root, ctx.branch),
    base: { ...base, ref },
    stack: stack ? { trunk: stack.trunk, parent: stack.parent, branches: stack.branches } : null,
    commits,
    size,
    ticket: ticketKey(ctx.branch, pr?.title) ?? slice?.ticket ?? null,
    slice,
    template: await templateAt(root, ctx.headRef),
    pr,
    otherPrs: others,
  };
  emit(args.flags.has("--json"), data, () => {
    console.log(`${ctx.repo} ${ctx.branch}${data.checkout ? `  (${data.checkout})` : ""}`);
    console.log(`base      ${base.branch} (${base.source}): ${base.evidence}`);
    console.log(`remote    ${data.remote.exists ? `origin/${ctx.branch} ahead ${data.remote.ahead} behind ${data.remote.behind}` : "not pushed"}`);
    console.log(`commits   ${commits.length}${commits.length ? `: ${commits.map((c) => c.subject).slice(0, 5).join("; ")}${commits.length > 5 ? "; …" : ""}` : ""}`);
    if (size) console.log(`size      ${size.files} files, +${size.added} -${size.deleted}, net ${size.net} of ${size.budget}${size.over ? " OVER BUDGET" : ""}${size.excluded.length ? ` (${size.excluded.length} excluded)` : ""}`);
    console.log(`ticket    ${data.ticket ?? "none"}${slice ? `  (slice ${slice.n} of ${slice.slug}: ${slice.title})` : ""}`);
    console.log(`template  ${data.template.path ?? (data.template.choices.length ? `choose one: ${data.template.choices.join(", ")}` : "none")}`);
    console.log(`pr        ${pr ? `#${pr.number} ${pr.isDraft ? "draft" : "ready"} -> ${pr.base}  ${pr.url}` : "none open"}`);
  });
}

async function upsert(args: Args) {
  allowFlags(args, ["--branch", "--cwd", "--title", "--body-file", "--base", "--dry-run"]);
  const title = str(args, "--title")?.trim();
  const bodyFile = str(args, "--body-file");
  if (!title || !bodyFile) throw new UserError("usage: pr upsert --title <t> --body-file <f> [--base <b>] [--attach ./<file>[#alt]]... [--dry-run]");
  const file = resolve(bodyFile);
  if (!existsSync(file)) throw new UserError(`no such body file ${bodyFile}`);
  const bodyDir = dirname(file);
  const attachIssues = attachmentProblems(readFileSync(file, "utf8"), args.attach);
  const badPaths = attachIssues.filter((i) => i.includes("use ./"));
  if (badPaths.length) throw new UserError(badPaths.join("; "));
  for (const spec of args.attach) if (!existsSync(join(bodyDir, attachPath(spec)))) throw new UserError(`no such attachment ${attachPath(spec)} next to ${bodyFile}`);
  for (const i of attachIssues) warn(i);
  const problems = attributionProblems(`${title}\n${readFileSync(file, "utf8")}`);
  if (problems.length) throw new UserError(`refusing: title or body ${problems.join(", ")}`);
  if (/[–—]/.test(title + readFileSync(file, "utf8"))) warn("title or body contains an em or en dash");

  const ctx = await context(args);
  const stack = stackOf(ctx.local);
  const { pr } = await openPr(ctx);
  let base = str(args, "--base") ?? null;
  if (!base && !pr) base = chooseBase(null, stack, await integrationTarget(ctx.local.root))?.branch ?? null;
  const remote = await exec(["git", "ls-remote", "--exit-code", "origin", `refs/heads/${ctx.branch}`], ctx.local.root);
  const plan = planUpsert({ repo: ctx.repo, branch: ctx.branch, title, bodyFile: file, base, pr, inStack: !!stack, remoteHead: remote.code === 0, attach: args.attach });
  for (const n of plan.notes) warn(n);
  if (args.flags.has("--dry-run")) {
    emit(args.flags.has("--json"), { dryRun: true, action: plan.action, command: ["gh", ...plan.argv] }, () =>
      console.log(`dry run, would ${plan.action}:\n  gh ${plan.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`),
    );
    return;
  }
  await gh(args.attach.length ? bodyDir : ctx.local.root, plan.argv);
  const view = JSON.parse(await gh(ctx.local.root, ["pr", "view", ctx.branch, "--repo", ctx.repo, "--json", "number,url,isDraft,baseRefName,title,body"]));
  if (plan.action === "create" && !view.isDraft) warn(`#${view.number} was created but is not a draft; check it on GitHub`);
  for (const spec of args.attach) if (String(view.body).includes(`](${attachPath(spec)})`)) warn(`${attachPath(spec)} was not uploaded; the body still points at the local file`);
  emit(args.flags.has("--json"), { action: plan.action, number: view.number, url: view.url, isDraft: view.isDraft, base: view.baseRefName, title: view.title }, () =>
    console.log(`${plan.action === "create" ? "created draft" : "updated"} #${view.number} -> ${view.baseRefName}${view.isDraft ? " (draft)" : ""}  ${view.url}`),
  );
}

const USAGE = `usage: pr <command>   (run inside the repo or one of its worktrees)
  facts [--branch <b>] [--cwd <dir>] [--json]
        branch, base (open PR > gh stack parent > br target), push state, commits since base,
        size (net lines vs ${NET_BUDGET}, lockfiles/generated/changesets excluded), ticket key,
        pair slice, PR template, existing open PR
  upsert --title <t> --body-file <f> [--base <b>] [--attach ./<file>[#alt]]... [--branch <b>] [--cwd <dir>] [--dry-run] [--json]
        create a DRAFT PR, or edit the open PR's title/body (and base, outside a gh stack);
        --attach uploads an image or video that sits next to the body file and that the body
        references as ](./<file>); never marks ready, never pushes`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "facts":
      return facts(args);
    case "upsert":
      return upsert(args);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

if (import.meta.main)
  main().catch((e) => {
    console.error(`pr: ${e instanceof UserError ? e.message : ((e as Error)?.message ?? e)}`);
    process.exit(1);
  });
