// Shared by the compiler (clang.worker.ts) and clangd (clangd.worker.ts).
// Always passed, ahead of the user's flags (so those can still override). WASM doesn't fault on null or
// out-of-bounds accesses, so catch UB with UBSan (handlers in runtime.c) and libc++ hardening (which only
// prints its message with the experimental ENFORCE semantic; QUICK_ENFORCE traps silently).
export const HIDDEN_FLAGS = {
  c: ['-fsanitize=undefined', '-fno-sanitize-recover=all'],
  cpp: [
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
