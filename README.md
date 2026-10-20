# interview-pad

Real-time collaborative code editor for interviews. Code runs **in the browser** (WASM) of whoever clicks Run,
and the output is shared. Python backend, one instance per interview, in-memory only. Open items: [TODO.md](TODO.md).

## Features

- Interviewer logs in with a password; candidates join with a name and wait to be admitted. "End interview"
  disconnects all candidates.
- Shared Monaco editor with live cursors/selections; per-person Vim bindings, completion toggle and theme.
- C, C++ (clang 22, C++26 by default, exceptions), Python 3.14 (Pyodide, numpy/pandas/pytest/… on import) and
  TypeScript. Shared compiler flags, program arguments and stdin.
- C/C++ catch UB at run time (UBSan, libc++ hardening) with source locations and backtraces.
- Completion/hover: TypeScript (Monaco), Python (Jedi), C/C++ (clangd, optional build).
- Colored, terminal-style output.

## Build and run (podman, rootless)

```sh
tools/clangd/build.sh             # optional, for C/C++ IntelliSense; see below
podman build -t interview-pad .
podman run --rm --read-only --cap-drop=all --security-opt=no-new-privileges \
    -p 127.0.0.1:8080:8000 -e INTERVIEWER_PASSWORD=secret interview-pad
```

- `-p` sets the host port; `-e PORT=9000` changes the internal one.
- Without `INTERVIEWER_PASSWORD`, a random password is generated and logged.
- Serve over HTTPS (session cookies are `Secure`; browsers make an exception for `localhost`).
- One instance per interview: run more on different ports, each with its own password.

### C/C++ IntelliSense (clangd)

`tools/clangd/build.sh` builds clangd for the browser into `web/public/clangd/`, which `podman build` then
includes. It needs git, cmake, make and a C++ compiler; it takes ~10 min on 32 cores and keeps ~6 GB of sources and
build files in `~/.cache/interview-pad-clangd` (reruns are incremental). Without it, C/C++ still compile and run.

Per participant, on first selecting C or C++: 58 MB download (16 MB gzipped), ~0.5 GB RAM, ~3 s to the first
completion (~1.6 s once cached).

## Behind Apache

```apache
# mod_proxy, mod_proxy_http (2.4.47+ for upgrade=websocket), mod_deflate
ProxyPass        /pad/ http://127.0.0.1:8080/ upgrade=websocket
ProxyPassReverse /pad/ http://127.0.0.1:8080/
# the app sets its cookie on /; scope it to the prefix so instances on one host don't clash
ProxyPassReverseCookiePath / /pad/

# compilers and runtimes are large; compression roughly quarters them
<Location /pad/>
    AddOutputFilterByType DEFLATE application/wasm application/x-tar text/javascript
</Location>
```

All app URLs are relative, so any prefix works; the trailing slash on `/pad/` matters.

## Development

```sh
cd server && uv sync && INTERVIEWER_PASSWORD=pw uv run uvicorn app:create_app --factory --reload
cd web && npm install && npm run dev    # http://localhost:5173, proxies api/ and ws/ to :8000

cd server && uv run pytest
cd web && npm run check                 # type-check
cd web && npm run build && npm run e2e  # fresh server + two headless Chrome sessions (CHROME=... to override)
```

## Limitations

- stdin and arguments are given up front (Input tab); no interactive stdin. TS gets `process.argv` and `prompt()`.
- Runs are killed after 10 s of execution (download and compile time don't count); output is capped at 64 KB.
- C++ exceptions thrown inside the prebuilt libc++ (e.g. `std::stoi`) abort instead of being catchable.
- No ASan. Null/out-of-bounds accesses that UBSan and hardening don't catch silently succeed (WASM memory).
- TS: the program ends when the module finishes evaluating; pending timers are dropped.
- Python: stdlib plus the packages listed in `web/scripts/pyodide.mjs`.
