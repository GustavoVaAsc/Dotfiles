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
#      exist. Needs `claude` on PATH; skipped with --no-mcp. `claude` is the
#      only writer of .claude.json here, and every running Claude Code process
#      rewrites that file too, so two writers can corrupt it. As a best-effort
#      guard, registration is skipped (a warning, exit 0, repeated at the end;
#      the manual `claude mcp add-json` commands are printed) when:
#        - .claude.json exists but is not a valid JSON object: `claude` is not
#          run and the file is left as is. Move it aside or restore one of
#          Claude Code's automatic backups,
#          <config dir>/backups/.claude.json.backup.*, then re-run;
#        - Claude Code is running, this script runs inside a Claude Code session
#          (CLAUDECODE set), or the process list cannot be read so Claude Code
#          cannot be ruled out: close Claude Code and re-run.
#      The running check happens right before each server is added, so it is
#      only needed when something has to be added; a session started in that
#      window can still race. A `claude` failure is still an error (exit 1) and
#      its output is shown.
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
#
# This script never writes .claude.json itself; `claude mcp add-json` does, and
# every running Claude Code process rewrites that file too, so two writers can
# corrupt it. As a best-effort guard, registration is skipped (a warning, not a
# failure) when the file is already unparseable or when Claude Code is running
# or cannot be ruled out. The running check is repeated right before each
# `claude mcp add-json`, but a session that starts in between can still race.

MCP_FAILED=0
MCP_SKIP_REASON=""

# claude_pids: comma-separated PIDs of running Claude Code processes, empty if
# none. Exit 2 when the process list cannot be trusted (ps failed, printed
# nothing, or does not even list this script), so callers fail closed.
#
# Classifies on `ps -axwwo pid=,args=` only (ww: BSD/macOS ps would truncate
# args; comm= is a full path on macOS and may hold spaces or a version number on
# Linux). The executable is the first argument or, for an absolute path with
# spaces, the text up to the first `/claude `, `/node `, `/nodejs `, `/bun ` or
# `/claude/versions/<ver>`, provided nothing before it looks like a further
# argument (` /` or ` -`) and that path exists and is executable (so
# `/usr/bin/vim ./claude` or `/usr/bin/cat foo/claude` are not read as a path
# with a space). Matches:
#   - the native binary: executable named `claude`, or under .../claude/versions/;
#   - the npm install: `node|nodejs|bun ...` with any argument that is a path
#     named `claude` (the npm shim) or contains
#     /node_modules/@anthropic-ai/claude-code/ (cli.js).
# Arguments are never matched otherwise, so this script, `vim claude/x.json`,
# `grep claude` and `node server.js --name claude` are not mistaken for a session.
# Undetectable: a native binary renamed to something else, a path with spaces
# that is not readable by this user (or has ` /` or ` -` or a `'` in a directory
# name), and processes hidden from ps (other users' processes in a container).
claude_pids() {
	local listing
	listing="$(ps -axwwo pid=,args= 2>/dev/null)" || return 2
	[ -n "$listing" ] || return 2
	printf '%s\n' "$listing" | awk -v self="$$" '
		function base(path,   n, parts) { n = split(path, parts, "/"); return parts[n] }
		function executable(path) {
			if (index(path, "\047") > 0) return 0
			return system("test -x \047" path "\047") == 0
		}
		function split_exe(line,   padded, mark, name, n, k, i, j, end, cand) {
			padded = line " "
			if (substr(line, 1, 1) == "/") {
				n = split("/claude ;/node ;/nodejs ;/bun ;/claude/versions/", mark, ";")
				split("claude node nodejs bun claude", name, " ")
				for (k = 1; k <= n; k++) {
					i = index(padded, mark[k])
					if (i == 0 || substr(padded, 1, i - 1) ~ " [/-]") continue
					if (k < n) end = i + length(mark[k]) - 2
					else { j = index(substr(padded, i), " "); end = i + j - 2 }
					cand = substr(padded, 1, end)
					if (index(cand, " ") > 0 && !executable(cand)) continue
					exe = name[k]
					rest = substr(padded, end + 2)
					return
				}
			}
			cand = line
			sub(/ .*/, "", cand)
			exe = base(cand)
			rest = substr(line, length(cand) + 2)
		}
		{
			if ($1 == self) seen = 1
			line = $0
			sub(/^ *[0-9]+ +/, "", line)
			split_exe(line)
			hit = (exe == "claude")
			if (!hit && (exe == "node" || exe == "nodejs" || exe == "bun")) {
				if (index(rest, "/node_modules/@anthropic-ai/claude-code/") > 0) hit = 1
				n = split(rest, args, " ")
				for (i = 1; i <= n; i++)
					if (index(args[i], "/") > 0 && base(args[i]) == "claude") hit = 1
			}
			if (hit) pids = pids (pids == "" ? "" : ",") $1
		}
		END { if (!seen) exit 2; print pids }
	'
}

# claude_blocker: print why registering now could race another .claude.json
# writer, or print nothing when it looks safe. Fails closed: if the process
# list cannot be read, that is a reason too.
claude_blocker() {
	local pids rc=0
	if [ -n "${CLAUDECODE:-}" ]; then
		echo "this script is running inside a Claude Code session (CLAUDECODE is set)"
		return 0
	fi
	pids="$(claude_pids)" || rc=$?
	if [ "$rc" -ne 0 ]; then
		echo "Claude Code could not be ruled out (the process list from ps was unavailable or incomplete)"
	elif [ -n "$pids" ]; then
		echo "Claude Code is running (pid $pids)"
	fi
}

