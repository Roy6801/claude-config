---
name: computer-use-setup
description: Set up the Claude Codex Computer Use plugin so Claude Code controls macOS apps through the OpenAI Computer Use service.
disable-model-invocation: true
metadata:
  origin: local
---

# Computer Use setup

- Installs `claude-codex-computer-use` (third-party, MIT, https://github.com/songkeys/claude-codex-computer-use) for this workspace, wires its launcher path, and tests it.
- Settings live in `$CLAUDE_CONFIG_DIR/settings.json`.
- The plugin's code stays as published.

## Steps

1. **Start** (sequential)
   - Read the plugin's README (`gh api repos/songkeys/claude-codex-computer-use/readme --jq .content | base64 -d`); where it differs from these steps, follow it and say so.
   - Check each prerequisite, and stop with the failing one named:
     - macOS, with `node` on PATH.
     - ChatGPT in `/Applications`, with Computer Use turned on and used once from ChatGPT, so that `${CODEX_HOME:-~/.codex}/computer-use/Codex Computer Use.app` exists.
2. **Install** (sequential)
   - With `claude plugin --help` listing the commands, run `claude plugin marketplace add songkeys/claude-codex-computer-use` and `claude plugin install claude-codex-computer-use@songkeys`.
   - Without them, give the user `/plugin marketplace add songkeys/claude-codex-computer-use` and `/plugin install claude-codex-computer-use@songkeys` to type.
3. **Launcher** (sequential)
   - Find candidates: `find /Applications/ChatGPT.app -type f -name codex -perm -u+x`.
   - Pick the signed native binary (`file` says Mach-O; `codesign -dv` shows a TeamIdentifier), usually `…/codex-cli/CodexCLI.app/Contents/MacOS/codex`. A `codex` that `file` reports as a shell script is a wrapper.
   - When it is not at `/Applications/ChatGPT.app/Contents/Resources/codex`, merge `"COMPUTER_USE_CODEX_LAUNCHER_PATH": "<path>"` into the `env` block of `$CLAUDE_CONFIG_DIR/settings.json` with `jq`, keeping every existing key.
   - Gate: the plugin is enabled in `settings.json` and the launcher path is set or default.
4. **End** (sequential)
   - Tell the user to restart Claude Code (to load the env value and the MCP server), with the resume line from `bun $CLAUDE_CONFIG_DIR/bin/launch.ts resume <session>`.
   - After the restart: load the tools with ToolSearch (query `claude-codex-computer-use`), call `get_app_state` on Finder. Passes when it returns Finder's window tree; anything else is a failure.
   - On failure: read the README's troubleshooting section, rerun with `COMPUTER_USE_BRIDGE_DEBUG=1`, and report the exact error.
