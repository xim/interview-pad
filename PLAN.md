# interview-pad — plan / spec

Working doc. Delete or fold into README once implemented.

## Goals / constraints

- Real-time collaborative editor for 1 interviewer + 1 candidate (more is allowed, but not optimized for).
- C++, Python and TypeScript, with highlighting, live cursors/selections, and code execution.
- **Code runs in the browser** of whoever clicks Run; output is shared through the doc.
  The server never executes user code.
- Python backend. Rootless podman. Always behind a TLS-terminating reverse proxy
  (Apache), possibly under a path prefix → **relative URLs everywhere**, no TLS, no static-serving tuning.
- One instance per interview; in-memory state only; no DB.
- KISS/YAGNI, few dependencies, small focused commits.

## Prototype findings (proto/, not committed)

- **C++**: `@yowasp/clang` (LLVM 22, ISC/Apache-2) works in Chrome, in a Worker, built by Vite.
  - Download: 105 MB raw / ~27 MB gzip (`llvm.core.wasm` + `llvm-resources.tar`). Cached by the browser after the first load.
  - First compile, including load from localhost: ~1.8 s. Running the result: a few ms.
  - Output is WASI preview1 → run it with `@bjorn3/browser_wasi_shim` (MIT/Apache, 115 KB).
  - The sysroot has **no libunwind → no exception support**. Fix: link a tiny stub defining
    `__cxa_allocate_exception`/`__cxa_throw`. Then `try`/`catch` compiles and `throw` prints
    `terminate: exception thrown (St12out_of_range) ...` and aborts. Verified.
  - Vite: `optimizeDeps.exclude: ['@yowasp/clang']` is required (it loads assets via `new URL(..., import.meta.url)`).
  - Pass `fetchProgress` to `runClang`, otherwise it spams the console with progress lines.
- **TypeScript**: npm `typescript@7` is the native Go port → unusable in a browser. Monaco 0.57 bundles
  TS 5.9 and exposes `monaco.typescript.getTypeScriptWorker()` → `getEmitOutput(uri)`. No extra dependency,
  and the editor shows type errors for free.
- **Python**: Pyodide (npm `pyodide`, v314). Not prototyped; it's mature. Self-host it (no CDN).
- **Backend**: `pycrdt-websocket` 0.16 (import path `pycrdt.websocket`) provides `WebsocketServer` + `ASGIServer`
  (`on_connect(msg, scope) -> True` rejects the connection). It speaks the y-websocket protocol.
  Must use `auto_clean_rooms=False`, or the doc is dropped when everyone disconnects.

## Architecture

```
          ┌──────────── backend (Starlette + uvicorn, one process) ───────────┐
browser ──┤ /api/*   auth + join/admit (JSON, cookie session)                 │
          │ /ws      Yjs sync + awareness (pycrdt-websocket), auth on connect │
          │ /*       static frontend (Vite build output)                      │
          └───────────────────────────────────────────────────────────────────┘
browser: Monaco + y-monaco ── Y.Doc ── y-websocket provider
         runners: cpp (clang worker + run worker), python (pyodide worker), ts (Monaco emit + run worker)
```

### Backend (Python)

Deps: `starlette`, `uvicorn`, `websockets`, `pycrdt-websocket`. Dev: `pytest`, `httpx`.
Managed with `uv` (`pyproject.toml`, `uv.lock`).

Config (env):
- `INTERVIEWER_PASSWORD`: if unset, a random one is generated and logged at startup.
- `PORT` (default 8000), `HOST` (default 0.0.0.0 in the container).
- `INSECURE_COOKIES=1`: drops the `Secure` cookie flag, for plain-HTTP testing on a non-localhost address.

State (in memory):
```python
sessions: dict[token, Session]   # Session(name, role: "interviewer"|"candidate", status: "pending"|"admitted"|"denied")
```
The token is `secrets.token_urlsafe(32)`, in an `HttpOnly; SameSite=Strict; Secure; Path=/` cookie.

API:
| Method | Path | Who | Effect |
|---|---|---|---|
| POST | `api/login` `{password}` | anyone | `compare_digest` → interviewer session (admitted), sets cookie. 401 on mismatch. |
| POST | `api/join` `{name}` | anyone | candidate session (pending), sets cookie. Name: stripped, 1–40 chars. |
| GET | `api/me` | session | `{name, role, status}`, or 401 without a session. Candidate polls this (1 s) while pending. |
| GET | `api/pending` | interviewer | `[{id, name}]` of pending candidates. Interviewer polls this (1 s). |
| POST | `api/admit/{id}` `{admit: bool}` | interviewer | set admitted/denied |

`id` is a separate short random id, not the session token.
WebSocket `ws`: `on_connect` parses the cookie from `scope["headers"]` and rejects unless the session is admitted.
All connections join one fixed room; its doc is created at startup with starter templates (see Doc schema).
Static: `StaticFiles(directory=frontend/dist, html=True)` mounted last.

Polling vs push: polling at 1 s for 2 people is negligible and much simpler than a control websocket.

### Doc schema (Y.Doc, shared)

