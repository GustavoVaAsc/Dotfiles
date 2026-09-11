#!/usr/bin/env bash
# install.sh
# Cross-platform idempotent installer for Dotfiles-managed config.
# Wires each tracked config (kitty, nvim, opencode, mcp) into ~/.config/
# via symlinks, then delegates Pi/agent handling to bin/install-kosmos-pi.sh.
#
# Run once on a new machine (or after adding new entries to the manifest):
#
#   ~/Dotfiles/install.sh
#
# What it does:
#   1. Parses flags (--help, --dry-run, --only <name>, --no-kosmos-pi, --no-backup).
#   2. For each manifest entry, creates or updates the symlink in ~/.config/.
#   3. Backs up any existing real directory/file before replacing it
#      (unless --no-backup is given).
#   4. Runs bin/install-kosmos-pi.sh unless --no-kosmos-pi is given.
#
# Safe to re-run: already-correct symlinks are skipped; backed-up targets
# are saved to ~/.config/<name>.bak.<timestamp> so reverts are possible.
#
# Cross-platform: Fedora, Pop OS, macOS (bash 3.2 compatible).

set -euo pipefail

# --- locate the repo ---------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$SCRIPT_DIR"

# --- argument parsing --------------------------------------------------------

HELP=false
DRY_RUN=false
ONLY_NAME=""
NO_KOSMOS_PI=false
NO_BACKUP=false
KOSMOS_PI_RAN=false

while [[ $# -gt 0 ]]; do
	case "$1" in
	--help)
		HELP=true
		shift
		;;
	--dry-run)
		DRY_RUN=true
		shift
		;;
	--only)
		if [[ -n "$ONLY_NAME" ]]; then
			echo "error: --only specified more than once" >&2
			exit 2
		fi
		ONLY_NAME="${2:-}"
		if [[ -z "$ONLY_NAME" ]]; then
			echo "error: --only requires a name argument" >&2
			exit 2
		fi
		shift 2
		;;
	--no-kosmos-pi)
		NO_KOSMOS_PI=true
		shift
		;;
	--no-backup)
		NO_BACKUP=true
		shift
		;;
	-*)
		echo "error: unknown flag: $1" >&2
		echo "usage: $0 [--help] [--dry-run] [--only <name>] [--no-kosmos-pi] [--no-backup]" >&2
		exit 2
		;;
	*)
		# No positional arguments expected; anything else is an error
		echo "error: unexpected argument: $1" >&2
		echo "usage: $0 [--help] [--dry-run] [--only <name>] [--no-kosmos-pi] [--no-backup]" >&2
		exit 2
		;;
	esac
done

# --- usage --------------------------------------------------------------------

if $HELP; then
	echo "usage: $0 [--help] [--dry-run] [--only <name>] [--no-kosmos-pi] [--no-backup]"
	echo ""
	echo "  --help           Show this help and exit 0."
	echo "  --dry-run        Print intended actions, modify nothing."
	echo "  --only <name>    Restrict to one manifest entry by name."
	echo "  --no-kosmos-pi   Skip the npm + rsync block (pi/agent setup)."
	echo "  --no-backup      Replace existing targets without backing up."
	echo ""
	echo "Manifest entries: kitty, nvim, opencode, mcp"
	exit 0
fi

# --- manifest ----------------------------------------------------------------
# Format: name|target (target uses ~ for $HOME)

MANIFEST="
kitty|~/.config/kitty
nvim|~/.config/nvim
opencode|~/.config/opencode
mcp|~/.config/mcp
"

# Convert manifest to indexed arrays (used for validation and loop)
set -o noglob  # prevent word splitting on empty lines
IFS=$'\n'
manifest_lines=($MANIFEST)
set +o noglob
IFS='
'

# --- validate --only name against manifest -------------------------------------

if [[ -n "$ONLY_NAME" ]]; then
	valid=false
	for entry in "${manifest_lines[@]}"; do
		if [[ -z "$entry" ]]; then
			continue
		fi
		name="${entry%%|*}"
		if [[ "$name" == "$ONLY_NAME" ]]; then
			valid=true
			break
		fi
	done
	if [[ "$valid" != true ]]; then
		echo "error: --only name '$ONLY_NAME' not in manifest; expected one of:" >&2
		for entry in "${manifest_lines[@]}"; do
			if [[ -z "$entry" ]]; then
				continue
			fi
			echo "  - ${entry%%|*}" >&2
		done
		exit 2
	fi
fi

# --- helper: resolve ~ to $HOME -----------------------------------------------

