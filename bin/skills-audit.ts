#!/usr/bin/env bun
// Checks installed third-party skills (~/.agents/.skill-lock.json) against their upstream
// repos and manages the skill refine queue. Output feeds the status line and /skills.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const CONFIG_DIR = join(import.meta.dir, "..");
const CACHE_FILE = join(CONFIG_DIR, "cache", "skills-audit.json");
const QUEUE_FILE = join(CONFIG_DIR, "state", "skill-refine-queue.json");
const LOCK_FILE = join(homedir(), ".agents", ".skill-lock.json");
const EXTRA_SOURCES = ["anthropics/skills", "vercel-labs/agent-skills"];
// Dirs with a SKILL.md that are not installable skills: dot dirs (CI workflows),
// repo templates, and agent-browser's internal sub-skill data.
const NON_SKILL_PATHS = [/(^|\/)\./, /(^|\/)template$/, /^skill-data\//];

type LockEntry = { source: string; skillPath: string; skillFolderHash: string; installedAt?: string };
type NewEntry = { source: string; path: string; name: string };
type Moved = { name: string; newPath: string };
type Clash = { name: string; kind: "lock" | "new"; source?: string; path?: string };
type Cache = {
  checkedAt: string | null;
  ok: string[];
  update: string[];
  moved: Moved[];
  removed: string[];
  new: NewEntry[];
  clashes: Clash[];
  ignored: string[];
  errors: { source: string; message: string }[];
};
type Queue = { nextId: number; items: { id: number; name: string; note: string; addedAt: string }[] };
type TreeItem = { path: string; type: string; sha: string };

class UserError extends Error {}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw new UserError(`could not parse ${file}`);
  }
}

