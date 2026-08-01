#!/usr/bin/env bash
# install-kosmos-pi.sh
# Idempotent installer for the kosmos-pi Pi package from this Dotfiles repo.
# Run once on a new machine (or whenever the package version bumps):
#
#   ~/Dotfiles/bin/install-kosmos-pi.sh
#
# What it does:
#   1. Locates the kosmos-pi package relative to this script.
#   2. Runs `npm install <pkg>` into ~/.pi/agent/npm/ (Pi's user package dir).
#   3. Adds "npm:kosmos-pi" to ~/.pi/agent/settings.json packages if missing.
#   4. Reports what changed. Exits non-zero on real failures.
#
# Safe to re-run: settings.json is patched via Python (json.load/dump), so
# formatting and ordering are preserved.

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

# --- summary -------------------------------------------------------------------

echo
echo "Done. Restart Pi to load the package."
echo "After restart, /agents should list kosmos-* agents and"
echo "/skill:pr-workflow, /skill:the-cock-of-justice should resolve."
