#!/usr/bin/env bash
# Rebases the patch queue onto a new upstream ref.
#
#   rebase.sh <maplibre-clone> <new-upstream-ref> [--patches DIR] [--branch NAME]
#
# 1. apply.sh the current queue onto <new-upstream-ref> (git am --3way).
# 2. On success: refresh.sh against the new ref and pin it in DIR/UPSTREAM.
# 3. On conflict: exit 1 with the `git am` session left open. DIR (patches and UPSTREAM) is untouched.
#    After resolving and `git am --continue`, finish with:
#      refresh.sh <clone> --base <new-upstream-ref> && echo <new-upstream-ref> > DIR/UPSTREAM
set -euo pipefail

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patches="$(cd "$script_dir/../.." && pwd)/patches"
branch="maprama/patched"
positional=""
while [ $# -gt 0 ]; do
  case "$1" in
    --patches) patches="${2:?--patches needs a directory}"; shift 2 ;;
    --branch) branch="${2:?--branch needs a name}"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "rebase: unknown option $1" >&2; usage ;;
    *) positional="$positional $1"; shift ;;
  esac
done
# shellcheck disable=SC2086
set -- $positional
[ $# -eq 2 ] || usage
clone="$1"
new_base="$2"
[ -d "$patches" ] || { echo "rebase: patches directory not found: $patches" >&2; exit 2; }
patches="$(cd "$patches" && pwd)"

old_base=""
if [ -f "$patches/UPSTREAM" ]; then
  old_base="$(grep -v '^[[:space:]]*#' "$patches/UPSTREAM" | grep -v '^[[:space:]]*$' | head -n 1 | tr -d '[:space:]')"
fi

if ! bash "$script_dir/apply.sh" "$clone" --patches "$patches" --base "$new_base" --branch "$branch"; then
  echo "rebase: conflict rebasing the queue from ${old_base:-<unpinned>} onto $new_base." >&2
  echo "rebase: after 'git am --continue', run: $script_dir/refresh.sh $clone --patches $patches --base $new_base" >&2
  echo "rebase: then pin the new base: echo $new_base > $patches/UPSTREAM" >&2
  exit 1
fi

bash "$script_dir/refresh.sh" "$clone" --patches "$patches" --base "$new_base"

new_sha="$(git -C "$clone" rev-parse --verify "$new_base^{commit}")"
{
  echo "# Upstream maplibre/maplibre-native ref the patch queue applies to (first non-comment line)."
  echo "# Updated by scripts/patch-queue/rebase.sh; resolved commit: $new_sha"
  echo "$new_base"
} > "$patches/UPSTREAM"
echo "rebase: queue rebased from ${old_base:-<unpinned>} onto $new_base ($new_sha)"