| Key | Type | Content |
|---|---|---|
| `code:cpp`, `code:python`, `code:ts` | Y.Text | per-language buffers; server seeds starter templates (avoids a double-insert race between clients) |
| `state` | Y.Map | `lang` (current language), `run` (see below) |
| `output` | Y.Text | output of the last run (capped at 64 KB, then `[output truncated]`) |

`state.run` = `{status: "running"|"done", by: name, clientId, lang, exitCode?, ms?}`.
Switching language is shared: both editors switch, and each language keeps its own code.

Awareness: `user: {name, color}` (y-monaco renders cursors/selections; CSS for name labels).
A participants list is built from awareness.

### Run flow

1. Run is clicked → disabled for everyone while `run.status == "running"`, unless the runner's
   `clientId` has disappeared from awareness (stale run → Run is enabled again).
2. The runner sets `run = running`, clears `output`, executes locally, and appends stdout/stderr to `output`
   in batches (≤ every 50 ms). stdout/stderr are interleaved as-is. Compile diagnostics go to `output` too.
3. On finish: `run = done` + `exitCode` + `ms`.
4. Timeout of 10 s (shared constant) → terminate the worker, append `[killed: timeout]`. A Stop button (runner only) does the same.

Runners (all in Web Workers, one module per language, common message protocol `{type: out|err|exit, ...}`):
- **cpp**: a long-lived compiler worker (`runClang(['clang++','-std=c++23','-O2','-Wall','main.cc','stub.cc', ...])`),
  then the binary runs in a **separate disposable worker** with the WASI shim, so a hung program doesn't cost a compiler reload.
  Download starts when C++ is selected (with a progress bar).
- **python**: a long-lived Pyodide worker. Each run uses fresh globals. Timeout → terminate, recreate lazily.
- **ts**: emit via the Monaco TS worker on the main thread, then run the JS in a disposable worker with `console.*` redirected.

No stdin (it would need SharedArrayBuffer + COOP/COEP); maybe later.

### Frontend

Vite + TypeScript, no UI framework. Deps: `monaco-editor`, `yjs`, `y-websocket`, `y-monaco`,
`@yowasp/clang`, `@bjorn3/browser_wasi_shim`, `pyodide`. Dev: `vite`, `typescript`(5.x for tsc type-check only), `puppeteer-core`.
`base: './'` for path-prefix-safe URLs; the ws URL is derived from `location`.
Dev: Vite dev server proxies `/api` and `/ws` to uvicorn.

Screens (one page, swapping sections):
1. **Landing**: "Your name" + Join (candidate) | collapsed "Interviewer login" (password).
2. **Waiting** (candidate): "Waiting for the interviewer to let you in…" Denied → message.
3. **Pad**: toolbar (language select, Run/Stop, run status "running (by X)…", participants),
   Monaco (left/top), output pane (right/bottom, monospace, exit code + duration).
   Interviewer only: a banner listing join requests with Admit/Deny.

On reload, `api/me` restores the screen from the cookie.

### Container

`Containerfile`, multi-stage: `node:24-slim` builds the frontend → `python:3.13-slim` + uv installs the backend and copies
`dist`. Runs as a non-root user. `CMD uvicorn ... --host $HOST --port $PORT`.

```sh
podman build -t interview-pad .
podman run --rm -p 127.0.0.1:8080:8000 -e INTERVIEWER_PASSWORD=secret interview-pad
# or a different internal port: -e PORT=9000 -p 127.0.0.1:8080:9000
```

Apache example (README): `ProxyPass /pad/ http://127.0.0.1:8080/ upgrade=websocket`.
Recommend `mod_deflate` for `application/wasm` (105 → 27 MB).

### Testing

- Backend: pytest + Starlette `TestClient`: login/join/admit/deny, ws rejected without an admitted session.
- E2E: `frontend/e2e/smoke.mjs` (puppeteer-core + system Chrome, `CHROME=` env): two browser contexts,
  interviewer logs in, candidate joins, interviewer admits, candidate types, the interviewer's editor sees it,
  run cpp/python/ts → both see the output. A run to verify autonomously; not CI.

## Commit plan

1. `PLAN.md` (this) + README stub
2. backend skeleton: Starlette app, sessions, login/join/me/pending/admit + tests
3. backend: ws sync via pycrdt-websocket, auth on connect, seeded doc + test
4. frontend skeleton: Vite + TS, landing/waiting/admit screens against the API
5. frontend: Monaco + y-monaco + y-websocket, language switch, cursors/awareness, participants
6. run infrastructure: shared run state, output pane, Run/Stop, timeout + TS runner
7. Python runner (Pyodide, self-hosted)
8. C++ runner (clang worker + WASI run worker + exception stub, progress bar)
9. Containerfile + podman/Apache docs in README
10. E2E smoke script

## Open questions (defaults chosen; I'll proceed with these unless told otherwise)

1. Interviewer auth = a shared password from env (auto-generated if unset). OK? (Alternative: a one-time secret URL printed at startup.)
2. Multiple candidates can be admitted (e.g. a panel). No kick feature. OK?
3. Language switch is shared (both see the same language). OK?
4. C++ standard `-std=c++23 -O2 -Wall`, exceptions stubbed (throw = abort with a message). OK?
5. Monaco (VS Code feel, TS IntelliSense) over CodeMirror 6 (lighter). OK?
6. No dark/light toggle; follow the OS theme. OK?
