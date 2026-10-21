#!/usr/bin/env bun
// Read-only GitHub activity for the gather-context skill: a person's activity in a time window, one PR's
// full state (checks, reviews, review threads), a repo's git/GitHub conventions, where new work merges,
// and which logged-in gh account a repo's work belongs to.
// gh CLI only. Never pushes, comments, edits, resolves or switches accounts.
// Other scripts (wt.ts, pr.ts) import the repo-level helpers below; keep them free of CLI side effects.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const VALUE_FLAGS = new Set(["--since", "--until", "--repos", "--repo", "--cwd", "--user"]);
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
// Ticket keys: in a branch, a KEY-123 at the start or right after a "/"; in a title, a leading
// KEY-123 or a bracketed [KEY-123]. Looser matching picks up versions like biome-2 or GPT-6.
const BRANCH_TICKET_RE = /(?:^|\/)([A-Za-z]{2,10}-\d+)(?=$|[-_/])(?!-\d)/;
const TITLE_TICKET_RE = /^\[?([A-Za-z]{2,10}-\d+)\b|\[([A-Za-z]{2,10}-\d+)\]/;
const MAX_PUSH_BRANCHES = 25;

type Args = { pos: string[]; flags: Map<string, string | true> };
export type Local = { root: string; commonDir: string; branch: string | null };
export type Target = { branch: string; source: string; evidence: string };
type Node = Record<string, any>;

class UserError extends Error {}

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
const cwdOf = (args: Args) => resolve(str(args, "--cwd") ?? process.cwd());
export const ticketKey = (branch?: string | null, title?: string | null) => {
  const m = branch?.match(BRANCH_TICKET_RE) ?? title?.match(TITLE_TICKET_RE);
  const key = m?.[1] ?? m?.[2];
  return key ? key.toUpperCase() : null;
};
const countBy = (items: string[]) =>
  [...items.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

function emit(json: boolean, data: unknown, human: () => void) {
  if (json) console.log(JSON.stringify(data, null, 2));
  else human();
}

// ---------- process helpers ----------

let ghToken: string | undefined;

// Non-interactive gh, using the repo owner's token once useAccountFor has picked it.
export const ghEnv = (): Record<string, string> => ({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", ...(ghToken ? { GH_TOKEN: ghToken } : {}) });

async function run(cmd: string[], cwd: string, extra: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...ghEnv(), ...extra },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

async function gh(args: string[], cwd = process.cwd()): Promise<string> {
  if (!Bun.which("gh")) throw new UserError("gh not found on PATH");
  const r = await run(["gh", ...args], cwd);
  if (r.code === 0) return r.out;
  const e = r.err.trim();
  if (/gh auth login|not logged in|HTTP 401|Bad credentials/i.test(e)) throw new UserError("gh is not authenticated (run: gh auth login)");
  if (/no git remotes|none of the git remotes/i.test(e)) throw new UserError(`no GitHub remote in ${cwd}`);
  if (/not a git repository/i.test(e)) throw new UserError(`not a git repository: ${cwd}`);
  throw new UserError(`gh ${args[0]} failed: ${e.split("\n")[0] || `exit ${r.code}`}`);
}

const ghJson = async <T = any>(args: string[], cwd?: string): Promise<T> => JSON.parse(await gh(args, cwd)) as T;

async function graphql<T = any>(query: string, vars: Record<string, string | number>): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  const res = JSON.parse(await gh(args));
  if (res.errors?.length) throw new UserError(`graphql: ${res.errors[0].message}`);
  return res.data as T;
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  const r = await run(["git", ...args], cwd);
  return r.code === 0 ? r.out.trim() : null;
}

export async function localRepo(cwd: string): Promise<Local | null> {
  if (!existsSync(cwd)) throw new UserError(`no such directory ${cwd}`);
  const root = await git(cwd, "rev-parse", "--show-toplevel");
  if (!root) return null;
  const commonDir = (await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")) ?? join(root, ".git");
  const branch = await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD");
  return { root, commonDir, branch: branch || null };
}

// ---------- accounts ----------

type Access = "push" | "read" | "none";
export type Account = { login: string; active: boolean; access: Access };

async function tokenFor(login: string) {
  const r = await run(["gh", "auth", "token", "--user", login], process.cwd());
  return r.code === 0 && r.out.trim() ? r.out.trim() : undefined;
}

async function accessOf(token: string, repo: string): Promise<Access> {
  const r = await run(["gh", "api", `repos/${repo}`, "--jq", ".permissions.push"], process.cwd(), { GH_TOKEN: token });
  if (r.code !== 0) return "none";
  return r.out.trim() === "true" ? "push" : "read";
}

// Every logged-in github.com account with its access to repo, and the one the repo's work belongs to:
// the owner's own account when it can push, else the only account that can push. Two or more pushers
// with none of them the owner (an org repo both accounts belong to) is ambiguous: account is null.
export async function accountFor(repo: string) {
  const r = await run(["gh", "auth", "status", "--json", "hosts"], process.cwd(), { GH_TOKEN: "", GITHUB_TOKEN: "" });
  if (r.code !== 0) throw new UserError("gh is not authenticated (run: gh auth login)");
  const logins = ((JSON.parse(r.out).hosts?.["github.com"] ?? []) as Node[]).filter((a) => a.state === "success");
  const accounts = await Promise.all(
    logins.map(async (a) => {
      const token = await tokenFor(a.login);
      return { login: a.login as string, active: !!a.active, access: token ? await accessOf(token, repo) : ("none" as Access), token };
    }),
  );
  const owner = repo.split("/")[0]!.toLowerCase();
  const pushers = accounts.filter((a) => a.access === "push");
  const account = pushers.find((a) => a.login.toLowerCase() === owner) ?? (pushers.length === 1 ? pushers[0]! : null);
  return { accounts, account, ambiguous: !account && pushers.length > 1 };
}

// Scripts read a repo through its account's token for this process only; the active account is untouched.
export async function useAccountFor(repo: string) {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return;
  const own = await tokenFor(repo.split("/")[0]!);
  if (own) {
    ghToken = own;
    return;
  }
  const { accounts, account } = await accountFor(repo);
  ghToken = (account ?? accounts.find((a) => a.active && a.access !== "none") ?? accounts.find((a) => a.access !== "none"))?.token;
}

export async function originRepo(local: Local): Promise<string> {
  const remotes = (await git(local.root, "remote"))?.split("\n").filter(Boolean) ?? [];
  const name = remotes.includes("origin") ? "origin" : remotes[0];
  if (!name) throw new UserError(`no git remote in ${local.root}`);
  const url = (await git(local.root, "remote", "get-url", name)) ?? "";
  const m = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new UserError(`remote ${name} is not a GitHub repo: ${url}`);
  return m[1]!;
}

// The repo to query, plus the local checkout when it is that repo (for current branch and gh stack).
async function resolveRepo(args: Args): Promise<{ repo: string; local: Local | null }> {
  const cwd = cwdOf(args);
  const flag = str(args, "--repo");
  if (flag && !REPO_RE.test(flag)) throw new UserError(`--repo must be owner/name, got "${flag}"`);
  const local = await localRepo(cwd);
  if (!local && !flag) throw new UserError(`not a git repository: ${cwd} (pass --repo owner/name)`);
  const here = local ? await originRepo(local).catch((e) => (flag ? null : Promise.reject(e))) : null;
  const repo = flag ?? here!;
  await useAccountFor(repo);
  return { repo, local: here?.toLowerCase() === repo.toLowerCase() ? local : null };
}

// ---------- dates ----------

const pad = (n: number) => String(n).padStart(2, "0");
function isoLocal(d: Date) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// Day forms (today, yesterday, <n>d, YYYY-MM-DD) mean local midnight; as --until they mean the end of that day.
function parseWhen(raw: string, flag: string, endOfDay: boolean): Date {
  const startOfDay = (offset: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset + (endOfDay ? 1 : 0));
    return d;
  };
  if (raw === "today") return startOfDay(0);
  if (raw === "yesterday") return startOfDay(-1);
  let m = raw.match(/^(\d+)d$/);
  if (m) return startOfDay(-Number(m[1]));
  m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (endOfDay ? 1 : 0));
  const d = new Date(raw);
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && !isNaN(d.getTime())) return d;
  throw new UserError(`${flag}: expected today, yesterday, <n>d, YYYY-MM-DD or an ISO datetime, got "${raw}"`);
}

// ---------- me ----------

const PR_FIELDS = `number title url state isDraft headRefName baseRefName createdAt updatedAt mergedAt closedAt
  repository { nameWithOwner }
  reviews(author: $login, last: 50) { nodes { state submittedAt url } }
  comments(last: 100) { nodes { author { login } createdAt url } }`;

async function searchPrs(q: string, login: string) {
  const data = await graphql(
    `query($q: String!, $login: String!) { search(query: $q, type: ISSUE, first: 100) { issueCount nodes { ... on PullRequest { ${PR_FIELDS} } } } }`,
    { q, login },
  );
  const nodes: Node[] = data.search.nodes.filter((n: Node) => n?.number);
  return { nodes, truncated: data.search.issueCount > nodes.length ? data.search.issueCount : 0 };
}

const prSummary = (n: Node) => ({
  repo: n.repository.nameWithOwner as string,
  number: n.number as number,
  url: n.url as string,
  title: n.title as string,
  state: n.state as string,
  isDraft: n.isDraft as boolean,
  branch: n.headRefName as string,
  base: n.baseRefName as string,
  ticket: ticketKey(n.headRefName, n.title),
});

async function pushedBranches(login: string, from: Date, to: Date, repos: string[]) {
  const pushes: Node[] = [];
  for (let page = 1; page <= 3; page++) {
    const events = await ghJson<Node[]>(["api", `users/${login}/events?per_page=100&page=${page}`]);
    for (const e of events) {
      const at = new Date(e.created_at);
      if (e.type !== "PushEvent" || at < from || at >= to) continue;
      if (!String(e.payload?.ref).startsWith("refs/heads/")) continue;
      if (repos.length && !repos.some((r) => r.toLowerCase() === e.repo.name.toLowerCase())) continue;
      pushes.push(e);
    }
    if (events.length < 100 || new Date(events[events.length - 1]!.created_at) < from) break;
  }
  const groups = new Map<string, { repo: string; branch: string; pushes: number; lastPushAt: string; head: string }>();
  for (const e of pushes) {
    const branch = e.payload.ref.slice("refs/heads/".length);
    const key = `${e.repo.name}:${branch}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { repo: e.repo.name, branch, pushes: 1, lastPushAt: e.created_at, head: e.payload.head });
    else {
      g.pushes++;
      if (e.created_at > g.lastPushAt) Object.assign(g, { lastPushAt: e.created_at, head: e.payload.head });
    }
  }
  const list = [...groups.values()].sort((a, b) => b.lastPushAt.localeCompare(a.lastPushAt));
  const kept = list.slice(0, MAX_PUSH_BRANCHES);
  // Author date, not commit date: rebased commits get a new commit date but were not written in the window.
  const results = await Promise.allSettled(
    kept.map((g) =>
      ghJson<Node[]>(["api", `repos/${g.repo}/commits?sha=${g.head}&author=${login}&since=${from.toISOString()}&per_page=100`]),
    ),
  );
  const rows = kept.map((g, i) => {
    const r = results[i]!;
    const commits =
      r.status === "fulfilled"
        ? r.value
            .filter((c) => {
              const at = new Date(c.commit.author.date);
              return at >= from && at < to;
            })
            .map((c) => ({ sha: c.sha as string, message: String(c.commit.message).split("\n")[0]!, url: c.html_url as string, authoredAt: c.commit.author.date as string }))
        : [];
    return {
      repo: g.repo,
      branch: g.branch,
      ticket: ticketKey(g.branch),
      pushes: g.pushes,
      lastPushAt: g.lastPushAt,
      commits,
      ...(r.status === "rejected" ? { error: (r.reason as Error).message } : {}),
    };
  });
  // Stacked branches share commits; keep each commit only on the smallest branch that contains it.
  const owner = new Map<string, number>();
  rows.forEach((row, i) => {
    for (const c of row.commits) {
      const prev = owner.get(c.sha);
      if (prev === undefined || rows[prev]!.commits.length > row.commits.length) owner.set(c.sha, i);
    }
  });
  rows.forEach((row, i) => (row.commits = row.commits.filter((c) => owner.get(c.sha) === i)));
  return { rows, skippedBranches: list.length - kept.length };
}

async function cmdMe(args: Args) {
  allowFlags(args, ["--since", "--until", "--repos", "--user"]);
  const sinceRaw = str(args, "--since");
  if (!sinceRaw) throw new UserError("--since is required (today, yesterday, <n>d, YYYY-MM-DD)");
  const from = parseWhen(sinceRaw, "--since", false);
  const untilRaw = str(args, "--until");
  const to = untilRaw ? parseWhen(untilRaw, "--until", true) : new Date();
  if (from >= to) throw new UserError(`empty window: ${isoLocal(from)} to ${isoLocal(to)}`);
  const repos = (str(args, "--repos") ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  for (const r of repos) if (!REPO_RE.test(r)) throw new UserError(`--repos: "${r}" is not owner/name`);

  const user = str(args, "--user");
  if (user && !/^[\w-]+$/.test(user)) throw new UserError(`--user must be a GitHub login, got "${user}"`);
  const login = user ?? (await gh(["api", "user", "-q", ".login"])).trim();
  const range = `${isoLocal(from)}..${isoLocal(to)}`;
  const scope = repos.map((r) => `repo:${r}`).join(" ");
  const q = (s: string) => `is:pr ${s} ${scope}`.trim();
  const inWindow = (t?: string | null) => !!t && new Date(t) >= from && new Date(t) < to;

  const [authoredRes, reviewedRes, commentedRes, requestedRes, pushed] = await Promise.all([
    searchPrs(q(`author:${login} updated:${range}`), login),
    searchPrs(q(`reviewed-by:${login} -author:${login} updated:${range}`), login),
    searchPrs(q(`commenter:${login} -author:${login} updated:${range}`), login),
    searchPrs(q(`is:open user-review-requested:${login}`), login),
    pushedBranches(login, from, to, repos),
  ]);

  const authored = authoredRes.nodes.map((n) => ({
    ...prSummary(n),
    activity: inWindow(n.mergedAt) ? "merged" : inWindow(n.closedAt) ? "closed" : inWindow(n.createdAt) ? "opened" : "updated",
  }));
  const reviewed = reviewedRes.nodes
    .map((n) => ({ ...prSummary(n), myReviews: (n.reviews.nodes as Node[]).filter((r) => inWindow(r.submittedAt)).map((r) => ({ state: r.state, at: r.submittedAt, url: r.url })) }))
    .filter((p) => p.myReviews.length);
  const reviewedKeys = new Set(reviewed.map((p) => p.url));
  const commented = commentedRes.nodes
    .filter((n) => !reviewedKeys.has(n.url))
    .map((n) => ({ ...prSummary(n), myComments: (n.comments.nodes as Node[]).filter((c) => c.author?.login === login && inWindow(c.createdAt)).map((c) => c.url as string) }))
    .filter((p) => p.myComments.length);
  const reviewRequested = requestedRes.nodes.map(prSummary);
  const truncated = Object.entries({ authored: authoredRes, reviewed: reviewedRes, commented: commentedRes, reviewRequested: requestedRes })
    .filter(([, r]) => r.truncated)
    .map(([k, r]) => `${k}: first 100 of ${r.truncated}`);
  if (pushed.skippedBranches) truncated.push(`pushes: ${pushed.skippedBranches} older branches skipped`);

  const data = { login, window: { since: isoLocal(from), until: isoLocal(to) }, repos, authored, reviewed, commented, reviewRequested, pushes: pushed.rows, truncated };
  emit(args.flags.has("--json"), data, () => {
    const line = (p: ReturnType<typeof prSummary>, extra: string) =>
      console.log(`  ${p.repo}#${p.number} ${p.isDraft ? "DRAFT" : p.state}${p.ticket ? ` ${p.ticket}` : ""} ${p.title}${extra}  ${p.url}`);
    console.log(`${login}  ${data.window.since} → ${data.window.until}${repos.length ? `  (${repos.join(", ")})` : ""}`);
    console.log(`authored (${authored.length})`);
    authored.forEach((p) => line(p, ` [${p.activity}]`));
    console.log(`reviewed (${reviewed.length})`);
    reviewed.forEach((p) => line(p, ` [${[...new Set(p.myReviews.map((r) => r.state))].join(", ")}]`));
    console.log(`commented (${commented.length})`);
    commented.forEach((p) => line(p, ` [${p.myComments.length} comment${p.myComments.length === 1 ? "" : "s"}]`));
    console.log(`review requested, open now (${reviewRequested.length})`);
    reviewRequested.forEach((p) => line(p, ""));
    console.log(`pushes (${pushed.rows.length} branches)`);
    for (const b of pushed.rows) {
      console.log(`  ${b.repo} ${b.branch}${b.ticket ? ` ${b.ticket}` : ""}: ${b.pushes} push${b.pushes === 1 ? "" : "es"}, ${b.commits.length} new commit${b.commits.length === 1 ? "" : "s"}${b.error ? ` (commits unavailable: ${b.error})` : ""}`);
      for (const c of b.commits) console.log(`    ${c.sha.slice(0, 7)} ${c.message}`);
    }
    for (const t of truncated) console.log(`truncated: ${t}`);
  });
}

