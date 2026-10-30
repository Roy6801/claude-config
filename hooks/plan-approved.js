#!/usr/bin/env node
'use strict';
// PostToolUse on ExitPlanMode (fires only when the user approves a plan). Copies what
// the user needs next to the clipboard and saves marked PR plans into ~/roadmaps:
//   <!-- pr: <project>/<slug>/<pr-name> -->     copy the plan, save <slug>/prs/<pr-name>/plan.md
//   no marker                                   copy the plan
// Then tells Claude to finish only its skill's post-approval steps and stop.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

// The approved plan lives in tool_response; tool_input can arrive empty or hold an
// earlier plan when one session plans several PRs.
function planText(input) {
  const res = input.tool_response || {};
  const req = input.tool_input || {};
  if (res.plan) return res.plan;
  const file = res.filePath || req.planFilePath;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  return req.plan || '';
}

function save(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function main() {
  const input = readInput();
  const plan = planText(input);
  if (!plan) return;

  const marker = plan.match(/<!--\s*pr:\s*([^\s>]+)\s*-->/);
  const parts = marker ? marker[1].split('/') : [];
  const valid = parts.length > 0 && parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..');
  const roadmaps = path.join(os.homedir(), 'roadmaps');

  let note = 'Plan copied to the clipboard.';
  if (valid && parts.length === 3) {
    const [project, slug, pr] = parts;
    const file = path.join(roadmaps, project, slug, 'prs', pr, 'plan.md');
    save(file, plan);
    note = `PR plan saved to ${file} and copied to the clipboard.`;
  }

  execFileSync('pbcopy', { input: plan });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `${note} Do only the steps your current skill defines for after approval, then stop and tell the user what was copied. Implementation starts in a new chat.`,
    },
  }));
}

try {
  main();
} catch (err) {
  process.stderr.write(`plan-approved hook: ${err.message}\n`);
}
