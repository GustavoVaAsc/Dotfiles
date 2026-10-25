#!/usr/bin/env python3
"""Kosmos status line for Claude Code.

Port of the two Pi extensions in pi/agent/extensions/:

  footer.ts          the cwd (branch) line and the stats line with the model on
                     the right
  agent-name-hint.ts the active persona, taken from the first heading of the
                     agent's prompt

Claude Code runs this on every update and pipes the session JSON to stdin
(https://code.claude.com/docs/en/statusline). The output is three lines:

  ~/Dotfiles (main) • my-session
  CH91.0% $0.012 8.0%/200k                           claude-sonnet-5-5 • xhigh
  ● kosmos.orchestrator — lead mode

Preview without launching Claude Code:

  echo '{"agent":{"name":"kosmos-orchestrator"},"model":{"id":"claude-sonnet-5-5"}}' \\
    | COLUMNS=80 python3 claude/statusline.py

Colours are the Pi theme's palette (claude/themes/kosmos.json). NO_COLOR turns
them off.
"""
import json
import os
import re
import shutil
import sys
import unicodedata
from pathlib import Path

ACCENT = (168, 85, 247)  # purple: the persona dot
DIM = (216, 180, 254)  # purplePastel: the footer's "dim"
WARNING = (250, 204, 21)
ERROR = (248, 113, 113)

# Claude Code indents the status line by two columns; leave the same on the
# right so the model on line 2 is not cut off with an ellipsis.
MARGIN = 4
MIN_PADDING = 2
FALLBACK_PERSONA = "Claude Code"

ANSI = re.compile(r"\033\[[0-9;]*m")


def paint(rgb, text):
    if os.environ.get("NO_COLOR") or not text:
        return text
    return "\033[38;2;%d;%d;%dm%s\033[39m" % (rgb + (text,))


def visible_width(text):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in ANSI.sub("", text))


def truncate(text, width, ellipsis="..."):
    """Cut plain text to `width` columns, ending in the ellipsis when cut."""
    if visible_width(text) <= width:
        return text
    keep = max(0, width - len(ellipsis))
    out = ""
    for char in text:
        if visible_width(out + char) > keep:
            break
        out += char
    return out + ellipsis


def format_tokens(count):
    """Token formatting, same as Pi's footer."""
    if count < 1000:
        return str(int(count))
    if count < 10000:
        return "%.1fk" % (count / 1000)
    if count < 1000000:
        return "%dk" % round(count / 1000)
    if count < 10000000:
        return "%.1fM" % (count / 1000000)
    return "%dM" % round(count / 1000000)


def format_cwd(cwd, home):
    """Home-relative with a leading ~, same as Pi's footer."""
    try:
        relative = Path(cwd).resolve().relative_to(Path(home).resolve())
    except (ValueError, OSError):
        return cwd
    return "~" if str(relative) == "." else "~/%s" % relative


def git_branch(cwd):
    """Read the branch from .git/HEAD; git itself is never run, so a hostile
    repository config cannot execute anything from the status line."""
    start = Path(cwd)
    head = None
    for directory in [start] + list(start.parents):
        dotgit = directory / ".git"
        try:
            if dotgit.is_dir():
                head = dotgit / "HEAD"
                break
            if dotgit.is_file():  # linked worktree or submodule
                match = re.match(r"gitdir:\s*(.+)", dotgit.read_text().strip())
                if not match:
                    return None
                gitdir = Path(match.group(1))
                head = (gitdir if gitdir.is_absolute() else directory / gitdir) / "HEAD"
                break
        except OSError:
            return None
    if head is None:
        return None
    try:
        content = head.read_text().strip()
    except OSError:
        return None
    if content.startswith("ref: refs/heads/"):
        return content[len("ref: refs/heads/"):]
    if content.startswith("ref: "):
        return content[len("ref: "):]
    return content[:7] or None  # detached HEAD