// ---------- pr ----------

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
  number title body url state isDraft baseRefName headRefName author { login } additions deletions changedFiles
  createdAt updatedAt mergedAt reviewDecision
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { totalCount nodes {
    __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } } }
  reviews(last: 100) { nodes { author { login } state submittedAt url } }
  reviewThreads(first: 100) { totalCount nodes { isResolved isOutdated path line originalLine resolvedBy { login }
    comments(first: 50) { nodes { author { login } body createdAt url } } } }
} } }`;

const FAIL = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const SKIP = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

function checksSummary(rollup: Node | null) {
  const out = { state: (rollup?.state as string) ?? "NONE", total: 0, pass: 0, fail: 0, pending: 0, skipped: 0, failing: [] as { name: string; url: string | null }[] };
  for (const c of (rollup?.contexts?.nodes ?? []) as Node[]) {
    out.total++;
    const name = c.__typename === "CheckRun" ? c.name : c.context;
    const url = c.__typename === "CheckRun" ? c.detailsUrl : c.targetUrl;
    const result = c.__typename === "CheckRun" ? (c.status === "COMPLETED" ? c.conclusion : "PENDING") : c.state;
    if (FAIL.has(result)) {
      out.fail++;
      out.failing.push({ name, url: url ?? null });
    } else if (SKIP.has(result)) out.skipped++;
    else if (result === "SUCCESS") out.pass++;
    else out.pending++;
  }
  return out;
}

async function resolvePr(args: Args): Promise<{ repo: string; number: number; candidates: string[] }> {
  const raw = args.pos[0];
  if (!raw) throw new UserError("usage: gh-activity pr <number|url|branch> [--repo owner/name]");
  const m = raw.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (m) {
    await useAccountFor(m[1]!);
    return { repo: m[1]!, number: Number(m[2]), candidates: [] };
  }
  const { repo } = await resolveRepo(args);
  if (/^#?\d+$/.test(raw)) return { repo, number: Number(raw.replace("#", "")), candidates: [] };
  const list = await ghJson<Node[]>(["pr", "list", "--repo", repo, "--head", raw, "--state", "all", "--limit", "10", "--json", "number,state,updatedAt,url"]);
  if (!list.length) throw new UserError(`no PR with head branch ${raw} in ${repo}`);
  list.sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || b.updatedAt.localeCompare(a.updatedAt));
  return { repo, number: list[0]!.number, candidates: list.slice(1).map((p) => `${p.url} (${p.state})`) };
}

async function cmdPr(args: Args) {
  allowFlags(args, ["--repo", "--cwd"]);
  const { repo, number, candidates } = await resolvePr(args);
  const [owner, name] = repo.split("/") as [string, string];
  const data = await graphql(PR_QUERY, { owner, name, number });
  const p: Node | null = data.repository?.pullRequest;
  if (!p) throw new UserError(`no PR #${number} in ${repo}`);

  const latest = new Map<string, Node>();
  for (const r of p.reviews.nodes as Node[]) {
    const login = r.author?.login ?? "ghost";
    const prev = latest.get(login);
    if (!prev || r.state !== "COMMENTED" || prev.state === "COMMENTED") latest.set(login, r);
  }
  const threads = (p.reviewThreads.nodes as Node[]).map((t) => ({
    isResolved: t.isResolved as boolean,
    isOutdated: t.isOutdated as boolean,
    path: t.path as string,
    line: (t.line ?? t.originalLine ?? null) as number | null,
    resolvedBy: (t.resolvedBy?.login ?? null) as string | null,
    comments: (t.comments.nodes as Node[]).map((c) => ({ author: c.author?.login ?? "ghost", body: c.body as string, createdAt: c.createdAt as string, url: c.url as string })),
  }));
  const out = {
    repo,
    number: p.number,
    url: p.url,
    title: p.title,
    body: p.body,
    state: p.state,
    isDraft: p.isDraft,
    base: p.baseRefName,
    head: p.headRefName,
    author: p.author?.login ?? "ghost",
    additions: p.additions,
    deletions: p.deletions,
    files: p.changedFiles,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    mergedAt: p.mergedAt,
    reviewDecision: p.reviewDecision,
    ticket: ticketKey(p.headRefName, p.title),
    headSha: p.commits.nodes[0]?.commit.oid ?? null,
    checks: checksSummary(p.commits.nodes[0]?.commit.statusCheckRollup ?? null),
    reviewers: [...latest].map(([login, r]) => ({ login, state: r.state, submittedAt: r.submittedAt, url: r.url })),
    threads: {
      total: p.reviewThreads.totalCount as number,
      unresolved: threads.filter((t) => !t.isResolved).length,
      outdated: threads.filter((t) => t.isOutdated).length,
      items: threads,
    },
    otherCandidates: candidates,
  };
  emit(args.flags.has("--json"), out, () => {
    const c = out.checks;
    console.log(`${repo}#${out.number} ${out.isDraft ? "DRAFT" : out.state}${out.ticket ? ` ${out.ticket}` : ""} ${out.title}`);
    console.log(`  ${out.url}`);
    console.log(`  ${out.head} → ${out.base} · by ${out.author} · +${out.additions}/-${out.deletions} in ${out.files} files · review ${out.reviewDecision ?? "none"}`);
    console.log(`  checks ${c.state}: ${c.pass} pass, ${c.fail} fail, ${c.pending} pending, ${c.skipped} skipped of ${c.total}`);
    for (const f of c.failing) console.log(`    failing: ${f.name}${f.url ? `  ${f.url}` : ""}`);
    console.log(`  reviewers: ${out.reviewers.map((r) => `${r.login} ${r.state}`).join(", ") || "none"}`);
    console.log(`  threads: ${out.threads.total} (${out.threads.unresolved} unresolved, ${out.threads.outdated} outdated)`);
    for (const t of threads) {
      const first = t.comments[0];
      const tag = t.isResolved ? "resolved" : "open";
      console.log(`    [${tag}${t.isOutdated ? ", outdated" : ""}] ${t.path}:${t.line ?? "?"} ${first?.author ?? ""}: ${(first?.body ?? "").replace(/\s+/g, " ").slice(0, 100)}`);
    }
    if (out.threads.total > threads.length) console.log(`    (first ${threads.length} of ${out.threads.total} threads)`);
    if (candidates.length) console.log(`  other PRs for this branch: ${candidates.join(", ")}`);
  });
}

