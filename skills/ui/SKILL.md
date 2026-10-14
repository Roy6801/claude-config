---
name: ui
description: |
  Route UI work across the installed design skills and integrations: detects Figma, browser, stack, and design context, then picks which skill and mode runs at each step (plan, build, verify, review) and enforces the gates between them. Owns workflow and routing only; domain expertise stays in `impeccable`, `web-design-guidelines`, the Figma plugin skills, and the stack skills.

  Use when: designing, building, or reviewing a screen, component, or flow; implementing from a figma.com URL; asked to "plan this UI", "build this page", "review my UI", "polish/harden this screen", or when unsure which design skill fits.
user-invocable: true
metadata:
  origin: local
---

# UI Workflow

Decide which skill runs, when, with what inputs, and what must be true before moving on. Never restate what the routed skill already says; load it and follow it.

## 0. Detect (cheap, before anything)

| Signal | Check | Outcome |
|---|---|---|
| Figma | `ToolSearch select:mcp__plugin_figma_figma__get_design_context` | Returned → connected. Only `mcp__plugin_figma_figma__authenticate` / `complete_authentication` exist → installed, not signed in. figma.com URL given and not connected → offer to run `authenticate`; otherwise proceed without Figma and say so in one line |
| Browser | `claude-in-chrome` per CLAUDE.md "Browser Automation" | `agent-browser` only in the cases CLAUDE.md allows. Chosen tool unavailable → stop and ask |
| Stack | `package.json` deps + files | `next` → `vercel:nextjs`; `react` → `vercel:react-best-practices`; `components.json` → `vercel:shadcn`; `expo` / `react-native` → `expo:expo-ui`, `expo:expo-native-ui` (plus other `expo:*` as the task needs); note `tailwind` for token reuse |
| Design context | `PRODUCT.md` / `DESIGN.md` at repo root | Absent and work is non-trivial (new surface, redesign) → offer `impeccable init` (and `impeccable document` for existing UI) |

Package commands: `ni` / `nr` / `nlx` only. Never `npm` / `npx`.

Print one routing line before acting, e.g. `Figma: connected · Browser: chrome · Stack: next+shadcn · Context: PRODUCT.md · Mode: build`.

## 1. Route by intent

### Plan (new screen, feature, or flow)
1. `impeccable shape <feature>` → brief covering states: empty, loading, error, permission, overflow.
2. Figma connected and the user wants a mockup → load `figma:figma-use`, then `figma:figma-generate-design`.
3. **Gate:** user confirms the brief before any build step.

### Build
- figma.com URL + Figma connected → load `figma:figma-design-to-code` **before** any `get_design_context` call, and pass its skill name as that skill instructs. Motion in the design → also `figma:figma-implement-motion`.
- Otherwise → `impeccable` (new-work from the confirmed brief, or `impeccable <mode> <target>` for a named mode).
- Always load the detected stack skills alongside. Reuse existing components and tokens before creating new ones.
- Multi-file builds follow CLAUDE.md orchestration (`builder` agent through `/pair`); this skill supplies the routing and inputs.

### Verify (browser)
1. Needs a running dev server URL. Ask for it; never auto-start.
2. Render in `claude-in-chrome`: screenshot (desktop + mobile width), console errors, failed network requests.
3. Variant iteration requested → `impeccable live`.
4. **Gate:** screenshot evidence and a clean console before calling the UI done.

### Review
1. Changed UI files: `git diff --name-only <base>...HEAD` filtered to `.tsx .jsx .css .html .vue .svelte`. Confirm `<base>` if not obvious.
2. Run in parallel on that file list:
   - `web-design-guidelines` (guideline compliance, `file:line`)
   - `impeccable critique <target>` (UX) and/or `impeccable audit <target>` (a11y, perf, responsive). Default both for new surfaces; `audit` alone for small refinements.
3. Merge and dedupe findings by `file:line`; group by severity.
4. Fix high severity; list medium/low for the user to choose.
5. **Gate:** re-run Verify on touched screens after fixes.

### Refine existing UI
`polish`, `harden`, `clarify`, `adapt`, `distill`, `animate`, `typeset`, `layout`, `colorize`, `optimize`, etc. → straight to `impeccable <mode> <target>`, then Verify, then Review.

## 2. Handoffs

| Need | Route |
|---|---|
| Behavioral test cases, flow QA | `/qa` |
| Code-quality / maintainability review | `/thermo` (or `/review`) |
| Browser bug with visible symptoms | `diagnosing-bugs` |
| Code Connect mappings | `figma:figma-code-connect`, only on explicit request |

## 3. Rules

- Never call a Figma tool without its mandatory skill loaded first (`figma-design-to-code` for `get_design_context`, `figma-use` for `use_figma`).
- Don't enable impeccable hooks (`impeccable hooks on`) without asking.
- First time impeccable's launcher runs in a session, tell the user once: its detector downloads a checksum-verified binary on first use.
- One routing decision per step; if two modes fit, ask once.
- No UI is done without a screenshot from Verify.
