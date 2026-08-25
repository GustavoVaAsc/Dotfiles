#!/usr/bin/env bash
# install-kosmos-pi.sh
# Idempotent installer for the kosmos-pi Pi package + portable config tree
# from this Dotfiles repo. Run once on a new machine (or whenever the package
# version bumps, or after editing the portable config tree):
#
#   ~/Dotfiles/bin/install-kosmos-pi.sh
#
# What it does:
#   1. Locates the kosmos-pi package relative to this script.
#   2. Runs `npm install <pkg>` into ~/.pi/agent/npm/ (Pi's user package dir).
#   3. Adds "npm:kosmos-pi" to ~/.pi/agent/settings.json packages if missing.
#   4. Syncs ~/Dotfiles/pi/agent/ into ~/.pi/agent/ (SYSTEM.md, settings.json,
#      themes/, mcp.json). Scoped per-file/per-subtree so Pi's other state
#      (~/.pi/agent/npm/, agents/, sessions/, etc.) is preserved.
#   5. Syncs ~/Dotfiles/config/mcp/ into ~/.config/mcp/ (global MCP config).
#   6. Reports what changed. Exits non-zero on real failures.
#
# Safe to re-run: npm install is a no-op when already installed; settings.json
# is patched via Python (json.load/dump) so formatting is preserved; the rsyncs
# only touch their destination files and the themes/ subdirectory.
#
# Note: settings.json is deployed verbatim from Dotfiles, which means Pi-managed
# fields like `lastChangelogVersion` get overwritten on each install. This is
# acceptable — Pi refreshes them on first run.
#
# Note: the per-file/per-subtree rsync scoping (rather than a whole-directory
# rsync) is intentional. A naive `rsync -a --delete pi/agent/ ~/.pi/agent/`
# would wipe `~/.pi/agent/npm/` (Pi's installed packages), `agents/`, `sessions/`,
# and other Pi state that lives alongside the files we sync. Scoping each rsync
# to the specific file or subtree preserves that state while still allowing
# stale-file cleanup within each synced subtree (e.g., removing an old theme).

set -euo pipefail

# --- locate the package -------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_DIR="$DOTFILES_DIR/kosmos-pi"

if [ ! -d "$PKG_DIR" ] || [ ! -f "$PKG_DIR/package.json" ]; then
	echo "error: kosmos-pi package not found at $PKG_DIR" >&2
	echo "  expected layout: ~/Dotfiles/kosmos-pi/package.json" >&2
	exit 1
fi

PKG_NAME="$(node -e 'console.log(require(process.argv[1]).name)' "$PKG_DIR/package.json")"
PKG_VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "$PKG_DIR/package.json")"
echo "→ installing $PKG_NAME@$PKG_VERSION from $PKG_DIR"

# --- install into Pi's npm dir -----------------------------------------------

PI_NPM_DIR="${HOME}/.pi/agent/npm"
mkdir -p "$PI_NPM_DIR"

cd "$PI_NPM_DIR"
if npm install "$PKG_DIR" >/dev/null 2>&1; then
	echo "  ✓ installed to $PI_NPM_DIR/node_modules/$PKG_NAME"
else
	echo "error: npm install failed" >&2
	exit 1
fi

# --- patch settings.json -------------------------------------------------------

SETTINGS="${HOME}/.pi/agent/settings.json"
if [ ! -f "$SETTINGS" ]; then
	echo "error: $SETTINGS not found — is Pi installed?" >&2
	exit 1
fi

ENTRY="npm:$PKG_NAME"
python3 - "$SETTINGS" "$ENTRY" <<'PY'
import json, sys, pathlib

settings_path = pathlib.Path(sys.argv[1])
entry = sys.argv[2]

with settings_path.open() as f:
    settings = json.load(f)

packages = settings.setdefault("packages", [])
if entry in packages:
    print(f"  ✓ {entry} already in settings.json (no change)")
    sys.exit(0)

packages.append(entry)
with settings_path.open("w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
print(f"  ✓ added {entry} to settings.json (now {len(packages)} packages)")
PY

# --- sync portable config tree into ~/.pi/agent/ ------------------------------
# Scoped per-file/per-subtree to preserve Pi state outside the synced set
# (npm/, agents/, sessions/, extensions/, skills/, missions/, auth.json,
# mcp-cache.json, mcp-npx-cache.json, models-store.json, bin/). Only the
# files/subtree below are touched.

PI_AGENT_SRC="$DOTFILES_DIR/pi/agent"
PI_AGENT_DST="${HOME}/.pi/agent"

if [ ! -d "$PI_AGENT_SRC" ]; then
	echo "error: portable config tree not found at $PI_AGENT_SRC" >&2
	exit 1
fi

mkdir -p "$PI_AGENT_DST/themes"

for entry in SYSTEM.md settings.json mcp.json; do
	if [ ! -e "$PI_AGENT_SRC/$entry" ]; then
		echo "error: missing portable config file: $PI_AGENT_SRC/$entry" >&2
		exit 1
	fi
	if rsync -a --delete "$PI_AGENT_SRC/$entry" "$PI_AGENT_DST/$entry" >/dev/null 2>&1; then
		echo "  ✓ synced ~/.pi/agent/$entry"
	else
		echo "error: rsync failed for $entry" >&2
		exit 1
	fi
done

if rsync -a --delete "$PI_AGENT_SRC/themes/" "$PI_AGENT_DST/themes/" >/dev/null 2>&1; then
	echo "  ✓ synced ~/.pi/agent/themes/"
else
	echo "error: rsync failed for themes/" >&2
	exit 1
fi

# --- sync global MCP config into ~/.config/mcp/ -------------------------------

MCP_SRC="$DOTFILES_DIR/config/mcp"
MCP_DST="${HOME}/.config/mcp"
MCP_FILE="mcp.json"

if [ ! -d "$MCP_SRC" ]; then
	echo "error: global MCP config tree not found at $MCP_SRC" >&2
	exit 1
fi

mkdir -p "$MCP_DST"

if [ ! -e "$MCP_SRC/$MCP_FILE" ]; then
	echo "error: missing portable config file: $MCP_SRC/$MCP_FILE" >&2
	exit 1
fi
if rsync -a --delete "$MCP_SRC/$MCP_FILE" "$MCP_DST/$MCP_FILE" >/dev/null 2>&1; then
	echo "  ✓ synced ~/.config/mcp/$MCP_FILE"
else
	echo "error: rsync failed for $MCP_FILE" >&2
	exit 1
fi

# --- summary -------------------------------------------------------------------

echo
echo "Done. Restart Pi to load the package."
echo "After restart, /agents should list kosmos-* agents and"
echo "/skill:pr-workflow, /skill:the-cock-of-justice should resolve."
