import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atRisk,
  buildMessage,
  carryOver,
  claim,
  claimProblem,
  elapsedWorkingDays,
  guardCheck,
  inPlan,
  isBuilt,
  liveWith,
  migrate,
  nextFor,
  openMilestone,
  parseNameStatus,
  parsePorcelainPaths,
  parseShortstat,
  planDiff,
  planGaps,
  roadmapStatus,
  shipFirstWarning,
  stackPlan,
  stageOf,
  starterFor,
  stateOf,
  syncRoadmap,
  timeline,
  validatePlan,
  validTitle,
  workingDays,
  type Pair,
} from "./pair.ts";

const SCRIPT = join(import.meta.dir, "pair.ts");
const SPEC_EXAMPLE = join(import.meta.dir, "..", "..", "spec", "references", "examples", "ticket.md");
const SPEC_ACS = new Map([["AC-1", false], ["AC-2", false], ["AC-3", false], ["AC-4", false], ["AC-5", true]]);

function plan(over: Record<string, unknown> = {}) {
  return {
    base: "main",
    deadline: "2026-10-23",
    slices: [
      {
        n: 1,
        title: "Greeting end to end",
        goal: "thinnest path",
        after: "after this you can run the greeting",
        branch: "feature/demo-greet",
        acs: ["AC-1", "AC-2"],
        test_script: ["bun src/index.ts", "see the greeting"],
        est_days: 1,
        budget: { net_lines: 200 },
        milestone: "M1",
        commits: [
          { n: 1, title: "feat(greet): add the greeting module", why: "the core behaviour", files: ["src/greet.ts", "src/index.ts"], est_lines: 30, check: "bun run typecheck", acs: ["AC-1"] },
          { n: 2, title: "feat(greet): add a farewell", why: "second behaviour", files: ["src/farewell.ts"], est_lines: 20, check: "bun run typecheck", acs: ["AC-2"] },
        ],
      },
      {
        n: 2,
        title: "Retry",
        goal: "retry",
        after: "after this you can retry",
        branch: "feature/demo-retry",
        acs: ["AC-3", "AC-4"],
        test_script: ["retry it"],
        est_days: 2,
        budget: { net_lines: 300 },
        milestone: "M1",
        commits: [{ n: 1, title: "feat(retry): retry failed greetings", why: "AC-3", files: ["src/retry.ts"], est_lines: 100, check: "bun run typecheck", acs: ["AC-3"] }],
      },
    ],
    ...over,
  };
}

// The shape brainstorm saves: PRs with rough commits (n, title, why) and no test script or budget.
function roughPlan() {
  const p = plan();
  return {
    ...p,
    slices: p.slices.map(({ test_script: _t, budget: _b, commits, ...s }) => ({
      ...s,
      merge_point: true,
      commits: commits.map((c) => ({ n: c.n, title: c.title, why: c.why })),
    })),
  };
}

const ctx: { slug: string; repo: string; specAcs: Map<string, boolean> | null } = { slug: "demo", repo: "/repo", specAcs: SPEC_ACS };
const withSlice = (patch: Record<string, unknown>, i = 0) => {
  const p = plan();
  p.slices[i] = { ...p.slices[i]!, ...patch } as (typeof p.slices)[number];
  return p;
};
const problemsOf = (raw: unknown, c = ctx) => validatePlan(raw, c).problems;
const valid = (raw: unknown = plan()) => {
  const r = validatePlan(raw, ctx);
  expect(r.problems).toEqual([]);
  return r.plan!;
};
const done = (p: Pair, n: number, sha = `sha${n}`) => {
  for (const c of p.slices[n - 1]!.commits) Object.assign(c, { status: "done", sha: `${sha}-${c.n}` });
  p.slices[n - 1]!.status = "checkpoint";
};

