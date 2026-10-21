// Shared by the compiler (clang.worker.ts) and clangd (clangd.worker.ts).
// Always passed, ahead of the user's flags (so those can still override). WASM doesn't fault on null or
// out-of-bounds accesses, so catch UB with UBSan (handlers in runtime.c) and libc++ hardening (which only
// prints its message with the experimental ENFORCE semantic; QUICK_ENFORCE traps silently).
// wasm-ld's default stack is 64 KB with no guard; use Linux's 8 MB, placed first so an overflow traps (runs
// below address 0) instead of silently corrupting globals and the heap.
const STACK = ['-Wl,-z,stack-size=8388608', '-Wl,--stack-first'];

export const HIDDEN_FLAGS = {
  c: [...STACK, '-fsanitize=undefined', '-fno-sanitize-recover=all'],
  cpp: [
    ...STACK,
    // exception runtime built by scripts/clang-eh.mjs; the tag export lets wasi.worker.ts report uncaught ones
    '-fwasm-exceptions',
    '-Wl,--export-if-defined=__cpp_exception', // absent if the user adds -fno-exceptions
    '-fsanitize=undefined',
    '-fno-sanitize-recover=all',
    '-fexperimental-library',
    '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_FAST',
    '-D_LIBCPP_ASSERTION_SEMANTIC=_LIBCPP_ASSERTION_SEMANTIC_ENFORCE',
  ],
};
