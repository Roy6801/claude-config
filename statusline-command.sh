#!/usr/bin/env bash
input=$(cat)

cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd')
model=$(echo "$input" | jq -r '.model.display_name')
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
ctx_tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
ctx_size=$(echo "$input" | jq -r '.context_window.context_window_size // empty')
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
transcript=$(echo "$input" | jq -r '.transcript_path // empty')

# Compact token formatting: 1234 -> 1.2k, 1234567 -> 1.2M
fmt_tokens() {
  awk -v n="$1" 'BEGIN {
    if (n >= 1000000) s = sprintf("%.1fM", n / 1000000)
    else if (n >= 1000) s = sprintf("%.1fk", n / 1000)
    else s = sprintf("%d", n)
    sub(/\.0/, "", s); print s
  }'
}

# Shorten cwd: replace $HOME with ~
home="$HOME"
case "$cwd" in "$home"|"$home"/*) short_cwd="~${cwd#"$home"}" ;; *) short_cwd="$cwd" ;; esac

# Git branch (skip optional locks)
git_branch=""
if git -C "$cwd" rev-parse --git-dir --no-optional-locks > /dev/null 2>&1; then
  branch=$(git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" rev-parse --short HEAD 2>/dev/null)
  if [ -n "$branch" ]; then
    git_branch=" $branch"
    # Check for active PR on this branch
    pr_num=$(gh pr view --json number -q '.number' 2>/dev/null)
  fi
fi

# Context usage: 10-segment bar (10% each); full segments red, filling segment yellow, empty gray
ctx_info=""
if [ -n "$used" ] && [ "$used" != "null" ]; then
  used_int=$(printf "%.0f" "$used")
  [ "$used_int" -gt 100 ] && used_int=100
  full=$(( used_int / 10 ))
  partial=$(( used_int % 10 ))
  bar=""
  for ((i = 0; i < 10; i++)); do
    if [ "$i" -lt "$full" ]; then
      bar+="\033[31m"
    elif [ "$i" -eq "$full" ] && [ "$partial" -gt 0 ]; then
      bar+="\033[33m"
    else
      bar+="\033[38;5;238m"
    fi
    bar+="◢◤"
  done
  if [ -n "$ctx_tokens" ] && [ -n "$ctx_size" ]; then
    ctx_info="  ${bar}\033[0m $(fmt_tokens "$ctx_tokens")/$(fmt_tokens "$ctx_size") (${used_int}%)"
  else
    ctx_info="  ${bar}\033[0m ${used_int}%"
  fi
fi

# Session cost (client-side estimate at list price)
cost_info=""
if [ -n "$cost" ]; then
  cost_info="  \033[35m\$$(printf "%.2f" "$cost")\033[0m"
fi

# Session token totals, summed from transcript usage (deduped by message id;
# streamed responses log one entry per content block with the same usage)
tok_info=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  read -r tok_in tok_out < <(jq -rn '
    reduce (inputs | select(.type == "assistant" and .message.usage != null and .message.id != null)
            | {key: .message.id, value: .message.usage}) as $e ({}; .[$e.key] = $e.value)
    | [.[]] as $u
    | [($u | map((.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)) | add // 0),
       ($u | map(.output_tokens // 0) | add // 0)]
    | @tsv' "$transcript" 2>/dev/null)
  if [ -n "$tok_in" ]; then
    tok_info="  \033[90mtok $(fmt_tokens "$tok_in")/$(fmt_tokens "$tok_out")\033[0m"
  fi
fi

# Skills audit: counts from the cached upstream scan + refine queue (bin/skills-audit.ts).
# Shows only non-zero counts; 'check failed' = last scan had errors. Act on them with /skills.
config_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sk_cache="$config_dir/cache/skills-audit.json"
sk_queue="$config_dir/state/skill-refine-queue.json"
sk_info=""
read -r sk_up sk_rm sk_mv sk_new sk_ref sk_err sk_clash < <(cat "$sk_cache" "$sk_queue" 2>/dev/null | jq -rs '
  (map(select(has("checkedAt")))[0] // {}) as $c
  | ((map(select(has("items")))[0].items) // []) as $q
  | [($c.update // [] | length), ($c.removed // [] | length), ($c.moved // [] | length),
     ($c.new // [] | length), ($q | length), ($c.errors // [] | length), ($c.clashes // [] | length)]
  | @tsv' 2>/dev/null)
sk_parts=()
[ "${sk_up:-0}" -gt 0 ] && sk_parts+=("$sk_up updates")
[ "${sk_rm:-0}" -gt 0 ] && sk_parts+=("\033[33m$sk_rm removed\033[90m")
[ "${sk_mv:-0}" -gt 0 ] && sk_parts+=("$sk_mv moved")
[ "${sk_new:-0}" -gt 0 ] && sk_parts+=("$sk_new new")
[ "${sk_ref:-0}" -gt 0 ] && sk_parts+=("\033[33m$sk_ref to refine\033[90m")
[ "${sk_clash:-0}" -gt 0 ] && sk_parts+=("\033[33m$sk_clash name clash$([ "$sk_clash" -gt 1 ] && echo es)\033[90m")
[ "${sk_err:-0}" -gt 0 ] && sk_parts+=("\033[31mcheck failed\033[90m")
if [ ${#sk_parts[@]} -gt 0 ]; then
  sk_joined=$(printf ' · %s' "${sk_parts[@]}")
  sk_info="  \033[90mskills: ${sk_joined:3}\033[0m"
fi

# Background rescan when the cache is missing or stale (24h, or 1h after a failed scan).
# mkdir is the lock so concurrent renders start one scan; a lock older than 10 min is stale.
sk_age=$(( $(date +%s) - $(stat -f %m "$sk_cache" 2>/dev/null || echo 0) ))
sk_ttl=86400
[ "${sk_err:-0}" -gt 0 ] && sk_ttl=3600
if [ "$sk_age" -gt "$sk_ttl" ]; then
  sk_lock="$config_dir/cache/skills-audit.lock"
  if [ -d "$sk_lock" ] && [ $(( $(date +%s) - $(stat -f %m "$sk_lock" 2>/dev/null || echo 0) )) -gt 600 ]; then
    rmdir "$sk_lock" 2>/dev/null
  fi
  if mkdir -p "$config_dir/cache" 2>/dev/null && mkdir "$sk_lock" 2>/dev/null; then
    sk_bun=$(command -v bun || echo "$HOME/.bun/bin/bun")
    ( "$sk_bun" "$config_dir/bin/skills-audit.ts" scan; rmdir "$sk_lock" ) </dev/null >/dev/null 2>&1 &
    disown
  fi
fi

# Pair: current slice/total · commits done/planned · net lines/budget, from the pair.json of
# the cwd's initiative (active.json: exact cwd or longest parent; written by skills/pair).
# Stored values only (no bun, no git); hidden without pair.json, "pair off" when mode is off.
pair_info=""
pair_active="$config_dir/state/work/active.json"
if [ -f "$pair_active" ] && [ ! -L "$pair_active" ]; then
  pair_real=$(cd "$cwd" 2>/dev/null && pwd -P)
  pair_slug=$(jq -r --arg a "$cwd" --arg b "${pair_real:-$cwd}" '
    to_entries
    | map(select(.key as $k | [$a, $b] | any(. == $k or startswith($k + "/"))))
    | max_by(.key | length) | .value.slug // empty
    | select(test("^[a-z0-9]+(-[a-z0-9]+)*$"))' "$pair_active" 2>/dev/null)
  pair_file="$config_dir/state/work/$pair_slug/pair.json"
  if [ -n "$pair_slug" ] && [ -f "$pair_file" ] && [ ! -L "$pair_file" ]; then
    IFS='|' read -r p_mode p_n p_total p_done p_planned p_net p_budget p_status < <(jq -r '
      (.slices // []) as $s
      | ([$s[] | select(.status == "active" or .status == "checkpoint")][0]
         // [$s[] | select(.status == "todo")][0] // $s[-1]) as $c
      | [(.mode // "on"), ($c.n // 0), ($s | length),
         ([$c.commits[]? | select(.extra != true and .status == "done")] | length),
         ([$c.commits[]? | select(.extra != true)] | length),
         ($c.net_lines // ""), ($c.budget.net_lines // ""), ($c.status // "")]
      | map(tostring) | join("|")' "$pair_file" 2>/dev/null)
    if [ "$p_mode" = "off" ]; then
      pair_info="  \033[90mpair off\033[0m"
    elif [ "${p_total:-0}" -gt 0 ] 2>/dev/null; then
      if [ "$p_status" = "done" ]; then
        pair_info="  \033[90mpair ${p_n}/${p_total} · done\033[0m"
      else
        p_lines=""
        if [[ "$p_net" =~ ^-?[0-9]+$ ]]; then
          [ "$p_net" -ge 0 ] && p_net="+$p_net"
          p_lines=" · $p_net"
          [[ "$p_budget" =~ ^[0-9]+$ ]] && p_lines+="/$p_budget"
          [[ "$p_budget" =~ ^[0-9]+$ ]] && [ "${p_net#+}" -gt "$p_budget" ] && p_lines=" · \033[31m${p_lines:3}\033[90m"
        fi
        p_cp=""
        [ "$p_status" = "checkpoint" ] && p_cp=" · checkpoint"
        pair_info="  \033[90mpair ${p_n}/${p_total} · ${p_done}/${p_planned}${p_lines}${p_cp}\033[0m"
      fi
    fi
  fi
fi

stats="${ctx_info}${cost_info}${tok_info}${sk_info}${pair_info}"

if [ -n "$pr_num" ]; then
  printf "\033[34m%s\033[0m\033[90m%s \033[32mPR #%s\033[0m  \033[33m%s\033[0m%b" \
    "$short_cwd" "$git_branch" "$pr_num" "$model" "$stats"
else
  printf "\033[34m%s\033[0m\033[90m%s\033[0m  \033[33m%s\033[0m%b" \
    "$short_cwd" "$git_branch" "$model" "$stats"
fi
