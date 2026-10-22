# TODO

- Run user code in a sandboxed iframe (opaque origin): today code run by the interviewer can call the API with the
  interviewer's session (e.g. admit someone, end the interview).
- Configurable run time limit (env var or interviewer setting), or other options than a fixed 10 s wall clock.
- Make the rest of the page follow the Monaco theme (and system theme?).
- Use xterm.js for interactive stdin?
- LLVM (tools/clang, clang-eh.mjs, tools/clangd/build.sh) and Pyodide versions must be upgraded together.
- LLVM 23: tools/clang/wasi.patch needs porting (6 hunks conflict: CrashRecoveryContext.cpp, InitLLVM.cpp, Path.inc
  locking, Process.inc PreventCoreFiles, clang Compiler.h); then drop the __cpp_exception tag from clang-eh.mjs.
- Fix dead links in the About dialog.
- Backend dependencies: do we need websockets, pycrdt(-websocket), Starlette *and* uvicorn for a program this small?
