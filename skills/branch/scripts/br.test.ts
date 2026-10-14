import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orphanRefusal, parsePlan, planPrs, removeEmptyParents, slugify, suggestName, syncEnv, type LayerState } from "./br.ts";

const layer = (name: string, hasCommits = true, pr: LayerState["pr"] = null): LayerState => ({ name, hasCommits, pr });

describe("planPrs (open-PR cap)", () => {
  test("opens every layer when the cap has room", () => {
    expect(planPrs([layer("a"), layer("b")], 1, 5)).toEqual({ open: ["a", "b"], waiting: [] });
  });

  test("opens only up to the cap, bottom first; the rest wait", () => {
    const r = planPrs([layer("a"), layer("b"), layer("c"), layer("d")], 3, 5);
    expect(r.open).toEqual(["a", "b"]);
    expect(r.waiting.map((w) => w.name)).toEqual(["c", "d"]);
    expect(r.waiting[0]!.reason).toBe("open-PR cap 5 reached (3 open + 2 new)");
    expect(r.waiting[1]!.reason).toBe("open-PR cap 5 reached");
  });

  test("opens nothing when the user is already at or over the cap", () => {
    expect(planPrs([layer("a")], 5, 5).open).toEqual([]);
    expect(planPrs([layer("a")], 7, 5).open).toEqual([]);
  });

  test("skips layers that already have a PR and counts nothing new for them", () => {
    const r = planPrs([layer("a", true, { number: 1, state: "OPEN" }), layer("b", true, { number: 2, state: "MERGED" }), layer("c")], 4, 5);
    expect(r).toEqual({ open: ["c"], waiting: [] });
  });

  test("a closed PR does not count as having one", () => {
    expect(planPrs([layer("a", true, { number: 1, state: "CLOSED" })], 0, 5).open).toEqual(["a"]);
  });

  test("a layer without commits waits and blocks the layers above it", () => {
    const r = planPrs([layer("a"), layer("b", false), layer("c")], 0, 5);
    expect(r.open).toEqual(["a"]);
    expect(r.waiting).toEqual([
      { name: "b", reason: "no commits yet" },
      { name: "c", reason: "layer below (b) has no PR yet" },
    ]);
  });

  test("cap 0 opens nothing", () => {
    expect(planPrs([layer("a")], 0, 0).open).toEqual([]);
  });
});

describe("suggestName", () => {
  const recent = [
    "feature/prd-8963-edit-and-fix-with-ai",
    "feature/prd-9120-inline-diff-engine",
    "feat/sdk-1803-draft-item-status",
    "fix/prd-8993-content-editor-review-fixes",
    "chore/devdeps-lefthook-2-2",
  ];

  test("follows the repo's prefix and lowercase ticket style", () => {
    expect(suggestName("fix", "retry failed uploads", "PRD-123", recent).name).toBe("fix/prd-123-retry-failed-uploads");
  });

  test("picks the most used synonym for the type", () => {
    expect(suggestName("feature", "New thing!", null, recent).name).toBe("feature/new-thing");
    expect(suggestName("feature", "x", null, ["feat/a", "feat/b", "feature/c"]).name).toBe("feat/x");
  });

  test("uses an uppercase key when the repo does", () => {
    expect(suggestName("fix", "a b", "abc-9", ["fix/ABC-1-x", "fix/ABC-2-y"]).name).toBe("fix/ABC-9-a-b");
  });

  test("falls back to the canonical prefix and a lowercase key without evidence", () => {
    const s = suggestName("docs", "Read me", "AI-7", []);
    expect(s.name).toBe("docs/ai-7-read-me");
    expect(s.evidence[0]).toContain("using the conventional docs/");
  });

  test("rejects unknown types and empty descriptions", () => {
    expect(() => suggestName("wip", "x", null, [])).toThrow("--type must be one of");
    expect(() => suggestName("fix", "!!!", null, [])).toThrow("--desc needs");
  });
});

