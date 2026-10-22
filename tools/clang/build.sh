#!/usr/bin/env bash
# Builds the @yowasp/clang npm package (Clang/LLD for the browser) for an upstream LLVM release into tools/clang/dist/package/,
# using YoWASP's own recipe (https://github.com/YoWASP/clang, ISC/Apache-2.0) at a pinned revision, with their WASI
# patch (see wasi.patch) applied to the release. ~10-20 min on 32 cores; WORK holds ~6 GB for reuse.
set -euo pipefail

LLVM_TAG=llvmorg-22.1.8
YOWASP_REV=944dd7c774954180e621cc8e12984023a7f8bcbe # YoWASP/clang develop, 2026-03-01
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$HOME/.cache/interview-pad-yowasp/build}
export CMAKE_BUILD_PARALLEL_LEVEL=${JOBS:-$(nproc)} MAKEFLAGS=-j${JOBS:-$(nproc)}

mkdir -p "$WORK" "$HERE/dist"
cd "$WORK"
[[ -d clang ]] || git clone -q https://github.com/YoWASP/clang
cd clang
git checkout -q "$YOWASP_REV"
git submodule update --init -q wasi-libc-src

if [[ "$(cat llvm-src/.tag 2>/dev/null)" != "$LLVM_TAG" ]]; then
  rm -rf llvm-src
  git clone -q --depth 1 --branch "$LLVM_TAG" https://github.com/llvm/llvm-project llvm-src
  git -C llvm-src apply "$HERE/wasi.patch"
  echo "$LLVM_TAG" > llvm-src/.tag
fi

rm -rf wasi-libc-build # build.sh doesn't reinstall wasi-libc's headers on re-runs otherwise
./build.sh
rm -rf npmjs/dist
PYTHON=python3 ./package-npmjs.sh
# unpacked: web/package.json depends on the directory, as the tarball isn't bit-for-bit reproducible (lockfile integrity)
rm -rf "$HERE/dist" && mkdir -p "$HERE/dist"
tar xzf npmjs/dist/*.tgz -C "$HERE/dist"
ls -la "$HERE/dist/package"
