import { describe, expect, test } from "bun:test";
import { attachmentProblems, attributionProblems, chooseBase, findTemplate, isExcluded, planUpsert, sizeOf } from "./pr.ts";

describe("findTemplate", () => {
  test("no template", () => {
    expect(findTemplate(["README.md", ".github/workflows/ci.yml"])).toEqual({ path: null, choices: [] });
  });

  test(".github wins over docs and root, any case", () => {
    const r = findTemplate(["pull_request_template.md", "docs/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md"]);
    expect(r.path).toBe(".github/PULL_REQUEST_TEMPLATE.md");
  });

  test("docs wins over root", () => {
    expect(findTemplate(["PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md"]).path).toBe("docs/pull_request_template.md");
  });

  test("a template directory with one file is that file", () => {
    expect(findTemplate([".github/PULL_REQUEST_TEMPLATE/default.md"]).path).toBe(".github/PULL_REQUEST_TEMPLATE/default.md");
  });

  test("a template directory with several files asks for a choice", () => {
    const r = findTemplate([".github/pull_request_template/fix.md", ".github/pull_request_template/feature.md"]);
    expect(r).toEqual({ path: null, choices: [".github/pull_request_template/feature.md", ".github/pull_request_template/fix.md"] });
  });

  test("a single .github file wins over a template directory", () => {
    expect(findTemplate([".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE/a.md", ".github/PULL_REQUEST_TEMPLATE/b.md"]).path).toBe(
      ".github/pull_request_template.md",
    );
  });

  test("nested or non-markdown files do not count", () => {
    expect(findTemplate(["packages/app/pull_request_template.md", ".github/pull_request_template.txt"]).path).toBeNull();
  });
});

describe("sizeOf", () => {
  test("counts added and deleted; net is added minus deleted", () => {
    const s = sizeOf("10\t2\tsrc/a.ts\n5\t0\tsrc/a.test.ts\n");
    expect(s).toMatchObject({ files: 2, added: 15, deleted: 2, net: 13, over: false });
  });

  test("excludes lockfiles, generated files, changesets and snapshots", () => {
    const s = sizeOf(["900\t0\tbun.lock", "800\t3\tpnpm-lock.yaml", "700\t0\tpackage-lock.json", "50\t0\tsrc/api.gen.ts", "4\t0\t.changeset/brave-cat.md", "30\t0\tsrc/__snapshots__/a.test.ts.snap", "12\t1\tsrc/a.ts"].join("\n"));
    expect(s.files).toBe(1);
    expect(s.net).toBe(11);
    expect(s.excluded).toHaveLength(6);
  });

  test("binary files count as files with no lines", () => {
    expect(sizeOf("-\t-\tpublic/logo.png")).toMatchObject({ files: 1, added: 0, net: 0 });
  });

  test("over budget only when net exceeds it", () => {
    expect(sizeOf("500\t0\ta.ts").over).toBe(false);
    expect(sizeOf("501\t0\ta.ts").over).toBe(true);
    expect(sizeOf("700\t300\ta.ts").over).toBe(false);
    expect(sizeOf("60\t0\ta.ts", 50).over).toBe(true);
  });

  test("renames are judged by their new path", () => {
    expect(sizeOf("3\t1\tsrc/{old => gen}/x.gen.ts").excluded).toEqual(["src/gen/x.gen.ts"]);
    expect(sizeOf("3\t1\told.ts => new.ts").files).toBe(1);
    expect(isExcluded("yarn.lock")).toBe(true);
    expect(isExcluded("src/lock.ts")).toBe(false);
  });
});

describe("chooseBase", () => {
  const pr = { number: 7, url: "u", isDraft: true, base: "feature/parent", title: "t" };
  const target = { branch: "staging", evidence: "27 of 30 merged PRs" };
  test("open PR base first", () => {
    expect(chooseBase(pr, { parent: "x" }, target)).toMatchObject({ branch: "feature/parent", source: "open-pr" });
  });
  test("then the gh stack parent", () => {
    expect(chooseBase(null, { parent: "feature/below" }, target)).toMatchObject({ branch: "feature/below", source: "gh-stack" });
  });
  test("then the integration target", () => {
    expect(chooseBase(null, null, target)).toMatchObject({ branch: "staging", source: "integration-target" });
  });
  test("nothing resolves", () => {
    expect(chooseBase(null, null, null)).toBeNull();
  });
});

