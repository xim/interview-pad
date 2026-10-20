# interview-pad

Minimal real-time collaborative code editor for interviews.
Shared editor with live cursors; C, C++, Python and TypeScript run **in the browser** (WASM) of whoever clicks Run,
and the output is shared. Python backend; one instance per interview; in-memory only.

Flow: the interviewer logs in with a password (and optional display name); the candidate joins with a name and waits
until the interviewer admits them. "End interview" disconnects all candidates.

Design and status: [PLAN.md](PLAN.md).

## Run with podman (rootless)

```sh
podman build -t interview-pad .
podman run --rm -p 127.0.0.1:8080:8000 -e INTERVIEWER_PASSWORD=secret interview-pad
```

- The host port is the `-p` mapping. The internal port can be changed with `-e PORT=9000 -p 127.0.0.1:8080:9000`.
- Without `INTERVIEWER_PASSWORD`, a random password is generated and logged.
- Session cookies are `Secure`: serve over HTTPS (browsers make an exception for `localhost`).
- One instance per interview: run more on different ports, each with its own password.

## C/C++ IntelliSense (optional)

Completion, diagnostics, hover etc. for C/C++ come from clangd compiled to WASM, which isn't part of the normal build:

```sh
tools/clangd/build.sh    # ~10 min on 32 cores, ~6 GB in ~/.cache/interview-pad-clangd; needs git, cmake, make
podman build -t interview-pad .   # picks up web/public/clangd/
```

Without it, C/C++ still compile and run; the editor just says IntelliSense is unavailable. Cost per participant,
on first selecting C or C++: a 58 MB download (16 MB gzipped), ~0.5 GB RAM, ~3 s and ~18 CPU-seconds to the first
completion (~1.6 s and ~5 CPU-seconds once the browser has cached it), then idle. It needs cross-origin isolation
(COOP/COEP headers, always sent by the server), as it uses threads.

## Behind Apache

```apache
# needs mod_proxy, mod_proxy_http (2.4.47+ for upgrade=websocket)
ProxyPass        /pad/ http://127.0.0.1:8080/ upgrade=websocket
ProxyPassReverse /pad/ http://127.0.0.1:8080/
# the app sets its cookie on /; scope it to the prefix so instances on one host don't clash
ProxyPassReverseCookiePath / /pad/

# the C++ compiler is ~105 MB raw, ~27 MB compressed
<Location /pad/>
    AddOutputFilterByType DEFLATE application/wasm application/x-tar text/javascript
</Location>
```

All app URLs are relative, so any prefix works. The trailing slash on `/pad/` matters.

## Development

```sh
cd server && uv sync && INTERVIEWER_PASSWORD=pw uv run uvicorn app:create_app --factory --reload
cd web && npm install && npm run dev    # http://localhost:5173, proxies api/ and ws/ to :8000
```

Tests:

```sh
cd server && uv run pytest
cd web && npm run check                 # type-check
# end-to-end: starts a fresh server, drives two headless Chrome sessions (CHROME=/path/to/chrome to override)
cd web && npm run build && npm run e2e
node e2e/smoke.mjs http://localhost:8080/pad/   # or against a running instance (PASSWORD=..., default pw)
```

## Limitations

- stdin and arguments are set up front in the shared Input tab; there is no interactive stdin.
  TS gets `process.argv` and `prompt()` (next stdin line, `null` at EOF).
- C/C++: WASM has no memory protection inside its linear memory, so null dereferences and out-of-bounds
  accesses don't fault by themselves. UBSan (with our own handlers, `web/src/runners/runtime.c`) and, for C++,
  libc++ hardening are always enabled and report the problem; crashes print a backtrace. No ASan (no runtime).
- C++: exceptions work (WASM exception handling; runtime built from llvm-project by `web/scripts/clang-eh.mjs`),
  except ones thrown from inside the prebuilt libc++ library (e.g. `std::stoi`), which abort with a message.
- TS/JS: the program ends when the module finishes evaluating; pending timers are dropped.
- Python: full stdlib plus a set of bundled packages (numpy, pandas, pydantic, pytest, pyyaml, rich, …; loaded
  on import; list in `web/scripts/pyodide.mjs`). Other third-party imports fail.
- Run timeout: 10 s of execution (runtime download and compile time don't count). Output is capped at 64 KB.