describe("slugify", () => {
  test("cuts long descriptions at a word boundary", () => {
    const s = slugify("make the upload retry logic resilient to flaky network conditions everywhere");
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s).toBe("make-the-upload-retry-logic-resilient-to-flaky");
  });
});

describe("parsePlan", () => {
  test("accepts a valid plan and trims titles", () => {
    expect(parsePlan({ branches: [{ name: "feature/a", title: " A " }] })).toEqual({ branches: [{ name: "feature/a", title: "A" }] });
  });

  test("rejects missing prefixes, duplicates and empty plans", () => {
    expect(() => parsePlan({ branches: [] })).toThrow("non-empty array");
    expect(() => parsePlan({ branches: [{ name: "a", title: "A" }] })).toThrow("conventional prefix");
    expect(() => parsePlan({ branches: [{ name: "wip/a", title: "A" }] })).toThrow("conventional prefix");
    expect(() =>
      parsePlan({ branches: [{ name: "fix/a", title: "A" }, { name: "fix/a", title: "B" }] }),
    ).toThrow("appears twice");
    expect(() => parsePlan({ base: "", branches: [{ name: "fix/a", title: "A" }] })).toThrow("base must be");
  });
});

// Every deletion test runs in a throwaway tree; the integration test points HOME at it so ~/worktrees is never touched.
const SCRATCH = process.env.BR_TEST_DIR || tmpdir();
let fx = "";
const mk = (...parts: string[]) => {
  const d = join(fx, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
};

beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true });
  fx = mkdtempSync(join(SCRATCH, "br-rm-"));
});
afterAll(() => {
  if (fx && !process.env.BR_KEEP) rmSync(fx, { recursive: true, force: true });
});

describe("orphanRefusal", () => {
  test("accepts a plain folder or a stale worktree (.git file) at <project>/<name>, with or without a trailing slash", () => {
    const root = mk("u1", "worktrees");
    mk("u1", "worktrees", "proj", "orphan", "sub");
    const stale = mk("u1", "worktrees", "proj", "stale");
    writeFileSync(join(stale, ".git"), "gitdir: /nowhere/.git/worktrees/stale\n");
    expect(orphanRefusal(join(root, "proj", "orphan"), root)).toBeNull();
    expect(orphanRefusal(join(root, "proj", "orphan") + "/", root)).toBeNull();
    expect(orphanRefusal(stale, root)).toBeNull();
  });

  test("refuses the root itself, a project folder, and anything deeper than <project>/<name>", () => {
    const root = mk("u2", "worktrees");
    mk("u2", "worktrees", "proj", "wt", "src");
    expect(orphanRefusal(root, root)).toContain("not a folder");
    expect(orphanRefusal(join(root, "proj"), root)).toContain("not a folder");
    expect(orphanRefusal(join(root, "proj", "wt", "src"), root)).toContain("not a folder");
  });

  test("refuses paths that leave the root through .., a relative path, or the home dir", () => {
    const root = mk("u3", "worktrees");
    const outside = mk("u3", "outside", "keep");
    mk("u3", "worktrees", "proj");
    expect(orphanRefusal(join(root, "proj", "..", "..", "outside", "keep"), root)).toContain("not a folder");
    expect(orphanRefusal(join(root, "proj", "..", "..", "outside"), root)).toContain("not a folder");
    expect(orphanRefusal(".", root)).toContain("not a folder");
    expect(orphanRefusal(join(fx, "u3"), root)).toContain("not a folder");
    expect(existsSync(outside)).toBe(true);
  });

  test("refuses a symlink (never follows it to its target) and a symlinked project folder pointing outside", () => {
    const root = mk("u4", "worktrees");
    const target = mk("u4", "elsewhere", "precious");
    mk("u4", "worktrees", "proj");
    symlinkSync(target, join(root, "proj", "link"));
    symlinkSync(join(fx, "u4", "elsewhere"), join(root, "alias"));
    expect(orphanRefusal(join(root, "proj", "link"), root)).toContain("is a symlink");
    expect(orphanRefusal(join(root, "alias", "precious"), root)).toContain("not a folder");
  });

  test("refuses a repository (a .git directory), a file, a missing path, and a missing root", () => {
    const root = mk("u5", "worktrees");
    mk("u5", "worktrees", "proj", "clone", ".git");
    writeFileSync(join(mk("u5", "worktrees", "proj"), "file"), "x");
    expect(orphanRefusal(join(root, "proj", "clone"), root)).toContain("has a .git directory");
    expect(orphanRefusal(join(root, "proj", "file"), root)).toContain("not a directory");
    expect(orphanRefusal(join(root, "proj", "gone"), root)).toContain("does not exist");
    expect(orphanRefusal(join(root, "proj", "clone"), join(fx, "u5", "nope"))).toContain("does not exist");
  });
});

