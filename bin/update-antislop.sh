#!/usr/bin/env bash
# update-antislop.sh
# Refresh the vendored anti-slop skill pack (pi/agent/skills/antislop*/) from
# upstream without npx/npm. This is the only script in bin/ that touches the
# network — ai-harness-install.sh / install-kosmos-pi.sh work entirely offline from the
# vendored copy.
#
# Usage:
#   ~/Dotfiles/bin/update-antislop.sh [ref]
#
#   ref    Optional upstream tag or commit SHA to vendor. Defaults to the
#          pinned commit recorded in pi/agent/skills/ANTISLOP-NOTICE.md.
#
# What it does:
#   1. Fetches upstream https://github.com/miqdadbadjuber/anti-slop into a
#      local cache (~/.cache/dotfiles-anti-slop, override with
#      $ANTISLOP_CACHE_DIR): git clone on first run, git fetch afterwards.
#   2. Checks out the requested ref (detached HEAD) in the cache.
#   3. rsync -a --delete each skills/antislop* folder over the vendored copy,
#      so stale files inside a vendored skill are removed.
#   4. Updates the version and pinned commit in
#      pi/agent/skills/ANTISLOP-NOTICE.md.
#   5. Prints a summary of changed skill files (git status / diff --stat).
#
# All git write operations (clone/fetch/checkout) happen in the cache clone,
# never against the Dotfiles repo — your working tree, including unrelated
# uncommitted changes, is untouched. Review with `git diff` and commit by hand.
#
# Safe to re-run: re-vendoring an unchanged ref is a no-op.
#
# bash 3.2 compatible (macOS).

set -euo pipefail

# --- locate the repo ----------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILLS_DST="$DOTFILES_DIR/pi/agent/skills"
NOTICE="$SKILLS_DST/ANTISLOP-NOTICE.md"
REPO_URL="https://github.com/miqdadbadjuber/anti-slop"
CACHE_DIR="${ANTISLOP_CACHE_DIR:-$HOME/.cache/dotfiles-anti-slop}"

usage() {
	echo "usage: $0 [ref]"
	echo ""
	echo "  ref    Upstream tag or commit SHA to vendor (default: the pinned"
	echo "         commit in pi/agent/skills/ANTISLOP-NOTICE.md)."
	echo "  -h, --help   Show this help and exit 0."
	echo ""
	echo "Re-vendors pi/agent/skills/antislop*/ from $REPO_URL."
	echo "This is the only Dotfiles script that needs network access."
}

# --- argument parsing ---------------------------------------------------------

REF=""
if [ $# -gt 0 ]; then
	case "$1" in
	-h | --help)
		usage
		exit 0
		;;
	-*)
		echo "error: unknown flag: $1" >&2
		usage >&2
		exit 2
		;;
	*)
		REF="$1"
		;;
	esac
	shift
	if [ $# -gt 0 ]; then
		echo "error: unexpected argument: $1" >&2
		usage >&2
		exit 2
	fi
fi

if [ ! -f "$NOTICE" ]; then
	echo "error: $NOTICE not found — vendored skills missing?" >&2
	exit 1
fi

if [ -z "$REF" ]; then
	REF="$(sed -n 's/^- Pinned commit: `\([0-9a-f]\{40\}\)`$/\1/p' "$NOTICE" | head -n 1)"
	if [ -z "$REF" ]; then
		echo "error: could not read the pinned commit from $NOTICE" >&2
		echo "  pass an explicit tag or commit SHA: $0 <ref>" >&2
		exit 1
	fi
	echo "→ using pinned commit from ANTISLOP-NOTICE.md: $REF"
else
	echo "→ using requested ref: $REF"
fi

# --- fetch upstream into the cache clone --------------------------------------

if [ -d "$CACHE_DIR/.git" ]; then
	echo "→ updating cached upstream clone at $CACHE_DIR"
	git -C "$CACHE_DIR" fetch --quiet --tags origin
elif [ -d "$CACHE_DIR" ]; then
	echo "error: $CACHE_DIR exists but is not a git clone" >&2
	echo "  remove it, or set the ANTISLOP_CACHE_DIR variable to another path" >&2
	exit 1
else
	echo "→ cloning $REPO_URL into $CACHE_DIR"
	mkdir -p "$(dirname "$CACHE_DIR")"
	git clone --quiet "$REPO_URL" "$CACHE_DIR"
fi

if ! git -C "$CACHE_DIR" checkout --quiet --detach "$REF"; then
	echo "error: ref '$REF' not found in $CACHE_DIR" >&2
	exit 1
fi
VENDORED_COMMIT="$(git -C "$CACHE_DIR" rev-parse HEAD)"

SRC_SKILLS="$CACHE_DIR/skills"
if [ ! -d "$SRC_SKILLS" ]; then
	echo "error: no skills/ directory at $VENDORED_COMMIT in $CACHE_DIR" >&2
	exit 1
fi

VENDORED_VERSION=""
if [ -f "$SRC_SKILLS/antislop/VERSION" ]; then
	VENDORED_VERSION="$(cat "$SRC_SKILLS/antislop/VERSION")"
fi

# Validate before touching anything: the values are interpolated into sed.
case "$VENDORED_VERSION" in
*[!0-9A-Za-z.+-]*)
	echo "error: unexpected VERSION content in upstream antislop/: $VENDORED_VERSION" >&2
	exit 1
	;;