describe("validatePlan", () => {
  test("a valid plan has no problems and fills defaults", () => {
    const p = valid();
    expect(p.cap).toBe(5);
    expect(p.repo).toBe("/repo");
    expect(p.slices[0]!.status).toBe("todo");
    expect(p.slices[0]!.merge_point).toBe(true);
    expect(p.slices[0]!.commits[0]!.status).toBe("todo");
    expect("mode" in p).toBe(false);
  });

  test("brainstorm's rough ladder is valid: commits need only n, title and why", () => {
    const p = valid(roughPlan());
    const c = p.slices[0]!.commits[0]!;
    expect(c).toEqual({ n: 1, title: "feat(greet): add the greeting module", why: "the core behaviour", acs: [], status: "todo" });
    expect(p.slices[0]!.test_script).toBeUndefined();
    expect(p.slices[0]!.budget.net_lines).toBe(500);
    expect(planGaps(p.slices[0]!)).toEqual(["no test script", "commit 1 has no files, check, est_lines", "commit 2 has no files, check, est_lines"]);
    expect(planGaps(valid().slices[0]!)).toEqual([]);
  });

  test("a milestone must keep its PRs together", () => {
    const three = (ms: string[]) => {
      const p = plan();
      p.slices.push({ ...structuredClone(p.slices[1]!), n: 3, title: "Third", branch: "feature/demo-third" });
      p.slices.forEach((s, i) => (s.milestone = ms[i]));
      return p;
    };
    expect(problemsOf(three(["M1", "M2", "M1"]))).toContain('slice 3 "Third": milestone M1 comes back after M2; keep each milestone\'s PRs together');
    expect(problemsOf(three(["M1", "M1", "M2"]))).toEqual([]);
  });

  test("present commit details are still validated", () => {
    const bad = withSlice({ commits: [{ n: 1, title: "feat: x", why: "w", files: [], est_lines: -1, check: "" }] });
    const out = problemsOf(bad).join("\n");
    expect(out).toContain("commit 1: files must list at least one path");
    expect(out).toContain("commit 1: est_lines must be a non-negative integer");
    expect(out).toContain("commit 1: check must be the command that proves the commit");
  });

  test("a started PR must carry its full plan", () => {
    const p = roughPlan();
    (p.slices[0] as Record<string, unknown>).status = "active";
    expect(problemsOf(p)).toContain('slice 1 "Greeting end to end": is active but its plan is incomplete: no test script; commit 1 has no files, check, est_lines; commit 2 has no files, check, est_lines');
  });

  test("merge_point defaults to true, keeps false, refuses other values; liveWith names the PR that takes it live", () => {
    const p = valid(withSlice({ merge_point: false }));
    expect(p.slices[0]!.merge_point).toBe(false);
    expect(liveWith(p, p.slices[0]!)!.n).toBe(2);
    expect(liveWith(p, p.slices[1]!)!.n).toBe(2);
    expect(problemsOf(withSlice({ merge_point: "yes" })).join()).toContain("merge_point must be true or false");
    expect(validatePlan(withSlice({ merge_point: false }, 1), ctx).notes.join()).toContain("is not a merge point and nothing above it takes it live");
  });

  test("pr, sessions and plan fields are typed", () => {
    const p = valid(withSlice({ pr: 101, sessions: ["chat-a"], plan_file: "/state/pr-1-plan.md", plan_approved_at: "2026-10-14T10:00:00.000Z", status: "shipped" }));
    expect(p.slices[0]).toMatchObject({ pr: 101, sessions: ["chat-a"], plan_file: "/state/pr-1-plan.md", status: "shipped" });
    const out = problemsOf(withSlice({ pr: "#101", sessions: "chat-a", plan_file: "" })).join("\n");
    expect(out).toContain("pr must be the PR number");
    expect(out).toContain("sessions must be a list of chat ids");
    expect(out).toContain("plan_file must be a non-empty string");
  });

  test("DB commands as checks are refused with the guard's reason; ordinary checks pass", () => {
    const withCheck = (check: string) => withSlice({ commits: [{ ...plan().slices[0]!.commits[0]!, check }] });
    expect(problemsOf(withCheck("nr db:migrate"))).toEqual([
      'slice 1 "Greeting end to end": commit 1: check `nr db:migrate` is refused by the DB guard (package script `db:migrate`); checks never touch a database',
    ]);
    expect(problemsOf(withCheck("psql -c 'select 1'"))[0]).toContain("`psql` database CLI");
    expect(problemsOf(withCheck("nr typecheck && psql $DATABASE_URL"))[0]).toContain("`psql` database CLI");
    expect(problemsOf(withSlice({ green_check: "nr typecheck && nr db:migrate" }))[0]).toBe(
      'slice 1 "Greeting end to end": green_check: check `nr typecheck && nr db:migrate` is refused by the DB guard (package script `db:migrate`); checks never touch a database',
    );
    expect(problemsOf(withCheck("nr typecheck"))).toEqual([]);
    expect(problemsOf(withSlice({ green_check: "nr typecheck && nr test" }))).toEqual([]);
    expect(guardCheck("bun run typecheck")).toBeNull();
    expect(guardCheck("prisma migrate deploy")).toContain("`prisma migrate`");
  });

  test("budget over 500 names the slice and says split", () => {
    expect(problemsOf(withSlice({ budget: { net_lines: 600 } }))).toContain('slice 1 "Greeting end to end": budget 600 net lines is over the 500 limit; split the slice');
  });

  test("commit estimates over the slice budget fail", () => {
    expect(problemsOf(withSlice({ budget: { net_lines: 40 } })).join("\n")).toContain("commits estimate 50 net lines, over the slice budget 40");
  });

  test("conventional commit titles: type, scope, length", () => {
    expect(validTitle("feat(ui): show the empty state")).toBeNull();
    expect(validTitle("fix: crash on load")).toBeNull();
    expect(validTitle("feat!: drop v1")).toBeNull();
    expect(validTitle("Add a button")).toContain("not a Conventional Commit title");
    expect(validTitle("feature(ui): x")).toContain("not a Conventional Commit title");
    expect(validTitle(`feat: ${"x".repeat(70)}`)).toContain("max 72");
  });

  test("unknown and superseded AC ids fail against the spec", () => {
    const out = problemsOf(withSlice({ acs: ["AC-1", "AC-99", "AC-5"] })).join("\n");
    expect(out).toContain("AC-99 is not in the spec");
    expect(out).toContain("AC-5 is superseded in the spec");
  });

  test("ticket-scoped AC ids are accepted and not checked against the spec", () => {
    expect(problemsOf(withSlice({ acs: ["AC-1", "PRD-9167/AC-1", "HUB2-4/AC-12"] }))).toEqual([]);
    const commits = [{ ...plan().slices[0]!.commits[0]!, acs: ["PRD-9167/AC-1"] }];
    expect(validatePlan(withSlice({ acs: ["PRD-9167/AC-1"], commits }), ctx).problems).toEqual([]);
  });

  test("malformed AC ids fail on slices and commits", () => {
    const out = problemsOf(withSlice({ acs: ["prd-9167/AC-1", "AC1", "PRD-9167/ac-1", "PRD/AC-1"] }), { ...ctx, specAcs: null }).join("\n");
    for (const id of ["prd-9167/AC-1", "AC1", "PRD-9167/ac-1", "PRD/AC-1"]) expect(out).toContain(`"${id}" is not an AC id (AC-<n> or <TICKET>/AC-<n>)`);
    const commits = [{ ...plan().slices[0]!.commits[0]!, acs: ["story-1"] }];
    expect(problemsOf(withSlice({ commits }), { ...ctx, specAcs: null }).join()).toContain('commit 1: "story-1" is not an AC id');
  });

  test("without a spec, AC ids are only shape-checked", () => {
    expect(problemsOf(withSlice({ acs: ["AC-99"] }), { ...ctx, specAcs: null })).toEqual([]);
    expect(problemsOf(withSlice({ acs: ["story-1"] }), { ...ctx, specAcs: null }).join()).toContain('"story-1" is not an AC id');
  });

  test("uncovered spec ACs are reported as notes, not problems", () => {
    const p = plan();
    p.slices[1]!.acs = ["AC-3"];
    const r = validatePlan(p, ctx);
    expect(r.problems).toEqual([]);
    expect(r.notes).toContain("ACs not covered by any slice: AC-4");
  });

  test("duplicate branches, numbering, and missing parts", () => {
    const out = problemsOf(withSlice({ branch: "feature/demo-retry", n: 3, test_script: [], commits: [] })).join("\n");
    expect(out).toContain("branch feature/demo-retry is used by another slice");
    expect(out).toContain("n must be 1");
    expect(out).toContain("test_script needs at least one step");
    expect(out).toContain("needs at least one planned commit");
  });

  test("slug mismatch, missing base, bad deadline", () => {
    const out = problemsOf({ ...plan(), slug: "other", base: "", deadline: "next friday" }).join("\n");
    expect(out).toContain('slug "other" does not match');
    expect(out).toContain("base (the integration target from br target) is required");
    expect(out).toContain("deadline must be YYYY-MM-DD");
  });

  test("empty acs are allowed only on a prefactor slice with a why", () => {
    const ok = validatePlan(withSlice({ acs: [], prefactor: true, why: "extract the client before slice 2 reuses it" }), ctx);
    expect(ok.problems).toEqual([]);
    expect(ok.plan!.slices[0]).toMatchObject({ acs: [], prefactor: true, why: "extract the client before slice 2 reuses it" });
    expect(problemsOf(withSlice({ acs: [] })).join()).toContain("acs must list at least one AC id (a prefactor slice sets prefactor: true and why)");
    expect(problemsOf(withSlice({ acs: [], prefactor: true })).join()).toContain("a prefactor slice with no ACs needs why");
    expect(problemsOf(withSlice({ acs: [], prefactor: "yes", why: "w" })).join()).toContain("prefactor must be true or false");
  });

  test("unapproved exceptions are notes", () => {
    const r = validatePlan(withSlice({ exceptions: [{ what: "no tests", why: "spike", approved: false }] }), ctx);
    expect(r.problems).toEqual([]);
    expect(r.notes.join()).toContain('exception "no tests" is not approved yet');
  });

  test("stack plan has the br stack shape", () => {
    expect(stackPlan(valid())).toEqual({
      base: "main",
      branches: [
        { name: "feature/demo-greet", title: "Greeting end to end" },
        { name: "feature/demo-retry", title: "Retry" },
      ],
    });
  });

  test("older pair.json files migrate on load: mode dropped, merge_point defaulted", () => {
    const legacy = JSON.parse(JSON.stringify({ ...valid(), mode: "off" }));
    for (const s of legacy.slices) delete s.merge_point;
    const p = migrate(legacy);
    expect("mode" in p).toBe(false);
    expect(p.slices.map((s) => s.merge_point)).toEqual([true, true]);
  });
});