function writeJsonAtomic(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

function emptyCache(): Cache {
  return { checkedAt: null, ok: [], update: [], moved: [], removed: [], new: [], clashes: [], ignored: [], errors: [] };
}

function loadCache(): Cache {
  return { ...emptyCache(), ...readJson<Partial<Cache>>(CACHE_FILE, {}) };
}

async function gh(endpoint: string): Promise<any> {
  let proc;
  try {
    proc = Bun.spawn(["gh", "api", endpoint], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch {
    throw new Error("gh not found on PATH");
  }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim().split("\n")[0] || `gh exited ${code}`);
  return JSON.parse(out);
}

const skillDir = (skillPath: string) => {
  const d = dirname(skillPath);
  return d === "." ? "" : d;
};

type SourceResult = {
  ok: string[];
  update: string[];
  moved: Moved[];
  removed: string[];
  new: NewEntry[] | null; // null = could not determine (truncated tree), keep prior
};

async function scanSource(
  source: string,
  installed: [string, LockEntry][],
  installedNames: Set<string>,
  ignored: Set<string>,
): Promise<SourceResult> {
  const res: SourceResult = { ok: [], update: [], moved: [], removed: [], new: [] };
  const data = await gh(`repos/${source}/git/trees/HEAD?recursive=1`);

  if (data.truncated) {
    // Too large for one tree call: look each installed skill up in its parent dir instead.
    res.new = null;
    await Promise.all(
      installed.map(async ([name, entry]) => {
        const dir = skillDir(entry.skillPath);
        let sha: string | undefined;
        if (dir === "") sha = data.sha;
        else {
          try {
            const parent = dirname(dir) === "." ? "" : dirname(dir);
            const list = await gh(`repos/${source}/contents/${parent}`);
            sha = (list as { name: string; type: string; sha: string }[]).find(
              (e) => e.type === "dir" && e.name === basename(dir),
            )?.sha;
          } catch (e) {
            if (!String((e as Error).message).includes("404")) throw e;
          }
        }
        if (!sha) res.removed.push(name);
        else if (sha === entry.skillFolderHash) res.ok.push(name);
        else res.update.push(name);
      }),
    );
    return res;
  }

  const tree = data.tree as TreeItem[];
  const treeSha = new Map<string, string>([["", data.sha]]);
  for (const t of tree) if (t.type === "tree") treeSha.set(t.path, t.sha);
  // All SKILL.md dirs (installed skills may live under dot dirs, e.g. impeccable's .agents/);
  // NON_SKILL_PATHS only filters what counts as moved/new.
  const allSkillDirs = tree
    .filter((t) => t.type === "blob" && (t.path === "SKILL.md" || t.path.endsWith("/SKILL.md")))
    .map((t) => skillDir(t.path))
    .filter((d) => d !== "");
  const skillDirs = allSkillDirs.filter((d) => !NON_SKILL_PATHS.some((re) => re.test(d)));

  for (const [name, entry] of installed) {
    const dir = skillDir(entry.skillPath);
    const sha = treeSha.get(dir);
    const hasSkill = dir === "" || allSkillDirs.includes(dir);
    if (sha && hasSkill) {
      (sha === entry.skillFolderHash ? res.ok : res.update).push(name);
      continue;
    }
    const target = basename(dir || name);
    const newPath = skillDirs.find((d) => basename(d) === target);
    if (newPath) res.moved.push({ name, newPath });
    else res.removed.push(name);
  }

  for (const path of skillDirs) {
    const name = basename(path);
    if (installedNames.has(name) || ignored.has(`${source}:${path}`)) continue;
    res.new!.push({ source, path, name });
  }
  return res;
}

// Our hand-rolled skills are real dirs; upstream ones are symlinks or plain copies.
function isRealDir(name: string): boolean {
  try {
    const st = lstatSync(join(CONFIG_DIR, "skills", name));
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// A local fork marks itself with `origin: local` in its SKILL.md frontmatter.
function isLocalFork(name: string): boolean {
  try {
    const text = readFileSync(join(CONFIG_DIR, "skills", name, "SKILL.md"), "utf8");
    const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    return /^\s+origin:\s*local\s*$/m.test(front);
  } catch {
    return false;
  }
}

// A lock entry counts as installed here if this config dir links to the shared copy, or holds
// a plain copy of it (a real dir not marked as a local fork). A real dir marked `origin: local`
// (or a same-named hand-rolled skill, e.g. our `qa`) is not the upstream one and clashes with it.
function installedHere(name: string): boolean {
  try {
    const p = join(CONFIG_DIR, "skills", name);
    if (lstatSync(p).isSymbolicLink()) return readlinkSync(p).includes(".agents/skills/");
  } catch {
    return false;
  }
  return isRealDir(name) && !isLocalFork(name);
}

async function scan() {
  const lock = readJson<{ skills?: Record<string, LockEntry> }>(LOCK_FILE, {});
  const skills = Object.entries(lock.skills ?? {});
  if (skills.length === 0) throw new UserError(`no skills found in ${LOCK_FILE}`);

  const prior = loadCache();
  const ignored = new Set(prior.ignored);
  const installedNames = new Set<string>();
  const bySource = new Map<string, [string, LockEntry][]>();
  for (const [name, entry] of skills) {
    installedNames.add(name);
    installedNames.add(basename(skillDir(entry.skillPath) || name));
    if (!bySource.has(entry.source)) bySource.set(entry.source, []);
    // Track only skills installed in this config dir (linked or copied); pruned ones stay in the shared lock
    // (other config dirs may use them) but aren't reported as updates or new.
    if (installedHere(name)) bySource.get(entry.source)!.push([name, entry]);
  }
  for (const s of EXTRA_SOURCES) if (!bySource.has(s)) bySource.set(s, []);

  const sourceOf = (name: string) => lock.skills![name]?.source;
  const next = emptyCache();
  const results = await Promise.allSettled(
    [...bySource].map(([source, installed]) => scanSource(source, installed, installedNames, ignored)),
  );

  [...bySource.keys()].forEach((source, i) => {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      next.ok.push(...r.value.ok);
      next.update.push(...r.value.update);
      next.moved.push(...r.value.moved);
      next.removed.push(...r.value.removed);
      next.new.push(...(r.value.new ?? prior.new.filter((n) => n.source === source)));
      return;
    }
    next.errors.push({ source, message: (r.reason as Error)?.message ?? String(r.reason) });
    const mine = (name: string) => sourceOf(name) === source;
    next.ok.push(...prior.ok.filter(mine));
    next.update.push(...prior.update.filter(mine));
    next.moved.push(...prior.moved.filter((m) => mine(m.name)));
    next.removed.push(...prior.removed.filter(mine));
    next.new.push(...prior.new.filter((n) => n.source === source));
  });

  // Re-read ignored in case `ignore` ran during the scan.
  next.ignored = loadCache().ignored;
  const ign = new Set(next.ignored);
  next.new = next.new.filter((n) => !ign.has(`${n.source}:${n.path}`));
  for (const k of ["ok", "update", "removed"] as const) next[k].sort();
  next.moved.sort((a, b) => a.name.localeCompare(b.name));
  next.new.sort((a, b) => a.source.localeCompare(b.source) || a.path.localeCompare(b.path));
  next.clashes = [
    ...skills
      .filter(([name, e]) => isRealDir(name) && !installedHere(name) && !ign.has(`${e.source}:${skillDir(e.skillPath)}`))
      .map(([name, e]): Clash => ({ name, kind: "lock", source: e.source, path: e.skillPath })),
    ...next.new.filter((n) => isRealDir(n.name)).map((n): Clash => ({ name: n.name, kind: "new", source: n.source, path: n.path })),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  next.new = next.new.filter((n) => !isRealDir(n.name));
  next.checkedAt = new Date().toISOString();
  writeJsonAtomic(CACHE_FILE, next);

  console.log(
    `scanned ${bySource.size} sources: ${next.update.length} update, ${next.moved.length} moved, ` +
      `${next.removed.length} removed, ${next.new.length} new, ${next.clashes.length} clashes, ${next.errors.length} errors`,
  );
  for (const e of next.errors) console.error(`error: ${e.source}: ${e.message}`);
}

function loadQueue(): Queue {
  return { nextId: 1, items: [], ...readJson<Partial<Queue>>(QUEUE_FILE, {}) };
}

function refine(args: string[]) {
  const [sub, ...rest] = args;
  const q = loadQueue();
  if (sub === "add") {
    const [name, ...note] = rest;
    if (!name || note.length === 0) throw new UserError("usage: refine add <name> <note>");
    const item = { id: q.nextId, name, note: note.join(" "), addedAt: new Date().toISOString() };
    q.items.push(item);
    q.nextId++;
    writeJsonAtomic(QUEUE_FILE, q);
    console.log(`added #${item.id} ${name}`);
  } else if (sub === "list") {
    if (rest.includes("--json")) return console.log(JSON.stringify(q.items, null, 2));
    if (q.items.length === 0) return console.log("refine queue empty");
    for (const i of q.items) console.log(`#${i.id}  ${i.name}  ${i.note}  (${i.addedAt.slice(0, 10)})`);
  } else if (sub === "done") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id)) throw new UserError("usage: refine done <id>");
    const idx = q.items.findIndex((i) => i.id === id);
    if (idx === -1) throw new UserError(`no refine entry #${id}`);
    const [removed] = q.items.splice(idx, 1);
    writeJsonAtomic(QUEUE_FILE, q);
    console.log(`done #${id} ${removed!.name}`);
  } else {
    throw new UserError("usage: refine add <name> <note> | refine list [--json] | refine done <id>");
  }
}

function ignore(key: string | undefined, add: boolean) {
  const m = key?.match(/^([^/:\s]+\/[^/:\s]+):(.+)$/);
  if (!m) throw new UserError(`usage: ${add ? "ignore" : "unignore"} <owner/repo>:<path>`);
  const cache = loadCache();
  const set = new Set(cache.ignored);
  if (add) {
    set.add(key!);
    cache.new = cache.new.filter((n) => `${n.source}:${n.path}` !== key);
  } else set.delete(key!);
  cache.ignored = [...set].sort();
  writeJsonAtomic(CACHE_FILE, cache);
  console.log(`${add ? "ignored" : "unignored"} ${key}${add ? "" : " (reappears in new after next scan)"}`);
}

function report(json: boolean) {
  if (!existsSync(CACHE_FILE)) throw new UserError("no scan yet; run: skills-audit scan");
  const c = loadCache();
  const q = loadQueue();
  if (json) return console.log(JSON.stringify({ ...c, refine: q.items }, null, 2));

  const lines: string[] = [];
  const age = c.checkedAt ? Math.round((Date.now() - Date.parse(c.checkedAt)) / 3.6e6) : null;
  lines.push(`Skills audit, checked ${c.checkedAt ?? "never"}${age !== null ? ` (${age}h ago)` : ""}`);
  lines.push(`ok: ${c.ok.length}`);
  if (c.errors.length) {
    lines.push(`\nErrors (${c.errors.length}), counts for these sources are from the previous scan:`);
    for (const e of c.errors) lines.push(`  ${e.source}: ${e.message}`);
  }
  lines.push(`\nUpdates (${c.update.length}): ${c.update.join(", ") || "-"}`);
  lines.push(`\nMoved (${c.moved.length}):`);
  for (const m of c.moved) lines.push(`  ${m.name} -> ${m.newPath}`);
  lines.push(`\nRemoved upstream (${c.removed.length}): ${c.removed.join(", ") || "-"}`);
  lines.push(`\nNew upstream (${c.new.length}):`);
  const bySrc = Map.groupBy(c.new, (n) => n.source);
  for (const [src, items] of bySrc) {
    lines.push(`  ${src} (${items.length}):`);
    for (const n of items) lines.push(`    ${n.name}  ${n.path}`);
  }
  lines.push(`\nName clashes (${c.clashes.length}):`);
  for (const k of c.clashes) {
    lines.push(`  ${k.name}  ${k.kind === "lock" ? "lock entry shadowed by our real dir" : "new upstream skill"}  ${k.source ?? ""}:${k.path ?? ""}`);
  }
  lines.push(`\nRefine queue (${q.items.length}):`);
  for (const i of q.items) lines.push(`  #${i.id} ${i.name}: ${i.note}`);
  lines.push(`\nIgnored (${c.ignored.length})${c.ignored.length ? ": " + c.ignored.join(", ") : ""}`);
  console.log(lines.join("\n"));
}

const USAGE = `usage: skills-audit <command>
  scan                          check installed skills against upstream, write cache
  report [--json]               show the last scan and the refine queue
  refine add <name> <note>      queue a skill/agent for refinement
  refine list [--json]
  refine done <id>
  ignore <owner/repo>:<path>    hide an upstream skill from "new"
  unignore <owner/repo>:<path>`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "scan":
      return scan();
    case "report":
      return report(args.includes("--json"));
    case "refine":
      return refine(args);
    case "ignore":
    case "unignore":
      return ignore(args[0], cmd === "ignore");
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`skills-audit: ${e instanceof UserError ? e.message : (e as Error)?.message ?? e}`);
  process.exit(1);
});