esac
case "$VENDORED_COMMIT" in
*[!0-9a-f]*)
	echo "error: unexpected commit id from git: $VENDORED_COMMIT" >&2
	exit 1
	;;
esac

# --- copy skills/* over the vendored antislop* folders ------------------------

mkdir -p "$SKILLS_DST"

copied=0
for skill_src in "$SRC_SKILLS"/antislop*; do
	if [ ! -d "$skill_src" ]; then
		continue
	fi
	skill_name="$(basename "$skill_src")"
	if rsync -a --delete "$skill_src/" "$SKILLS_DST/$skill_name/" >/dev/null 2>&1; then
		echo "  ✓ re-vendored pi/agent/skills/$skill_name/"
	else
		echo "error: rsync failed for skills/$skill_name" >&2
		exit 1
	fi
	copied=$((copied + 1))
done

if [ "$copied" -eq 0 ]; then
	echo "error: no antislop* skill folders found at $SRC_SKILLS" >&2
	exit 1
fi

# --- update ANTISLOP-NOTICE.md ------------------------------------------------
# Portable rewrite (temp file + mv) so both GNU and BSD sed work unchanged.

TMP_NOTICE="$NOTICE.tmp.$$"
trap 'rm -f "$TMP_NOTICE"' EXIT
if [ -n "$VENDORED_VERSION" ]; then
	sed \
		-e "s|^- Pinned commit: .*|- Pinned commit: \`$VENDORED_COMMIT\`|" \
		-e "s|^- Vendored version: .*|- Vendored version: \`$VENDORED_VERSION\`|" \
		"$NOTICE" >"$TMP_NOTICE"
	echo "  ✓ updated ANTISLOP-NOTICE.md (version $VENDORED_VERSION, commit $VENDORED_COMMIT)"
else
	echo "  ! upstream antislop/VERSION missing — keeping the version line in ANTISLOP-NOTICE.md"
	sed -e "s|^- Pinned commit: .*|- Pinned commit: \`$VENDORED_COMMIT\`|" \
		"$NOTICE" >"$TMP_NOTICE"
	echo "  ✓ updated ANTISLOP-NOTICE.md (commit $VENDORED_COMMIT)"
fi
mv "$TMP_NOTICE" "$NOTICE"

# --- summary -------------------------------------------------------------------

echo
CHANGES="$(git -C "$DOTFILES_DIR" status --porcelain -- pi/agent/skills)"
echo "→ changed skill files:"
git -C "$DOTFILES_DIR" status --short --untracked-files=all -- pi/agent/skills
git -C "$DOTFILES_DIR" diff --stat -- pi/agent/skills
if [ -z "$CHANGES" ]; then
	echo "  ✓ no changes — vendored copy already matches $VENDORED_COMMIT"
fi

echo
echo "Done. Review with 'git diff', then commit by hand:"
echo "  git add pi/agent/skills bin/update-antislop.sh"
echo "  git commit -m 'chore(pi): refresh vendored antislop skills'"
