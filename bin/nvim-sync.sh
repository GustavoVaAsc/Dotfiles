#!/usr/bin/env bash
# nvim-sync.sh
# Standalone helper that wires the repo's nvim/ config into
# ${XDG_CONFIG_HOME:-~/.config}/nvim as a symlink.
#
# Usage:
#
#   ~/Dotfiles/bin/nvim-sync.sh [--dry-run] [--yes|-y] [--help]
#
# What it does:
#   1. If the target is already a symlink to <repo>/nvim, says so and exits 0.
#   2. If the target exists (real file/dir, or a symlink pointing elsewhere),
#      asks before overwriting (y/N, default No). On yes it MOVES the existing
#      target to <target>.bak.<YYYYmmddHHMMSS> (a .N suffix is added if that
#      name is taken), then creates the symlink. On no it changes nothing.
#   3. Otherwise creates the symlink.
#
# Flags:
#   --help       Show this help and exit.
#   --dry-run    Print what would happen; modify nothing, never prompt.
#   --yes, -y    Overwrite without prompting (the backup is still made).
#
# When stdin is not a terminal and --yes is not given, an overwrite is refused
# with an error (exit 1) instead of hanging or overwriting silently.
#
# Exit codes: 0 ok / declined, 1 error, 2 bad usage.
#
# Cross-platform: Fedora, Pop OS, macOS (bash 3.2 compatible).

set -euo pipefail

# --- locate the repo ---------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTFILES_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- argument parsing --------------------------------------------------------

usage() {
	cat <<'USAGE'
Usage: nvim-sync.sh [--dry-run] [--yes|-y] [--help]

Symlink <repo>/nvim to ${XDG_CONFIG_HOME:-~/.config}/nvim, asking before
overwriting anything already there (existing config is backed up, not deleted).

  --help       Show this help and exit.
  --dry-run    Print intended actions; modify nothing, never prompt.
  --yes, -y    Overwrite without prompting (still backs up).
USAGE
}

DRY_RUN=false
ASSUME_YES=false

while [[ $# -gt 0 ]]; do
	case "$1" in
	--help)
		usage
		exit 0
		;;
	--dry-run)
		DRY_RUN=true
		shift
		;;
	--yes | -y)
		ASSUME_YES=true
		shift
		;;
	*)
		echo "error: unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

# --- paths -------------------------------------------------------------------

src="$DOTFILES_DIR/nvim"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
target="$config_home/nvim"

if [[ ! -e "$src" ]]; then
	echo "error: source $src does not exist" >&2
	exit 1
fi

# --- already correctly linked? -----------------------------------------------

if [[ -L "$target" ]]; then
	current_link="$(readlink "$target")"
	# Resolve relative symlink for comparison (portable, no GNU readlink -f)
	resolved_link=""
	if [[ -n "$current_link" ]]; then
		case "$current_link" in
		/*) resolved_link="$current_link" ;;
		*) resolved_link="$(cd "$(dirname "$target")" && cd "$current_link" 2>/dev/null && pwd -P 2>/dev/null)" || resolved_link="" ;;
		esac
	fi
	if [[ "$current_link" == "$src" || "$resolved_link" == "$src" ]]; then
		echo "✓ already linked: $target -> $src"
		exit 0
	fi
fi

# --- overwrite handling ------------------------------------------------------

backup=""
if [[ -L "$target" || -e "$target" ]]; then
	stamp="$(date +%Y%m%d%H%M%S)"
	backup="$target.bak.$stamp"
	n=1
	while [[ -e "$backup" || -L "$backup" ]]; do
		backup="$target.bak.$stamp.$n"
		n=$((n + 1))
	done

	if [[ "$DRY_RUN" == true ]]; then
		echo "[dry-run] $target already exists"
		echo "[dry-run] would move $target -> $backup"
		echo "[dry-run] would link $target -> $src"
		exit 0
	fi

	if [[ "$ASSUME_YES" != true ]]; then
		if [[ ! -t 0 ]]; then
			echo "error: $target already exists and stdin is not a terminal; pass --yes to overwrite (it will be backed up)" >&2
			exit 1
		fi
		printf '%s already exists. Back it up to %s and link to %s? [y/N] ' "$target" "$backup" "$src"
		answer=""
		read -r answer || answer=""
		case "$answer" in
		y | Y | yes | YES | Yes) ;;
		*)
			echo "left $target untouched"
			exit 0
			;;
		esac
	fi

	mv "$target" "$backup"
	echo "backed up: $target -> $backup"
elif [[ "$DRY_RUN" == true ]]; then
	echo "[dry-run] would create $config_home (if missing)"
	echo "[dry-run] would link $target -> $src"
	exit 0
fi

mkdir -p "$config_home"
ln -s "$src" "$target"
echo "✓ linked: $target -> $src"