describe("carryOver and planDiff", () => {
  const stored = () => {
    const p = valid();
    p.slices[0]!.status = "active";
    p.slices[0]!.started_at = "2026-10-09T10:00:00.000Z";
    p.slices[0]!.sessions = ["chat-a"];
    p.slices[0]!.plan_approved_at = "2026-10-09T09:00:00.000Z";
    p.slices[0]!.plan_file = "/state/demo/pr-1-plan.md";
    Object.assign(p.slices[0]!.commits[0]!, { status: "done", sha: "abc1234def", done_at: "2026-10-09T11:00:00.000Z" });
    p.slices[0]!.commits.push({ n: 3, title: "refactor: simplify", why: "w", files: ["src/greet.ts"], est_lines: 0, check: "c", acs: [], status: "done", sha: "fff", extra: true });
    return p;
  };
  const resave = (old: Pair, raw: unknown) => {
    const r = validatePlan(carryOver(old, raw), ctx);
    expect(r.problems).toEqual([]);
    return { plan: r.plan!, ...planDiff(old, r.plan!) };
  };

  test("keeps live_at from the stored PR", () => {
    const old = stored();
    old.slices[0]!.live_at = "2026-10-12T10:00:00.000Z";
    const { plan: merged } = resave(old, plan());
    expect(merged.slices[0]!.live_at).toBe("2026-10-12T10:00:00.000Z");
  });

  test("inserting a PR before a started one keeps its done markers by branch and commit title", () => {
    const old = stored();
    const raw = plan();
    raw.slices.unshift({ ...raw.slices[1]!, title: "Logging", branch: "feature/demo-logging", acs: ["AC-4"] });
    raw.slices.forEach((s, i) => (s.n = i + 1));
    const { plan: merged, diff, dropped } = resave(old, raw);
    const s = merged.slices[1]!;
    expect(s.branch).toBe("feature/demo-greet");
    expect(s).toMatchObject({ status: "active", started_at: "2026-10-09T10:00:00.000Z", sessions: ["chat-a"], plan_file: "/state/demo/pr-1-plan.md" });
    expect(s.commits[0]).toMatchObject({ status: "done", sha: "abc1234def" });
    expect(s.commits[1]!.status).toBe("todo");
    expect(s.commits[2]).toMatchObject({ n: 3, title: "refactor: simplify", extra: true });
    expect(merged.slices[0]!.status).toBe("todo");
    expect(diff).toContain('+ PR 1 "Logging"');
    expect(diff).toContain('~ PR 1 "Greeting end to end" is now PR 2');
    expect(dropped).toEqual([]);
  });

  test("a rough re-save from brainstorm keeps the approved details, the plan and the progress", () => {
    const old = stored();
    const { plan: merged, diff } = resave(old, roughPlan());
    const s = merged.slices[0]!;
    expect(s.test_script).toEqual(["bun src/index.ts", "see the greeting"]);
    expect(s.budget.net_lines).toBe(200);
    expect(s.plan_approved_at).toBe("2026-10-09T09:00:00.000Z");
    expect(s.commits[0]).toMatchObject({ files: ["src/greet.ts", "src/index.ts"], check: "bun run typecheck", est_lines: 30, acs: ["AC-1"], status: "done", sha: "abc1234def" });
    expect(planGaps(s)).toEqual([]);
    expect(diff).toEqual(["no plan changes"]);
  });

  test("a renamed branch is matched by title; a changed commit title is reported", () => {
    const old = stored();
    const raw = plan();
    raw.slices[0]!.branch = "feature/demo-hello";
    raw.slices[0]!.commits[1]!.title = "feat(greet): add a goodbye";
    const { plan: merged, diff, dropped } = resave(old, raw);
    expect(merged.slices[0]!.commits[0]!.sha).toBe("abc1234def");
    expect(diff).toContain('~ PR 1: branch "feature/demo-greet" → "feature/demo-hello"');
    expect(diff).toContain('  PR 1: + commit "feat(greet): add a goodbye"');
    expect(diff).toContain('  PR 1: - commit "feat(greet): add a farewell"');
    expect(dropped).toEqual([]);
  });

  test("done work that leaves the ladder is reported as dropped", () => {
    const old = stored();
    old.slices[1]!.pr = 102;
    old.slices[1]!.status = "shipped";
    const raw = plan();
    raw.slices[0]!.commits[0]!.title = "feat(greet): renamed";
    raw.slices.pop();
    const { dropped, diff } = resave(old, raw);
    expect(dropped).toContain('PR 1 commit "feat(greet): add the greeting module" (abc1234) is done but no longer planned');
    expect(dropped).toContain('PR 2 "Retry" is shipped as #102 but was removed from the ladder');
    expect(diff).toContain('- PR 2 "Retry"');
  });

  test("first save reports the plan size", () => {
    expect(planDiff(null, valid()).diff).toEqual(["new plan: 2 PRs, 3 commits"]);
  });
});

describe("routing and one PR per chat", () => {
  const ladder = () => {
    const p = valid();
    p.slices.push({ ...structuredClone(p.slices[1]!), n: 3, title: "Third", branch: "feature/demo-third" });
    return p;
  };
  const approve = (p: Pair, n: number) => (p.slices[n - 1]!.plan_approved_at = "2026-10-14T09:00:00.000Z");

  test("states, stages and starters follow the PR's progress", () => {
    const p = valid(roughPlan());
    const s = p.slices[0]!;
    expect([stateOf(s), stageOf(s), starterFor(p, s)]).toEqual(["not planned yet", "todo", "/pair plan demo"]);
    expect(starterFor(p, p.slices[1]!)).toBe("/pair plan demo 2");
    const q = valid();
    approve(q, 1);
    expect([stateOf(q.slices[0]!), stageOf(q.slices[0]!), starterFor(q, q.slices[0]!)]).toEqual(["plan approved, not built", "planned", "/pair implement demo"]);
    q.slices[0]!.commits[0]!.status = "done";
    expect([stateOf(q.slices[0]!), stageOf(q.slices[0]!)]).toEqual(["in progress, 1 of 2 commits", "in-progress"]);
    done(q, 1);
    expect([stateOf(q.slices[0]!), stageOf(q.slices[0]!), starterFor(q, q.slices[0]!)]).toEqual(["built, not shipped", "checkpoint", "/pair implement demo"]);
    q.slices[0]!.pr = 101;
    q.slices[0]!.status = "shipped";
    expect([stateOf(q.slices[0]!), stageOf(q.slices[0]!)]).toEqual(["draft #101", "shipped"]);
  });

  test("/pair plan routes the first unshipped PR by its state", () => {
    const p = ladder();
    expect(nextFor(p, "chat-a")).toMatchObject({ action: "plan", slice: { n: 1 } });
    approve(p, 1);
    expect(nextFor(p, "chat-a").action).toBe("build");
    done(p, 1);
    expect(nextFor(p, "chat-a").action).toBe("ship");
    claim(p.slices[0]!, "chat-a");
    expect(nextFor(p, "chat-a").action).toBe("checkpoint");
    expect(nextFor(p, null).action).toBe("checkpoint");
    p.slices[0]!.status = "shipped";
    p.slices[0]!.pr = 101;
    expect(nextFor(p, "chat-a")).toMatchObject({ action: "fixes", slice: { n: 1 }, next: { n: 2 } });
    expect(nextFor(p, "chat-b")).toMatchObject({ action: "plan", slice: { n: 2 } });
    for (const s of p.slices) Object.assign(s, { status: "shipped", pr: 100 + s.n });
    expect(nextFor(p, "chat-b").action).toBe("all-shipped");
  });

  test("/pair plan <n> jumps ahead with the earlier unshipped PRs listed, and refuses another PR in a claimed chat", () => {
    const p = ladder();
    const r = nextFor(p, "chat-a", { want: 3 });
    expect(r.action).toBe("plan");
    expect(r.earlier.map((s) => s.n)).toEqual([1, 2]);
    claim(p.slices[0]!, "chat-a");
    expect(nextFor(p, "chat-a", { want: 3 })).toMatchObject({ action: "refuse", slice: { n: 3 } });
    expect(nextFor(p, "chat-a", { want: 1 }).action).toBe("plan");
    expect(() => nextFor(p, "chat-a", { want: 9 })).toThrow("PR 9 not found");
  });

  test("/pair implement takes the first approved or half-built PR, or says there is none", () => {
    const p = ladder();
    expect(nextFor(p, "chat-b", { implement: true }).action).toBe("no-plan");
    approve(p, 2);
    expect(nextFor(p, "chat-b", { implement: true })).toMatchObject({ action: "build", slice: { n: 2 } });
    p.slices[0]!.status = "active";
    p.slices[0]!.commits[0]!.status = "done";
    p.slices[0]!.sessions = ["chat-a"];
    expect(nextFor(p, "chat-b", { implement: true })).toMatchObject({ action: "build", slice: { n: 1 } });
    expect(nextFor(p, "chat-a", { implement: true })).toMatchObject({ action: "build", slice: { n: 1 } });
  });

  test("a chat that holds a PR is refused another one; a fresh chat takes over the same PR", () => {
    const p = ladder();
    claim(p.slices[0]!, "chat-a");
    expect(claimProblem(p, p.slices[0]!, "chat-a")).toBeNull();
    expect(claimProblem(p, p.slices[1]!, "chat-a")).toBe(
      'this chat is on PR 1 "Greeting end to end"; one PR per chat, so here it only takes fixes to PR 1 and roadmap updates. Start PR 2 "Retry" in a fresh chat with /pair plan demo 2 (run /handoff for the starter)',
    );
    expect(claimProblem(p, p.slices[1]!, "chat-a", true)).toBeNull();
    expect(claimProblem(p, p.slices[1]!, null)).toBeNull();
    expect(claimProblem(p, p.slices[0]!, "chat-b")).toBeNull();
    claim(p.slices[0]!, "chat-b");
    claim(p.slices[0]!, "chat-b");
    expect(p.slices[0]!.sessions).toEqual(["chat-a", "chat-b"]);
    expect(claimProblem(p, p.slices[1]!, "chat-b")).toContain("this chat is on PR 1");
  });

  test("more than one built but unshipped PR warns to ship the lowest first", () => {
    const p = ladder();
    expect(shipFirstWarning(p)).toBeNull();
    done(p, 2);
    expect(shipFirstWarning(p)).toBeNull();
    done(p, 3);
    expect(shipFirstWarning(p)).toBe("2 PRs are built but not shipped (PR 2, PR 3); ship PR 2 first, one PR per chat");
    expect(isBuilt(p.slices[2]!)).toBe(true);
  });

  describe("milestone gate", () => {
    const milestones = (p: Pair, ms: string[]) => p.slices.forEach((s, i) => (s.milestone = ms[i]));
    const shipTwo = (p: Pair) => {
      for (const s of p.slices.slice(0, 2)) Object.assign(s, { status: "shipped", pr: 100 + s.n });
    };

    test("the first PR of a later milestone waits while an earlier milestone is not live", () => {
      const p = ladder();
      milestones(p, ["M1", "M1", "M2"]);
      shipTwo(p);
      const r = nextFor(p, "chat-x");
      expect(r).toMatchObject({ action: "close-milestone", slice: { n: 3 }, gate: { milestone: "M1" } });
      expect(r.gate?.slices.map((s) => s.n)).toEqual([1, 2]);
      expect(nextFor(p, "chat-x", { want: 3 })).toMatchObject({ action: "close-milestone", gate: { milestone: "M1" } });
      for (const s of p.slices.slice(0, 2)) s.live_at = "2026-10-14T10:00:00.000Z";
      expect(nextFor(p, "chat-x")).toMatchObject({ action: "plan", slice: { n: 3 }, gate: null });
    });

    test("only the first PR of a milestone is gated, and only before it is planned", () => {
      const p = ladder();
      milestones(p, ["M1", "M2", "M2"]);
      Object.assign(p.slices[0]!, { status: "shipped", pr: 101 });
      approve(p, 2);
      expect(nextFor(p, "chat-x", { want: 3 }).action).toBe("plan");
      approve(p, 3);
      expect(nextFor(p, "chat-x", { want: 3 }).action).toBe("build");
      expect(openMilestone(p, p.slices[2]!)).toBeNull();
      const q = ladder();
      milestones(q, ["M1", "M2", "M2"]);
      Object.assign(q.slices[0]!, { status: "shipped", pr: 101 });
      expect(nextFor(q, "chat-x")).toMatchObject({ action: "close-milestone", slice: { n: 2 } });
      expect(openMilestone(q, q.slices[2]!)).toBeNull();
    });

    test("a ladder without milestones is never gated", () => {
      const p = ladder();
      for (const s of p.slices) delete s.milestone;
      shipTwo(p);
      expect(nextFor(p, "chat-x")).toMatchObject({ action: "plan", gate: null });
    });
  });
});

