#!/usr/bin/env bash
# install-kosmos-pi.sh
# Idempotent installer for the kosmos-pi Pi package + portable config tree
# from this Dotfiles repo. Run once on a new machine (or whenever the package
# version bumps, or after editing the portable config tree, or after a pinned
# dependency version bumps):
#
#   ~/Dotfiles/bin/install-kosmos-pi.sh
#
# What it does, in order:
#   1. Locates the kosmos-pi package relative to this script.
#   2. Runs `npm install <pkg>` into ~/.pi/agent/npm/ (Pi's user package dir).
#   3. Syncs ~/Dotfiles/pi/agent/ into ~/.pi/agent/ (SYSTEM.md, settings.json,
#      themes/, extensions/, mcp-adapter.json). Scoped per-file/per-subtree so
#      Pi's other state (~/.pi/agent/npm/, agents/, sessions/, etc.) is preserved.
#   4. Normalises ~/.pi/agent/settings.json: removes every stale `file:<path>`
#      entry that points at the kosmos-pi package (path ends with `kosmos-pi`,
#      with or without a trailing slash) and appends exactly one `file:$PKG_DIR`
#      entry. Other package entries are left untouched and in their original order.
#   5. Reads the (now current) `packages` array and, for entries of the form
#      `npm:<spec>` that carry an explicit version (e.g. `npm:pi-subagents@0.79.1`,
#      `npm:@scope/pkg@1.2.3`), runs `npm install --save-exact <spec>` inside
#      ~/.pi/agent/npm/. Unpinned `npm:` entries (e.g. `npm:pi-mcp-adapter`,
#      `npm:@juicesharp/rpiv-todo`) are deliberately skipped — those are left
#      to Pi's own package reconciliation, so this script never silently
#      upgrades an unpinned package.
#   6. Reports what changed. Exits non-zero on real failures.
#
# Safe to re-run: `npm install` is a no-op when the package is already at the
# same version; the settings normalisation leaves a single canonical `file:`
# entry alone and removes only stale ones, so re-running never duplicates the
# entry; `npm install --save-exact` on an already-satisfied pin is a no-op.
#
# Note: settings.json is deployed verbatim from Dotfiles and then normalised
# in step 4, which means Pi-managed fields like `lastChangelogVersion` get
# overwritten on each install. This is acceptable — Pi refreshes them on first run.
#
# Note: the per-file/per-subtree rsync scoping (rather than a whole-directory
# rsync) is intentional. A naive `rsync -a --delete pi/agent/ ~/.pi/agent/`
# would wipe `~/.pi/agent/npm/` (Pi's installed packages), `agents/`, `sessions/`,
# and other Pi state that lives alongside the files we sync. Scoping each rsync
# to the specific file or subtree preserves that state while still allowing
# stale-file cleanup within each synced subtree (e.g., removing an old theme).
#
# Reminder: restart Pi after running this so the new package version is loaded.

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
mkdir -p "$PI_AGENT_DST/extensions"

for entry in SYSTEM.md settings.json mcp-adapter.json; do
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

if rsync -a --delete "$PI_AGENT_SRC/extensions/" "$PI_AGENT_DST/extensions/" >/dev/null 2>&1; then
	echo "  ✓ synced ~/.pi/agent/extensions/"
else
	echo "error: rsync failed for extensions/" >&2
	exit 1
fi

# --- patch settings.json -------------------------------------------------------
# Run AFTER the rsync so this sees the canonical settings.json from the repo.
# Any existing entry in `packages` that is a `file:` URL whose path's final
# segment is `kosmos-pi` (with or without trailing slash) is removed; exactly
# one `file:$PKG_DIR` entry is appended; everything else is left in place and
# in its original order.

SETTINGS="${HOME}/.pi/agent/settings.json"
if [ ! -f "$SETTINGS" ]; then
	echo "error: $SETTINGS not found — is Pi installed?" >&2
	exit 1
fi

python3 - "$SETTINGS" "$PKG_DIR" <<'PY'
import json, sys, pathlib

settings_path = pathlib.Path(sys.argv[1])
pkg_dir = sys.argv[2]
entry = f"file:{pkg_dir}"

with settings_path.open() as f:
    settings = json.load(f)

packages = settings.setdefault("packages", [])

removed = []
for p in [p for p in packages if isinstance(p, str) and p.startswith("file:")]:
    name = pathlib.PurePath(p[len("file:"):].rstrip("/")).name
    if name != "kosmos-pi":
        continue
    if p == entry:
        # canonical entry already present in its current position; leave it
        continue
    packages.remove(p)
    removed.append(p)

for p in removed:
    print(f"  ✓ removed stale {p}")

if entry in packages:
    print(f"  ✓ {entry} already in settings.json (no change)")
else:
    packages.append(entry)
    print(f"  ✓ added {entry} to settings.json")

with settings_path.open("w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
PY

# --- install pinned npm packages ----------------------------------------------
# Run AFTER the settings normalisation so we read the canonical packages array.
# For each `npm:<spec>` entry that carries an explicit version (the part after
# the last `/` contains `@`), run `npm install --save-exact <spec>` inside Pi's
# npm dir with the `npm:` prefix stripped. Unpinned `npm:` entries are skipped
# — those are left to Pi's own package reconciliation.

python3 - "$SETTINGS" "$PI_NPM_DIR" <<'PY'
import json, sys, pathlib, subprocess

settings_path = pathlib.Path(sys.argv[1])
npm_dir = sys.argv[2]

with settings_path.open() as f:
    settings = json.load(f)

packages = settings.get("packages", [])

pinned = []
for entry in packages:
    if not isinstance(entry, str) or not entry.startswith("npm:"):
        continue
    spec = entry[len("npm:"):]
    # Look only at the part after the last `/` so scoped packages like
    # `@juicesharp/rpiv-todo` (unpinned) are correctly distinguished from
    # `@scope/pkg@1.2.3` (pinned).
    last_segment = spec.rsplit("/", 1)[-1]
    if "@" in last_segment:
        pinned.append(spec)

if not pinned:
    print("  ✓ no pinned npm packages to install (unpinned npm: entries skipped — left to Pi's own reconciliation)")
else:
    for spec in pinned:
        print(f"→ installing pinned npm package {spec}")
        result = subprocess.run(
            ["npm", "install", "--save-exact", spec],
            cwd=npm_dir,
        )
        if result.returncode != 0:
            print(f"error: npm install --save-exact {spec} failed", file=sys.stderr)
            sys.exit(1)
        print(f"  ✓ installed {spec}")
PY

# --- summary -------------------------------------------------------------------

echo
echo "Done. Pinned npm packages installed and local kosmos-pi package linked."
echo "Restart Pi to load the new package and extension versions."
echo "After restart, /agents should list kosmos-* agents and"
echo "/skill:pr-workflow, /skill:the-cock-of-justice should resolve."