// ---------- conventions ----------

// gh stack keeps its state in <git-common-dir>/gh-stack; the parent is the previous branch, or the trunk.
export function stackOf(local: Local | null) {
  if (!local?.branch) return null;
  const file = join(local.commonDir, "gh-stack");
  if (!existsSync(file)) return null;
  let state: Node;
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  for (const s of (state.stacks ?? []) as Node[]) {
    const branches = ((s.branches ?? []) as Node[]).map((b) => b.branch as string);
    const i = branches.indexOf(local.branch);
    if (i < 0) continue;
    return { number: (s.number ?? null) as number | null, trunk: s.trunk?.branch as string, parent: i === 0 ? (s.trunk?.branch as string) : branches[i - 1]!, branches };
  }
  return null;
}

// Repo-level conventions for new work, from the last 30 merged and open PRs. Deliberately ignores the
// current branch: its open-PR base or stack parent describes that branch, not where new work goes.
export async function repoConventions(repo: string) {
  const [info, merged, open] = await Promise.all([
    ghJson(["repo", "view", repo, "--json", "defaultBranchRef"]),
    ghJson<Node[]>(["pr", "list", "--repo", repo, "--state", "merged", "--limit", "30", "--json", "number,title,headRefName,baseRefName,url"]),
    ghJson<Node[]>(["pr", "list", "--repo", repo, "--state", "open", "--limit", "30", "--json", "number,title,headRefName,baseRefName,url"]),
  ]);
  const defaultBranch = (info.defaultBranchRef?.name ?? null) as string | null;
  const mergedBases = countBy(merged.map((p) => p.baseRefName as string)).map(({ key, count }) => ({ branch: key, count }));
  // A branch that many PRs merge into is an integration branch itself; its own PR (e.g. a release PR) says nothing.
  const integrationBranches = new Set([defaultBranch, ...mergedBases.filter((b) => b.count >= 3).map((b) => b.branch)]);

  let target: Target | null = null;
  if (mergedBases[0]) {
    const rest = mergedBases.slice(1);
    const others = rest.slice(0, 4).map((b) => `${b.branch} ${b.count}`).join(", ") + (rest.length > 4 ? `, +${rest.length - 4} more` : "");
    target = { branch: mergedBases[0].branch, source: "merged-prs", evidence: `${mergedBases[0].count} of the last ${merged.length} merged PRs target ${mergedBases[0].branch}${others ? ` (others: ${others})` : ""}` };
  } else if (defaultBranch) target = { branch: defaultBranch, source: "default-branch", evidence: `no open PR, stack or merged PRs; repo default is ${defaultBranch}` };

  const heads = [...open, ...merged].map((p) => p.headRefName as string).filter((h) => !integrationBranches.has(h));
  const recentBranches = [...new Set(heads)].slice(0, 30);
  return {
    defaultBranch,
    merged,
    open,
    mergedBases,
    integrationBranches,
    target,
    recentBranches,
    branchPrefixes: countBy(recentBranches.map((b) => (b.includes("/") ? `${b.split("/")[0]}/` : "(none)"))).map(({ key, count }) => ({ prefix: key, count })),
    ticketPrefixes: countBy([...open, ...merged].map((p) => ticketKey(p.headRefName, p.title)?.split("-")[0]).filter((k): k is string => !!k)).map(({ key, count }) => ({ prefix: key, count })),
  };
}

