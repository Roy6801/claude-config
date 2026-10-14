#!/usr/bin/env node
'use strict';
// PreToolUse guard: Claude never touches a database; the user drives all DB access.
// Denies DB CLIs (however they are launched), ORM migrate/db commands, DB package
// scripts (judged by name and by their package.json body), DB connection URLs,
// running migration/seed files, inline interpreter code that loads a DB driver, and
// DB MCP tools. Writing .sql/migration files and file-only generators (prisma
// generate, drizzle-kit generate) are allowed. Prints nothing when the call is fine
// (normal permission flow applies).

const fs = require('fs');
const path = require('path');
const { walk, norm, positionals, flagValues, globRegex } = require('./lib/shell');

const DB_CLIS = new Set([
  'psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'pgcli', 'mysql', 'mysqldump', 'mysqlsh',
  'mariadb', 'mariadb-dump', 'mongosh', 'mongo', 'mongoexport', 'mongoimport', 'mongodump',
  'mongorestore', 'redis-cli', 'valkey-cli', 'sqlite3', 'sqlite', 'cockroach',
  'clickhouse-client', 'duckdb', 'neonctl', 'sqlcmd', 'usql', 'mycli', 'litecli', 'cqlsh',
  'snowsql', 'flyway', 'liquibase', 'dbmate', 'migrate', 'postgres', 'pg_ctl', 'initdb', 'createdb', 'dropdb',
  'createuser', 'dropuser', 'vacuumdb', 'reindexdb', 'clusterdb', 'pg_basebackup', 'pg_upgrade', 'pgbench', 'mysqladmin',
  'mysqlimport', 'mysqlcheck', 'mysqlpump', 'mariadb-admin', 'mongofiles', 'mongostat', 'mongotop', 'sqlite-utils',
]);
// DB CLI names distinctive enough to flag when they appear as an argument (a
// launcher's payload) rather than as the command itself.
const ARG_CLIS = new Set([...DB_CLIS].filter((n) => !['migrate', 'mongo', 'sqlite', 'cockroach', 'postgres'].includes(n)));
// `docker run postgres` starts a server; `docker run postgres psql` is a client.
const REMOTE_CLIS = new Set([...DB_CLIS].filter((n) => n !== 'postgres'));
// Search/VCS/text tools whose arguments are data, so a DB URL in them is a mention,
// not a connection. Commands they can launch (find -exec, git -c alias, rg --pre, …)
// are still walked by lib/shell.
const URL_EXEMPT = new Set(['git', 'gh', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'man', 'ls', 'which', 'type', 'whereis', 'find', 'fd']);
// Commands whose arguments are data: never scanned for launched DB CLIs.
const DATA_CMDS = new Set([...URL_EXEMPT, 'echo', 'printf', 'cat', 'bat', 'head', 'tail', 'less', 'more', 'whatis', 'apropos', 'info',
  'tldr', 'help', 'tree', 'sed', 'gsed', 'awk', 'gawk', 'tr', 'cut', 'sort', 'uniq', 'wc', 'diff', 'cmp', 'comm', 'jq', 'yq', 'tee',
  'touch', 'mkdir', 'rmdir', 'cp', 'mv', 'rm', 'ln', 'chmod', 'chown', 'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink',
  'pwd', 'cd', 'test', '[', '[[', 'true', 'false', 'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'port', 'code', 'cursor',
  'vim', 'nvim', 'vi', 'nano', 'emacs', 'open', 'pbcopy', 'pbpaste', 'date', 'sleep', 'kill', 'pkill', 'pgrep', 'ps', 'lsof', 'du',
  'df', 'export', 'declare', 'typeset', 'local', 'readonly', 'set', 'unset', 'read', 'exit', 'return', 'history', 'tar', 'zip', 'unzip']);
const INSTALL_VERBS = new Set(['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'info', 'search', 'show', 'upgrade', 'update', 'list', 'ls',
  'outdated', 'link', 'unlink', 'reinstall', 'uses', 'deps', 'view', 'home', 'why', 'audit', 'fetch', 'edit']);
