#!/bin/bash
# PreToolUse(Read) guard: block reads of .env files.
# Replaces the `Read(**/.env)` permissions.deny rules, which trigger spurious
# "This command requires approval" prompts on `cd X && cat Y` compounds in
# Claude Code >= 2.1.259 (even in bypass mode).
# Exit 2 = deny the tool call; stderr is shown to Claude.

path=$(python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("file_path", ""))
except Exception:
    print("")' 2>/dev/null)

case "$(basename "$path")" in
  .env.example|.env.sample|.env.template|.env.dist)
    exit 0
    ;;
  .env|.env.*)
    echo "Blocked: $path is an environment file and may contain secrets. Read .env.example instead, or ask the user for the value." >&2
    exit 2
    ;;
esac

exit 0