async function cmdConventions(args: Args) {
  allowFlags(args, ["--repo", "--cwd"]);
  const { repo, local } = await resolveRepo(args);
  const { defaultBranch, merged, mergedBases, integrationBranches, target, recentBranches, branchPrefixes, ticketPrefixes } = await repoConventions(repo);
  const branch = local?.branch ?? null;
  const stack = stackOf(local);

  let integrationTarget: Target | null = null;
  if (branch && !integrationBranches.has(branch)) {
    const prs = await ghJson<Node[]>(["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,baseRefName,url"]);
    if (prs[0]) integrationTarget = { branch: prs[0].baseRefName, source: "open-pr", evidence: `open PR #${prs[0].number} for ${branch} targets ${prs[0].baseRefName} (${prs[0].url})` };
    else if (stack) integrationTarget = { branch: stack.parent, source: "gh-stack", evidence: `${branch} sits on ${stack.parent} in gh stack${stack.number ? ` #${stack.number}` : ""} (trunk ${stack.trunk})` };
  }
  integrationTarget ??= target;

  const titles = merged.map((p) => p.title as string);
  const commits = local ? ((await git(local.root, "log", "-30", "--no-merges", "--format=%s")) ?? "").split("\n").filter(Boolean) : [];
  const conventional = (t: string) => /^(\[[^\]]+\]\s*)?[a-z]+(\([^)]+\))?!?:\s/.test(t);
  const out = {
    repo,
    currentBranch: branch,
    defaultBranch,
    integrationTarget,
    mergedBases,
    stack,
    recentBranches,
    branchPrefixes,
    prTitleSamples: titles.slice(0, 15),
    prTitlePatterns: {
      total: titles.length,
      bracketTicketPrefix: titles.filter((t) => /^\[[A-Za-z]+-\d+\]/.test(t)).length,
      ticketColonPrefix: titles.filter((t) => /^[A-Za-z]+-\d+:/.test(t)).length,
      conventional: titles.filter(conventional).length,
    },
    commitSamples: commits.slice(0, 10),
    commitPatterns: { total: commits.length, conventional: commits.filter(conventional).length },
    ticketPrefixes,
  };
  emit(args.flags.has("--json"), out, () => {
    console.log(`${repo}${branch ? `  on ${branch}` : ""}  default ${defaultBranch ?? "?"}`);
    console.log(`integration target: ${integrationTarget?.branch ?? "unknown"} (${integrationTarget?.source ?? "-"})`);
    if (integrationTarget) console.log(`  ${integrationTarget.evidence}`);
    if (stack) console.log(`stack${stack.number ? ` #${stack.number}` : ""}: ${stack.trunk} ← ${stack.branches.join(" ← ")}`);
    console.log(`branch prefixes: ${out.branchPrefixes.map((p) => `${p.prefix} ${p.count}`).join(", ") || "none"}`);
    console.log(`ticket prefixes: ${out.ticketPrefixes.map((p) => `${p.prefix} ${p.count}`).join(", ") || "none"}`);
    const tp = out.prTitlePatterns;
    console.log(`PR titles (last ${tp.total} merged): ${tp.bracketTicketPrefix} [KEY] prefix, ${tp.ticketColonPrefix} KEY: prefix, ${tp.conventional} conventional type(scope):`);
    for (const t of out.prTitleSamples.slice(0, 8)) console.log(`  ${t}`);
    if (commits.length) {
      console.log(`commit subjects (last ${commits.length} local, no merges): ${out.commitPatterns.conventional} conventional`);
      for (const c of commits.slice(0, 5)) console.log(`  ${c}`);
    }
    console.log(`recent branches:`);
    for (const b of recentBranches.slice(0, 10)) console.log(`  ${b}`);
  });
}

