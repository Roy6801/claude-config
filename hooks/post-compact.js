#!/usr/bin/env node
'use strict';
// SessionStart (matcher "compact") context injector: after a compaction, point Claude
// back at the active initiative for this cwd (state/work/<slug>/, see bin/work.ts) so
// the roadmap and decision log survive the summary. When the initiative has a pair.json
// (skills/pair), also restate the current slice, commit and pair mode. Prints nothing
// when no initiative is active; never blocks.

const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '..', 'state', 'work');
const ACTIVE_FILE = path.join(STATE_DIR, 'active.json');
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ACTIVE_BYTES = 64 * 1024;
const MAX_ROADMAP_BYTES = 256 * 1024;
const MAX_PAIR_BYTES = 1024 * 1024;

function safeRead(file, maxBytes) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) return null;
    const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    try {
      return fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function isRealDir(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function findSlug(cwd) {
  const raw = safeRead(ACTIVE_FILE, MAX_ACTIVE_BYTES);
  if (!raw) return null;
  let active;
  try {
    active = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!active || typeof active !== 'object') return null;
  const starts = [path.resolve(cwd)];
  try {
    starts.push(fs.realpathSync(cwd));
  } catch {}
  for (const start of starts) {
    for (let d = start; ; d = path.dirname(d)) {
      const hit = Object.prototype.hasOwnProperty.call(active, d) ? active[d] : null;
      if (hit && typeof hit.slug === 'string' && SLUG_RE.test(hit.slug)) return hit.slug;
      if (path.dirname(d) === d) break;
    }
  }
  return null;
}

function stepLine(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^##\s+Steps\b/.test(l));
  if (start < 0) return 'no steps yet';
  const steps = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const c = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
    if (lines[i].trim().startsWith('|') && /^\d+$/.test(c[0])) {
      steps.push({ n: c[0], step: c[1] || '', status: (c[c.length - 1] || '').toLowerCase() });
    }
  }
  const cur = steps.find((s) => s.status === 'active') || steps.find((s) => s.status === 'todo');
  if (cur) return `step ${cur.n}/${steps.length}: ${cur.step} [${cur.status}]`;
  return steps.length ? 'all steps done' : 'no steps yet';
}

function pairLines(file) {
  const raw = safeRead(file, MAX_PAIR_BYTES);
  if (raw === null) return [];
  let pair;
  try {
    pair = JSON.parse(raw);
  } catch {
    return [];
  }
  const slices = Array.isArray(pair && pair.slices) ? pair.slices : [];
  const cur =
    slices.find((s) => s && (s.status === 'active' || s.status === 'checkpoint')) ||
    slices.find((s) => s && s.status === 'todo') ||
    slices[slices.length - 1];
  const mode = pair && pair.mode === 'off' ? 'off' : 'on';
  let where = 'no slices planned';
  if (cur) {
    const commits = (Array.isArray(cur.commits) ? cur.commits : []).filter((c) => c && c.extra !== true);
    const done = commits.filter((c) => c && c.status === 'done').length;
    const status = String(cur.status || 'todo').slice(0, 20);
    where = `slice ${Number(cur.n) || 0}/${slices.length} (${status}) · commit ${done}/${commits.length}`;
  }
  return [`pair: ${where} · mode ${mode}`, `Pair state: ${file} (/pair continues the slice)`];
}

function buildContext(cwd) {
  const slug = findSlug(cwd);
  if (!slug) return null;
  const dir = path.join(STATE_DIR, slug);
  if (!isRealDir(dir)) return null;
  const roadmap = path.join(dir, 'roadmap.md');
  const md = safeRead(roadmap, MAX_ROADMAP_BYTES);
  if (md === null) return null;
  const title = (md.match(/^#\s+(.+)$/m) || [])[1] || slug;
  const handoff = path.join(dir, 'handoff.md');
  return [
    `Active initiative: ${title.trim().slice(0, 120)} (${slug})`,
    `Current: ${stepLine(md).slice(0, 200)}`,
    `Roadmap: ${roadmap}`,
    `Decisions: ${path.join(dir, 'decisions.md')}`,
    `Handoff: ${fs.existsSync(handoff) ? handoff : 'none yet'}`,
    ...pairLines(path.join(dir, 'pair.json')),
    'Read these before continuing; decisions.md is authoritative.',
  ].join('\n');
}

function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const context = buildContext(String(data.cwd || process.cwd()));
  if (!context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    if (process.env.POST_COMPACT_DEBUG) process.stderr.write(`[post-compact] ${e && e.message}\n`);
  }
  process.exit(0);
}

module.exports = { buildContext };
