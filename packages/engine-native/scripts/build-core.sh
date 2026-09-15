#!/usr/bin/env bash
# Builds the Diorama native C++ core without CMake (none on this toolchain).
#
#   scripts/build-core.sh            -> build/libdiorama_core.a  (-O2)
#   scripts/build-core.sh --tests    -> also build/diorama_core_tests (ASan + UBSan unless SANITIZE=0)
#
# Compiler: $CXX if set, else `xcrun clang++` (macOS), else clang++ / c++.
# The iOS/Android builds will compile the same sources from CocoaPods / CMake (DESIGN.md §9).
# Paths are kept in arrays so a checkout under a directory with spaces builds too.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="$root/build"
with_tests=0
for arg in "$@"; do
  case "$arg" in
    --tests) with_tests=1 ;;
    *) echo "build-core: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -n "${CXX:-}" ]; then
  read -r -a cxx <<< "$CXX"
elif command -v xcrun >/dev/null 2>&1 && xcrun --find clang++ >/dev/null 2>&1; then
  cxx=(xcrun clang++)
elif command -v clang++ >/dev/null 2>&1; then
  cxx=(clang++)
else
  cxx=(c++)
fi
if command -v xcrun >/dev/null 2>&1 && xcrun --find ar >/dev/null 2>&1; then
  ar_cmd=(xcrun ar)
else
  ar_cmd=(ar)
fi

common_flags=(-std=c++17 -Wall -Wextra -Wpedantic -Werror "-I$root/cpp/include" "-I$root/cpp/src")
mkdir -p "$build/obj"

# Compile $1 -> $2 with extra flags $3 (space-separated, no paths) in the background; records the pid.
pids=""
compile() {
  # shellcheck disable=SC2086
  "${cxx[@]}" "${common_flags[@]}" $3 -c "$1" -o "$2" &
  pids="$pids $!"
}
wait_all() {
  local failed=0
  for pid in $pids; do
    if ! wait "$pid"; then failed=1; fi
  done
  pids=""
  if [ "$failed" -ne 0 ]; then
    echo "build-core: compilation failed" >&2
    exit 1
  fi
}

sources=("$root"/cpp/src/*.cpp)

# 1) Static library.
objects=()
for src in "${sources[@]}"; do
  obj="$build/obj/$(basename "${src%.cpp}").o"
  compile "$src" "$obj" "-O2 -fPIC"
  objects+=("$obj")
done
wait_all
rm -f "$build/libdiorama_core.a"
"${ar_cmd[@]}" rcs "$build/libdiorama_core.a" "${objects[@]}"
echo "build-core: $build/libdiorama_core.a (${#sources[@]} sources, compiler: ${cxx[*]})"

# 2) Conformance test binary (sources compiled again with sanitizers).
if [ "$with_tests" -eq 1 ]; then
  test_flags="-O1 -g"
  if [ "${SANITIZE:-1}" != "0" ]; then
    test_flags="$test_flags -fsanitize=address,undefined -fno-sanitize-recover=undefined -fno-omit-frame-pointer"
  fi
  mkdir -p "$build/test-obj"
  test_objects=()
  for src in "${sources[@]}" "$root"/cpp/tests/*.cpp; do
    obj="$build/test-obj/$(basename "$(dirname "$src")")-$(basename "${src%.cpp}").o"
    compile "$src" "$obj" "$test_flags"
    test_objects+=("$obj")
  done
  wait_all
  # shellcheck disable=SC2086
  "${cxx[@]}" $test_flags "${test_objects[@]}" -o "$build/diorama_core_tests"
  echo "build-core: $build/diorama_core_tests (flags: $test_flags)"
fi
