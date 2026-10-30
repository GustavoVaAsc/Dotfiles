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
  $0.012 █░░░░░░░░░░░ 8.0%/200k                      claude-sonnet-5-5 • xhigh
  ● kosmos-orchestrator

Preview without launching Claude Code:

  echo '{"agent":{"name":"kosmos-orchestrator"},"model":{"id":"claude-sonnet-5-5"}}' \\
    | COLUMNS=80 python3 claude/statusline.py

Colours are the Pi theme's palette (claude/themes/kosmos.json). NO_COLOR turns
them off.
"""
import json
import math
import os
import re
import shutil
import sys
import unicodedata
from pathlib import Path

ACCENT = (168, 85, 247)  # purple: the persona dot
DIM = (216, 180, 254)  # purplePastel: the footer's "dim"
MUTED = (161, 161, 170)  # gray: the bar's empty cells
WARNING = (250, 204, 21)
ERROR = (248, 113, 113)

# Claude Code indents the status line by two columns; leave the same on the
# right so the model on line 2 is not cut off with an ellipsis.
MARGIN = 4
MIN_PADDING = 2
FALLBACK_PERSONA = "Claude Code"

# Context usage bar: cell characters, default width and the degradation ladder.
BAR_FILLED = "█"
BAR_EMPTY = "░"
BAR_WIDTHS = (12, 8, 6, 4)

# A percentage above 100 % is possible (the estimate can exceed the window),
# so the ceiling is generous; beyond it the number is not a percentage.
MAX_CONTEXT_PERCENT = 1000

ANSI = re.compile(r"\033\[[0-9;]*m")


def paint(rgb, text):
    if os.environ.get("NO_COLOR") or not text:
        return text
    return "\033[38;2;%d;%d;%dm%s\033[39m" % (rgb + (text,))


def visible_width(text):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in ANSI.sub("", text))


def finite_number(value):
    """The value as a finite float, or None when it is not a finite number.

    A bool is an int subclass, so it is rejected on purpose; strings, None,
    NaN and both infinities are rejected as well. A huge integer is
    converted defensively: float() and math.isfinite() raise on it.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
    return number if math.isfinite(number) else None


def usable_percent(value):
    """The context percentage, or None when it is not a usable percentage.

    A percentage has to be a finite number within 0..MAX_CONTEXT_PERCENT: an
    over-100 % estimate is possible, but a magnitude such as 1e300 is not a
    percentage at all. The readout, the thresholds and the bar all follow
    this one value, so they can never disagree.
    """
    number = finite_number(value)
    if number is None or not 0 <= number <= MAX_CONTEXT_PERCENT:
        return None
    return number


def context_bar(percent, width, color):
    """The context usage bar: filled cells in `color`, empty ones muted.

    The filled count is the percentage of the bar, rounded half up like
    JavaScript's Math.round, so both footers agree cell for cell. A small
    but non-zero usage still shows one filled cell. The empty cells are
    muted, not dim: dim is the brightest colour of the theme and would make
    the unused part the loudest.
    """
    filled = int(percent / 100.0 * width + 0.5)
    filled = max(0, min(width, filled))
    if percent > 0 and filled == 0:
        filled = 1
    pieces = []
    if filled > 0:
        pieces.append((BAR_FILLED * filled, color))
    if filled < width:
        pieces.append((BAR_EMPTY * (width - filled), MUTED))
    return pieces


def items_plain(items):
    """The plain text of the line-2 items, joined by a space."""
    return " ".join("".join(text for text, _ in item) for item in items)


def items_width(items):
    return visible_width(items_plain(items))


def paint_items(items):
    """Paint every piece of every item; the items are joined by a space."""
    return " ".join("".join(paint(color, text) for text, color in item) for item in items)


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

    # Line 2: cost, the context bar and the context readout on the left;
    # model and effort on the right.
    segments = []
    # The cost is validated: a string or a huge integer would raise and take
    # the whole status line down with it. A zero cost shows no segment, as
    # it always has.
    cost = finite_number((data.get("cost") or {}).get("total_cost_usd"))
    if cost:
        segments.append([("$%.3f" % cost, DIM)])
    window = data.get("context_window") or {}
    # The percentage is validated once, up front: the readout, the
    # thresholds and the bar all use this one value, so they can never
    # disagree. A percentage that is not usable is treated like a missing
    # one: the readout says so and no bar is drawn.
    percent = usable_percent(window.get("used_percentage"))
    size = format_tokens(window.get("context_window_size") or 0)
    context = ("%.1f%%/%s" % (percent, size)) if percent is not None else "?/%s" % size
    usage = percent if percent is not None else 0
    context_color = ERROR if usage > 90 else WARNING if usage > 70 else DIM
    # The bar's filled cells follow the same thresholds, but a healthy usage
    # is accent (purple) rather than the dim text colour.
    bar_color = ERROR if usage > 90 else WARNING if usage > 70 else ACCENT

    model = (data.get("model") or {}).get("id") or "no-model"
    effort = (data.get("effort") or {}).get("level")
    right_plain = "%s • %s" % (model, effort) if effort else model

    def build_left(bar_width):
        items = list(segments)
        if bar_width:
            items.append(context_bar(percent, bar_width, bar_color))
        items.append([(context, context_color)])
        return items

    # The bar is the only thing that shrinks: it tries the widest size first
    # and falls back to narrower ones, and it is dropped entirely rather than
    # pushing the numbers, the cost or the model out.
    left_items = build_left(None)
    if percent is not None and (window.get("context_window_size") or 0) > 0:
        for bar_width in BAR_WIDTHS:
            candidate = build_left(bar_width)
            if items_width(candidate) + MIN_PADDING + visible_width(right_plain) <= width:
                left_items = candidate
                break

    left_plain = items_plain(left_items)
    if visible_width(left_plain) > width:
        # Too narrow for the whole left half: cut it with an ellipsis and
        # paint it dim, like the previous version did.
        left_plain = truncate(left_plain, width)
        left_items = [[(left_plain, DIM)]]
    left = paint_items(left_items)
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
