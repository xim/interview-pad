#!/usr/bin/env bash
# Builds the @yowasp/clang npm package (Clang/LLD for the browser) for an upstream LLVM release into tools/clang/dist/package/,
# using YoWASP's own recipe (https://github.com/YoWASP/clang, ISC/Apache-2.0) at a pinned revision, with their WASI
# patch (see wasi.patch) applied to the release. The bundled target sysroot is wasi-sdk's wasm32-wasip1-threads one
# instead of the recipe's own. ~10-20 min on 32 cores; WORK holds ~6 GB for reuse.
set -euo pipefail

LLVM_TAG=llvmorg-23.1.5
WASI_SDK_VER=34 # its sysroot is built from LLVM 23.1
WASI_SYSROOT_SHA256=9d813544eeebe38b7b8f2244ed591de46b6db812c6dd1a257ff9f0d2a905a2be
WASI_RT_SHA256=eee3e634dcf71aa22b1333391623cf5c9965a637dc428a27b1a858c026c587f1
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
  rm -rf llvm-src llvm-tblgen-build # build.sh reuses an existing tblgen
  git clone -q --depth 1 --branch "$LLVM_TAG" https://github.com/llvm/llvm-project llvm-src
  git -C llvm-src apply "$HERE/wasi.patch"
  echo "$LLVM_TAG" > llvm-src/.tag
fi

# only the compiler and its resource headers: the target libraries (the rest) come from wasi-sdk below
sed '/^# Options below heavily based on wasi-sdk/,$d' build.sh | sh -ex

fetch() {
  [[ -f ../$1 ]] || curl -fsSL -o "../$1" "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_SDK_VER/$1"
  echo "$2  ../$1" | sha256sum -c --quiet
}
fetch "wasi-sysroot-$WASI_SDK_VER.0.tar.gz" "$WASI_SYSROOT_SHA256"
fetch "libclang_rt-$WASI_SDK_VER.0.tar.gz" "$WASI_RT_SHA256"
rm -rf wasi-sdk-sysroot && mkdir -p wasi-sdk-sysroot/rt
tar xzf "../wasi-sysroot-$WASI_SDK_VER.0.tar.gz" -C wasi-sdk-sysroot --strip-components=1
tar xzf "../libclang_rt-$WASI_SDK_VER.0.tar.gz" -C wasi-sdk-sysroot/rt --strip-components=1
# keep the recipe's clang resource headers; only the C++-exceptions variants (C++ always gets -fwasm-exceptions)
T=wasm32-wasip1-threads
P=wasi-prefix/usr
rm -rf "$P"/include/wasm32-* "$P"/include/c++ "$P"/lib/wasm32-* "$P"/share
cp -r "wasi-sdk-sysroot/include/$T" "wasi-sdk-sysroot/include/c++" "$P/include/" # c++/v1: empty, the driver's version probe
cp -r "wasi-sdk-sysroot/lib/$T" "wasi-sdk-sysroot/rt/wasm32-unknown-wasip1-threads" "$P/lib/"
rm -rf "$P/include/$T/noeh" "$P/lib/$T/noeh" "$P/lib/$T/llvm-lto" "$P/lib/$T/eh/llvm-lto"
# wasi-sdk's libraries carry DWARF, which would end up in every program
wasi-sdk-*/bin/llvm-strip --strip-debug "$P"/lib/*/*.a "$P"/lib/*/*.o "$P/lib/$T"/eh/*.a
rm -rf npmjs/dist
PYTHON=python3 ./package-npmjs.sh
# unpacked: web/package.json depends on the directory, as the tarball isn't bit-for-bit reproducible (lockfile integrity)
rm -rf "$HERE/dist" && mkdir -p "$HERE/dist"
tar xzf npmjs/dist/*.tgz -C "$HERE/dist"
ls -la "$HERE/dist/package"
