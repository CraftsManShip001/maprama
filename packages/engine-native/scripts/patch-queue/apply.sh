#!/usr/bin/env bash
# Applies the MapLibre Native patch queue onto a pinned upstream ref.
#
#   apply.sh <maplibre-clone> [--patches DIR] [--base REF] [--branch NAME]
#
#   <maplibre-clone>  path to a git clone of maplibre/maplibre-native (never cloned by these scripts)
#   --patches DIR     patch queue directory (default: packages/engine-native/patches)
#   --base REF        upstream ref to build on (default: first non-comment line of DIR/UPSTREAM)
#   --branch NAME     branch created/reset at REF (default: maprama/patched)
#
# Applies DIR/*.patch in lexical order with `git am --3way`. Refuses to run on a dirty work tree
# or while a previous `git am` is in progress. On conflict it stops, leaves the `git am` session
# open for resolution and exits 1.
set -euo pipefail

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
patches="$(cd "$script_dir/../.." && pwd)/patches"
clone=""
base=""
branch="maprama/patched"
while [ $# -gt 0 ]; do
  case "$1" in
    --patches) patches="${2:?--patches needs a directory}"; shift 2 ;;
    --base) base="${2:?--base needs a ref}"; shift 2 ;;
    --branch) branch="${2:?--branch needs a name}"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "apply: unknown option $1" >&2; usage ;;
    *) if [ -z "$clone" ]; then clone="$1"; shift; else echo "apply: unexpected argument $1" >&2; usage; fi ;;
  esac
done
[ -n "$clone" ] || usage
[ -d "$patches" ] || { echo "apply: patches directory not found: $patches" >&2; exit 2; }
patches="$(cd "$patches" && pwd)"

read_upstream() {
  [ -f "$1/UPSTREAM" ] || return 0
  grep -v '^[[:space:]]*#' "$1/UPSTREAM" | grep -v '^[[:space:]]*$' | head -n 1 | tr -d '[:space:]'
}

if [ -z "$base" ]; then base="$(read_upstream "$patches")"; fi
if [ -z "$base" ]; then
  echo "apply: no upstream ref: pass --base or pin one in $patches/UPSTREAM" >&2
  exit 2
fi

git -C "$clone" rev-parse --git-dir >/dev/null 2>&1 || { echo "apply: not a git repository: $clone" >&2; exit 2; }
git_dir="$(git -C "$clone" rev-parse --absolute-git-dir)"
if [ -d "$git_dir/rebase-apply" ] || [ -d "$git_dir/rebase-merge" ]; then
  echo "apply: a git am/rebase is in progress in $clone (finish with 'git am --continue' or 'git am --abort')" >&2
  exit 1
fi
if [ -n "$(git -C "$clone" status --porcelain --untracked-files=no)" ]; then
  echo "apply: work tree has uncommitted changes: $clone" >&2
  exit 1
fi
base_sha="$(git -C "$clone" rev-parse --verify --quiet "$base^{commit}")" || {
  echo "apply: upstream ref not found in clone: $base (fetch it first)" >&2
  exit 2
}

git -C "$clone" checkout --quiet -B "$branch" "$base_sha"

count=0
for patch in "$patches"/*.patch; do
  [ -e "$patch" ] || continue
  count=$((count + 1))
done
if [ "$count" -eq 0 ]; then
  echo "apply: no patches in $patches; $branch is at $base ($base_sha)"
  exit 0
fi

if ! git -C "$clone" am --3way --keep-cr --quiet "$patches"/*.patch; then
  echo "apply: conflict while applying the patch queue onto $base." >&2
  echo "apply: resolve in $clone, 'git add' the files, then 'git am --continue' (or 'git am --abort')." >&2
  exit 1
fi
echo "apply: applied $count patch(es) onto $base ($base_sha) on branch $branch"