describe("syncRoadmap", () => {
  const ROADMAP = [
    "# Demo",
    "",
    "**Next up: PR 1, Greeting.** Start it in a fresh chat with `/pair plan demo`.",
    "",
    "## What we are doing and why",
    "Prose (stays) as written.",
    "",
    "## Milestone 1: greetings",
    "",
    "**PR 1: Greeting** (next)",
    "Users see a greeting (on the home page).",
    "",
    "**PR 2: Retry** (not started)",
    "Users can retry.",
    "",
  ].join("\n");

  test("rewrites only the status parts from the ladder", () => {
    const p = valid();
    const same = syncRoadmap(ROADMAP, p);
    expect(same).toEqual({ md: ROADMAP, changed: [], problems: [] });
    p.slices[0]!.plan_approved_at = "2026-10-14T09:00:00.000Z";
    let r = syncRoadmap(ROADMAP, p);
    expect(r.md).toContain("**Next up: PR 1, Greeting.** Start it in a fresh chat with `/pair implement demo`.");
    expect(r.md).toContain("**PR 1: Greeting** (plan approved)");
    p.slices[0]!.commits[0]!.status = "done";
    expect(syncRoadmap(ROADMAP, p).md).toContain("**PR 1: Greeting** (in progress, 1 of 2 commits)");
    Object.assign(p.slices[0]!, { status: "shipped", pr: 4301 });
    p.slices[0]!.commits[1]!.status = "done";
    r = syncRoadmap(ROADMAP, p);
    expect(r.md).toContain("**PR 1: Greeting** (draft #4301)");
    expect(r.md).toContain("**PR 2: Retry** (next)");
    expect(r.md).toContain("**Next up: PR 2, Retry.** Start it in a fresh chat with `/pair plan demo`.");
    expect(r.changed).toEqual(["PR 1: next → draft #4301", "PR 2: not started → next", "Next up → PR 2"]);
    expect(r.md.replace(/\*\*.*\*\*.*$/gm, "")).toBe(ROADMAP.replace(/\*\*.*\*\*.*$/gm, ""));
  });

  test("live_at makes a shipped PR live and closes the roadmap once every PR is live", () => {
    const p = valid();
    for (const s of p.slices) Object.assign(s, { status: "shipped", pr: 4300 + s.n });
    p.slices[0]!.live_at = "2026-10-14T10:00:00.000Z";
    expect([stateOf(p.slices[0]!), roadmapStatus(p, p.slices[0]!, "draft #4301")]).toEqual(["live", "live"]);
    let r = syncRoadmap(ROADMAP, p);
    expect(r.md).toContain("**PR 1: Greeting** (live)");
    expect(r.md).toContain("**Next up: nothing; every PR in this roadmap is shipped.**");
    p.slices[1]!.live_at = "2026-10-14T10:00:00.000Z";
    r = syncRoadmap(ROADMAP, p);
    expect(r.md).toContain("**Next up: nothing; every PR is live. This roadmap is done.**");
  });

  test("Next up asks to close the earlier milestone when the next PR starts a new one", () => {
    const p = valid();
    p.slices[1]!.milestone = "M2";
    Object.assign(p.slices[0]!, { status: "shipped", pr: 4301 });
    const r = syncRoadmap(ROADMAP, p);
    expect(r.md).toContain("**Next up: close M1 once PR 1 merges, with `/done demo milestone M1`; then PR 2, Retry.**");
    p.slices[0]!.live_at = "2026-10-14T10:00:00.000Z";
    expect(syncRoadmap(ROADMAP, p).md).toContain("**Next up: PR 2, Retry.** Start it in a fresh chat with `/pair plan demo`.");
  });

  test("keeps the done line the done skill writes once every PR is live", () => {
    const p = valid();
    for (const s of p.slices) Object.assign(s, { status: "shipped", pr: 4300 + s.n });
    const done = "**Next up: nothing; every PR is live. This roadmap is done.**";
    const md = ROADMAP.replace("(next)", "(live)").replace("(not started)", "(live)").replace(/^\*\*Next up:.*$/m, done);
    const r = syncRoadmap(md, p);
    expect(r.md).toContain(done);
    expect(r.changed).toEqual([]);
    Object.assign(p.slices[1]!, { status: "todo", pr: undefined });
    expect(syncRoadmap(md, p).md).toContain("**Next up: PR 2, Retry.**");
  });

  test("keeps live, reports lines it cannot match, and closes the Next up line when all shipped", () => {
    const p = valid();
    for (const s of p.slices) Object.assign(s, { status: "shipped", pr: 4300 + s.n });
    const md = ROADMAP.replace("(next)", "(live)") + "**PR 3: Extra** (not started)\n";
    const r = syncRoadmap(md, p);
    expect(r.md).toContain("**PR 1: Greeting** (live)");
    expect(r.md).toContain("**PR 2: Retry** (draft #4302)");
    expect(r.md).toContain("**Next up: nothing; every PR in this roadmap is shipped.**");
    expect(r.problems).toEqual(["roadmap PR 3 is not in the ladder"]);
    expect(syncRoadmap("# Demo\n", p).problems).toEqual([
      'ladder PR 1 "Greeting end to end" has no "**PR 1: …** (…)" line in the roadmap',
      'ladder PR 2 "Retry" has no "**PR 2: …** (…)" line in the roadmap',
      'roadmap has no "**Next up: …**" line',
    ]);
    expect(roadmapStatus(p, p.slices[0]!, "live")).toBe("live");
  });
});