# mcp_add_command <name> <json>: the manual registration command, pasteable into
# a shell (single quotes in the JSON are escaped).
mcp_add_command() {
	local esc
	esc=${2//\'/\'\\\'\'}
	echo "claude mcp add-json --scope user $1 '$esc'"
}

# print_mcp_commands <plan>: the manual registration command for each "add" line.
print_mcp_commands() {
	local action name json
	while IFS=$'\t' read -r action name json; do
		[ "$action" = "add" ] || continue
		echo "  $(mcp_add_command "$name" "$json")"
	done <<<"$1"
}

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

	# One line per server: "have<TAB>name" or "add<TAB>name<TAB>json". A single
	# "invalid<TAB>reason" line instead when .claude.json exists but is not a
	# JSON object (or its mcpServers is not), so it is never handed to `claude`.
	MCP_PLAN="$(python3 - "$MCP_SRC" "$CLAUDE_JSON" <<'PY'
import json, pathlib, sys

wanted = json.loads(pathlib.Path(sys.argv[1]).read_text()).get("mcpServers", {})
claude_json = pathlib.Path(sys.argv[2])
have = {}
if claude_json.exists():
    try:
        live = json.loads(claude_json.read_text())
    except Exception as exc:
        print(f"invalid\t{exc}")
        sys.exit(0)
    if not isinstance(live, dict):
        print("invalid\tnot a JSON object")
        sys.exit(0)
    have = live.get("mcpServers") or {}
    if not isinstance(have, dict):
        print("invalid\tmcpServers is not a JSON object")
        sys.exit(0)
for name, config in wanted.items():
    if name in have:
        print(f"have\t{name}")
    else:
        print(f"add\t{name}\t{json.dumps(config, separators=(',', ':'))}")
PY
)"

	IFS=$'\t' read -r MCP_FIRST MCP_DETAIL <<<"$MCP_PLAN"
	if [ "$MCP_FIRST" = "invalid" ]; then
		MCP_SKIP_REASON="$CLAUDE_JSON is not valid JSON ($MCP_DETAIL)"
		if $DRY_RUN; then
			echo "[dry-run] would skip MCP registration: $MCP_SKIP_REASON"
			echo "[dry-run] claude would not be run and the file would not be touched"
			echo "  A Claude Code running mid-write can cause a transient parse failure; if it"
			echo "  persists, move the file aside or restore the newest good copy from"
			echo "  $CLAUDE_DIR/backups/.claude.json.backup.*, then re-run this script."
		else
			echo "warning: $MCP_SKIP_REASON" >&2
			echo "  Skipped MCP registration; $CLAUDE_JSON was not touched and claude was not run." >&2
			echo "  A Claude Code running mid-write can cause a transient parse failure; if it" >&2
			echo "  persists, move the file aside or restore the newest good copy from" >&2
			echo "  $CLAUDE_DIR/backups/.claude.json.backup.*, then re-run this script." >&2
		fi
	else
		MCP_LEFT=""
		while IFS=$'\t' read -r action name json; do
			[ -n "$action" ] || continue
			if [ "$action" = "have" ]; then
				echo "  ✓ MCP server $name already registered"
				continue
			fi
			# Checked per server, right before the write, to narrow the race window.
			# Once a blocker fires, every remaining server is skipped.
			if [ -z "$MCP_SKIP_REASON" ]; then
				MCP_SKIP_REASON="$(claude_blocker)"
			fi
			if [ -n "$MCP_SKIP_REASON" ]; then
				MCP_LEFT="$MCP_LEFT$action"$'\t'"$name"$'\t'"$json"$'\n'
			elif $DRY_RUN; then
				echo "[dry-run] would register MCP server $name"
			elif MCP_ERR="$(claude mcp add-json --scope user "$name" "$json" 2>&1 </dev/null)"; then
				echo "  ✓ registered MCP server $name"
			else
				MCP_FAILED=$((MCP_FAILED + 1))
				echo "warning: could not register MCP server $name; add it with: $(mcp_add_command "$name" "$json")" >&2
				if [ -n "$MCP_ERR" ]; then
					echo "  claude said:" >&2
					printf '%s\n' "$MCP_ERR" | sed 's/^/    /' >&2
				fi
			fi
		done <<<"$MCP_PLAN"

		if [ -n "$MCP_LEFT" ]; then
			if $DRY_RUN; then
				echo "[dry-run] would skip MCP registration: $MCP_SKIP_REASON"
				echo "[dry-run] close Claude Code, then run:"
				print_mcp_commands "$MCP_LEFT"
			else
				echo "warning: skipped MCP registration: $MCP_SKIP_REASON." >&2
				echo "  A running Claude Code rewrites .claude.json and can collide with" >&2
				echo "  \`claude mcp add-json\`. Close Claude Code and re-run this script, or run:" >&2
				print_mcp_commands "$MCP_LEFT" >&2
			fi
		fi
	fi
fi

# --- summary -------------------------------------------------------------------

echo
if $DRY_RUN; then
	echo "Dry run finished; nothing was changed."
else
	echo "Done. The kosmos agent system is configured in $CLAUDE_DIR."
	echo "Start a new Claude Code session: the header reads @kosmos-orchestrator and the"
	echo "status line shows '● kosmos-orchestrator'. The kosmos-* specialists"
	echo "are in $CLAUDE_DIR/agents/; /pr-workflow and /the-cock-of-justice are available."
fi
if [ -n "$MCP_SKIP_REASON" ]; then
	if $DRY_RUN; then
		echo "[dry-run] MCP registration would be skipped (some or all servers); see above."
	else
		echo "warning: MCP registration was skipped (some or all servers not registered); see the warning above." >&2
	fi
fi
if [ "$MCP_FAILED" -gt 0 ]; then
	echo "$MCP_FAILED MCP server(s) were not registered; see the warnings above." >&2
	exit 1
fi