const REMOTE_RUNNERS = new Set(['docker', 'docker-compose', 'podman', 'kubectl', 'oc', 'ssh']);
const SHELL_CMDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'ash', 'yash', 'source', '.']);
const SCRIPT_RUNNERS = new Set(['nr', 'ni', 'npm', 'bun', 'pnpm', 'yarn', 'turbo', 'nx', 'make', 'just', 'task']);
const RUNNER_VALUE_FLAGS = ['--filter', '-F', '-C', '--dir', '--cwd', '--prefix', '--workspace', '-f', '--file'];
const PM_BUILTINS = new Set(['run', 'create', 'init', 'exec', 'dlx', 'x', 'test', 'build', 'pack', 'publish', 'patch', 'config', 'store',
  'dedupe', 'prune', 'rebuild', 'import', 'setup', 'env', 'help', 'version', 'login', 'logout', 'whoami', 'cache', 'workspace', 'workspaces']);
// `bun build` / `bun test` are bun's own tools, not package scripts.
const BUN_BUILTINS = new Set(['build', 'test', 'install', 'i', 'add', 'a', 'remove', 'rm', 'update', 'link', 'unlink', 'pm', 'x', 'create', 'init', 'upgrade', 'repl', 'exec', 'outdated', 'publish', 'patch', 'audit', 'info', 'why']);
// CLIs with their own subcommand rules below; `pnpm prisma generate` runs the bin.
const BIN_RULES = new Set(['prisma', 'drizzle-kit', 'knex', 'typeorm', 'sequelize', 'sequelize-cli', 'mikro-orm', 'atlas', 'supabase', 'alembic']);

