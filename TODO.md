# TODO

- Run user code in a sandboxed iframe (opaque origin): today code run by the interviewer can call the API with the
  interviewer's session (e.g. admit someone, end the interview).
- Configurable run time limit (env var or interviewer setting), or other options than a fixed 10 s wall clock.
- Make the rest of the page follow the Monaco theme (and system theme?).
- Use xterm.js for interactive stdin?
- LLVM (clang-eh.mjs, tools/clangd/build.sh), Pyodide and @yowasp/clang versions must be upgraded together.
- Fix dead links in the About dialog.
- Backend dependencies: do we need websockets, pycrdt(-websocket), Starlette *and* uvicorn for a program this small?
