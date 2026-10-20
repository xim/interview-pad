# TODO

- Run user code in a sandboxed iframe (opaque origin): today code run by the interviewer can call the API with the
  interviewer's session (e.g. admit someone, end the interview).
- Configurable run time limit (env var or interviewer setting), or other options than a fixed 10 s wall clock.
- Make the rest of the page follow the Monaco theme (and system theme?).
- Use xterm.js for interactive stdin?
- Interviewer-only "download code + output" (state is lost when the instance stops).
- CI: backend tests, type-check, e2e; cache the clangd build as an artifact.
- Monaco pins DOMPurify 3.4.15 (npm audit: two IN_PLACE-mode advisories; Monaco doesn't use IN_PLACE). Bump with Monaco.
- LLVM (clang-eh.mjs, tools/clangd/build.sh), Pyodide and @yowasp/clang versions must be upgraded together.