resolve_path() {
	local path="$1"
	# Replace ~ at the start with $HOME; leave other ~ untouched
	case "$path" in
		"~"/*)
			echo "${HOME}${path:1}"
			;;
		~)
			echo "$HOME"
			;;
		*)
			echo "$path"
			;;
	esac
}

# --- symlink loop ------------------------------------------------------------

link_count=0
skip_count=0

for entry in "${manifest_lines[@]}"; do
	# Skip empty lines
	if [[ -z "$entry" ]]; then
		continue
	fi

	# Parse name|target
	name="${entry%%|*}"
	target_tilde="${entry#*|}"

	# Resolve ~ to $HOME
	target="$(resolve_path "$target_tilde")"
	src="$DOTFILES_DIR/$name"

	# Filter by --only
	if [[ -n "$ONLY_NAME" && "$name" != "$ONLY_NAME" ]]; then
		continue
	fi

	# Check source exists
	if [[ ! -e "$src" ]]; then
		echo "error: source $src does not exist" >&2
		exit 1
	fi

	# Check if already correctly linked
	if [[ -L "$target" ]]; then
		current_link="$(readlink "$target")"
		# Resolve relative symlink for comparison (portable, no GNU readlink -f)
		if [[ -n "$current_link" ]]; then
			case "$current_link" in
				/*) resolved_link="$current_link" ;;
				*)  resolved_link="$(cd "$(dirname "$target")" && cd "$current_link" 2>/dev/null && pwd -P 2>/dev/null)" || resolved_link="" ;;
			esac
		else
			resolved_link=""
		fi
		if [[ "$current_link" == "$src" || "$resolved_link" == "$src" ]]; then
			echo "✓ already linked: $target -> $src"
			skip_count=$((skip_count + 1))
			continue
		fi
		# Symlink exists but points elsewhere — will be replaced below
		needs_replace=true
	elif [[ -e "$target" ]]; then
		# Real file/directory exists — back up unless --no-backup
		needs_replace=true
	else
		# Target does not exist — create
		needs_replace=false
	fi

	# Backup existing real target
	if [[ "$needs_replace" == true ]] && [[ ! "$NO_BACKUP" == true ]]; then
		ts="$(date +%Y%m%d%H%M%S)"
		backup_base="${target}.bak.${ts}"
		backup="$backup_base"
		n=0
		while [[ -e "$backup" ]]; do
			n=$((n+1))
			backup="${backup_base}.${n}"
		done
		if $DRY_RUN; then
			echo "[dry-run] would backup: $target -> $backup"
		else
			mv "$target" "$backup"
			echo "  backed up: $target -> $backup"
		fi
	fi

	# Remove existing target (after backup)
	if [[ "$needs_replace" == true ]]; then
		if $DRY_RUN; then
			echo "[dry-run] would remove: $target"
		else
			rm -rf "$target"
		fi
	fi

	# Create parent directory if needed
	parent="$(dirname "$target")"
	if [[ ! -d "$parent" ]]; then
		if $DRY_RUN; then
			echo "[dry-run] would mkdir -p: $parent"
		else
			mkdir -p "$parent"
		fi
	fi

	# Create symlink
	if $DRY_RUN; then
		echo "[dry-run] would link: $target -> $src"
	else
		ln -sfn "$src" "$target"
		echo "✓ linked: $target -> $src"
		link_count=$((link_count + 1))
	fi
done

# --- kosmos-pi block ---------------------------------------------------------

KOSMOS_PI_RAN=false
KOSMOS_PI_FAILED=false
KOSMOS_PI_SKIPPED=false
KOSMOS_PI_EXIT=0

if [[ "$NO_KOSMOS_PI" == false ]]; then
	installer="$DOTFILES_DIR/bin/install-kosmos-pi.sh"
	if [[ ! -x "$installer" ]]; then
		# Try making it executable
		if [[ -f "$installer" ]]; then
			if $DRY_RUN; then
				echo "[dry-run] would chmod +x: $installer"
			else
				chmod +x "$installer"
			fi
		else
			echo "error: $installer not found" >&2
			exit 1
		fi
	fi

	if $DRY_RUN; then
		echo "[dry-run] would run: $installer"
	else
		# Run the kosmos-pi installer; it handles its own idempotency
		if bash "$installer"; then
			KOSMOS_PI_RAN=true
		else
			KOSMOS_PI_FAILED=true
			KOSMOS_PI_EXIT=$?
		fi
	fi
else
	KOSMOS_PI_SKIPPED=true
fi

# --- summary -----------------------------------------------------------------

echo ""
echo "Summary:"
echo "  symlinks created: $link_count"
echo "  symlinks skipped (already correct): $skip_count"
if $KOSMOS_PI_FAILED; then
	echo "  kosmos-pi: failed (exit $KOSMOS_PI_EXIT)"
elif $KOSMOS_PI_SKIPPED; then
	echo "  kosmos-pi: skipped (--no-kosmos-pi)"
elif $KOSMOS_PI_RAN; then
	echo "  kosmos-pi: ran"
else
	echo "  kosmos-pi: not available"
fi

# Exit non-zero if kosmos-pi failed
if $KOSMOS_PI_FAILED; then
	exit 1
fi