describe("removeEmptyParents", () => {
  test("removes empty folders up to, never including, the root", () => {
    const root = mk("p1", "worktrees");
    mk("p1", "worktrees", "proj", "nested");
    removeEmptyParents(join(root, "proj", "nested", "wt"), root);
    expect(existsSync(join(root, "proj"))).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  test("stops at a non-empty folder and never climbs from outside the root", () => {
    const root = mk("p2", "worktrees");
    mk("p2", "worktrees", "proj", "other");
    mk("p2", "outside", "empty");
    removeEmptyParents(join(root, "proj", "wt"), root);
    expect(existsSync(join(root, "proj"))).toBe(true);
    removeEmptyParents(join(fx, "p2", "outside", "empty", "wt"), root);
    expect(existsSync(join(fx, "p2", "outside", "empty"))).toBe(true);
    removeEmptyParents(join(root, "wt"), root);
    expect(existsSync(root)).toBe(true);
  });
});

describe("br rm in a scratch HOME", () => {
  const BR = join(import.meta.dir, "br.ts");
  let home = "";
  let repo = "";
  let wts = "";
  const run = (cmd: string[], cwd: string) => {
    const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const git = (...args: string[]) => {
    const r = run(["git", ...args], repo);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
    return r.out.trim();
  };
  const br = (...args: string[]) => run(["bun", BR, "rm", ...args], repo);
  const brOutside = (...args: string[]) => run(["bun", BR, "rm", ...args], mk("cwd"));

  beforeAll(() => {
    home = mk("home");
    repo = mk("home", "code", "demo");
    wts = join(home, "worktrees", "demo");
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Br Test");
    git("config", "user.email", "br-test@example.invalid");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
    git("add", "-A");
    git("commit", "-q", "-m", "chore: initial");
    git("worktree", "add", "-q", "-b", "feature/wt1", join(wts, "wt1"));
    mk("home", "worktrees", "demo", "orphan", "deep");
    mk("home", "worktrees", "demo", "clone", ".git");
    mk("home", "outside", "precious");
    symlinkSync(join(home, "outside"), join(wts, "link"));
  });

  test("refuses every path that is not a worktree or a <project>/<name> orphan, and deletes nothing", () => {
    const cases: [string[], string][] = [
      [["."], "no worktree named . in ~/worktrees/demo"],
      [[".."], "no worktree named .. in ~/worktrees/demo"],
      [["orphan/.."], "no worktree named orphan/.. in ~/worktrees/demo"],
      [[join(home, "worktrees")], "is not a registered worktree and not a folder ~/worktrees/<project>/<name>; refusing"],
      [["~/worktrees/demo"], "is not a registered worktree and not a folder"],
      [[join(wts, "wt1", "src")], "is not a registered worktree and not a folder"],
      [[join(wts, "..", "..", "outside")], "is not a registered worktree and not a folder"],
      [[join(wts, "link")], "is a symlink; refusing to delete it or its target"],
      [[join(wts, "clone")], "has a .git directory (a repository, not a worktree); refusing"],
    ];
    for (const [args, msg] of cases) {
      const r = br(...args, "--force");
      expect(r.code).toBe(1);
      expect(r.err).toContain(msg);
    }
    expect(br(home, "--force").err).toContain("current directory is inside it");
    const fromOutside = brOutside(home, "--force");
    expect(fromOutside.code).toBe(1);
    expect(fromOutside.err).toContain("is not a registered worktree and not a folder");
    for (const p of [join(wts, "wt1", "src", "a.ts"), join(wts, "orphan", "deep"), join(wts, "clone", ".git"), join(home, "outside", "precious"), join(wts, "link")])
      expect(existsSync(p)).toBe(true);
  });

  test("an orphan needs --force, then goes; a registered worktree goes through git; empty parents go, the root stays", () => {
    const dry = br("orphan");
    expect(dry.code).toBe(1);
    expect(dry.out).toContain("rerun with --force to delete it");
    expect(br("orphan", "--force").code).toBe(0);
    expect(existsSync(join(wts, "orphan"))).toBe(false);
    rmSync(join(wts, "clone"), { recursive: true });
    rmSync(join(wts, "link"));
    const r = br("wt1");
    expect(r.code).toBe(0);
    expect(r.out).toContain("removed ~/worktrees/demo/wt1");
    expect(existsSync(wts)).toBe(false);
    expect(existsSync(join(home, "worktrees"))).toBe(true);
    expect(existsSync(join(home, "outside", "precious"))).toBe(true);
    expect(git("worktree", "list", "--porcelain")).not.toContain("wt1");
  });
});

describe("syncEnv", () => {
  const put = (root: string, rel: string, body: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const read = (p: string) => readFileSync(p, "utf8");

  test("copies missing files, nested ones included; skips node_modules and nested repos", () => {
    const main = mk("env1", "main");
    const wt = mk("env1", "wt");
    put(main, ".env", "A=1\n");
    put(main, "apps/hub/.env", "B=1\n");
    put(main, "node_modules/x/.env", "N=1\n");
    put(main, "vendor/.git/HEAD", "ref\n");
    put(main, "vendor/.env", "V=1\n");
    const r = syncEnv(main, wt);
    expect(r.copied.sort()).toEqual([".env", "apps/hub/.env"]);
    expect(read(join(wt, "apps/hub/.env"))).toBe("B=1\n");
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
    expect(existsSync(join(wt, "vendor"))).toBe(false);
  });

  test("reports files that differ and leaves them alone; identical files count as same", () => {
    const main = mk("env2", "main");
    const wt = mk("env2", "wt");
    put(main, ".env", "A=1\n");
    put(main, "packages/db/.env", "DB=main\n");
    put(wt, ".env", "A=1\n");
    put(wt, "packages/db/.env", "DB=mine\n");
    const r = syncEnv(main, wt);
    expect(r).toEqual({ missing: [], copied: [], same: [".env"], differs: ["packages/db/.env"], overwritten: [], extra: [] });
    expect(read(join(wt, "packages/db/.env"))).toBe("DB=mine\n");
  });

  test("overwrite replaces differing files and moves the old copy into the backup dir, outside the working tree", () => {
    const main = mk("env3", "main");
    const wt = mk("env3", "wt");
    const backups = join(fx, "env3", "gitdir", "br-env-backup", "t1");
    put(main, "apps/hub/.env", "A=main\n");
    put(wt, "apps/hub/.env", "A=mine\n");
    expect(() => syncEnv(main, wt, "overwrite")).toThrow();
    const r = syncEnv(main, wt, "overwrite", backups);
    expect(r.overwritten).toEqual([{ file: "apps/hub/.env", backup: join(backups, "apps/hub/.env") }]);
    expect(read(join(wt, "apps/hub/.env"))).toBe("A=main\n");
    expect(read(join(backups, "apps/hub/.env"))).toBe("A=mine\n");
    expect(syncEnv(main, wt, "check").extra).toEqual([]);
  });

  test("a dangling symlink in the worktree counts as differing, never crashes the copy", () => {
    const main = mk("env4", "main");
    const wt = mk("env4", "wt");
    put(main, ".env.local", "L=1\n");
    symlinkSync(join(wt, "nowhere"), join(wt, ".env.local"));
    expect(syncEnv(main, wt).differs).toEqual([".env.local"]);
    expect(syncEnv(main, wt, "overwrite", join(fx, "env4", "backup")).overwritten).toHaveLength(1);
    expect(read(join(wt, ".env.local"))).toBe("L=1\n");
  });

  test("check mode writes nothing: reports missing, differing and target-only files by name", () => {
    const main = mk("env5", "main");
    const wt = mk("env5", "wt");
    put(main, ".env", "A=1\n");
    put(main, "apps/hub/.env", "B=main\n");
    put(wt, "apps/hub/.env", "B=mine\n");
    put(wt, "packages/ui/.env.local", "U=1\n");
    const r = syncEnv(main, wt, "check");
    expect(r).toEqual({ missing: [".env"], copied: [], same: [], differs: ["apps/hub/.env"], overwritten: [], extra: ["packages/ui/.env.local"] });
    expect(existsSync(join(wt, ".env"))).toBe(false);
    expect(read(join(wt, "apps/hub/.env"))).toBe("B=mine\n");
  });
});

describe("br env in a scratch repo", () => {
  const BR = join(import.meta.dir, "br.ts");
  const run = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", BR, "env", ...args, "--json"], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const json = (r: ReturnType<typeof run>) => {
    if (r.code !== 0) throw new Error(r.err);
    return JSON.parse(r.out);
  };
  let repo = "";
  let wts = "";

  beforeAll(() => {
    repo = mk("envrepo", "main");
    wts = mk("envrepo", "wts");
    const g = (...a: string[]) => {
      const p = Bun.spawnSync(["git", ...a], { cwd: repo });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    };
    g("init", "-q", "-b", "main");
    g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
    g("worktree", "add", "-q", "-b", "feature/a", join(wts, "a"));
    g("worktree", "add", "-q", "-b", "feature/b", join(wts, "b"));
    writeFileSync(join(repo, ".env"), "DB=main\n");
    writeFileSync(join(wts, "a", ".env"), "DB=a\n");
  });

  test("defaults to the main checkout, --from switches the source and is remembered after a real sync", () => {
    const b = join(wts, "b");
    expect(json(run(b, "--check"))).toMatchObject({ source: "main checkout", missing: [".env"] });
    expect(json(run(b, "--from", "feature/a", "--check"))).toMatchObject({ source: "--from", missing: [".env"] });
    expect(json(run(b, "--check")).source).toBe("main checkout");
    expect(json(run(b, "--from", "feature/a")).copied).toEqual([".env"]);
    expect(readFileSync(join(b, ".env"), "utf8")).toBe("DB=a\n");
    expect(json(run(b, "--check"))).toMatchObject({ source: "spawned from", same: [".env"] });
  });

  test("--overwrite keeps the old copy in the worktree's git dir, never in the working tree", () => {
    const a = join(wts, "a");
    const r = json(run(a, "--from", "main", "--overwrite"));
    expect(r.overwritten).toHaveLength(1);
    expect(r.overwritten[0].backup).toContain(join(".git", "worktrees", "a", "br-env-backup"));
    expect(readFileSync(join(a, ".env"), "utf8")).toBe("DB=main\n");
    const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: a }).stdout.toString();
    expect(status).not.toContain("br-env-backup");
    expect(json(run(a, "--check")).source).toBe("main checkout");
  });

  test("refuses the main checkout, a worktree as its own source, and --check with --overwrite", () => {
    expect(run(repo).code).toBe(1);
    expect(run(join(wts, "a"), "--from", "feature/a").err).toContain("its own env source");
    expect(run(join(wts, "a"), "--check", "--overwrite").code).toBe(1);
  });
});

describe("--help", () => {
  const help = (...a: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "br.ts"), ...a], { cwd: tmpdir() });
  test("prints usage and exits 0 at the top level and on a subcommand", () => {
    for (const a of [["--help"], ["-h"], ["new", "--help"], ["stack", "-h"]]) {
      const r = help(...a);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("usage: br <command>");
      expect(r.stderr.toString()).toBe("");
    }
  });
});