describe("git output parsers", () => {
  test("name-status -z with renames and copies", () => {
    expect(parseNameStatus("A\0src/a.ts\0M\0src/b.ts\0D\0old.ts\0R087\0src/x.ts\0src/y.ts\0")).toEqual([
      { kind: "A", path: "src/a.ts" },
      { kind: "M", path: "src/b.ts" },
      { kind: "D", path: "old.ts" },
      { kind: "R", from: "src/x.ts", path: "src/y.ts" },
    ]);
    expect(() => parseNameStatus("U\0src/a.ts\0")).toThrow("resolve conflicts first");
  });

  test("porcelain -z paths include untracked and both sides of a rename", () => {
    expect(parsePorcelainPaths(" M src/a.ts\0?? new.ts\0R  src/y.ts\0src/x.ts\0")).toEqual(["src/a.ts", "new.ts", "src/y.ts", "src/x.ts"]);
  });

  test("shortstat", () => {
    expect(parseShortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)")).toEqual({ ins: 10, del: 2, net: 8 });
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({ ins: 1, del: 0, net: 1 });
    expect(parseShortstat(" 1 file changed, 5 deletions(-)")).toEqual({ ins: 0, del: 5, net: -5 });
    expect(parseShortstat("")).toEqual({ ins: 0, del: 0, net: 0 });
  });

  test("planned paths: exact, directory, glob", () => {
    expect(inPlan("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(inPlan("src/ui/b.tsx", ["src/ui/"])).toBe(true);
    expect(inPlan("src/ui/b.test.ts", ["src/**/*.test.ts"])).toBe(true);
    expect(inPlan("src/b.ts", ["src/a.ts", "src/ui/"])).toBe(false);
  });
});

describe("buildMessage", () => {
  test("groups by change kind, omits empty groups, defaults the optional lines", () => {
    const msg = buildMessage({
      title: "feat(greet): add the greeting module",
      why: "users need a greeting",
      changes: [
        { kind: "A", path: "src/greet.ts", note: "greet(name) returns the text" },
        { kind: "R", from: "src/old.ts", path: "src/index.ts", note: "entry point renamed, calls greet" },
      ],
      checked: "bun run typecheck",
      acs: ["AC-1", "PRD-9167/AC-2"],
    });
    expect(msg).toBe(
      [
        "feat(greet): add the greeting module",
        "",
        "Why: users need a greeting",
        "",
        "Added:",
        "- src/greet.ts: greet(name) returns the text",
        "Modified:",
        "- src/old.ts → src/index.ts: entry point renamed, calls greet",
        "",
        "Alternatives: none considered",
        "Deviation: none",
        "Noticed (out of scope): nothing",
        "Checked with: bun run typecheck",
        "ACs: AC-1, PRD-9167/AC-2",
        "",
      ].join("\n"),
    );
    expect(msg).not.toMatch(/Co-Authored-By|Claude-Session|Generated/i);
  });

  test("explicit alternatives, deviation, noticed; no ACs", () => {
    const msg = buildMessage({ title: "chore: x", why: "w", changes: [{ kind: "D", path: "a", note: "gone" }], alt: "keep it", deviation: "touched b", noticed: "c is slow", checked: "nr test", acs: [] });
    expect(msg).toContain("Deleted:\n- a: gone\n\nAlternatives: keep it\nDeviation: touched b\nNoticed (out of scope): c is slow\nChecked with: nr test\nACs: none\n");
    expect(msg).not.toContain("Added:");
  });
});

describe("timeline and risk", () => {
  test("working days skip weekends, inclusive", () => {
    expect(workingDays(new Date(2026, 9, 9), new Date(2026, 9, 9))).toBe(1);
    expect(workingDays(new Date(2026, 9, 9), new Date(2026, 9, 12))).toBe(2);
    expect(workingDays(new Date(2026, 9, 12), new Date(2026, 9, 9))).toBe(0);
  });

  test("elapsed working days skip weekends", () => {
    expect(elapsedWorkingDays(new Date(2026, 9, 9, 12), new Date(2026, 9, 12, 12))).toBeCloseTo(1, 5);
    expect(elapsedWorkingDays(new Date(2026, 9, 8, 9), new Date(2026, 9, 8, 21))).toBeCloseTo(0.5, 5);
  });

  test("at risk when >80% time used with <80% commits done", () => {
    expect(atRisk(1.7, 2, 2, 4)).toBe(true);
    expect(atRisk(1.7, 2, 4, 5)).toBe(false);
    expect(atRisk(1.6, 2, 0, 4)).toBe(false);
    expect(atRisk(3, 2, 0, 0)).toBe(false);
  });

  test("timeline compares the days left to build with working days to the deadline", () => {
    const p = validatePlan(plan({ deadline: "2026-10-12" }), ctx).plan!;
    expect(timeline(p, new Date(2026, 9, 9))).toMatchObject({ planned: 3, remaining: 3, available: 2, gap: 1, atRisk: true });
    done(p, 2);
    expect(timeline(p, new Date(2026, 9, 9))).toMatchObject({ remaining: 1, atRisk: false });
    expect(timeline({ ...p, deadline: undefined } as Pair, new Date()).available).toBeNull();
  });
});

// ---------- integration: scratch repo with a local bare remote ----------

const SCRATCH = process.env.PAIR_TEST_DIR || tmpdir();
let root = "";
let repo = "";
let state = "";
const BRANCH = "feature/demo-greet";
const ROADMAP_FIXTURE = [
  "# Demo",
  "",
  "**Next up: PR 1, Greeting.** Start it in a fresh chat with `/pair plan demo`.",
  "",
  "## What we are doing and why",
  "People want a greeting.",
  "",
  "**PR 1: Greeting** (next)",
  "Users see a greeting.",
  "",
  "**PR 2: Retry** (not started)",
  "Users can retry.",
  "",
].join("\n");

function sh(cmd: string[], cwd = repo) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const g = (...args: string[]) => sh(["git", ...args]);
function run(opts: { chat?: string | null; slug?: string }, ...args: string[]) {
  const env: Record<string, string | undefined> = { ...process.env, PAIR_STATE_DIR: state, CLAUDE_CODE_SESSION_ID: opts.chat ?? undefined };
  if (opts.chat === null) delete env.CLAUDE_CODE_SESSION_ID;
  const slug = opts.slug === undefined ? ["--slug", "demo"] : opts.slug ? ["--slug", opts.slug] : [];
  const p = Bun.spawnSync(["bun", SCRIPT, ...args, ...slug], { cwd: repo, env });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const pair = (...args: string[]) => run({ chat: "chat-a" }, ...args);
const pairAs = (chat: string, ...args: string[]) => run({ chat }, ...args);
const write = (rel: string, text: string) => {
  mkdirSync(join(repo, rel, ".."), { recursive: true });
  writeFileSync(join(repo, rel), text);
};
const tmpFile = (name: string, text: string) => {
  const f = join(root, `${name}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, text);
  return f;
};
const notes = (map: Record<string, string>) => tmpFile("notes.json", JSON.stringify(map));
const savePlan = (p: unknown, ...extra: string[]) => pair("plan", "save", tmpFile("plan.json", JSON.stringify(p)), ...extra);
const pairJson = (slug = "demo") => JSON.parse(readFileSync(join(state, slug, "pair.json"), "utf8")) as Pair;
const roadmap = () => readFileSync(join(state, "demo", "roadmap.md"), "utf8");
const detail = (n: number) => {
  const { n: _n, title: _t, goal: _g, after: _a, branch: _b, acs: _c, est_days: _e, milestone: _m, ...rest } = plan().slices[n - 1]!;
  return rest;
};
const PLAN_MD = "# PR 1: Greeting\n\n## What this PR does\nPeople see a greeting.\n";

beforeAll(() => {
  mkdirSync(SCRATCH, { recursive: true });
  root = mkdtempSync(join(SCRATCH, "pair-it-"));
  repo = join(root, "repo");
  state = join(root, "state");
  mkdirSync(join(state, "demo"), { recursive: true });
  copyFileSync(SPEC_EXAMPLE, join(state, "demo", "spec.md"));
  writeFileSync(join(state, "demo", "roadmap.md"), ROADMAP_FIXTURE);
  sh(["git", "init", "--bare", "-b", "main", join(root, "remote.git")], root);
  sh(["git", "init", "-b", "main", repo], root);
  g("config", "user.name", "Pair Test");
  g("config", "user.email", "pair-test@example.invalid");
  g("config", "commit.gpgsign", "false");
  write("package.json", JSON.stringify({ name: "demo", private: true, scripts: { typecheck: "bun build ./src/index.ts --target=bun --outdir=.out" } }, null, 2));
  write(".gitignore", ".out/\n");
  write("src/index.ts", 'console.log("hello");\n');
  write("README.md", "# demo\n");
  g("add", "-A");
  g("commit", "-m", "chore: initial");
  g("remote", "add", "origin", join(root, "remote.git"));
  g("push", "-u", "origin", "main");
});
afterAll(() => {
  if (root && !process.env.PAIR_KEEP) rmSync(root, { recursive: true, force: true });
});

describe("scratch repo", () => {
  let rawDocsSha = "";

  test("plan save rejects invalid plans with one line per problem", () => {
    const r = savePlan(withSlice({ budget: { net_lines: 600 }, acs: ["AC-9"] }));
    expect(r.code).toBe(1);
    expect(r.err).toContain('pair: slice 1 "Greeting end to end": budget 600 net lines is over the 500 limit; split the slice');
    expect(r.err).toContain('pair: slice 1 "Greeting end to end": AC-9 is not in the spec');
    const prefix = savePlan(withSlice({ branch: "demo-greet" }));
    expect(prefix.code).toBe(1);
    expect(prefix.err).toContain("branches would not pass br stack");
    expect(existsSync(join(state, "demo", "pair.json"))).toBe(false);
  });

  test("plan save refuses a DB command as a check and stores nothing", () => {
    const r = savePlan(withSlice({ commits: [{ ...plan().slices[0]!.commits[0]!, check: "nr db:migrate" }], green_check: "psql -c 'select 1'" }));
    expect(r.code).toBe(1);
    expect(r.err).toContain('pair: slice 1 "Greeting end to end": commit 1: check `nr db:migrate` is refused by the DB guard (package script `db:migrate`)');
    expect(r.err).toContain("green_check: check `psql -c 'select 1'` is refused by the DB guard (`psql` database CLI)");
    expect(existsSync(join(state, "demo", "pair.json"))).toBe(false);
  });

  test("brainstorm's rough ladder saves; plan show and status read it; the roadmap already matches", () => {
    const r = savePlan(roughPlan());
    expect(r.code).toBe(0);
    expect(r.out).toContain("new plan: 2 PRs, 3 commits");
    expect(pairJson().repo).toBe(sh(["pwd", "-P"]));
    expect(JSON.parse(readFileSync(join(state, "demo", "stack.json"), "utf8")).branches[0]).toEqual({ name: BRANCH, title: "Greeting end to end" });
    const show = pair("plan", "show");
    expect(show.code).toBe(0);
    expect(show.out).toContain("PR 1: Greeting end to end (not planned yet)");
    expect(show.out).toContain("AC-4 → PR 2");
    expect(show.out).toMatch(/timeline: 3d left to build of 3d planned/);
    expect(roadmap()).toBe(ROADMAP_FIXTURE);
    const next = JSON.parse(pair("next", "--json").out);
    expect(next).toMatchObject({ action: "plan", slice: { n: 1, gaps: ["no test script", "commit 1 has no files, check, est_lines", "commit 2 has no files, check, est_lines"] } });
  });

  test("a PR cannot start before its plan is approved and saved", () => {
    const r = pair("slice", "start", "1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("PR 1 has no approved plan yet (no test script; commit 1 has no files, check, est_lines");
    expect(r.err).toContain("/pair plan demo");
  });

  test("plan save --slice stores the approved plan: details, pr-<n>-plan.md, approval, claim, roadmap", () => {
    const slice = tmpFile("slice.json", JSON.stringify(detail(1)));
    expect(pair("plan", "save", slice, "--slice", "1").err).toContain("--plan <plan.md> is required with --slice");
    expect(pair("plan", "save", tmpFile("plan.json", JSON.stringify(plan())), "--slice", "1", "--plan", tmpFile("p.md", PLAN_MD)).err).toContain("--slice takes one PR's JSON object");
    const thin = { ...detail(1), commits: detail(1).commits.map(({ check: _c, ...c }) => c) };
    const incomplete = pair("plan", "save", tmpFile("slice.json", JSON.stringify(thin)), "--slice", "1", "--plan", tmpFile("p.md", PLAN_MD));
    expect(incomplete.code).toBe(1);
    expect(incomplete.err).toContain("PR 1's plan is incomplete: commit 1 has no check; commit 2 has no check");
    const ok = pair("plan", "save", slice, "--slice", "1", "--plan", tmpFile("p.md", PLAN_MD));
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("PR 1: plan approved and saved to");
    expect(ok.out).toContain("/pair implement demo");
    const s = pairJson().slices[0]!;
    expect(s.plan_file).toBe(join(state, "demo", "pr-1-plan.md"));
    expect(readFileSync(s.plan_file!, "utf8")).toBe(PLAN_MD);
    expect(typeof s.plan_approved_at).toBe("string");
    expect(s.sessions).toEqual(["chat-a"]);
    expect(s.commits[0]).toMatchObject({ files: ["src/greet.ts", "src/index.ts"], check: "bun run typecheck", est_lines: 30 });
    expect(s.status).toBe("todo");
    expect(roadmap()).toContain("**PR 1: Greeting** (plan approved)");
    expect(roadmap()).toContain("**Next up: PR 1, Greeting.** Start it in a fresh chat with `/pair implement demo`.");
    expect(pair("status").out).toContain('PR 1: plan approved, not built ("Greeting end to end")');
  });

  test("the planning chat is refused another PR; a fresh chat finds the approved plan with /pair implement", () => {
    const other = pair("plan", "save", tmpFile("slice.json", JSON.stringify(detail(2))), "--slice", "2", "--plan", tmpFile("p.md", PLAN_MD));
    expect(other.code).toBe(1);
    expect(other.err).toContain('this chat is on PR 1 "Greeting end to end"; one PR per chat');
    const start2 = pair("slice", "start", "2");
    expect(start2.code).toBe(1);
    expect(start2.err).toContain("Start PR 2 \"Retry\" in a fresh chat with /pair plan demo 2");
    const refuse = JSON.parse(pair("next", "2", "--json").out);
    expect(refuse).toMatchObject({ action: "refuse", slice: { n: 2 }, held: [1] });
    expect(JSON.parse(pairAs("chat-b", "next", "--implement", "--json").out)).toMatchObject({ action: "build", slice: { n: 1, plan_file: join(state, "demo", "pr-1-plan.md") } });
    expect(JSON.parse(pairAs("chat-z", "next", "--json").out)).toMatchObject({ action: "build", slice: { n: 1 } });
  });

  test("slice start claims the PR and prints the br command", () => {
    const r = pair("slice", "start", "1");
    expect(r.code).toBe(0);
    expect(r.out).toContain('PR 1 "Greeting end to end" is in progress; next commit: 1 feat(greet): add the greeting module');
    expect(r.out).toContain(`br new ${BRANCH} --here --base origin/main`);
    expect(pairJson().slices[0]!.status).toBe("active");
    g("switch", "-c", BRANCH, "origin/main");
  });

  test("commit refuses: nothing staged, out-of-plan file, missing note, DB check", () => {
    expect(pair("commit", "--why", "w", "--notes", notes({})).err).toContain("nothing staged");
    write("src/greet.ts", 'export const greet = (name: string) => `hello ${name}`;\n');
    write("README.md", "# demo\nmore\n");
    g("add", "src/greet.ts", "README.md");
    expect(pair("commit", "--why", "w", "--notes", notes({ "src/greet.ts": "n", "README.md": "n" })).err).toContain("staged files outside the planned commit: README.md");
    g("restore", "--staged", "README.md");
    g("checkout", "README.md");
    expect(pair("commit", "--why", "w", "--notes", notes({ "src/other.ts": "n" })).err).toContain("no note for staged path(s): src/greet.ts");
    const db = pair("commit", "--why", "w", "--notes", notes({ "src/greet.ts": "n" }), "--checked", "nr typecheck && nr db:migrate");
    expect(db.code).toBe(1);
    expect(db.err).toContain("check `nr typecheck && nr db:migrate` is refused by the DB guard (package script `db:migrate`)");
    expect(g("rev-list", "--count", "HEAD")).toBe("1");
  });

  test("first planned commit lands and the roadmap shows the progress", () => {
    write("src/index.ts", 'import { greet } from "./greet";\nconsole.log(greet("world"));\n');
    g("add", "src/index.ts", "src/greet.ts");
    const c1 = pair("commit", "--why", "the core behaviour the user tests first", "--notes", notes({ "src/greet.ts": "greet(name) builds the greeting", "src/index.ts": 'prints greet("world")' }), "--alt", "inline the string in index.ts");
    expect(c1.code).toBe(0);
    expect(c1.out).toContain("next: commit 2 feat(greet): add a farewell");
    const first = g("log", "-1", "--format=%B");
    expect(first).toContain('Added:\n- src/greet.ts: greet(name) builds the greeting\nModified:\n- src/index.ts: prints greet("world")');
    expect(roadmap()).toContain("**PR 1: Greeting** (in progress, 1 of 2 commits)");
    expect(roadmap()).toContain("Start it in a fresh chat with `/pair implement demo`.");
  });

  test("a fresh chat takes over the half-built PR from its next commit, and is still refused another PR", () => {
    expect(JSON.parse(pairAs("chat-b", "next", "--implement", "--json").out)).toMatchObject({ action: "build", slice: { n: 1 }, held: [] });
    const start = pairAs("chat-b", "slice", "start", "1");
    expect(start.code).toBe(0);
    expect(start.out).toContain("next commit: 2 feat(greet): add a farewell");
    expect(pairJson().slices[0]!.sessions).toEqual(["chat-a", "chat-b"]);
    write("src/farewell.ts", "export const farewell = () => 'bye';\n");
    g("add", "src/farewell.ts");
    const c2 = pairAs("chat-b", "commit", "--why", "second behaviour", "--notes", notes({ "src/farewell.ts": "farewell() text" }), "--checked", "bun run typecheck && bun src/index.ts");
    expect(c2.code).toBe(0);
    expect(c2.out).toContain("PR 1 is at its checkpoint");
    const msg = g("log", "-1", "--format=%B");
    expect(msg).toContain("feat(greet): add a farewell\n\nWhy: second behaviour\n\nAdded:\n- src/farewell.ts: farewell() text\n\nAlternatives: none considered");
    expect(msg).toContain("Checked with: bun run typecheck && bun src/index.ts\nACs: AC-2");
    const p = pairJson();
    expect(p.slices[0]!.status).toBe("checkpoint");
    expect(p.slices[0]!.commits.map((c) => c.status)).toEqual(["done", "done"]);
    expect(p.slices[0]!.commits[1]!.sha).toBe(g("rev-parse", "HEAD"));
    expect(pairAs("chat-b", "slice", "start", "2").err).toContain('this chat is on PR 1 "Greeting end to end"');
    expect(JSON.parse(pairAs("chat-b", "next", "--json").out).action).toBe("checkpoint");
    expect(JSON.parse(pairAs("chat-c", "next", "--json").out).action).toBe("ship");
  });

  test("without a session id the claim is not enforced and says so", () => {
    const r = run({ chat: null }, "next", "--json");
    expect(r.code).toBe(0);
    expect(r.err).toContain("CLAUDE_CODE_SESSION_ID is not set, so one PR per chat is not enforced");
    expect(JSON.parse(r.out).action).toBe("checkpoint");
  });

  test("check exits 2 on an out-of-plan file and on budget overflow", () => {
    write("README.md", "# demo\nchanged\n");
    const r = pair("check");
    expect(r.code).toBe(2);
    expect(r.out).toContain("README.md");
    g("checkout", "README.md");
    write("src/greet.ts", Array.from({ length: 260 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    const over = pair("check", "--json");
    expect(over.code).toBe(2);
    expect(JSON.parse(over.out)).toMatchObject({ ok: false, over: true, outOfPlan: [], budget: 200 });
    g("checkout", "src/greet.ts");
    expect(pair("check").code).toBe(0);
  });

  test("status --json tells the states apart and stores net lines", () => {
    const r = pair("status", "--json");
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out);
    expect(s.slice).toMatchObject({ n: 1, of: 2, status: "checkpoint", branch: BRANCH, head: BRANCH });
    expect(s.commits).toEqual({ done: 2, planned: 2, extra: 0 });
    expect(s.net_lines).toBe(3);
    expect(s.slices.map((x: { stage: string }) => x.stage)).toEqual(["checkpoint", "todo"]);
    expect(s.slices[0].commits).toEqual({ done: 2, planned: 2, extra: 0 });
    expect(s.next).toEqual({ n: 1, title: "Greeting end to end", stage: "checkpoint", starter: "/pair implement demo" });
    expect(s.chat).toEqual([1]);
    expect(pairJson().slices[0]!.net_lines).toBe(3);
  });

  test("green passes with SHAs unchanged", () => {
    const before = g("rev-parse", "HEAD");
    const r = pair("green");
    expect(r.code).toBe(0);
    expect(r.out).toContain("green: all 2 commit(s) of PR 1 pass");
    expect(g("rev-parse", "HEAD")).toBe(before);
  });

  test("green refuses a DB check written into pair.json by hand, before running anything", () => {
    const file = join(state, "demo", "pair.json");
    const saved = readFileSync(file, "utf8");
    const p = JSON.parse(saved) as Pair;
    p.slices[0]!.commits[0]!.check = "psql -c 'select 1'";
    writeFileSync(file, JSON.stringify(p));
    const before = g("rev-parse", "HEAD");
    try {
      const r = pair("green");
      expect(r.code).toBe(1);
      expect(r.err).toContain("is refused by the DB guard (`psql` database CLI)");
      expect(r.out).not.toContain("green:");
      expect(g("rev-parse", "HEAD")).toBe(before);
    } finally {
      writeFileSync(file, saved);
    }
  });

  test("green fails on a broken first commit, aborts, SHAs unchanged", () => {
    const good = g("rev-parse", "HEAD");
    g("reset", "--hard", "origin/main");
    write("src/index.ts", 'import { greet } from "./greet";\nconsole.log(greet("world")\n');
    write("src/greet.ts", "export const greet = (n: string) => n;\n");
    g("add", "src");
    g("commit", "-m", "feat(greet): broken");
    write("src/index.ts", 'import { greet } from "./greet";\nconsole.log(greet("world"));\n');
    g("add", "src");
    g("commit", "-m", "fix(greet): repair");
    const broken = g("rev-parse", "HEAD");
    const r = pair("green");
    expect(r.code).toBe(1);
    expect(r.out).toContain("not green: commit 1/2");
    expect(r.out).toContain("feat(greet): broken fails `bun run typecheck`");
    expect(r.out).toContain("rebase aborted; HEAD back at");
    expect(g("rev-parse", "HEAD")).toBe(broken);
    expect(g("status", "--porcelain")).toBe("");
    g("reset", "--hard", good);
  });

  test("walk lists deviations first, including an unplanned commit", () => {
    write("README.md", "# demo\nunplanned\n");
    g("commit", "-am", "docs: tweak readme");
    rawDocsSha = g("rev-parse", "HEAD");
    write("src/greet.ts", 'export const greet = (name: string) => `hi ${name}`;\n');
    g("add", "src/greet.ts");
    const extra = pair("commit", "--title", "refactor(greet): shorter greeting", "--why", "simplify pass", "--notes", notes({ "src/greet.ts": "hi instead of hello" }), "--deviation", "wording change not in the plan");
    expect(extra.code).toBe(0);
    const w = pair("walk");
    expect(w.code).toBe(0);
    const [head, rest] = [w.out.split("=== 1/")[0]!, w.out];
    expect(head).toContain(`Approved plan: ${join(state, "demo", "pr-1-plan.md")}`);
    expect(head).toContain("Deviations:");
    expect(head).toContain("docs: tweak readme: unplanned commit, no reasoning recorded");
    expect(head).toContain("refactor(greet): shorter greeting: Deviation: wording change not in the plan");
    expect(rest).toContain("=== 3/4");
    expect(rest).toContain("[UNPLANNED]");
    expect(rest).toContain("src/greet.ts | 2 +-");
    expect(pairJson().slices[0]!.commits[2]).toMatchObject({ title: "refactor(greet): shorter greeting", extra: true, status: "done" });
  });

  test("slice ship records the PR, syncs the roadmap and names the next starter", () => {
    expect(pair("slice", "ship", "1").err).toContain("--pr <number> is required");
    const r = pair("slice", "ship", "1", "--pr", "101", "--json");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.message).toBe('PR 1 is open as draft #101 and marked shipped in the roadmap. Next is PR 2, Retry (starter: /pair plan demo).');
    expect(out.next).toEqual({ n: 2, title: "Retry", starter: "/pair plan demo" });
    expect(pairJson().slices[0]).toMatchObject({ status: "shipped", pr: 101 });
    expect(roadmap()).toContain("**PR 1: Greeting** (draft #101)");
    expect(roadmap()).toContain("**PR 2: Retry** (next)");
    expect(roadmap()).toContain("**Next up: PR 2, Retry.** Start it in a fresh chat with `/pair plan demo`.");
    expect(roadmap()).toContain("People want a greeting.\n");
  });

  test("after ship the chat only takes fixes to its PR", () => {
    expect(JSON.parse(pair("next", "--json").out)).toMatchObject({ action: "fixes", slice: { n: 1, pr: 101 }, next: { n: 2 } });
    expect(pair("next").out).toContain("This chat only takes fixes to it and roadmap updates. Next is PR 2, \"Retry\": start it in a fresh chat with /pair plan demo");
    expect(pair("slice", "start", "2").err).toContain("one PR per chat");
    write("src/greet.ts", 'export const greet = (name: string) => `hi, ${name}`;\n');
    g("add", "src/greet.ts");
    const fix = pair("commit", "--title", "fix(greet): add the comma reviewers asked for", "--why", "review feedback", "--notes", notes({ "src/greet.ts": "comma after hi" }));
    expect(fix.code).toBe(0);
    expect(fix.out).toContain("PR 1 is shipped as #101; push the fix through /ship (update mode) after the user's OK");
    expect(pairJson().slices[0]!.status).toBe("shipped");
    expect(JSON.parse(pairAs("chat-n", "next", "--json").out)).toMatchObject({ action: "plan", slice: { n: 2 } });
  });

  test("slice live records a merged PR as live and refuses one without a PR", () => {
    const early = pair("slice", "live", "2");
    expect(early.code).toBe(1);
    expect(early.err).toContain("PR 2 is not shipped yet");
    const r = pair("slice", "live", "1", "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ slices: [1], live: [], message: "PR 1 is live." });
    expect(typeof pairJson().slices[0]!.live_at).toBe("string");
    expect(roadmap()).toContain("**PR 1: Greeting** (live)");
  });

  test("walk --commit resolves the PR from the sha with no PR in progress and HEAD off every PR branch", () => {
    g("switch", "main");
    try {
      expect(pairJson().slices.some((s) => s.status === "active" || s.status === "checkpoint")).toBe(false);
      const w = pair("walk", "--commit", rawDocsSha.slice(0, 10));
      expect(w.code).toBe(0);
      expect(w.out).toContain('Walkthrough: PR 1 "Greeting end to end"');
      expect(w.out).toContain("docs: tweak readme: unplanned commit, no reasoning recorded");
      const stray = pair("walk", "--commit", g("rev-parse", "HEAD"));
      expect(stray.code).toBe(1);
      expect(stray.err).toContain("is on no PR branch of the ladder");
    } finally {
      g("switch", BRANCH);
    }
  });

  test("inserting a PR keeps the shipped one by branch; a rough re-save keeps the approved details", () => {
    const raw = roughPlan();
    raw.slices.unshift({ ...raw.slices[1]!, title: "Logging", branch: "feature/demo-logging", acs: ["AC-4"] });
    raw.slices.forEach((s, i) => (s.n = i + 1));
    const r = savePlan(raw);
    expect(r.code).toBe(0);
    expect(r.out).toContain('~ PR 1 "Greeting end to end" is now PR 2');
    const s = pairJson().slices[1]!;
    expect(s).toMatchObject({ branch: BRANCH, status: "shipped", pr: 101, sessions: ["chat-a", "chat-b"] });
    expect(s.commits.map((c) => c.status)).toEqual(["done", "done", "done", "done"]);
    expect(s.commits[0]!.files).toEqual(["src/greet.ts", "src/index.ts"]);
    expect(s.test_script).toEqual(["bun src/index.ts", "see the greeting"]);
    expect(r.err).toContain("ladder PR 3");
  });

  test("roadmaps lists this repo's initiatives with an unshipped PR and their starter", () => {
    const r = pair("roadmaps", "--json");
    expect(r.code).toBe(0);
    const demo = JSON.parse(r.out).roadmaps.find((x: { slug: string }) => x.slug === "demo");
    expect(demo).toMatchObject({ next: { n: 1, title: "Logging" }, starter: "/pair plan demo" });
    expect(demo.next_up).toContain("**Next up: PR 1");
  });
});

describe("legacy ladder", () => {
  const legacy = () => {
    const p = JSON.parse(JSON.stringify(validatePlan(plan(), ctx).plan!)) as Pair & { mode?: string };
    p.mode = "on";
    p.slug = "legacy";
    p.repo = repo;
    p.slices.push({ ...JSON.parse(JSON.stringify(p.slices[1]!)), n: 3, title: "Third", branch: "feature/demo-third" });
    for (const s of p.slices) delete (s as Partial<typeof s>).merge_point;
    p.slices[0]!.status = "done";
    p.slices[0]!.commits.forEach((c) => (c.status = "done"));
    p.slices[1]!.status = "done";
    p.slices[1]!.commits.forEach((c) => (c.status = "done"));
    p.slices[2]!.status = "done";
    return p;
  };

  test("an older pair.json loads, warns to ship the lowest built PR first, and re-saves without mode", () => {
    mkdirSync(join(state, "legacy"), { recursive: true });
    writeFileSync(join(state, "legacy", "pair.json"), JSON.stringify(legacy(), null, 2));
    const show = run({ chat: "chat-l", slug: "legacy" }, "plan", "show");
    expect(show.code).toBe(0);
    expect(show.err).toContain("2 PRs are built but not shipped (PR 1, PR 2); ship PR 1 first, one PR per chat");
    expect(show.out).toContain("PR 3: Third (not planned yet)");
    const next = JSON.parse(run({ chat: "chat-l", slug: "legacy" }, "next", "--json").out);
    expect(next).toMatchObject({ action: "ship", slice: { n: 1 } });
    const st = JSON.parse(run({ chat: "chat-l", slug: "legacy" }, "status", "--json").out);
    expect(st.slices.map((x: { stage: string }) => x.stage)).toEqual(["checkpoint", "checkpoint", "todo"]);
    expect(st.warnings).toContain("2 PRs are built but not shipped (PR 1, PR 2); ship PR 1 first, one PR per chat");
    const jump = run({ chat: "chat-l", slug: "legacy" }, "next", "3");
    expect(jump.err).toContain("earlier PRs are not shipped yet (PR 1, PR 2)");
    const start = run({ chat: "chat-m", slug: "legacy" }, "slice", "start", "1");
    expect(start.code).toBe(0);
    expect(start.out).toContain("PR 1 is built; next: green, the walkthrough, then /ship");
    const resave = run({ chat: "chat-m", slug: "legacy" }, "plan", "save", join(state, "legacy", "pair.json"));
    expect(resave.code).toBe(0);
    const saved = pairJson("legacy") as Pair & { mode?: string };
    expect("mode" in saved).toBe(false);
    expect(saved.slices.map((s) => s.merge_point)).toEqual([true, true, true]);
    expect(saved.slices[0]!.sessions).toEqual(["chat-m"]);
  });
});