describe("planUpsert", () => {
  const base = { repo: "o/r", branch: "feat/x", title: "feat: x", bodyFile: "/tmp/b.md", base: "staging", pr: null, inStack: false, remoteHead: true };
  const pr = { number: 9, url: "u", isDraft: true, base: "staging", title: "old" };

  test("creates a draft PR", () => {
    const p = planUpsert(base);
    expect(p.action).toBe("create");
    expect(p.argv).toContain("--draft");
    expect(p.argv.join(" ")).toContain("--head feat/x --base staging");
  });

  test("assigns the PR to the user on create and update", () => {
    expect(planUpsert(base).argv.join(" ")).toContain("--assignee @me");
    expect(planUpsert({ ...base, pr }).argv.join(" ")).toContain("--add-assignee @me");
  });

  test("never marks ready", () => {
    expect(planUpsert(base).argv).not.toContain("--ready");
    expect(planUpsert({ ...base, pr }).argv).not.toContain("--ready");
  });

  test("refuses to create before the branch is pushed", () => {
    expect(() => planUpsert({ ...base, remoteHead: false })).toThrow(/push first/);
  });

  test("dry run on an unpushed branch still plans the create, with a push note", () => {
    const p = planUpsert({ ...base, remoteHead: false, dryRun: true });
    expect(p.action).toBe("create");
    expect(p.argv.slice(0, 2)).toEqual(["pr", "create"]);
    expect(p.notes.join(" ")).toMatch(/push it first/);
  });

  test("refuses to create without a base, or onto itself", () => {
    expect(() => planUpsert({ ...base, base: null })).toThrow(/no base/);
    expect(() => planUpsert({ ...base, base: "feat/x" })).toThrow(/both/);
  });

  test("edits an existing PR and keeps its base by default", () => {
    const p = planUpsert({ ...base, base: null, pr });
    expect(p.action).toBe("edit");
    expect(p.argv.slice(0, 3)).toEqual(["pr", "edit", "9"]);
    expect(p.argv).not.toContain("--base");
    expect(p.argv).not.toContain("--draft");
  });

  test("retargets an existing PR only outside a gh stack", () => {
    expect(planUpsert({ ...base, base: "main", pr }).argv).toContain("--base");
    expect(() => planUpsert({ ...base, base: "main", pr, inStack: true })).toThrow(/gh stack/);
  });

  test("a ready PR is edited without touching its draft state", () => {
    const p = planUpsert({ ...base, pr: { ...pr, isDraft: false } });
    expect(p.notes.join()).toMatch(/draft state is untouched/);
    expect(p.argv.some((a) => /draft|ready/.test(a))).toBe(false);
  });
});

describe("attachments", () => {
  const base = { repo: "o/r", branch: "feat/x", title: "feat: x", bodyFile: "/tmp/b.md", base: "staging", pr: null, inStack: false, remoteHead: true };
  const pr = { number: 9, url: "u", isDraft: false, base: "staging", title: "old" };

  test("passes each attachment to gh on create and edit", () => {
    const attach = ["./before.png#Before", "./after.png"];
    expect(planUpsert({ ...base, attach }).argv.join(" ")).toContain("--attach ./before.png#Before --attach ./after.png");
    expect(planUpsert({ ...base, pr, attach }).argv.join(" ")).toContain("--attach ./before.png#Before --attach ./after.png");
  });

  test("adds no attach flags when there are none", () => {
    expect(planUpsert(base).argv).not.toContain("--attach");
    expect(planUpsert({ ...base, pr }).argv).not.toContain("--attach");
  });

  test("needs every attachment referenced in the body next to the body file", () => {
    const body = "## Evidence\n\n![Before](./before.png)\n";
    expect(attachmentProblems(body, ["./before.png#Before"])).toEqual([]);
    expect(attachmentProblems(body, ["./after.png"])[0]).toMatch(/never references/);
    expect(attachmentProblems(body, ["/tmp/shots/before.png"])[0]).toMatch(/use \.\/<file>/);
    expect(attachmentProblems(body, ["shots/before.png"])[0]).toMatch(/use \.\/<file>/);
  });
});

describe("attributionProblems", () => {
  test("flags session links and AI attribution", () => {
    expect(attributionProblems("see https://claude.ai/code/session_01abc")).toHaveLength(1);
    expect(attributionProblems("Generated with Claude Code")).toHaveLength(1);
    expect(attributionProblems("Co-Authored-By: Claude <noreply@anthropic.com>")).toHaveLength(1);
  });
  test("passes a normal body", () => {
    expect(attributionProblems("## Why\nUsers lose uploads on flaky networks.")).toEqual([]);
  });
});
