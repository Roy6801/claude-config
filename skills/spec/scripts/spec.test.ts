import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "spec.ts");
const EXAMPLES = join(import.meta.dir, "..", "references", "examples");
const TICKET = readFileSync(join(EXAMPLES, "ticket.md"), "utf8");
const PRD = readFileSync(join(EXAMPLES, "prd.md"), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "spec-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", SCRIPT, ...args], { env: { ...process.env, ...env } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

let n = 0;
function file(text: string) {
  const f = join(tmp, `spec-${n++}.md`);
  writeFileSync(f, text);
  return f;
}

function mutate(src: string, from: string | RegExp, to: string) {
  const out = src.replace(from, to);
  if (out === src) throw new Error(`fixture mutation did not apply: ${from}`);
  return out;
}

describe("check", () => {
  test("valid ticket and prd examples pass", () => {
    expect(run(["check", join(EXAMPLES, "ticket.md")]).code).toBe(0);
    expect(run(["check", join(EXAMPLES, "prd.md")]).code).toBe(0);
  });

  const broken: [string, string, string][] = [
    ["missing Source", mutate(PRD, '- Source: #123 description: "admins need to load a full chapter at once"\n', ""), 'AC-1: missing "Source:"'],
    ["placeholder Source", mutate(PRD, /- Source: #123 description: .*\n/, "- Source: TBD\n"), 'AC-1: Source "TBD" is a placeholder'],
    ["duplicate id", mutate(PRD, "### AC-2 [error]", "### AC-1 [error]"), "AC-1: duplicate id"],
    ["id gap", mutate(PRD, "### AC-3 [edge]", "### AC-4 [edge]"), "ids must be sequential"],
    ["behaviour AC without Then", mutate(PRD, /- Then the bank shows 170.*\n/, ""), 'AC-1: behaviour AC missing "Then"'],
    ["no edge/error tag", mutate(TICKET, "[error] A failed", "[happy] A failed").replace("[edge] A rejected", "[happy] A rejected"), "no [edge] or [error] AC"],
    ["missing prd-only section", mutate(PRD, /## Demo milestones\n[\s\S]*?\n## Release notes/, "## Release notes"), 'missing section "## Demo milestones" (required for size: prd)'],
    ["file name in AC text", mutate(PRD, "Then neither sees the Import button", "Then importQuestions() is not exposed"), "AC-4: AC text names a file, function or line"],
    ["struck without reason", mutate(PRD, /- Superseded: user, 2026-10-09: merging.*\n/, ""), "AC-6: struck through without"],
    ["missing Asked/Real", mutate(TICKET, /^Asked: .*\n/m, ""), 'Problem: needs both "Asked:" and "Real:"'],
    ["missing Rollback", mutate(PRD, /- Rollback: .*\n/, ""), 'Release notes: missing "Rollback:" line'],
    ["bad size", mutate(TICKET, "size: ticket", "size: medium"), "size must be ticket or prd"],
    ["prd link on a ticket-size spec", mutate(TICKET, "ticket: #481", "ticket: #481\nprd: https://example.com/doc"), "prd is only allowed with size: prd"],
    ["unknown front matter key", mutate(TICKET, "ticket: #481", "owner: sonu"), 'unknown key "owner"'],
  ];
  for (const [name, text, expected] of broken) {
    test(`fails: ${name}`, () => {
      const r = run(["check", file(text)]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(expected);
    });
  }

  test("a Waived line replaces the edge/error requirement", () => {
    const noEdge = TICKET.replace("[error] A failed", "[happy] A failed").replace("[edge] A rejected", "[happy] A rejected");
    const waived = mutate(noEdge, "## Non-goals", "Waived: no failure path beyond AC-1, user 2026-10-09\n\n## Non-goals");
    expect(run(["check", file(waived)]).code).toBe(0);
  });

  test("--json reports problems as an array", () => {
    const r = run(["check", file(PRD.replace("### AC-2 [error]", "### AC-1 [error]")), "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).problems.length).toBeGreaterThan(0);
  });
});

describe("acs", () => {
  test("emits every AC with its fields", () => {
    const r = run(["acs", join(EXAMPLES, "prd.md"), "--json"]);
    expect(r.code).toBe(0);
    const acs = JSON.parse(r.out);
    expect(acs.map((a: { id: string }) => a.id)).toEqual(["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8"]);
    expect(acs[0].when).toBe("they upload a 50-row CSV that matches the template and confirm the preview");
    expect(acs[5]).toMatchObject({ superseded: true, tags: ["edge"] });
    expect(acs[7]).toMatchObject({ kind: "check", given: null });
  });

  test("resolves a slug under the work dir", () => {
    const work = join(tmp, "work");
    mkdirSync(join(work, "bulk-question-import"), { recursive: true });
    writeFileSync(join(work, "bulk-question-import", "spec.md"), PRD);
    const r = run(["acs", "bulk-question-import", "--json"], { SPEC_WORK_DIR: work });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toHaveLength(8);
  });

  test("refuses an invalid spec", () => {
    expect(run(["acs", file(PRD.replace(/- Verify: manual on staging with the 50-row.*\n/, ""))]).code).toBe(1);
  });
});

describe("status", () => {
  test("round trip draft -> approved -> draft", () => {
    const f = file(TICKET);
    expect(run(["status", f, "approved"]).code).toBe(0);
    expect(readFileSync(f, "utf8")).toContain("status: approved");
    expect(readFileSync(f, "utf8").replace("status: approved", "status: draft")).toBe(TICKET);
    expect(run(["status", f, "draft"]).code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(TICKET);
  });

  test("will not approve a spec that fails check", () => {
    const f = file(TICKET.replace("### AC-2 [happy]", "### AC-1 [happy]"));
    expect(run(["status", f, "approved"]).code).toBe(1);
    expect(readFileSync(f, "utf8")).toContain("status: draft");
  });
});
