#!/usr/bin/env bash
# install-kosmos-claude.sh
# Idempotent installer that configures a Claude Code installation with the
# kosmos agent system: the Claude port of the Pi setup (kosmos-pi/ + pi/agent/).
# Run once on a fresh machine, after installing Claude Code and cloning this
# repo (and again whenever the claude/ tree changes):
#
#   ~/Dotfiles/bin/install-kosmos-claude.sh [--dry-run] [--no-mcp] [--help]
#
# What it does, in order:
#   1. Symlinks claude/agents/*.md, claude/skills/*/, claude/themes/kosmos.json
#      and claude/statusline.py into ~/.claude/, so editing the repo is editing
#      the live config. Whatever already sits at a target is moved to
#      ~/.claude/kosmos-backups/<timestamp>/ first (outside the directories
#      Claude Code scans, so a backup never loads as a second agent or skill).
#      Links into this repo whose source was deleted are pruned.
#   2. Merges claude/settings.json into ~/.claude/settings.json. The live file
#      is the base, because Claude Code writes its own state there (model,
#      permissions, plugins, hooks): only the keys the repo declares are set
#      (`agent`, `theme`, `statusLine`, and the `env` entries), every other key
#      is left alone, and the previous file is backed up when anything changes.
#      An unreadable settings.json aborts the install untouched.
#   3. Registers the MCP servers from mcp/mcp.json (the same file Pi reads) at
#      user scope with `claude mcp add-json`, skipping servers that already
#      exist. Needs `claude` on PATH; skipped with --no-mcp.
#
# CLAUDE_CONFIG_DIR is honoured: the target is $CLAUDE_CONFIG_DIR, else ~/.claude.
#
# Safe to re-run: correct links are skipped, settings that already match are
# not rewritten (and not backed up), and MCP servers already registered are
# left alone. Requires python3.
#
# Reminder: start a new Claude Code session afterwards. The `agent` setting is
# read at startup, and a themes/ directory created by this run is only watched
# from the next start.

set -euo pipefail

# --- locate the repo -----------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$DOTFILES_DIR/claude"
MCP_SRC="$DOTFILES_DIR/mcp/mcp.json"

# --- arguments -----------------------------------------------------------------

DRY_RUN=false
NO_MCP=false

usage() {
	echo "usage: $0 [--help] [--dry-run] [--no-mcp]"
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--help)
		usage
		echo ""
		echo "  --help      Show this help and exit 0."
		echo "  --dry-run   Print intended actions, modify nothing."
		echo "  --no-mcp    Do not register the MCP servers from mcp/mcp.json."
		echo ""
		echo "Target: \$CLAUDE_CONFIG_DIR, else ~/.claude."
		exit 0
		;;
	--dry-run)
		DRY_RUN=true
		shift
		;;
	--no-mcp)
		NO_MCP=true
		shift
		;;
	*)
		echo "error: unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

# --- preflight -----------------------------------------------------------------

if [ ! -d "$SRC/agents" ] || [ ! -f "$SRC/settings.json" ]; then
	echo "error: claude config tree not found at $SRC" >&2
	echo "  expected layout: ~/Dotfiles/claude/{agents,skills,themes,settings.json,statusline.py}" >&2
	exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
	echo "error: python3 is required (settings merge and the status line)" >&2
	exit 1
fi

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
BACKUP_DIR="$CLAUDE_DIR/kosmos-backups/$(date +%Y%m%d%H%M%S)"

if $DRY_RUN; then
	echo "→ dry run: configuring $CLAUDE_DIR from $SRC (nothing will change)"
else
	echo "→ configuring $CLAUDE_DIR from $SRC"
fi

# --- helpers -------------------------------------------------------------------

# physical <path>: the path with its directory part fully resolved (no readlink -f
# on older macOS).
physical() {
	local dir
	dir="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" || return 1
	echo "$dir/$(basename "$1")"
}