// ---------- target ----------

async function cmdTarget(args: Args) {
  allowFlags(args, ["--repo", "--cwd"]);
  const { repo } = await resolveRepo(args);
  const { target, defaultBranch } = await repoConventions(repo);
  if (!target) throw new UserError(`${repo} has no merged PRs and no default branch`);
  emit(args.flags.has("--json"), { repo, ...target, defaultBranch }, () => {
    console.log(`${target.branch} (${target.source})`);
    console.log(`  ${target.evidence}`);
    console.log(`  new branches start from origin/${target.branch}`);
  });
}

// ---------- account ----------

async function cmdAccount(args: Args) {
  allowFlags(args, ["--repo", "--cwd"]);
  const cwd = cwdOf(args);
  const flag = str(args, "--repo");
  if (flag && !REPO_RE.test(flag)) throw new UserError(`--repo must be owner/name, got "${flag}"`);
  const local = flag ? null : await localRepo(cwd);
  if (!flag && !local) throw new UserError(`not a git repository: ${cwd} (pass --repo owner/name)`);
  const repo = flag ?? (await originRepo(local!));
  const { accounts, account, ambiguous } = await accountFor(repo);
  const active = accounts.find((a) => a.active)?.login ?? null;
  let identity: { name: string; email: string } | null = null;
  if (account?.token) {
    const r = await run(["gh", "api", "user", "--jq", ".id"], cwd, { GH_TOKEN: account.token });
    if (r.code === 0) identity = { name: account.login, email: `${r.out.trim()}+${account.login}@users.noreply.github.com` };
  }
  const match = !!account && account.login === active;
  const out = {
    repo,
    active,
    account: account?.login ?? null,
    match,
    switch: account && !match ? `gh auth switch --user ${account.login}` : null,
    identity,
    ambiguous,
    accounts: accounts.map(({ login, active, access }) => ({ login, active, access })),
  };
  emit(args.flags.has("--json"), out, () => {
    console.log(repo);
    for (const a of out.accounts) console.log(`  ${a.login.padEnd(20)} ${a.access.padEnd(5)}${a.active ? " (active)" : ""}`);
    if (ambiguous) console.log(`  ambiguous: ${accounts.filter((a) => a.access === "push").map((a) => a.login).join(", ")} can all push; ask which one this work belongs to`);
    else if (!account) console.log("  no logged-in account can push to this repo");
    else console.log(`  account ${account.login}${match ? " (active)" : `; switch: ${out.switch}`}`);
    if (identity) console.log(`  commit  git -c user.name=${identity.name} -c user.email=${identity.email} commit`);
  });
}

