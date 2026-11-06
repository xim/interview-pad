// Shared by the compiler (clang.worker.ts) and clangd (clangd.worker.ts).
// Always passed, ahead of the user's flags (so those can still override). WASM doesn't fault on null or
// out-of-bounds accesses, so catch UB with UBSan (handlers in runtime.c) and libc++ hardening (which only
// prints its message with the experimental ENFORCE semantic; QUICK_ENFORCE traps silently).
const TARGET = ['--target=wasm32-wasip1-threads', '-pthread'];
// wasm-ld's default stack is 64 KB with no guard; use Linux's 8 MB, placed first so an overflow traps (runs
// below address 0) instead of silently corrupting globals and the heap.
const STACK = ['-Wl,-z,stack-size=8388608', '-Wl,--stack-first'];
// wasi-threads: every thread instantiates the module on the same imported memory; shared memory needs a maximum
const MEMORY = ['-Wl,--import-memory,--export-memory,--max-memory=4294967296'];

export const HIDDEN_FLAGS = {
  c: [...TARGET, ...STACK, ...MEMORY, '-fsanitize=undefined', '-fno-sanitize-recover=all'],
  cpp: [
    ...TARGET,
    ...STACK,
    ...MEMORY,
    // the sysroot's libc++ uses exnref exceptions, not yet clang's default; the tag export lets wasi.worker.ts
    // report uncaught ones
    '-fwasm-exceptions',
    '-mllvm',
    '-wasm-use-legacy-eh=false',
    '-Wl,-lunwind',
    '-Wl,--export-if-defined=__cpp_exception', // absent if the user adds -fno-exceptions
    '-fsanitize=undefined',
    '-fno-sanitize-recover=all',
    '-fexperimental-library',
    '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST',
    '-D_LIBCPP_ASSERTION_SEMANTIC=_LIBCPP_ASSERTION_SEMANTIC_ENFORCE',
  ],
};
