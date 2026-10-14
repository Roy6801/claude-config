'use strict';
// Bash command walker shared by PreToolUse hooks (db-guard).
// Parses a command line closely enough to bash to find every program it would run:
// quoting ($'…', "…", \), parameter / command / process substitution, brace
// expansion, heredocs and here-strings, pipelines, aliases and simple variable
// tracking, launcher prefixes (sudo, env, timeout, npx, uv run, …) and commands
// that run other commands (sh -c, eval, find -exec, xargs, git -c, watch, …).
// Values it cannot know statically are marked with DYN so callers can decide
// conservatively.

const path = require('path');

const MAX_DEPTH = 8;
const DYN = '\u0000';
const SLOT = 0xe000;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'yash', 'nu', 'xonsh', 'elvish', 'pwsh', 'powershell']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
// Env vars whose value is run as a command by the program they are set for.
const CMD_VAR = /(PAGER|EDITOR|VISUAL|COMMAND|CMD|SHELL|DIFF|PROGRAM|BROWSER|LESSOPEN|LESSCLOSE|ASKPASS|HOOK|BASH_ENV|^ENV)$/i;

// ---------- parser ----------

function newCmd(start) {
  return { words: [], redirs: [], inputs: [], herestrings: [], heredocs: [], sep: '', start, text: '' };
}

function pushLit(word, v, q) {
  const last = word[word.length - 1];
  if (last && last.k === 'lit' && last.q === q) last.v += v;
  else word.push({ k: 'lit', v, q });
}

function parse(src) {
  return parseList({ src: String(src), i: 0, pending: [] }, false);
}

// Parses commands until EOF, or (inner) until the `)` closing a $( / <( substitution.
function parseList(p, inner) {
  const src = p.src;
  const cmds = [];
  let cmd = newCmd(p.i);
  let word = null;
  let redir = null;
  let depth = 0;
  const w = () => (word ??= []);
  const endWord = () => {
    if (word === null) return;
    if (redir === 'in') cmd.inputs.push(word);
    else if (redir === 'here') cmd.herestrings.push(word);
    else if (redir === 'doc' || redir === 'doc-') {
      const delim = word.map((x) => (x.k === 'lit' ? x.v : '')).join('');
      p.pending.push({ cmd, delim, quoted: word.some((x) => x.q), strip: redir === 'doc-' });
    } else if (redir) cmd.redirs.push(word);
    else cmd.words.push(word);
    word = null;
    redir = null;
  };
  const endCmd = (sep) => {
    endWord();
    redir = null;
    cmd.sep = sep;
    cmd.text = src.slice(cmd.start, p.i);
    if (cmd.words.length || cmd.redirs.length || cmd.inputs.length || cmd.herestrings.length || p.pending.some((h) => h.cmd === cmd)) cmds.push(cmd);
    p.i += sep.length;
    cmd = newCmd(p.i);
  };

  while (p.i < src.length) {
    const c = src[p.i];
    if (c === "'") {
      const j = src.indexOf("'", p.i + 1);
      const end = j < 0 ? src.length : j;
      pushLit(w(), src.slice(p.i + 1, end), true);
      p.i = end + 1;
    } else if (c === '"') {
      p.i++;
      const parts = parseDQ(p, '"');
      if (parts.length) w().push(...parts);
      else pushLit(w(), '', true);
    } else if (c === '\\') {
      if (src[p.i + 1] === '\n') p.i += 2;
      else {
        pushLit(w(), src[p.i + 1] ?? '\\', true);
        p.i += 2;
      }
    } else if (c === '$') {
      parseDollar(p, w(), false);
    } else if (c === '`') {
      parseBacktick(p, w(), false);
    } else if ((c === '<' || c === '>') && src[p.i + 1] === '(') {
      const start = p.i + 2;
      p.i += 2;
      const sub = parseList(p, true);
      w().push({ k: 'sub', cmds: sub, q: false, proc: true, src: src.slice(start, p.i - 1) });
    } else if (c === '#' && word === null) {
      const j = src.indexOf('\n', p.i);
      p.i = j < 0 ? src.length : j;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      p.i++;
    } else if (c === '<' || c === '>' || (c === '&' && src[p.i + 1] === '>')) {
      if (word && word.length === 1 && word[0].k === 'lit' && !word[0].q && /^\d+$/.test(word[0].v)) word = null;
      else endWord();
      const op = /^(<<<|<<-|<<|<>|<&|>&|>>|>\||&>>|&>|<|>)/.exec(src.slice(p.i, p.i + 3))[1];
      p.i += op.length;
      if (op === '<&' || op === '>&') {
        const m = /^\s*(\d+-?|-)(?=[\s;&|()<>]|$)/.exec(src.slice(p.i, p.i + 16));
        if (m) {
          p.i += m[0].length;
          continue;
        }
      }
      redir = { '<<<': 'here', '<<': 'doc', '<<-': 'doc-', '<': 'in' }[op] || 'out';
    } else if (c === '\n') {
      endCmd('\n');
      if (p.pending.length) readHeredocs(p);
      cmd.start = p.i;
    } else if (c === ';' || c === '&' || c === '|') {
      endCmd(/^(;;&?|;&|&&|\|\||\|&|[;&|])/.exec(src.slice(p.i, p.i + 3))[1]);
    } else if (c === '(') {
      if (inner) depth++;
      endCmd('(');
    } else if (c === ')') {
      if (inner && depth === 0) {
        endCmd(')');
        return cmds;
      }
      if (depth) depth--;
      endCmd(')');
    } else {
      let j = p.i + 1;
      while (j < src.length && !/[\s'"\\$`<>;&|()]/.test(src[j])) j++;
      pushLit(w(), src.slice(p.i, j), false);
      p.i = j;
    }
  }
  endCmd('');
  return cmds;
}

function readHeredocs(p) {
  const src = p.src;
  for (const h of p.pending.splice(0)) {
    const lines = [];
    while (p.i < src.length) {
      let j = src.indexOf('\n', p.i);
      if (j < 0) j = src.length;
      const line = src.slice(p.i, j).replace(/\r$/, '');
      p.i = Math.min(j + 1, src.length);
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
      lines.push(h.strip ? line.replace(/^\t+/, '') : line);
    }
    const text = lines.join('\n');
    h.cmd.heredocs.push(h.quoted ? { text } : { text, parts: parseDQ({ src: text, i: 0, pending: [] }, null) });
  }
}

// Double-quoted text (term '"'), or an unquoted heredoc body (term null).
function parseDQ(p, term) {
  const src = p.src;
  const parts = [];
  while (p.i < src.length) {
    const c = src[p.i];
    if (term && c === term) {
      p.i++;
      return parts;
    }
    if (c === '\\') {
      const n = src[p.i + 1];
      if (n === '\n') p.i += 2;
      else if (n === '$' || n === '`' || n === '\\' || (term && n === term)) {
        pushLit(parts, n, true);
        p.i += 2;
      } else {
        pushLit(parts, '\\', true);
        p.i++;
      }
    } else if (c === '$') parseDollar(p, parts, true);
    else if (c === '`') parseBacktick(p, parts, true);
    else {
      pushLit(parts, c, true);
      p.i++;
    }
  }
  return parts;
}

function parseDollar(p, word, q) {
  const src = p.src;
  const n = src[p.i + 1];
  if (n === '(') {
    const start = p.i + 2;
    const arith = src[start] === '(';
    p.i = start;
    const cmds = parseList(p, true);
    word.push({ k: 'sub', cmds, q, arith, src: src.slice(start, p.i - 1) });
  } else if (n === '{') {
    let d = 0;
    let j = p.i + 1;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === '\\') j++;
      else if (c === "'" && !q) {
        const k = src.indexOf("'", j + 1);
        j = k < 0 ? src.length : k;
      } else if (c === '{') d++;
      else if (c === '}' && --d === 0) break;
    }
    word.push({ k: 'var', e: src.slice(p.i + 2, j), q });
    p.i = j + 1;
  } else if (n === "'" && !q) {
    let j = p.i + 2;
    while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
    pushLit(word, decodeEscapes(src.slice(p.i + 2, j), false), true);
    p.i = j + 1;
  } else if (n === '"' && !q) {
    p.i += 2;
    const parts = parseDQ(p, '"');
    if (parts.length) word.push(...parts);
    else pushLit(word, '', true);
  } else {
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(p.i + 1, p.i + 129));
    if (m) {
      word.push({ k: 'var', e: m[1], q });
      p.i += 1 + m[1].length;
    } else {
      pushLit(word, '$', q);
      p.i++;
    }
  }
}