const USAGE = `usage: gh-activity <command> [--json]   (read-only; gh CLI only)
  me --since <when> [--until <when>] [--repos o/a,o/b] [--user <login>]
                                                         PRs authored/reviewed/commented, open review requests,
                                                         pushed branches and commits (another --user: public pushes only)
                                                         <when>: today | yesterday | <n>d | YYYY-MM-DD | ISO datetime
  pr <number|url|branch> [--repo o/r] [--cwd <dir>]      PR metadata, checks, reviewers, review threads, ticket
  conventions [--repo o/r] [--cwd <dir>]                 integration target with evidence, default branch,
                                                         branch/ticket prefixes, PR title style, gh stack
  target [--repo o/r] [--cwd <dir>]                      where new work merges: most common base of the last
                                                         30 merged PRs, else the default branch
  account [--repo o/r] [--cwd <dir>]                     the logged-in account the repo's work belongs to,
                                                         the switch command when it is not active, and
                                                         its commit identity`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case "me":
      return cmdMe(args);
    case "pr":
      return cmdPr(args);
    case "conventions":
      return cmdConventions(args);
    case "target":
      return cmdTarget(args);
    case "account":
      return cmdAccount(args);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

if (import.meta.main)
  main().catch((e) => {
    console.error(`gh-activity: ${e instanceof UserError ? e.message : ((e as Error)?.message ?? e)}`);
    process.exit(1);
  });
