# Working on interview-pad

See [README.md](README.md) for building, running and testing.

## Conventions

- **Focused commits**: one logical change per commit, with its tests. Two changes means two commits.
- **Rationale goes in the commit message**, tersely: why, what failed, how it was found. Not in code comments.
- **Comments only for what the code can't say**: non-obvious constraints, workarounds, gotchas. One line where possible.
- **KISS/YAGNI**: no speculative options, abstractions or config. Prefer, in order: not doing it, an existing helper or
  pattern, the platform/stdlib, an installed dependency, minimal new code. Don't add a dependency for a few lines;
  removing one is a win.
- **Surgical changes**: fix in place and keep the existing structure. Ask before larger refactors.
- **Fix root causes** in shared code rather than patching callers; update the callers, tests and docs a change breaks.
- **Unrelated problems you notice**: mention them, don't fix them in the same change.
- **Verify before claiming done**: `uv run pytest` in `server/`, `npm run check` and `npm run build && npm run e2e` in
  `web/`. Report failures as they are.

## Don't break

- User code runs only in Web Workers, never on the page's main thread (the API token relies on workers not seeing
  `localStorage`), and never on the server.
- URLs stay relative, so the app works under any reverse-proxy prefix.