function parseBacktick(p, word, q) {
  const src = p.src;
  let i = p.i + 1;
  let body = '';
  while (i < src.length && src[i] !== '`') {
    if (src[i] === '\\' && /[`$\\]/.test(src[i + 1] || '')) {
      body += src[i + 1];
      i += 2;
    } else body += src[i++];
  }
  p.i = i + 1;
  word.push({ k: 'sub', cmds: parse(body), q, src: body });
}

const SIMPLE_ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

// Backslash escapes as in $'…' (printf=false) or printf / echo -e (printf=true).
function decodeEscapes(s, printf) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      out += s[i];
      continue;
    }
    const c = s[++i];
    let m;
    if (c in SIMPLE_ESC) out += SIMPLE_ESC[c];
    else if (c === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1, i + 3)))) {
      out += String.fromCharCode(parseInt(m[0], 16));
      i += m[0].length;
    } else if ((c === 'u' || c === 'U') && (m = /^[0-9a-fA-F]{1,8}/.exec(s.slice(i + 1, i + (c === 'u' ? 5 : 9))))) {
      out += String.fromCodePoint(Math.min(parseInt(m[0], 16), 0x10ffff));
      i += m[0].length;
    } else if (/[0-7]/.test(c)) {
      m = printf && c === '0' ? /^[0-7]{0,3}/.exec(s.slice(i + 1, i + 4)) : /^[0-7]{0,2}/.exec(s.slice(i + 1, i + 3));
      out += String.fromCharCode(parseInt((printf && c === '0' ? '' : c) + m[0] || '0', 8) & 0xff);
      i += m[0].length;
    } else if (c === 'c' && !printf && i + 1 < s.length) out += String.fromCharCode(s.charCodeAt(++i) & 31);
    else out += '\\' + c;
  }
  // bash strings end at a NUL byte; DYN is NUL, so never let one through.
  const nul = out.indexOf('\0');
  return nul < 0 ? out : out.slice(0, nul);
}

// ---------- word helpers ----------

function braceExpand(s, out = []) {
  if (out.length >= 64) return out;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let d = 0;
    let j = i;
    const commas = [];
    for (; j < s.length; j++) {
      if (s[j] === '{') d++;
      else if (s[j] === '}' && --d === 0) break;
      else if (s[j] === ',' && d === 1) commas.push(j);
    }
    if (j >= s.length) break;
    const pre = s.slice(0, i);
    const post = s.slice(j + 1);
    let alts = null;
    if (commas.length) {
      alts = [];
      let st = i + 1;
      for (const c of [...commas, j]) {
        alts.push(s.slice(st, c));
        st = c + 1;
      }
    } else {
      const m = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])$/.exec(s.slice(i + 1, j));
      if (m) {
        const num = /\d/.test(m[1]);
        const a = num ? Number(m[1]) : m[1].charCodeAt(0);
        const b = num ? Number(m[2]) : m[2].charCodeAt(0);
        alts = [];
        for (let k = a; alts.length < 64 && (a <= b ? k <= b : k >= b); k += a <= b ? 1 : -1) alts.push(num ? String(k) : String.fromCharCode(k));
      }
    }
    if (!alts) continue;
    for (const a of alts) braceExpand(pre + a + post, out);
    return out;
  }
  out.push(s);
  return out;
}

function globRegex(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const j = g.indexOf(']', i + 2);
      if (j < 0) re += '\\[';
      else {
        re += '[' + g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = j;
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return re;
}

function norm(w) {
  return path.basename(String(w)).replace(/^=(?=.)/, '').replace(/(.)@[^/]*$/, '$1').toLowerCase();
}

// Returns positional args, skipping flags (and the value of flags in valueFlags).
// Stops at `--`.
function positionals(args, valueFlags = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a.startsWith('-') && a.length > 1) {
      if (!a.includes('=') && valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function skipFlags(words, valueFlags = []) {
  let i = 0;
  while (i < words.length && words[i].startsWith('-') && words[i].length > 1 && words[i] !== '--') {
    i += !words[i].includes('=') && valueFlags.includes(words[i]) ? 2 : 1;
  }
  if (words[i] === '--') i++;
  return words.slice(i);
}

// Like skipFlags, but a flag in codeFlags carries a shell command string: it is
// handed to onText and nothing is left to run directly.
function afterFlags(words, valueFlags, codeFlags, onText) {
  let i = 0;
  while (i < words.length) {
    const a = words[i];
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a.length === 1) break;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (codeFlags.includes(flag)) {
      onText(eq > 0 ? a.slice(eq + 1) : words[i + 1] ?? '');
      return [];
    }
    i += eq < 0 && valueFlags.includes(flag) ? 2 : 1;
  }
  return words.slice(i);
}

function flagValues(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    for (const n of names) {
      if (a === n) out.push(args[++i] ?? '');
      else if (n.startsWith('--') && a.startsWith(n + '=')) out.push(a.slice(n.length + 1));
      else if (n.length === 2 && !n.startsWith('--') && a.startsWith(n) && a.length > 2 && !a.startsWith('--')) out.push(a.slice(2));
      else continue;
      break;
    }
  }
  return out;
}

// ---------- launcher prefixes ----------

const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'nohup', 'builtin', 'noglob', 'nocorrect', 'coproc', '-', 'setsid', 'chronic', 'unbuffer', 'busybox', 'toybox', 'valgrind', 'firejail', 'catchsegv', 'nq', 'entr', 'cross-env', 'pkexec']);
const FLAG_WRAPPERS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--close-from', '--command-timeout'],
  doas: ['-u', '-C'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata'],
  caffeinate: ['-t', '-w'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  time: ['-f', '-o', '--format', '--output'],
  exec: ['-a'],
  arch: ['-e', '-d'],
  rlwrap: ['-a', '-f', '-H', '-p', '-P', '-S', '-t', '-w', '-z'],
  strace: ['-o', '-e', '-p', '-s', '-u', '-E', '-P', '-I', '-b', '-a', '-X'],
  ltrace: ['-o', '-e', '-p', '-s', '-u', '-n', '-a'],
  dtruss: ['-p', '-n', '-t', '-W'],
  'xvfb-run': ['-n', '-s', '-f', '-e', '-p', '--server-num', '--server-args', '--auth-file', '--error-file'],
  proxychains: ['-f'],
  proxychains4: ['-f'],
  torsocks: ['-a', '-P', '-u', '-p'],
  tsp: ['-L', '-D', '-N'],
  xargs: ['-I', '-J', '-R', '-S', '-n', '-P', '-L', '-d', '-E', '-e', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file'],
  npx: ['-p', '--package'],
  pnpx: ['-p', '--package'],
  bunx: ['-p', '--package'],
  uvx: ['--from', '--with', '-p', '--python', '--index', '--with-requirements'],
  nlx: [],
  dlx: [],
};
const CODE_FLAGS = { npx: ['-c', '--call'], pnpx: ['-c', '--call'] };
const SEPARATOR_WRAPPERS = new Set(['dotenv', 'dotenv-cli', 'with-env', 'env-cmd']);
// `<runner> <verb> [flags] cmd …` (npm exec, uv run, bundle exec, mise exec, …).
const VERB_RUNNERS = {
  npm: ['exec', 'x'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], bun: ['x'],
  uv: ['run'], poetry: ['run'], pipenv: ['run'], pdm: ['run'], hatch: ['run'], rye: ['run'], pipx: ['run'],
  conda: ['run'], mamba: ['run'], micromamba: ['run'], pixi: ['run', 'exec'],
  bundle: ['exec'], mise: ['exec', 'x'], rtx: ['exec', 'x'], asdf: ['exec'], devbox: ['run'],
  dotenvx: ['run'], op: ['run'], infisical: ['run'], doppler: ['run'], 'aws-vault': ['exec'], direnv: ['exec'],
  nix: ['develop', 'shell'],
};
const VERB_SKIP = { direnv: 1, 'aws-vault': 1 };
const VERB_VALUE_FLAGS = ['--filter', '-F', '-C', '--dir', '--cwd', '--prefix', '--workspace', '-p', '--package', '--with', '--from',
  '--python', '--project', '--directory', '--env-file', '-e', '--env', '-f', '--file', '-n', '--name', '--config', '--profile',
  '--project-dir', '-E', '--environment', '--group', '--extra', '--index', '--path', '--token', '--account', '--vault'];
const VERB_CODE_FLAGS = ['-c', '--call', '--command'];

// One unwrapping step: returns the wrapped command's words, or null when words[0]
// is not a launcher. Shell-string payloads are handed to onText.
function unwrapOnce(words, onText) {
  const w = words[0];
  const base = norm(w);
  if (ASSIGN.test(w)) {
    const eq = w.indexOf('=');
    if (CMD_VAR.test(w.slice(0, eq).replace(/\+$|\[.*$/, ''))) onText(w.slice(eq + 1));
    return words.slice(1);
  }
  if (KEYWORDS.has(base) || w === '--') return words.slice(1);
  if (base === 'function') return words.slice(2);
  if (base === 'command') return /^-[a-zA-Z]*[vV]/.test(words[1] || '') ? [] : skipFlags(words.slice(1));
  if (base === 'timeout' || base === 'gtimeout') return skipFlags(words.slice(1), ['-s', '-k', '--signal', '--kill-after']).slice(1);
  if (base === 'chroot' || base === 'chrt') return skipFlags(words.slice(1), ['--userspec', '--groups']).slice(1);
  if (base === 'taskset') return words.includes('-p') ? [] : skipFlags(words.slice(1)).slice(1);
  if (base === 'env') {
    const rest = words.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--') return rest.slice(i + 1);
      if (!a.startsWith('-') || a === '-') return rest.slice(i);
      const split = a === '-S' || a === '--split-string' ? rest[++i] ?? '' : a.startsWith('--split-string=') ? a.slice(15) : /^-[iv0]*S./.test(a) ? a.slice(a.indexOf('S') + 1) : null;
      if (split !== null) return [...splitWords(split), ...rest.slice(i + 1)];
      if (['-u', '-C', '-P', '--unset', '--chdir'].includes(a)) i++;
    }
    return [];
  }
  if (base === 'flock') {
    const rest = afterFlags(words.slice(1), ['-w', '--timeout', '-E', '--conflict-exit-code'], ['-c', '--command'], onText);
    return rest.slice(1);
  }
  if (base === 'su' || base === 'runuser' || base === 'sg') {
    for (const v of flagValues(words.slice(1), ['-c', '--command', '--session-command'])) onText(v);
    return [];
  }
  if (base === 'script') {
    return afterFlags(words.slice(1), ['-F', '-t', '-T', '-I', '-O', '-B', '-E'], ['-c', '--command'], onText).slice(1);
  }
  if (base === 'watch') {
    onText(skipFlags(words.slice(1), ['-n', '--interval', '-q', '--equexit']).join(' '));
    return [];
  }
  if (base === 'nix-shell') {
    flagValues(words.slice(1), ['--run', '--command']).forEach(onText);
    return [];
  }
  if (base === 'parallel') {
    const rest = skipFlags(words.slice(1), ['-j', '-P', '-S', '--jobs', '--sshlogin', '-a', '--arg-file', '-d', '--delimiter', '-n', '-N', '-L', '--joblog', '--results', '--tmpdir', '-I', '--colsep', '-C']);
    const sep = rest.findIndex((a) => /^:::+\+?$/.test(a));
    const cmd = sep < 0 ? rest : rest.slice(0, sep);
    if (sep >= 0 && (!cmd.length || cmd.some((a) => a.includes('{')))) rest.slice(sep + 1).filter((a) => !/^:::+\+?$/.test(a)).forEach(onText);
    if (cmd.length === 1 && /\s/.test(cmd[0])) {
      onText(cmd[0]);
      return [];
    }
    return cmd;
  }
  if (Object.prototype.hasOwnProperty.call(FLAG_WRAPPERS, base)) return afterFlags(words.slice(1), FLAG_WRAPPERS[base], CODE_FLAGS[base] || [], onText);
  if (SEPARATOR_WRAPPERS.has(base)) return skipFlags(words.slice(1), ['-e', '-c', '-v', '-f', '--file', '-p']);
  if (VERB_RUNNERS[base]) {
    const rest = words.slice(1);
    const pos = positionals(rest, VERB_VALUE_FLAGS);
    let at = pos[0];
    let from = rest.indexOf(at) + 1;
    if (base === 'uv' && at === 'tool' && pos[1] === 'run') from = rest.indexOf('run', from) + 1;
    else if (!VERB_RUNNERS[base].includes(at)) return null;
    let tail = rest.slice(from);
    // `mise exec node@20 -- cmd`: tool specs come before the separator.
    if ((base === 'mise' || base === 'rtx') && tail.includes('--')) return tail.slice(tail.indexOf('--') + 1);
    if (base === 'nix') {
      const ci = tail.findIndex((a) => a === '-c' || a === '--command');
      return ci < 0 ? [] : tail.slice(ci + 1);
    }
    tail = afterFlags(tail, VERB_VALUE_FLAGS, VERB_CODE_FLAGS, onText);
    return tail.slice(VERB_SKIP[base] || 0);
  }
  return null;
}

// Commands that run other commands given as arguments.
function embedded(cmd, args) {
  const out = [];
  const text = (t, why) => out.push({ text: t, why });
  switch (cmd) {
    case 'find': case 'gfind':
      for (let i = 0; i < args.length; i++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(args[i])) continue;
        let j = i + 1;
        while (j < args.length && args[j] !== ';' && args[j] !== '+') j++;
        out.push({ words: args.slice(i + 1, j).map((a) => a.replace(/\{\}/g, DYN)) });
        i = j;
      }
      break;
    case 'fd': case 'fdfind': {
      const i = args.findIndex((a) => /^(-x|--exec|-X|--exec-batch)$/.test(a));
      if (i >= 0) {
        let j = i + 1;
        while (j < args.length && args[j] !== ';') j++;
        out.push({ words: args.slice(i + 1, j).map((a) => a.replace(/\{[/.]*\}/g, DYN)) });
      }
      break;
    }
    case 'rg':
      flagValues(args, ['--pre']).forEach((v) => out.push({ words: [v] }));
      break;
    case 'man':
      flagValues(args, ['-P', '--pager', '-H', '--html']).forEach((v) => text(v));
      break;
    case 'ag': case 'ack': case 'tig':
      flagValues(args, ['--pager']).forEach((v) => text(v));
      break;
    case 'git': gitEmbedded(args, out); break;
    case 'gh': {
      const p = positionals(args);
      if (p[0] === 'alias' && p[1] === 'set' && p[3] !== undefined) text(p[3].replace(/^!/, ''));
      if (p[0] === 'config' && p[1] === 'set' && /^(editor|pager|browser)$/.test(p[2] || '') && p[3] !== undefined) text(p[3]);
      break;
    }
    case 'ssh': {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += /^-[bcDEeFIiJLlmOoPpQRSWw]$/.test(args[i]) ? 2 : 1;
      if (args.length > i + 1) text(args.slice(i + 1).join(' '));
      break;
    }
    case 'trap':
      if (args[0] && !args[0].startsWith('-')) text(args[0]);
      break;
    case 'sed': case 'gsed': {
      const scripts = flagValues(args, ['-e', '--expression']);
      if (!scripts.length) scripts.push(...positionals(args, ['-f', '--file', '-l', '--line-length']).slice(0, 1));
      for (const s of scripts) if (/(^|[;\n{}])\s*(\d+|\$|\/[^/]*\/)?\s*e(\s|;|$)|[^\\]\/[gpiImM0-9]*e[gpiImM0-9]*\s*(;|}|$)/.test(s)) out.push({ opaque: s, why: 'a sed script that executes commands' });
      break;
    }
    case 'awk': case 'gawk': case 'mawk': case 'nawk': {
      const prog = positionals(args, ['-F', '-v', '-f', '--field-separator', '--assign', '--file'])[0] || '';
      if (/\bsystem\s*\(|\|\s*"|"\s*\|\s*getline|\|&/.test(prog)) out.push({ opaque: prog, why: 'an awk program that runs commands' });
      break;
    }
    case 'vim': case 'nvim': case 'vi': case 'ex': case 'view':
      for (const v of [...flagValues(args, ['-c', '--cmd']), ...args.filter((a) => a.startsWith('+'))]) {
        if (/!|system\(/.test(v)) out.push({ opaque: v, why: 'an editor command that runs a shell' });
      }
      break;
    case 'osascript':
      for (const v of flagValues(args, ['-e'])) {
        for (const m of v.matchAll(/do shell script\s+"((?:[^"\\]|\\.)*)"/g)) text(m[1].replace(/\\(.)/g, '$1'));
      }
      break;
    case 'expect':
      flagValues(args, ['-c']).forEach((v) => out.push({ opaque: v, why: 'an expect script' }));
      break;
    case 'tmux': case 'screen': case 'hyperfine': case 'concurrently': case 'watchexec': case 'nodemon':
      args.filter((a) => !a.startsWith('-')).forEach((a) => text(a));
      break;
  }
  return out;
}

const GIT_CMD_KEY = /^alias\.|pager|editor|sshcommand|program|cmd|command|helper|textconv|driver|clean|smudge|process|external|fsmonitor|askpass|difffilter|hook/i;

function gitEmbedded(args, out) {
  const conf = (kv) => {
    const eq = kv.indexOf('=');
    if (eq < 0) return;
    const val = kv.slice(eq + 1);
    if (GIT_CMD_KEY.test(kv.slice(0, eq)) || val.startsWith('!')) out.push({ text: val.replace(/^!/, '') });
  };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '-c') conf(args[++i] || '');
    else if (/^-c./.test(a)) conf(a.slice(2));
    else if (['-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'].includes(a)) i++;
    else if (!a.startsWith('-')) break;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'config') {
    const pos = positionals(rest, ['--file', '-f', '--blob', '--type', '--default', '--comment', '--value']);
    const [k, v] = ['set', 'add'].includes(pos[0]) ? pos.slice(1) : pos;
    if (k && v !== undefined) conf(`${k}=${v}`);
  } else if (sub === 'rebase') {
    flagValues(rest, ['-x', '--exec']).forEach((v) => out.push({ text: v }));
  } else if (sub === 'bisect' && rest[0] === 'run') {
    out.push({ words: rest.slice(1) });
  } else if (sub === 'submodule' && rest.includes('foreach')) {
    out.push({ text: skipFlags(rest.slice(rest.indexOf('foreach') + 1)).join(' ') });
  } else if (sub === 'difftool' || sub === 'mergetool') {
    flagValues(rest, ['-x', '--extcmd']).forEach((v) => out.push({ text: v }));
  } else if (sub === 'filter-branch') {
    for (let j = 0; j < rest.length; j++) if (/^--\w+-filter$/.test(rest[j])) out.push({ text: rest[++j] || '' });
  }
}

function splitWords(s) {
  const cmds = parse(s);
  return cmds.length ? cmds[0].words.map((wd) => wd.map((x) => (x.k === 'lit' ? x.v : DYN)).join('')) : [];
}

// Static value of a command's stdout when it is trivially known (echo, printf, cat <<EOF).
function evalValue(c) {
  const f = c.fields;
  if (!f || !f.length) return null;
  const b = norm(f[0]);
  const a = f.slice(1);
  if (b === 'echo') {
    let k = 0;
    let esc = false;
    while (/^-[neE]+$/.test(a[k] || '')) esc = a[k++].includes('e') || esc;
    const s = a.slice(k).join(' ');
    return esc ? decodeEscapes(s, true) : s;
  }
  if (b === 'printf') {
    const r = a[0] === '--' ? a.slice(1) : a;
    if (!r.length || r[0] === '-v') return null;
    let args = r.slice(1);
    let out = '';
    const fmt = decodeEscapes(r[0], true);
    for (let n = 0; n < 16; n++) {
      out += fmt.replace(/%([-+ #0]*\d*(?:\.\d+)?)([a-zA-Z%])/g, (_, __, t) => (t === '%' ? '%' : t === 'b' ? decodeEscapes(args.shift() ?? '', true) : args.shift() ?? ''));
      if (!args.length || !/%[^%]/.test(fmt)) break;
    }
    return out;
  }
  if (b === 'which' || (b === 'command' && /^-[vV]$/.test(a[0] || '')) || (b === 'type' && /^-[pP]$/.test(a[0] || ''))) return a[a.length - 1] ?? null;
  if (b === 'cat' && !positionals(a).length) return c.docs?.[0] ?? c.here?.[0] ?? null;
  return null;
}

// ---------- walker ----------

class Walker {
  constructor(visit, opts) {
    this.visit = visit;
    this.top = opts.text;
    this.cwd = opts.cwd || process.cwd();
    this.env = new Map();
    this.aliases = new Map();
    this.result = null;
  }

  get(name) {
    if (this.env.has(name)) return this.env.get(name);
    if (name === 'IFS') return ' \t\n';
    const v = process.env[name];
    return v === undefined ? null : v;
  }

  // NAME=value or NAME+=value (append).
  assign(a) {
    const eq = a.indexOf('=');
    const name = a.slice(0, eq).replace(/\+$|\[.*$/, '');
    const prev = a[eq - 1] === '+' ? this.get(name) ?? (this.env.has(name) ? null : '') : '';
    const val = prev === null ? null : prev + a.slice(eq + 1);
    this.env.set(name, val === null || val.includes(DYN) ? null : val);
  }

  emit(words, cmd, raw, info) {
    if (this.result) return;
    const r = this.visit(words, cmd, raw, info);
    if (r) this.result = r;
  }

  opaque(text, why, depth) {
    this.emit(null, '', null, { opaque: String(text), why, depth, cwd: this.cwd, text: this.top });
  }

  text(src, depth) {
    if (this.result || !src || !String(src).trim()) return;
    if (depth > MAX_DEPTH) return this.opaque(src, 'a deeply nested command', depth);
    this.runList(parse(src), depth);
  }

  runList(cmds, depth) {
    for (let k = 0; k < cmds.length && !this.result; k++) {
      const prev = k > 0 ? cmds[k - 1] : null;
      const piped = prev && (prev.sep === '|' || prev.sep === '|&');
      let up = '';
      if (piped) for (let j = k - 1; j >= 0 && (j === k - 1 || cmds[j].sep === '|' || cmds[j].sep === '|&'); j--) up = cmds[j].text + ' | ' + up;
      this.runCmd(cmds[k], depth, piped ? prev : null, up);
    }
  }

  runCmd(c, depth, prev, upText) {
    const fields = [];
    for (const wd of c.words) fields.push(...this.expand(wd, depth));
    for (const wd of c.redirs) this.expand(wd, depth);
    const inputs = c.inputs.map((wd) => this.expand(wd, depth).join(' '));
    const here = c.herestrings.map((wd) => this.expand(wd, depth).join(' '));
    const docs = c.heredocs.map((h) => (h.parts ? this.expandQuoted(h.parts, depth) : h.text));
    if (this.result) return;
    Object.assign(c, { fields, docs, here });
    const stdin = [...docs, ...here];
    let piped = null;
    if (prev) {
      const v = evalValue(prev);
      if (v !== null) stdin.push(v);
      else piped = upText;
    }
    this.dispatch(fields, depth, { stdin, piped, inputs, text: c.text });
  }

  dispatch(raw, depth, io) {
    if (this.result) return;
    if (depth > MAX_DEPTH) return this.opaque(raw.join(' '), 'a deeply nested command', depth);
    let k = 0;
    while (k < raw.length && ASSIGN.test(raw[k])) k++;
    let words = raw.slice(k);
    for (const a of raw.slice(0, k)) {
      const eq = a.indexOf('=');
      const name = a.slice(0, eq).replace(/\+$|\[.*$/, '');
      const val = a.slice(eq + 1);
      if (CMD_VAR.test(name)) this.text(val, depth + 1);
      if (!words.length) this.assign(a);
    }
    const onText = (t) => this.text(t, depth + 1);
    const seen = new Set();
    let xargs = false;
    for (let g = 0; g < 40 && words.length && !this.result; g++) {
      const alias = this.aliases.get(words[0]);
      if (alias !== undefined && !seen.has(words[0])) {
        seen.add(words[0]);
        words = [...splitWords(alias), ...words.slice(1)];
        continue;
      }
      if (norm(words[0]) === 'xargs') xargs = true;
      const next = unwrapOnce(words, onText);
      if (!next) break;
      words = next;
    }
    if (this.result) return;
    if (xargs && (!words.length || words.some((a) => a.includes('{}')) || (SHELLS.has(norm(words[0])) && words.length <= 2))) this.feed(io, depth);
    if (words.length) this.command(words, raw, depth, io);
  }

  // Text a shell reads as its script from stdin.
  feed(io, depth) {
    for (const s of io.stdin || []) this.text(s, depth + 1);
    if (io.piped) this.opaque(io.piped, 'input piped into a shell', depth);
  }

  command(words, raw, depth, io) {
    const cmd = norm(words[0]);
    const args = words.slice(1);
    if (SHELLS.has(cmd)) {
      if (this.shell(args, depth, io)) return;
    } else if (cmd === 'eval') {
      return this.text(args.join(' '), depth + 1);
    } else if (cmd === 'source' || cmd === '.') {
      if ((args[0] || '').includes(DYN)) this.opaque(this.top, 'a generated script being sourced', depth);
    } else if (cmd === 'at' || cmd === 'batch') {
      this.feed(io, depth);
    } else if (cmd === 'alias') {
      for (const a of args) {
        const eq = a.indexOf('=');
        if (eq <= 0) continue;
        this.aliases.set(a.slice(0, eq), a.slice(eq + 1));
        this.text(a.slice(eq + 1), depth + 1);
      }
      return;
    } else if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(cmd)) {
      for (const a of args) {
        if (!ASSIGN.test(a)) continue;
        const eq = a.indexOf('=');
        const name = a.slice(0, eq).replace(/\+$|\[.*$/, '');
        if (CMD_VAR.test(name)) this.text(a.slice(eq + 1), depth + 1);
        this.assign(a);
      }
    } else if (cmd === 'unset') {
      args.forEach((a) => this.env.set(a, ''));
    } else if (cmd === 'cd') {
      const d = args.find((a) => !a.startsWith('-'));
      if (d && !d.includes(DYN)) this.cwd = path.resolve(this.cwd, d.replace(/^~(?=\/|$)/, process.env.HOME || '~'));
    }
    for (const e of embedded(cmd, args)) {
      if (this.result) return;
      if (e.words) this.dispatch(e.words, depth + 1, {});
      else if (e.opaque !== undefined) this.opaque(e.opaque, e.why, depth);
      else this.text(e.text, depth + 1);
    }
    this.emit(words, cmd, raw, {
      dynamic: path.basename(words[0]).includes(DYN),
      text: this.top,
      stdin: io.stdin || [],
      piped: io.piped || null,
      inputs: io.inputs || [],
      depth,
      cwd: this.cwd,
    });
  }

  // Handles sh -c / stdin-fed shells; returns true when nothing else should be checked.
  shell(args, depth, io) {
    let k = 0;
    let code = false;
    let stdin = false;
    while (k < args.length) {
      const a = args[k];
      if (a === '--' || a === '-') {
        stdin = stdin || a === '-';
        k++;
        break;
      }
      if (/^[-+][oO]$/.test(a) || a === '--rcfile' || a === '--init-file') k += 2;
      else if (/^-(c|command)$/i.test(a) || /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) {
        code = true;
        k++;
      } else if (/^[-+]/.test(a)) {
        if (/^-[A-Za-z]*s[A-Za-z]*$/.test(a)) stdin = true;
        k++;
      } else break;
    }
    const pos = args.slice(k);
    if (code) {
      this.text(pos[0] ?? '', depth + 1);
      return true;
    }
    if (stdin || !pos.length || /^\/dev\/(stdin|fd\/0)$/.test(pos[0])) this.feed(io, depth);
    else if (pos[0].includes(DYN)) this.opaque(this.top, 'a generated script run by a shell', depth);
    return false;
  }

  expandQuoted(parts, depth) {
    return parts.map((x) => (x.k === 'lit' ? x.v : this.value(x, depth) ?? DYN)).join('');
  }

  value(part, depth) {
    return part.k === 'var' ? this.param(part.e, depth) : this.sub(part, depth);
  }

  sub(part, depth) {
    if (depth >= MAX_DEPTH) {
      this.opaque(part.src || '', 'a deeply nested substitution', depth);
      return null;
    }
    const saved = new Map(this.env);
    this.runList(part.cmds, depth + 1);
    this.env = saved;
    if (part.proc || part.arith || part.cmds.length !== 1) return null;
    const v = evalValue(part.cmds[0]);
    return v === null ? null : v.replace(/\n+$/, '');
  }

  // Parameter expansion; null means unknown.
  param(e, depth) {
    let m;
    if ((m = /^[=~^]*([A-Za-z_][A-Za-z0-9_]*)$/.exec(e))) return this.get(m[1]);
    if (/^[0-9@*!-]$/.test(e)) return null;
    if (/^[#?$]$/.test(e)) return '0';
    if ((m = /^#([A-Za-z_]\w*)$/.exec(e))) {
      const v = this.get(m[1]);
      return v === null ? null : String(v.length);
    }
    if ((m = /^!([A-Za-z_]\w*)$/.exec(e))) {
      const r = this.get(m[1]);
      return r !== null && /^[A-Za-z_]\w*$/.test(r) ? this.get(r) : null;
    }
    m = /^([A-Za-z_]\w*)([\s\S]*)$/.exec(e);
    if (!m) return null;
    const v = this.get(m[1]);
    const op = m[2];
    const word = (t) => this.wordValue(t, depth);
    if ((m = /^(:?)([-=+?])([\s\S]*)$/.exec(op))) {
      // An unknown variable takes the alternative word: the conservative reading.
      if (m[2] === '+') return v === null || !(m[1] && v === '') ? word(m[3]) : '';
      if (m[2] === '?') return v;
      return v === null || (m[1] && v === '') ? word(m[3]) : v;
    }
    if (v === null) return null;
    if ((m = /^:\s*(-?\d+)(?::\s*(-?\d+))?$/.exec(op))) {
      const s = Number(m[1]) < 0 ? Math.max(0, v.length + Number(m[1])) : Number(m[1]);
      const len = m[2] === undefined ? undefined : Number(m[2]) < 0 ? v.length - s + Number(m[2]) : Number(m[2]);
      return v.substr(s, len);
    }
    if ((m = /^(##?|%%?)([\s\S]*)$/.exec(op))) {
      const pat = this.wordValue(m[2], depth);
      if (pat === null) return null;
      const re = new RegExp(`^${globRegex(pat)}$`, 's');
      const longest = m[1].length === 2;
      if (m[1][0] === '#') {
        for (let i = longest ? v.length : 0; longest ? i >= 0 : i <= v.length; i += longest ? -1 : 1) if (re.test(v.slice(0, i))) return v.slice(i);
      } else {
        for (let i = longest ? 0 : v.length; longest ? i <= v.length : i >= 0; i += longest ? 1 : -1) if (re.test(v.slice(i))) return v.slice(0, i);
      }
      return v;
    }
    if ((m = /^\/(\/?)((?:\\.|[^/])*)(?:\/([\s\S]*))?$/.exec(op))) {
      const pat = this.wordValue(m[2], depth);
      const rep = this.wordValue(m[3] ?? '', depth);
      if (pat === null || rep === null) return null;
      return v.replace(new RegExp(globRegex(pat), m[1] ? 'gs' : 's'), () => rep);
    }
    if (op === '^^' || op === '^') return op === '^' ? v.charAt(0).toUpperCase() + v.slice(1) : v.toUpperCase();
    if (op === ',,' || op === ',') return op === ',' ? v.charAt(0).toLowerCase() + v.slice(1) : v.toLowerCase();
    if (/^@[QEPAaKk]$/.test(op)) return v;
    return null;
  }

  wordValue(t, depth) {
    const parts = [];
    const p = { src: t, i: 0, pending: [] };
    const words = parseList(p, false).flatMap((c) => c.words);
    for (const wd of words) parts.push(this.expand(wd, depth).join(' '));
    const s = parts.join(' ');
    return s.includes(DYN) ? null : s;
  }

  // Expands one word into fields: brace expansion, parameter / command
  // substitution and unquoted word splitting. Unknown values become DYN.
  expand(parts, depth) {
    let tpl = '';
    const slots = [];
    for (const part of parts) {
      if (part.k === 'lit' && !part.q) tpl += part.v.replace(/[\ue000-\uf8ff]/g, '');
      else {
        tpl += String.fromCharCode(SLOT + slots.length);
        slots.push(part);
      }
    }
    const values = slots.map((part) => (part.k === 'lit' ? part.v : this.value(part, depth)));
    const fields = [];
    for (const alt of braceExpand(tpl)) {
      let cur = null;
      for (const ch of alt) {
        const code = ch.charCodeAt(0);
        if (code < SLOT || code >= SLOT + slots.length) {
          cur = (cur ?? '') + ch;
          continue;
        }
        const part = slots[code - SLOT];
        const val = values[code - SLOT];
        if (val === null) cur = (cur ?? '') + DYN;
        else if (part.k === 'lit' || part.q) cur = (cur ?? '') + val;
        else {
          const pieces = val.split(/[ \t\n]+/);
          if (pieces[0] !== '') cur = (cur ?? '') + pieces[0];
          for (let i = 1; i < pieces.length; i++) {
            if (cur !== null) fields.push(cur);
            cur = pieces[i] === '' ? null : pieces[i];
          }
        }
      }
      if (cur !== null) fields.push(cur);
    }
    return fields;
  }
}

// Visits every simple command the shell would run, including substitutions,
// `sh -c` strings, eval, heredocs and pipes fed to a shell, and commands launched
// by wrappers. visit(words, cmd, rawWords, info) returning a truthy value stops the
// walk and that value is returned. info.dynamic marks a command name that could not
// be resolved; a call with words === null carries info.opaque, text that will run
// but could not be parsed into commands.
function walk(command, visit, opts = {}) {
  const depth = opts.depth || 0;
  if (typeof command !== 'string' || !command.trim()) return null;
  const w = new Walker(visit, { text: command, cwd: opts.cwd });
  if (depth > MAX_DEPTH) {
    w.opaque(command, 'a deeply nested command', depth);
    return w.result;
  }
  w.text(command, depth);
  return w.result;
}

module.exports = { walk, parse, norm, positionals, skipFlags, flagValues, globRegex, DYN, SHELLS };