def derive_persona(prompt):
    """Port of agent-name-hint.ts derivePersona.

    Skip YAML frontmatter and fenced code, then take the first top-level
    heading (at most 48 chars). Pi's version also took a `##` heading or the
    first sentence, but the specialist prompts have no H1 and start with
    `## Mission` or `## Shell`, so the caller falls back to the agent's name.
    """
    in_frontmatter = False
    in_fence = False
    for raw in prompt.split("\n"):
        line = raw.strip()
        if line == "---" and not in_fence:
            in_frontmatter = not in_frontmatter
            continue
        if in_frontmatter:
            continue
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        heading = re.match(r"^#\s+(.+?)\s*$", line)
        if heading:
            cleaned = re.sub(r"[`*_]", "", heading.group(1)).strip()
            if cleaned:
                return cleaned[:48]
    return None


def persona_for(agent_name, config_dir, project_dir):
    if not agent_name:
        return FALLBACK_PERSONA
    # A project agent overrides a user agent of the same name.
    for base in (Path(project_dir) / ".claude" / "agents", Path(config_dir) / "agents"):
        path = base / ("%s.md" % agent_name)
        try:
            if path.is_file():
                return derive_persona(path.read_text()) or agent_name
        except OSError:
            continue
    return agent_name


def render(data, width):
    workspace = data.get("workspace") or {}
    cwd = workspace.get("current_dir") or data.get("cwd") or os.getcwd()
    project_dir = workspace.get("project_dir") or cwd
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR") or str(Path.home() / ".claude")

    # Line 1: cwd (branch) • session name
    pwd = format_cwd(cwd, os.environ.get("HOME") or os.environ.get("USERPROFILE"))
    branch = git_branch(cwd)
    if branch:
        pwd = "%s (%s)" % (pwd, branch)
    if data.get("session_name"):
        pwd = "%s • %s" % (pwd, data["session_name"])
    line1 = paint(DIM, truncate(pwd, width))

    # Line 2: cache, cost and context on the left; model and effort on the right.
    stats = []
    hit_ratio = (data.get("prompt_cache") or {}).get("hit_ratio")
    if isinstance(hit_ratio, (int, float)):
        stats.append("CH%.1f%%" % (hit_ratio * 100))
    cost = (data.get("cost") or {}).get("total_cost_usd")
    if cost:
        stats.append("$%.3f" % cost)
    window = data.get("context_window") or {}
    percent = window.get("used_percentage")
    size = format_tokens(window.get("context_window_size") or 0)
    context = ("%.1f%%/%s" % (percent, size)) if isinstance(percent, (int, float)) else "?/%s" % size
    stats.append(context)

    left_plain = truncate(" ".join(stats), width)
    context_color = ERROR if (percent or 0) > 90 else WARNING if (percent or 0) > 70 else DIM
    if left_plain.endswith(context) and context_color is not DIM:
        head = left_plain[: len(left_plain) - len(context)]
        left = paint(DIM, head) + paint(context_color, context)
    else:
        left = paint(DIM, left_plain)

    model = (data.get("model") or {}).get("id") or "no-model"
    effort = (data.get("effort") or {}).get("level")
    right_plain = "%s • %s" % (model, effort) if effort else model
    left_width = visible_width(left_plain)
    if left_width + MIN_PADDING + visible_width(right_plain) <= width:
        line2 = left + " " * (width - left_width - visible_width(right_plain)) + paint(DIM, right_plain)
    else:
        available = width - left_width - MIN_PADDING
        right_plain = truncate(right_plain, available, "") if available > 0 else ""
        line2 = left + (" " * (MIN_PADDING) + paint(DIM, right_plain) if right_plain else "")

    # Line 3: the agent hint.
    persona = persona_for((data.get("agent") or {}).get("name"), config_dir, project_dir)
    line3 = "%s %s" % (paint(ACCENT, "●"), truncate(persona, width - 2))

    return [line1, line2, line3]


def main():
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            data = {}
    except (ValueError, OSError):
        data = {}
    columns = os.environ.get("COLUMNS")
    width = int(columns) if columns and columns.isdigit() else shutil.get_terminal_size((80, 24)).columns
    try:
        lines = render(data, max(20, width - MARGIN))
    except Exception:  # a status line must never break the session
        lines = ["%s %s" % (paint(ACCENT, "●"), FALLBACK_PERSONA)]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
