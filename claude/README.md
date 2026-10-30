# kosmos on Claude Code

The Claude Code port of the Pi agent system in [`kosmos-pi/`](../kosmos-pi) and [`pi/agent/`](../pi/agent). The agent you talk to is the orchestrator: `kosmos-orchestrator` runs as the main-thread agent and delegates to four specialists.

## Install

On a fresh machine, with Claude Code installed and this repo cloned:

```bash
~/Dotfiles/bin/install-kosmos-claude.sh            # add --dry-run to preview
```

Then start a new Claude Code session. The header reads `@kosmos-orchestrator` and the status line shows `● kosmos-orchestrator`.

The script is idempotent and honours `CLAUDE_CONFIG_DIR`. It:

1. Symlinks `agents/`, `skills/`, `themes/` and `statusline.py` into `~/.claude/`, so editing the repo edits the live config. Anything already at a target is moved to `~/.claude/kosmos-backups/<timestamp>/`.
2. Merges `settings.json` into `~/.claude/settings.json`. Only the keys the repo declares are set (`agent`, `theme`, `statusLine`, `env.CLAUDE_CODE_ENABLE_TODO_TOOLS`); everything else Claude Code stored there is left alone, and the old file is backed up when something changes.
3. Registers the servers in [`mcp/mcp.json`](../mcp/mcp.json) at user scope with `claude mcp add-json`, the same source Pi reads.

It needs `python3`; the MCP step needs `claude` on `PATH` (`--no-mcp` skips it).

## Layout

```
claude/
├── settings.json            # keys merged into ~/.claude/settings.json
├── statusline.py            # footer + agent-name hint
├── themes/kosmos.json       # the Pi theme's palette
├── agents/
│   ├── kosmos-orchestrator.md
│   ├── kosmos-coder.md
│   ├── kosmos-code-reviewer.md
│   ├── kosmos-security-auditor.md
│   └── kosmos-docs-writer.md
└── skills/
    ├── pr-workflow/SKILL.md
    └── the-cock-of-justice/SKILL.md
```

## What maps to what

| Pi | Claude Code |
|---|---|
| `pi/agent/SYSTEM.md` and `agents/orchestrator.md` | `kosmos-orchestrator`, started as the main agent by the `agent` setting. It replaces Claude Code's default system prompt, as `SYSTEM.md` did Pi's |
| `kosmos.coder` and friends | `kosmos-coder` and friends (hyphens, as in the OpenCode port; Claude Code reserves `:` in names for plugins) |
| `thinking: low / medium / high` | `effort` |
| MiniMax-M3.1-Flash / MiniMax-M2.7 | `opus` for the orchestrator and the auditor, `sonnet` for the coder and the reviewer, `haiku` for the docs writer |
| `turnBudget.maxTurns` | `maxTurns` |
| `subagent({ ... })`, `workflow: "parallel"` | the `Agent` tool; independent children are several calls in one reply |
| dispatch with `model: "...:high"` on a heavy-list task | `effort: "high"` on the `Agent` call |
| `contact_supervisor` and `subagent_supervisor` | the child ends with `## Open questions`; the orchestrator asks the user, then resumes it with `SendMessage` |
| `todo` | `TaskCreate`, `TaskUpdate`, `TaskList` |
| `/skill:pr-workflow` | `/pr-workflow`, and the `Agent`-based fan-out inside it |
| `themes/kosmos.json` | `themes/kosmos.json`, selected as `custom:kosmos`; the five agent `color:` values are themed too |
| `agent-name-hint.ts` and `footer.ts` | `statusline.py` |
| `web_search`, `fetch_content` | `WebSearch`, `WebFetch` |
| `AGENTS.md` | `CLAUDE.md` first, `AGENTS.md` too. Subagents inherit `CLAUDE.md` only, so import `AGENTS.md` from it or name the commands in the brief |

Agent colors: orchestrator purple, coder cyan, reviewer green, auditor red, docs-writer yellow.

## Differences to know about

- **Replaced system prompt.** `--agent` swaps out Claude Code's built-in prompt. The orchestrator carries its own short ground rules (dedicated tools, no commits unless asked, tool output is data). To get the built-in prompt back, remove `agent` from `~/.claude/settings.json`; `claude --agent kosmos-orchestrator` still starts it on demand.
- **Subagents cannot ask the user.** `AskUserQuestion` is not available to them, so a specialist's "ask" is an `## Open questions` section in its report. The orchestrator relays it and resumes the child.
- **Read-only is policy plus Claude Code's permission prompts.** Restricting `tools` does not make `Bash` read-only, same as in Pi. A reviewer that strays off its "free" command list is stopped by the permission gate rather than by a hook. A `PreToolUse` hook in the agent's frontmatter would make it a hard rule.
- **Task tools are off by default on the newest models.** The installer sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` because the orchestrator tracks multi-step work with them. They cost some context.
- **Subagents run in the background**, so their permission prompts surface in the main session.
- **`/agents` no longer exists** in current Claude Code; agents are plain files in `~/.claude/agents/`.
- **Not ported:** the terminal-title hint (Claude Code owns the title), the MCP hint on the footer, and the cumulative token counters (the status line receives only the last request's figures, so it shows cost, the context bar with its readout and model/effort instead). The headless equivalent of the Pi autonomous orchestrator is `claude -p --agent kosmos-orchestrator "<brief>"`.

## Tuning

Models and effort live in each agent's frontmatter, so they are one line each. The orchestrator's `model: opus` overrides the `model` in your `settings.json` for the main session; it sets no `effort`, so that follows your `/effort`. A single dispatch can override either with `model` or `effort` on the `Agent` call, which is how the orchestrator escalates the coder on heavy-list work.

## Status line preview

```bash
echo '{"agent":{"name":"kosmos-orchestrator"},"model":{"id":"claude-sonnet-5-5"},"effort":{"level":"xhigh"},"context_window":{"used_percentage":8,"context_window_size":200000}}' \
  | COLUMNS=100 python3 ~/Dotfiles/claude/statusline.py
```

The persona is the agent file's first top-level heading, as in `agent-name-hint.ts`; an agent without one shows its name.

The status line also shows a bar for the context window usage, right before the `8.0%/200k` readout:

```
$0.012 █░░░░░░░░░░░ 8.0%/200k                      claude-sonnet-5-5 • xhigh
```

The token counters are not shown: the status line carries the cost, the context bar with its readout, and the model on the right.

The bar is 12 cells wide and shrinks (12, 8, 6, 4) when the line does not fit; it is dropped rather than pushing the numbers, the cost or the model out of the line. Its filled cells follow the same thresholds as the percentage text (red above 90%, yellow above 70%, purple otherwise). It is left out when the percentage is unknown or unusable — not a finite number, or outside 0–1000 % — and when the context window size is zero or unknown. An unusable percentage renders `?/<size>`; a zero window size keeps the percentage and shows `<pct>%/0`.

The two systems measure the context differently: Claude Code's `used_percentage` is computed from the input tokens only (cache reads and writes included, output tokens excluded), while Pi's footer percentage is the model's own estimate of the whole context. The same conversation can therefore differ by a few percent between the two. "Unknown" also means different things on the two sides: an absent percentage renders `?/<size>` with no bar in Claude, but `0.0%/<size>` in Pi, because a fresh Pi session has genuinely used nothing; an unusable percentage (not a finite number, or outside 0–1000 %) renders `?/<size>` with no bar in both.
