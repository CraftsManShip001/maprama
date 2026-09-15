#!/usr/bin/env bash
# Regenerates the patch queue from commits on top of the upstream ref.
#
#   refresh.sh <maplibre-clone> [--patches DIR] [--base REF]
#
# Exports `git format-patch <base>..HEAD` into DIR, replacing every existing DIR/*.patch.
# Output is normalised so re-running without changes produces byte-identical files:
# zero commit hashes in the "From" line, no signature, no diffstat, 12-char blob abbreviations.
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patches="$(cd "$script_dir/../.." && pwd)/patches"
clone=""
base=""
while [ $# -gt 0 ]; do
  case "$1" in
    --patches) patches="${2:?--patches needs a directory}"; shift 2 ;;
    --base) base="${2:?--base needs a ref}"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "refresh: unknown option $1" >&2; usage ;;
    *) if [ -z "$clone" ]; then clone="$1"; shift; else echo "refresh: unexpected argument $1" >&2; usage; fi ;;
  esac
done
[ -n "$clone" ] || usage
mkdir -p "$patches"
patches="$(cd "$patches" && pwd)"

if [ -z "$base" ] && [ -f "$patches/UPSTREAM" ]; then
  base="$(grep -v '^[[:space:]]*#' "$patches/UPSTREAM" | grep -v '^[[:space:]]*$' | head -n 1 | tr -d '[:space:]')"
fi
[ -n "$base" ] || { echo "refresh: no upstream ref: pass --base or pin one in $patches/UPSTREAM" >&2; exit 2; }

git -C "$clone" rev-parse --git-dir >/dev/null 2>&1 || { echo "refresh: not a git repository: $clone" >&2; exit 2; }
git_dir="$(git -C "$clone" rev-parse --absolute-git-dir)"
if [ -d "$git_dir/rebase-apply" ] || [ -d "$git_dir/rebase-merge" ]; then
  echo "refresh: a git am/rebase is in progress in $clone; finish it first" >&2
  exit 1
fi
git -C "$clone" rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
  echo "refresh: upstream ref not found in clone: $base" >&2
  exit 2
}
if ! git -C "$clone" merge-base --is-ancestor "$base" HEAD; then
  echo "refresh: HEAD is not based on $base (run apply.sh or rebase.sh first)" >&2
  exit 1
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/patch-queue-refresh.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

git -C "$clone" -c core.abbrev=12 -c diff.noprefix=false -c diff.mnemonicPrefix=false \
  format-patch --quiet --zero-commit --no-signature --no-stat --no-renames \
  --output-directory "$tmp" "$base..HEAD"

rm -f "$patches"/*.patch
count=0
for patch in "$tmp"/*.patch; do
  [ -e "$patch" ] || continue
  mv "$patch" "$patches/"
  count=$((count + 1))
done
echo "refresh: wrote $count patch(es) for $base..HEAD to $patches"
