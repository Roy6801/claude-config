#!/usr/bin/env bun
// Launch and resume commands for a Claude workspace (a config dir such as ~/.claude-<name>).
// Prefers the user's shell alias for that workspace (found by scanning zsh functions and aliases
// for one that names the dir); without one, falls back to an explicit CLAUDE_CONFIG_DIR invocation
// so the command still opens the right workspace instead of the default ~/.claude.
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

export type Launcher = { workspace: string; dir: string; alias: string | null; prefix: string };

const HOME = homedir();
const tilde = (p: string) => (p === HOME || p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p);
const quote = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;

// Runs in an interactive zsh so ~/.zshrc is loaded; WS_NAME is passed through the environment to avoid quoting.
const FIND_ALIAS = `for k in \${(k)functions} \${(k)aliases}; do
  [[ $k == _* ]] && continue
  v=\${functions[$k]-\${aliases[$k]}}
  [[ $v == */"$WS_NAME" || $v == */"$WS_NAME"[^-_.[:alnum:]]* ]] && { print -r -- $k; break; }
done`;

function findAlias(dir: string): string | null {
  const shell = process.env.SHELL ?? "";
  if (!basename(shell).includes("zsh")) return null;
  const proc = Bun.spawnSync([shell, "-ic", FIND_ALIAS], {
    env: { ...process.env, WS_NAME: basename(dir) },
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5000,
  });
  const name = proc.stdout.toString().trim().split("\n").pop()?.trim();
  return name && /^[\w-]+$/.test(name) ? name : null;
}

export function launcher(configDir?: string): Launcher {
  const dir = resolve(configDir ?? process.env.CLAUDE_CONFIG_DIR ?? resolve(import.meta.dir, ".."));
  const workspace = basename(dir).replace(/^\.claude-?/, "") || "default";
  const alias = findAlias(dir);
  if (!alias) console.error(`launch: no shell alias found for ${tilde(dir)}; using the full command`);
  const prefix = alias ? `${alias} -d` : `CLAUDE_CONFIG_DIR=${tilde(dir)} claude --dangerously-skip-permissions`;
  return { workspace, dir, alias, prefix };
}

// `terminal` starts a new session; `inSession` is plain text for any open session, carrying the workspace
// so a session in a different workspace knows which config dir to look in.
export function resumeLines(name: string, l: Launcher = launcher()) {
  return {
    terminal: `${l.prefix} --resume ${quote(name)}`,
    inSession: `resume ${quote(name)} · workspace: ${l.workspace} (${tilde(l.dir)})`,
  };
}

export const startLine = (prompt: string, l: Launcher = launcher()) => `${l.prefix} ${quote(prompt)}`;
export const openLine = (path: string, l: Launcher = launcher()) => `cd ${path} && ${l.prefix}`;

const USAGE = `usage: launch [--dir <config dir>] <command>
  prefix                 launch prefix for the workspace (alias -d, or the full command)
  resume <name>          terminal and in-session resume lines for a named session or initiative
  start <prompt>         terminal line that starts a new session with <prompt>
  open <path>            terminal line that opens a new session in <path>`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--dir");
  const dir = i >= 0 ? argv.splice(i, 2)[1] : undefined;
  const [cmd, arg] = argv;
  if (!cmd || (cmd !== "prefix" && !arg)) {
    console.error(USAGE);
    process.exit(2);
  }
  const l = launcher(dir);
  if (cmd === "prefix") console.log(l.prefix);
  else if (cmd === "resume") {
    const r = resumeLines(arg!, l);
    console.log(`terminal:   ${r.terminal}\nin session: ${r.inSession}`);
  } else if (cmd === "start") console.log(startLine(arg!, l));
  else if (cmd === "open") console.log(openLine(arg!, l));
  else {
    console.error(USAGE);
    process.exit(2);
  }
}
