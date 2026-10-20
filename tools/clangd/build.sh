#!/usr/bin/env bash
# Builds clangd for the browser (emscripten, threaded) into web/public/clangd/.
# Adapted from https://github.com/guyutongxue/clangd-in-browser (MIT), incl. wait_stdin.patch.
# Headers aren't embedded: the page mounts the bundled clang's resource tarball at runtime instead.
# Slow (~LLVM build); WORK holds the checkouts and build dirs for reuse.
set -euo pipefail

EMSDK_VER=4.0.22
LLVM_TAG=llvmorg-22.1.8
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../../web/public/clangd
WORK=${WORK:-$HOME/.cache/interview-pad-clangd}
JOBS=${JOBS:-$(nproc)}

mkdir -p "$WORK" "$OUT"
cd "$WORK"

[[ -d emsdk ]] || git clone --depth 1 --branch "$EMSDK_VER" https://github.com/emscripten-core/emsdk
(cd emsdk && ./emsdk install "$EMSDK_VER" && ./emsdk activate "$EMSDK_VER") >/dev/null
source emsdk/emsdk_env.sh >/dev/null

[[ -d llvm-project ]] || git clone --depth 1 --branch "$LLVM_TAG" https://github.com/llvm/llvm-project
cd llvm-project
[[ -f .patched ]] || { git apply "$HERE/wait_stdin.patch" && touch .patched; }

cmake -S llvm -B build-native -DCMAKE_BUILD_TYPE=Release -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra" \
    -DLLVM_TARGETS_TO_BUILD=WebAssembly -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF
cmake --build build-native -j "$JOBS" --target llvm-tblgen clang-tblgen clang-tidy-confusable-chars-gen

emcmake cmake -S llvm -B build \
    -DCMAKE_CXX_FLAGS="-pthread -Dwait4=__syscall_wait4" \
    -DCMAKE_EXE_LINKER_FLAGS="-pthread -sENVIRONMENT=worker -sNO_INVOKE_RUN -sEXIT_RUNTIME -sINITIAL_MEMORY=256MB \
-sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=256kB -sEXPORTED_RUNTIME_METHODS=FS,callMain -sMODULARIZE \
-sEXPORT_ES6 -sWASM_BIGINT -sASYNCIFY -sPTHREAD_POOL_SIZE=6" \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DLLVM_TARGET_ARCH=wasm32-emscripten \
    -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasip1 \
    -DLLVM_TARGETS_TO_BUILD=WebAssembly \
    -DLLVM_ENABLE_PROJECTS="clang;clang-tools-extra" \
    -DLLVM_TABLEGEN="$PWD/build-native/bin/llvm-tblgen" \
    -DCLANG_TABLEGEN="$PWD/build-native/bin/clang-tblgen" \
    -DCLANG_TIDY_CONFUSABLE_CHARS_GEN="$PWD/build-native/bin/clang-tidy-confusable-chars-gen" \
    -DLLVM_BUILD_STATIC=ON -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_ENABLE_BACKTRACES=OFF \
    -DLLVM_ENABLE_UNWIND_TABLES=OFF -DLLVM_ENABLE_CRASH_OVERRIDES=OFF -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
    -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_PIC=OFF -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DCLANG_ENABLE_ARCMT=OFF
cmake --build build -j "$JOBS" --target clangd

cp build/bin/clangd.js build/bin/clangd.wasm "$OUT/"
ls -la "$OUT"
