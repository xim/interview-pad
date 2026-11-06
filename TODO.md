# TODO

- Configurable run time limit (env var or interviewer setting), or other options than a fixed 10 s wall clock.
- Make the rest of the page follow the Monaco theme (and system theme?).
- Use xterm.js for interactive stdin?
- LLVM (tools/clang incl. its wasi-sdk sysroot, tools/clangd/build.sh) and Pyodide versions must be upgraded together.
- Multiple interviews per instance: a room per interview (unguessable id, invite link `/i/<id>`, `ws/<id>`), with
  sessions, join requests, admission, limits and End interview scoped to it, and idle rooms dropped. Generalizes the
  demo rooms. Interviewer auth via accounts or reverse-proxy SSO (trusted user header) instead of one password.
- Split the language templates into files (e.g. `templates/init.<ext>`), so they're readable outside the web page.
- In-memory file I/O for programs, e.g. reading or writing a CSV file.
- Other (non-network) functions we might want to allow or expose.