// Interpreters: code flags (letters for -X clusters, long names), module flag, value flags.
const INTERP = {
  node: { code: 'ep', long: ['--eval', '--print'], value: ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--input-type', '--title'] },
  bun: { code: 'ep', long: ['--eval', '--print'], value: ['-r', '--preload', '--cwd', '--env-file', '--config', '-c'] },
  tsx: { code: 'ep', long: ['--eval', '--print'], value: ['-r', '--require', '--import', '--tsconfig'] },
  'ts-node': { code: 'ep', long: ['--eval', '--print'], value: ['-r', '--require', '-P', '--project', '-C', '--compiler'] },
  esno: { code: 'ep', long: ['--eval', '--print'] },
  'vite-node': { code: 'e', long: ['--eval'] },
  'babel-node': { code: 'ep', long: ['--eval', '--print'] },
  jiti: { code: 'e', long: ['--eval'] },
  deno: { code: '', long: [] },
  python: { code: 'c', module: 'm', value: ['-W', '-X', '-Q'] },
  pypy: { code: 'c', module: 'm', value: ['-W', '-X'] },
  ruby: { code: 'e', value: ['-r', '-I', '-C', '-E'] },
  perl: { code: 'eE', value: ['-M', '-I', '-m'] },
  php: { code: 'r', value: ['-c', '-d', '-z'] },
  lua: { code: 'e' }, luajit: { code: 'e' }, rscript: { code: 'e' }, julia: { code: 'eE' }, osascript: { code: 'e' },
};
const PY_MODULES = { django: 'django-admin' };

const DB_URL = /\b(postgres(ql)?|mysql|mariadb|mongodb(\+srv)?|rediss?|sqlserver|cockroachdb|clickhouse):\/\//i;
const DB_SCRIPT = /^(db|database|migrat\w*|seed\w*|sql|prisma|drizzle)([:_-]|$)/i;
const DB_SCRIPT_SUFFIX = /:(migrate|seed|push|reset|studio)$/i;
// File-only generators (no DB connection) are allowed; running migrations is not.
const SAFE_SCRIPT = /^((prisma)[:_-](generate|format|validate)|(db|database|drizzle|migrat\w*)[:_-](generate|gen|check))$/i;
const DB_FILE_BASENAME = /^(seed|migrate)[^/]*\.(ts|js|mjs|cjs|py|rb|sh|bash|zsh)$/i;
const DB_DIR = /\/(migrations|seeds)\//i;
const SCRIPT_EXT = /\.(ts|mts|cts|js|mjs|cjs|py|rb|sh|bash|zsh|sql)$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A DB CLI in command position inside free text (a pipe into sh, a dynamic command).
const DB_CMD_TEXT = new RegExp(`(^|[\\s'"\`;&|(){}=/!])(${[...DB_CLIS].filter((n) => n !== 'migrate' && n !== 'postgres').map(escapeRe).join('|')})(\\d[\\d.]*|-\\d+)?(?=$|[\\s'"\`;&|)}])`, 'i');
const ORM_TEXT = /\bprisma\s+(migrate|db\s|studio)|\bdrizzle-kit\s+(push|migrate|studio|drop|up|introspect|pull)|\b(db|database)[:_-](migrate|seed|push|reset|drop|studio|deploy|wipe|shell)\b|\b(knex|sequelize(-cli)?|typeorm|mikro-orm)\s+\S*(migrat|seed|schema|query)|\balembic\s+(upgrade|downgrade|stamp)|manage\.py\s+(migrate|dbshell|flush|loaddata)|\b(rake|rails)\s+db:|\bsupabase\s+(db|migration|seed)\b|\bartisan\s+(migrate|db:)|\becto\.(migrate|rollback|reset|drop)/i;
const OBFUSCATED = /\bbase64\s+(-d|--decode|-D)\b|\bxxd\s+-r|\brev\b|\bopenssl\s+(enc|base64)|\\x[0-9a-f]{2}|\\[0-7]{3}|\btr\s/i;
const DRIVER = /(require\s*\(\s*|from\s+|import\s*\(\s*|import\s+)['"](npm:|jsr:)?(pg|pg-promise|postgres|mysql2?|mariadb|mongodb|mongoose|redis|ioredis|better-sqlite3|sqlite3?|@prisma\/client|\.prisma\/client|drizzle-orm[^'"]*|knex|typeorm|sequelize|kysely|@neondatabase\/serverless|@planetscale\/database|@libsql\/client|@vercel\/postgres|@supabase\/supabase-js|@electric-sql\/pglite|bun:sqlite|duckdb|cassandra-driver|tedious|mssql|oracledb)['"]|\b(import|from)\s+(psycopg2?|asyncpg|pymysql|MySQLdb|mysql\.connector|sqlite3|sqlalchemy|pymongo|redis|duckdb|pg8000|cx_Oracle|pyodbc|motor|django\.db)\b|require\s*\(?\s*['"](pg|mysql2|sqlite3|sequel|redis|mongo|active_record)['"]|\bDBI\b|\bDBD::|\bnew\s+(PDO|mysqli)\b|\b(mysqli|pg)_connect\b|\bnew\s+PrismaClient\b|\bBun\.sql\b|\$(queryRaw|executeRaw)|import\s*\{[^}]*\b(sql|SQL)\b[^}]*\}\s*from\s*['"]bun['"]|\bnew\s+(Bun\.)?SQL\s*\(|\b(__import__|import_module)\s*\(\s*['"](psycopg2?|asyncpg|pymysql|MySQLdb|sqlite3|sqlalchemy|pymongo|redis|duckdb|pg8000)['"]/;
const DB_ENV = /\b[A-Z0-9_]*(DATABASE_URL|DB_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|MONGO(DB)?_UR[IL]|REDIS_URL|MYSQL_URL|DIRECT_URL|PGPASSWORD|PGHOST)\b/;
const EXEC_HINT = /exec|spawn|system|popen|subprocess|child_process|`|\$\(|Bun\.\$|\$`|Open3|shell_exec|passthru|proc_open|shell script/;
const EXEC_FLAG = /^(-c|-x|-e|--command|--cmd|--exec|--run|--eval|--execute|--pre|--pager|--shell-command)$/;

const MCP_ALLOW = new Set(['braintrust', 'langsmith', 'plugin_sentry_sentry', 'plugin_Notion_notion', 'claude_ai_Notion', 'claude_ai_Claude_Docs']);
const MCP_DB = /(postgres|mysql|supabase|neon|planetscale|turso|mongodb|redis|sqlite|database|bigquery|snowflake)/i;
const MCP_DB_SERVER = /(prisma|drizzle|cockroach|clickhouse|dynamo|firestore|cassandra|mssql|sqlserver|oracle|mariadb|timescale|xata|libsql|duckdb|motherduck|mongo|valkey|(^|_)(pg|db|sql)(_|$))/i;
const MCP_SQL = /^(execute_sql|run_sql|sql|query|sql_query|execute_query|run_query|query_database|apply_migration|list_tables|describe_table|migrate[\w-]*)$/i;

function looksDbCmd(t) {
  return DB_URL.test(t) || DB_CMD_TEXT.test(t) || ORM_TEXT.test(t);
}

function dbCode(code) {
  if (DB_URL.test(code)) return 'contains a database URL';
  if (DRIVER.test(code)) return 'loads a database driver';
  if (DB_ENV.test(code)) return 'reads a database connection variable';
  if (EXEC_HINT.test(code) && looksDbCmd(code)) return 'shells out to a DB CLI';
  return null;
}

const stripVersion = (n) => n.replace(/(?<=[a-z])[-_]?\d+(\.\d+)*$/, '');
const cliName = (w) => stripVersion(norm(w));

function isCliToken(a, set = ARG_CLIS) {
  if (a.startsWith('-') || !(/^[\w.@+-]+$/.test(a) || /^(\/|\.\.?\/)[\w.@+/-]+$/.test(a))) return false;
  return set.has(norm(a)) || set.has(cliName(a));
}

function isDbScript(s) {
  if (!s || SAFE_SCRIPT.test(s)) return false;
  return DB_SCRIPT.test(s) || DB_SCRIPT_SUFFIX.test(s) || isDbFile(s);
}

function isDbFile(p) {
  const s = '/' + String(p).replace(/\\/g, '/');
  return /\.(sql|psql|cql)$/i.test(s) || DB_DIR.test(s) || DB_FILE_BASENAME.test(path.posix.basename(s));
}

function scriptName(cmd, args) {
  const p = positionals(args, RUNNER_VALUE_FLAGS);
  switch (cmd) {
    case 'nr': return [p[0]];
    case 'ni': case 'npm':
      if (['run', 'run-script', 'rum', 'urn'].includes(p[0])) return [p[1]];
      return ['start', 'test', 't', 'tst', 'restart', 'stop'].includes(p[0]) ? [p[0] === 't' || p[0] === 'tst' ? 'test' : p[0]] : [];
    case 'bun': return p[0] === 'run' ? [p[1]] : BUN_BUILTINS.has(p[0]) ? [] : [p[0]];
    case 'pnpm': return p[0] === 'run' ? [p[1]] : [p[0]];
    case 'yarn': return p[0] === 'run' ? [p[1]] : p[0] === 'workspace' ? [p[2] === 'run' ? p[3] : p[2]] : [p[0]];
    case 'nx': return p[0] === 'run' ? [p[1]] : p[0] === 'migrate' ? [] : [p[0]];
    case 'turbo': return p[0] === 'run' ? p.slice(1) : p;
    default: return p;
  }
}

const pkgCache = new Map();
function readPkg(dir) {
  if (pkgCache.has(dir)) return pkgCache.get(dir);
  let found = null;
  for (let d = dir, k = 0; d && k < 10; k++) {
    try {
      found = { dir: d, scripts: JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).scripts || {} };
      break;
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') break;
    }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  pkgCache.set(dir, found);
  return found;
}

// Package directory the runner targets, or null when it can't be known (--filter).
function runnerDir(args, info) {
  if (args.some((a) => /^(--filter|-F|--workspace)(=|$)/.test(a)) || args[0] === 'workspace') return null;
  const d = flagValues(args, ['-C', '--dir', '--cwd', '--prefix'])[0];
  return d ? path.resolve(info.cwd || process.cwd(), d) : info.cwd || process.cwd();
}

// Walks the package.json bodies that `<runner> <name>` would run.
function scriptBody(names, args, info) {
  const dir = runnerDir(args, info);
  const pkg = dir && readPkg(dir);
  if (!pkg) return null;
  for (const n of names) {
    const body = pkg.scripts[n];
    if (typeof body !== 'string') continue;
    const r = walk(body, checkCommand, { depth: info.depth + 1, cwd: pkg.dir });
    if (r) return `package script \`${n}\` runs ${r}`;
  }
  return null;
}

function checkScripts(cmd, args, info) {
  const names = scriptName(cmd, args).filter(Boolean);
  const pkg = runnerDir(args, info) && readPkg(runnerDir(args, info));
  for (const s of names) {
    const isBin = ['bun', 'pnpm', 'yarn'].includes(cmd) && BIN_RULES.has(norm(s)) && !(pkg && s in pkg.scripts);
    if (!isBin && isDbScript(s)) return `package script \`${s}\``;
    const r = scriptBody([`pre${s}`, s, `post${s}`], args, info);
    if (r) return r;
  }
  const p = positionals(args, RUNNER_VALUE_FLAGS);
  const installs = (cmd === 'ni' && !p.length) || (['npm', 'pnpm', 'bun', 'yarn'].includes(cmd) && (['install', 'i', 'ci'].includes(p[0]) ? p.length === 1 : cmd === 'yarn' && !p.length));
  if (installs) return scriptBody(['preinstall', 'install', 'postinstall', 'prepare'], args, info);
  // `pnpm prisma migrate`, `yarn knex migrate:latest`, `bun drizzle-kit push` run the bin.
  if (cmd === 'yarn' && p[0] === 'workspace' && p[2] && p[2] !== 'run') {
    const at = args.indexOf(p[2], args.indexOf(p[1]) + 1);
    return checkCommand(args.slice(at), norm(p[2]), args.slice(at), info);
  }
  if (['bun', 'pnpm', 'yarn'].includes(cmd) && p[0] && !PM_BUILTINS.has(p[0]) && !INSTALL_VERBS.has(p[0])) {
    const at = args.indexOf(p[0]);
    return checkCommand(args.slice(at), norm(p[0]), args.slice(at), info);
  }
  return null;
}

function parseInterp(spec, args) {
  const code = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-') return { code, stdin: true, rest: [] };
    if (!a.startsWith('-') || a.length === 1) break;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if ((spec.long || []).includes(flag)) {
      code.push(eq > 0 ? a.slice(eq + 1) : args[++i] ?? '');
      i++;
      continue;
    }
    if (!a.startsWith('--')) {
      const letters = a.slice(1);
      const ci = [...letters].findIndex((ch) => spec.code.includes(ch));
      if (spec.module && letters[0] === spec.module) {
        const mod = letters.slice(1) || args[++i] || '';
        return { code, module: mod, rest: args.slice(i + 1) };
      }
      if (ci >= 0) {
        // `-pe CODE` / `-ne CODE` take the next arg; `-cCODE` carries it attached.
        const tail = letters.slice(ci + 1);
        code.push(tail && ![...tail].every((ch) => spec.code.includes(ch)) ? tail : args[++i] ?? '');
        i++;
        if (spec.module) break;
        continue;
      }
    }
    i += eq < 0 && (spec.value || []).includes(flag) ? 2 : 1;
  }
  const pos = args.slice(i);
  if (code.length) return { code, rest: pos };
  return { code, script: pos[0], rest: pos.slice(1), stdin: !pos.length };
}

function checkInterp(words, name, raw, info) {
  const args = words.slice(1);
  const spec = INTERP[name];
  let r;
  if (name === 'deno') {
    const p = positionals(args);
    r = p[0] === 'eval' ? { code: [p[1] || ''], rest: [] } : { code: [], script: p[0] === 'run' ? p[1] : undefined, rest: [] };
  } else r = parseInterp(spec, name === 'bun' && args[0] === 'run' ? args.slice(1) : args);
  for (const c of r.code) {
    const why = dbCode(c);
    if (why) return `inline \`${name}\` code that ${why}`;
  }
  if (r.module) {
    const mod = PY_MODULES[r.module] || r.module;
    return checkCommand([mod, ...r.rest], norm(mod), raw, info);
  }
  if (r.stdin) {
    const input = info.inputs.find(isDbFile) || (info.piped || '').split(/[\s'"<>|;&()]+/).find((t) => SCRIPT_EXT.test(t) && isDbFile(t));
    if (input) return `running DB script \`${input}\` through stdin`;
    for (const s of [...info.stdin, info.piped || '']) {
      const why = s && dbCode(s);
      if (why) return `\`${name}\` reading code from stdin that ${why}`;
    }
  }
  const f = positionals(args).find((a) => /\.(ts|mts|cts|js|mjs|cjs|py|rb)$/i.test(a) && isDbFile(a));
  if (f) return `running DB script \`${f}\``;
  return null;
}

function checkCommand(words, cmd, raw, info) {
  info = info || { depth: 0, stdin: [], inputs: [], text: '' };
  if (words === null) {
    if (looksDbCmd(info.opaque)) return `DB-looking command in ${info.why}`;
    const f = info.opaque.split(/[\s'"<>|;&()]+/).find((t) => SCRIPT_EXT.test(t) && isDbFile(t));
    return f ? `DB script \`${f}\` in ${info.why}` : null;
  }
  const args = words.slice(1);
  const name = stripVersion(cmd);
  const p = positionals(args);

  if (info.dynamic) {
    if (looksDbCmd(info.text) || OBFUSCATED.test(info.text)) return 'command name resolved at runtime alongside DB-looking or obfuscated content';
    return null;
  }
  if (!URL_EXEMPT.has(name) && raw.some((w) => DB_URL.test(w))) return 'database connection URL in command';
  if (URL_EXEMPT.has(name)) return null;

  if (DB_CLIS.has(cmd) || DB_CLIS.has(name)) return `\`${name}\` database CLI`;
  if (/[*?[]/.test(cmd) && cmd !== '[' && cmd !== '[[') {
    let re = null;
    try {
      re = new RegExp(`^${globRegex(cmd)}$`, 'i');
    } catch {}
    const hit = re && [...DB_CLIS].find((n) => re.test(n));
    if (hit) return `glob command \`${cmd}\` matches \`${hit}\``;
  }
  if (name === 'turso' && p[0] === 'db' && p[1] === 'shell') return '`turso db shell`';
  if (name === 'supabase' && ['db', 'migration', 'seed'].includes(p[0])) return `\`supabase ${p[0]}\``;
  if (name === 'pscale' && p[0] === 'shell') return '`pscale shell`';
  if (name === 'bq' && ['query', 'shell'].includes(p[0])) return `\`bq ${p[0]}\``;
  if (name === 'snow' && p[0] === 'sql') return '`snow sql`';
  if (name === 'clickhouse' && ['client', 'local'].includes(p[0])) return `\`clickhouse ${p[0]}\``;
  if (name === 'heroku' && /^pg:/.test(p[0] || '')) return `\`heroku ${p[0]}\``;
  if ((name === 'fly' || name === 'flyctl') && ['postgres', 'pg', 'mpg', 'redis'].includes(p[0])) return `\`${name} ${p[0]}\``;
  if (name === 'goose' && p[0] && !['create', 'fix'].includes(p[0])) return `\`goose ${p[0]}\``;

  if (name === 'prisma') {
    const sub = positionals(args, ['--schema'])[0];
    if (['migrate', 'db', 'studio', 'introspect'].includes(sub)) return `\`prisma ${sub}\``;
  }
  if (name === 'drizzle-kit') {
    const sub = (positionals(args, ['--config'])[0] || '').split(':')[0];
    if (['push', 'migrate', 'studio', 'drop', 'up', 'introspect', 'pull'].includes(sub)) return `\`drizzle-kit ${sub}\``;
  }
  if (name === 'knex' && /^(migrate|seed)/.test(p[0] || '')) return `\`knex ${p[0]}\``;
  if (name.startsWith('typeorm') && /^(migration|query|schema)/.test(p[0] || '')) return `\`typeorm ${p[0]}\``;
  if (/^sequelize(-cli)?$/.test(name) && /^(db|migration|seed):/.test(p[0] || '')) return `\`sequelize ${p[0]}\``;
  if (name === 'atlas' && (p[0] === 'migrate' || (p[0] === 'schema' && p[1] === 'apply'))) return `\`atlas ${p.slice(0, 2).join(' ')}\``;
  if (/^mikro-orm/.test(name) && /^(migration|schema|seeder|database)/.test(p[0] || '')) return `\`mikro-orm ${p[0]}\``;
  if (name === 'alembic' && ['upgrade', 'downgrade', 'revision', 'stamp'].includes(p[0])) return `\`alembic ${p[0]}\``;
  if ((name === 'sqlx' || name === 'diesel') && /^(migrat|database)/.test(p[0] || '')) return `\`${name} ${p[0]}\``;
  if ((name === 'rails' || name === 'rake') && p.some((a) => a.startsWith('db:') || (name === 'rails' && /^(dbconsole|db)$/.test(a)))) return `\`${name} db:*\``;
  if (name === 'mix' && /^ecto\./.test(p[0] || '') && !/^ecto\.gen/.test(p[0])) return `\`mix ${p[0]}\``;
  if (name === 'flask' && p[0] === 'db') return '`flask db`';
  if (name === 'dotnet' && p[0] === 'ef' && ['database', 'dbcontext'].includes(p[1])) return `\`dotnet ef ${p[1]}\``;

  const all = [cmd, ...p];
  const mi = all.findIndex((a) => a === 'manage.py' || a === 'django-admin');
  if (mi >= 0 && /^(migrate|makemigrations|sqlmigrate|dbshell|flush|loaddata|sqlflush|shell|shell_plus|runscript)$/.test(all[mi + 1] || '')) {
    return `Django \`${all[mi + 1]}\``;
  }
  const ai = all.findIndex((a) => a === 'artisan');
  if (ai >= 0 && /^(migrate|db|tinker|schema:)/.test(all[ai + 1] || '')) return `Laravel \`artisan ${all[ai + 1]}\``;

  if (SCRIPT_EXT.test(words[0]) && isDbFile(words[0])) return `running DB script \`${words[0]}\``;
  if (SHELL_CMDS.has(name)) {
    const script = p[0];
    if (script && isDbFile(script)) return `running DB script \`${script}\``;
    const input = info.inputs.find(isDbFile);
    if (input) return `running DB script \`${input}\``;
  }

  if (INTERP[name]) {
    const r = checkInterp(words, name, raw, info);
    if (r) return r;
  }

  if (SCRIPT_RUNNERS.has(name)) {
    const r = checkScripts(name, args, info);
    if (r) return r;
  }

  if (REMOTE_RUNNERS.has(name)) {
    const cli = args.find((a) => isCliToken(a, REMOTE_CLIS));
    if (cli) return `DB CLI via \`${name}\``;
    for (const a of args) {
      if (!a.includes(' ')) continue;
      const r = walk(a, checkCommand, { depth: info.depth + 1, cwd: info.cwd });
      if (r) return `${r} via \`${name}\``;
    }
  }

  // Unknown launchers (caffeinate psql, uv run --with x psql, foo --command '…').
  if (!DATA_CMDS.has(name) && !SCRIPT_RUNNERS.has(name) && !INTERP[name] && !SHELL_CMDS.has(name)) {
    if (!INSTALL_VERBS.has(p[0]) && !INSTALL_VERBS.has(p[1])) {
      const cli = args.find((a) => isCliToken(a));
      if (cli) return `\`${cliName(cli)}\` launched via \`${name}\``;
    }
    for (let i = 0; i < args.length; i++) {
      const eq = args[i].startsWith('--') ? args[i].indexOf('=') : -1;
      const flag = eq > 0 ? args[i].slice(0, eq) : args[i];
      if (!EXEC_FLAG.test(flag)) continue;
      const v = eq > 0 ? args[i].slice(eq + 1) : args[i + 1] || '';
      if (looksDbCmd(v)) return `DB command passed to \`${name} ${flag}\``;
    }
  }
  return null;
}

function checkBash(command, cwd) {
  try {
    return walk(command, checkCommand, { cwd });
  } catch (e) {
    // Unparseable: deny only when the text itself looks like DB access.
    if (looksDbCmd(command)) return 'command could not be parsed and contains DB-looking content';
    process.stderr.write(`[db-guard] could not parse Bash command, allowing: ${e && e.message}\n`);
    return null;
  }
}

function check(toolName, input, cwd) {
  input = input || {};
  // Writing SQL/migration/seed files is allowed; only running them (Bash) or DB tools are blocked.
  if (toolName === 'Bash') return checkBash(String(input.command || ''), cwd);
  if (toolName.startsWith('mcp__')) {
    // Exact server match: a prefix would also allow e.g. mcp__plugin_sentry_postgres__query.
    const m = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__(.+)$/.exec(toolName);
    const server = m ? m[1] : toolName.slice(5);
    const tool = m ? m[2] : toolName;
    if (MCP_ALLOW.has(server) && /^[A-Za-z0-9-]+(_[A-Za-z0-9-]+)*$/.test(tool)) return null;
    const segments = tool.split('__').map((s) => s.replace(/^_+/, ''));
    if (MCP_DB.test(toolName) || MCP_DB_SERVER.test(server) || segments.some((s) => MCP_SQL.test(s))) return `database MCP tool \`${toolName}\``;
    if (typeof input.sql === 'string') return `MCP tool \`${toolName}\` called with SQL`;
  }
  if (typeof input.command === 'string') return checkBash(input.command, cwd);
  return null;
}

function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const match = check(String(data.tool_name || ''), data.tool_input, typeof data.cwd === 'string' ? data.cwd : undefined);
  if (!match) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `DB guard: ${match}. Hard rule — I never run database scripts or queries (writing .sql files is fine; running them is not). Write a data request for the user instead: what data is needed, why, and how the result changes the plan. Never propose or run a query — the user handles all database access.`,
    },
  }));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`[db-guard] internal error, allowing: ${e && e.message}\n`);
  }
  process.exit(0);
}

module.exports = { check };