# link_target <symlink>: the absolute path the symlink points at.
link_target() {
	local target
	target="$(readlink "$1")"
	case "$target" in
	/*) echo "$target" ;;
	*) echo "$(dirname "$1")/$target" ;;
	esac
}

# link <source> <destination>: make <destination> a symlink to <source>.
link() {
	local src="$1" dst="$2" rel
	rel="${dst#"$CLAUDE_DIR"/}"

	if [ -L "$dst" ] && [ "$(physical "$(link_target "$dst")" 2>/dev/null)" = "$(physical "$src")" ]; then
		echo "  ✓ already linked: $rel"
		return 0
	fi

	if [ -e "$dst" ] || [ -L "$dst" ]; then
		if $DRY_RUN; then
			echo "[dry-run] would back up: $rel -> $BACKUP_DIR/$rel"
		else
			mkdir -p "$(dirname "$BACKUP_DIR/$rel")"
			mv "$dst" "$BACKUP_DIR/$rel"
			echo "  backed up: $rel -> $BACKUP_DIR/$rel"
		fi
	fi

	if $DRY_RUN; then
		echo "[dry-run] would link: $rel -> $src"
	else
		mkdir -p "$(dirname "$dst")"
		ln -s "$src" "$dst"
		echo "  ✓ linked: $rel -> $src"
	fi
}

# prune_dangling <dir>: remove links in <dir> into this repo whose source is gone.
prune_dangling() {
	local dir="$1" entry target
	[ -d "$dir" ] || return 0
	for entry in "$dir"/*; do
		[ -L "$entry" ] && [ ! -e "$entry" ] || continue
		target="$(link_target "$entry")"
		case "$target" in
		"$SRC"/*)
			if $DRY_RUN; then
				echo "[dry-run] would prune: ${entry#"$CLAUDE_DIR"/} (source removed from the repo)"
			else
				rm -f "$entry"
				echo "  ✓ pruned: ${entry#"$CLAUDE_DIR"/} (source removed from the repo)"
			fi
			;;
		esac
	done
}

# --- 1. symlinks ---------------------------------------------------------------

echo "→ linking agents, skills, theme and status line"

for file in "$SRC"/agents/*.md; do
	[ -e "$file" ] || continue
	link "$file" "$CLAUDE_DIR/agents/$(basename "$file")"
done
prune_dangling "$CLAUDE_DIR/agents"

for dir in "$SRC"/skills/*/; do
	[ -d "$dir" ] || continue
	dir="${dir%/}"
	link "$dir" "$CLAUDE_DIR/skills/$(basename "$dir")"
done
prune_dangling "$CLAUDE_DIR/skills"

for file in "$SRC"/themes/*.json; do
	[ -e "$file" ] || continue
	link "$file" "$CLAUDE_DIR/themes/$(basename "$file")"
done
prune_dangling "$CLAUDE_DIR/themes"

link "$SRC/statusline.py" "$CLAUDE_DIR/kosmos-statusline.py"

# --- 2. merge settings.json ----------------------------------------------------
# The live file is the base; the repo copy only sets the keys it declares.
# `env` is merged entry by entry so the user's own variables survive.

echo "→ merging settings.json"

python3 - "$SRC/settings.json" "$CLAUDE_DIR" "$BACKUP_DIR" "$DRY_RUN" <<'PY'
import contextlib, json, os, pathlib, re, shlex, shutil, sys

repo_path = pathlib.Path(sys.argv[1])
config_dir = pathlib.Path(sys.argv[2])
backup_dir = pathlib.Path(sys.argv[3])
dry_run = sys.argv[4] == "true"

# Write through a symlinked settings.json instead of replacing the link.
settings_path = (config_dir / "settings.json").resolve()


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    print("  → settings.json left untouched", file=sys.stderr)
    sys.exit(1)


try:
    with repo_path.open() as f:
        managed = json.load(f)
except Exception as exc:
    fail(f"could not read {repo_path} ({exc})")
if not isinstance(managed, dict):
    fail(f"{repo_path} is not a JSON object")

live = {}
if settings_path.exists():
    try:
        text = settings_path.read_text()
        live = json.loads(text) if text.strip() else {}
    except Exception as exc:
        fail(f"could not read {settings_path} ({exc})")
    if not isinstance(live, dict):
        fail(f"{settings_path} is not a JSON object")

# The repo writes `~/.claude/...` so it stays machine-independent; point the
# command at the real directory when CLAUDE_CONFIG_DIR moved it.
default_dir = str(pathlib.Path.home() / ".claude")
if str(config_dir) != default_dir:
    status_line = managed.get("statusLine")
    if isinstance(status_line, dict) and isinstance(status_line.get("command"), str):
        status_line["command"] = re.sub(
            r"~/\.claude/(\S+)",
            lambda match: shlex.quote(f"{config_dir}/{match.group(1)}"),
            status_line["command"],
        )

merged = dict(live)
changes = []


def describe(value):
    return json.dumps(value) if value is not None else "unset"


for key, value in managed.items():
    if key == "env":
        env = live.get("env", {})
        if not isinstance(env, dict) or not isinstance(value, dict):
            fail("'env' must be a JSON object in both settings files")
        env = dict(env)
        for name, wanted in value.items():
            if env.get(name) != wanted:
                changes.append(f"env.{name} = {json.dumps(wanted)} (was {describe(env.get(name))})")
                env[name] = wanted
        merged["env"] = env
    elif live.get(key) != value:
        changes.append(f"{key} = {json.dumps(value)} (was {describe(live.get(key))})")
        merged[key] = value

if not changes:
    print("  ✓ settings.json already up to date (no change)")
    sys.exit(0)

for change in changes:
    print(f"  {'[dry-run] would set' if dry_run else '✓ set'} {change}")
if dry_run:
    sys.exit(0)

try:
    if settings_path.exists():
        backup_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(settings_path, backup_dir / "settings.json")
        print(f"  backed up: settings.json -> {backup_dir / 'settings.json'}")
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = settings_path.with_name(settings_path.name + ".tmp")
    with tmp_path.open("w") as f:
        json.dump(merged, f, indent=2, ensure_ascii=False)
        f.write("\n")
    if settings_path.exists():
        shutil.copymode(settings_path, tmp_path)
    os.replace(tmp_path, settings_path)
except Exception as exc:
    with contextlib.suppress(Exception):
        tmp_path.unlink()
    fail(f"could not write {settings_path} ({exc})")
PY

# --- 3. MCP servers ------------------------------------------------------------
# mcp/mcp.json is the single source for the server list (Pi reads it through
# ~/.config/mcp). Claude Code keeps user-scope servers in .claude.json, which
# lives in $CLAUDE_CONFIG_DIR when set and next to ~/.claude otherwise.

MCP_FAILED=0

if $NO_MCP; then
	echo "→ MCP servers: skipped (--no-mcp)"
elif [ ! -f "$MCP_SRC" ]; then
	echo "→ MCP servers: skipped ($MCP_SRC not found)"
elif ! command -v claude >/dev/null 2>&1; then
	echo "warning: claude is not on PATH, so MCP servers were not registered." >&2
	echo "  Install Claude Code and re-run this script to register them." >&2
else
	echo "→ registering MCP servers from mcp/mcp.json"
	if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
		CLAUDE_JSON="$CLAUDE_CONFIG_DIR/.claude.json"
	else
		CLAUDE_JSON="$HOME/.claude.json"
	fi

	# One line per server: "have<TAB>name" or "add<TAB>name<TAB>json".
	MCP_PLAN="$(python3 - "$MCP_SRC" "$CLAUDE_JSON" <<'PY'
import json, pathlib, sys

wanted = json.loads(pathlib.Path(sys.argv[1]).read_text()).get("mcpServers", {})
claude_json = pathlib.Path(sys.argv[2])
have = {}
if claude_json.exists():
    try:
        have = json.loads(claude_json.read_text()).get("mcpServers", {}) or {}
    except Exception:
        pass
for name, config in wanted.items():
    if name in have:
        print(f"have\t{name}")
    else:
        print(f"add\t{name}\t{json.dumps(config, separators=(',', ':'))}")
PY
)"

	while IFS=$'\t' read -r action name json; do
		[ -n "$action" ] || continue
		if [ "$action" = "have" ]; then
			echo "  ✓ MCP server $name already registered"
		elif $DRY_RUN; then
			echo "[dry-run] would register MCP server $name"
		elif claude mcp add-json --scope user "$name" "$json" >/dev/null 2>&1; then
			echo "  ✓ registered MCP server $name"
		else
			MCP_FAILED=$((MCP_FAILED + 1))
			echo "warning: could not register MCP server $name; add it with: claude mcp add-json --scope user $name '$json'" >&2
		fi
	done <<<"$MCP_PLAN"
fi

# --- summary -------------------------------------------------------------------

echo
if $DRY_RUN; then
	echo "Dry run finished; nothing was changed."
else
	echo "Done. The kosmos agent system is configured in $CLAUDE_DIR."
	echo "Start a new Claude Code session: the header reads @kosmos-orchestrator and the"
	echo "status line shows '● kosmos.orchestrator — lead mode'. The kosmos-* specialists"
	echo "are in $CLAUDE_DIR/agents/; /pr-workflow and /the-cock-of-justice are available."
fi
if [ "$MCP_FAILED" -gt 0 ]; then
	echo "$MCP_FAILED MCP server(s) were not registered; see the warnings above." >&2
	exit 1
fi
