#!/usr/bin/env bash
# Tests apply.sh / refresh.sh / rebase.sh against a throwaway upstream git repository
# (no MapLibre clone needed). Hermetic: ignores global/system git config.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/patch-queue-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="Patch Queue Test" GIT_AUTHOR_EMAIL="patch-queue@example.invalid"
export GIT_COMMITTER_NAME="Patch Queue Test" GIT_COMMITTER_EMAIL="patch-queue@example.invalid"
export GIT_AUTHOR_DATE="2026-01-01T00:00:00Z" GIT_COMMITTER_DATE="2026-01-01T00:00:00Z"

passed=0
log="$tmp/last.log"
ok() { passed=$((passed + 1)); }
fail() {
  echo "patch-queue test: FAIL: $*" >&2
  [ -f "$log" ] && sed 's/^/    | /' "$log" >&2
  exit 1
}
expect_success() { local d="$1"; shift; if "$@" >"$log" 2>&1; then ok; else fail "$d (exit $?)"; fi; }
expect_exit() {
  local d="$1" want="$2"; shift 2
  local got=0
  "$@" >"$log" 2>&1 || got=$?
  [ "$got" -eq "$want" ] && ok || fail "$d: expected exit $want, got $got"
}
expect_eq() { [ "$2" = "$3" ] && ok || fail "$1: expected '$3', got '$2'"; }
upstream_ref() { grep -v '^[[:space:]]*#' "$1/UPSTREAM" | grep -v '^[[:space:]]*$' | head -n 1; }
queue_sum() { cat "$1"/*.patch "$1/UPSTREAM" | cksum; }
patch_count() { ls "$1"/*.patch 2>/dev/null | wc -l | tr -d ' '; }

apply() { bash "$script_dir/apply.sh" "$@"; }
refresh() { bash "$script_dir/refresh.sh" "$@"; }
rebase() { bash "$script_dir/rebase.sh" "$@"; }

# --- Upstream fixture: v1 -> v2 (non-conflicting) -> v3 (conflicts with our first patch) ---
up="$tmp/upstream"
git init -q -b main "$up"
for i in 1 2 3 4 5 6 7 8 9 10; do echo "line $i"; done > "$up/core.txt"
echo "render v1" > "$up/render.txt"
git -C "$up" add . && git -C "$up" commit -q -m "upstream v1" && git -C "$up" tag v1
echo "render v2" > "$up/render.txt"
git -C "$up" commit -q -am "upstream v2" && git -C "$up" tag v2
sed 's/^line 2$/upstream changed line 2/' "$up/core.txt" > "$up/core.tmp" && mv "$up/core.tmp" "$up/core.txt"
git -C "$up" commit -q -am "upstream v3" && git -C "$up" tag v3

# --- Author two patches on top of v1 and export them ---
work="$tmp/work"
git clone -q "$up" "$work"
git -C "$work" checkout -q -b dev v1
sed 's/^line 2$/maprama line 2/' "$work/core.txt" > "$work/core.tmp" && mv "$work/core.tmp" "$work/core.txt"
git -C "$work" commit -q -am "[maprama] patch core line 2"
echo "maprama layer" > "$work/maprama.txt"
git -C "$work" add maprama.txt && git -C "$work" commit -q -m "[maprama] add maprama layer"

queue="$tmp/patches"
mkdir -p "$queue"
printf '# pinned upstream\nv1\n' > "$queue/UPSTREAM"

expect_success "refresh exports the queue" refresh "$work" --patches "$queue"
expect_eq "refresh writes one patch per commit" "$(patch_count "$queue")" "2"
expect_eq "patch files are numbered" "$(cd "$queue" && ls *.patch | head -n 1)" "0001-maprama-patch-core-line-2.patch"
expect_eq "patches use zero commit ids" "$(head -n 1 "$queue/0001-maprama-patch-core-line-2.patch" | cut -d' ' -f2)" \
  "0000000000000000000000000000000000000000"
sum1="$(queue_sum "$queue")"
expect_success "refresh is repeatable" refresh "$work" --patches "$queue"
expect_eq "refresh is byte-identical when nothing changed" "$(queue_sum "$queue")" "$sum1"

# --- apply onto a fresh clone ---
clone="$tmp/clone"
git clone -q "$up" "$clone"
expect_success "apply onto pinned base" apply "$clone" --patches "$queue"
expect_eq "apply creates the patched branch" "$(git -C "$clone" rev-parse --abbrev-ref HEAD)" "maprama/patched"
expect_eq "apply adds both commits" "$(git -C "$clone" rev-list --count v1..HEAD)" "2"
expect_eq "patched content present" "$(sed -n 2p "$clone/core.txt")" "maprama line 2"
expect_eq "added file present" "$(cat "$clone/maprama.txt")" "maprama layer"

echo "dirty" >> "$clone/core.txt"
expect_exit "apply refuses a dirty work tree" 1 apply "$clone" --patches "$queue"
git -C "$clone" checkout -q -- core.txt

unpinned="$tmp/unpinned"
mkdir -p "$unpinned"
expect_exit "apply requires a pinned or explicit base" 2 apply "$clone" --patches "$unpinned"
expect_exit "apply rejects an unknown base" 2 apply "$clone" --patches "$queue" --base no-such-ref

# --- rebase onto v2 (clean) ---
expect_success "rebase onto a non-conflicting upstream" rebase "$clone" v2 --patches "$queue"
expect_eq "rebase pins the new base" "$(upstream_ref "$queue")" "v2"
expect_eq "rebase keeps the queue size" "$(patch_count "$queue")" "2"
expect_eq "rebased branch sits on v2" "$(git -C "$clone" rev-list --count v2..HEAD)" "2"
expect_eq "upstream change present after rebase" "$(cat "$clone/render.txt")" "render v2"
expect_eq "patch still applied after rebase" "$(sed -n 2p "$clone/core.txt")" "maprama line 2"
expect_success "refresh after rebase is stable" refresh "$clone" --patches "$queue"
sum2="$(queue_sum "$queue")"

# --- rebase onto v3 (conflict) ---
expect_exit "rebase stops on conflict" 1 rebase "$clone" v3 --patches "$queue"
expect_eq "conflicting rebase leaves UPSTREAM pinned to the old base" "$(upstream_ref "$queue")" "v2"
expect_eq "conflicting rebase leaves patches untouched" "$(queue_sum "$queue")" "$sum2"
expect_exit "apply refuses while git am is in progress" 1 apply "$clone" --patches "$queue"
expect_exit "refresh refuses while git am is in progress" 1 refresh "$clone" --patches "$queue"
git -C "$clone" am --abort

# --- empty queue ---
empty="$tmp/empty"
mkdir -p "$empty"
echo v1 > "$empty/UPSTREAM"
expect_success "apply with an empty queue" apply "$clone" --patches "$empty"
expect_eq "empty queue leaves the branch at the base" "$(git -C "$clone" rev-parse HEAD)" "$(git -C "$clone" rev-parse v1)"

echo "patch-queue test: $passed checks passed"
