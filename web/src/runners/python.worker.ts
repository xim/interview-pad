import type { PyodideAPI } from 'pyodide';

const post = (text: string) => postMessage({ type: 'out', text });

// Fresh __main__ globals per run; returns the exit code. Drops the harness frame from tracebacks.
const HARNESS = `
import sys, traceback

def run(src):
    try:
        exec(compile(src, "main.py", "exec"), {"__name__": "__main__"})
    except SystemExit as e:
        if e.code is None or isinstance(e.code, int):
            return e.code or 0
        print(e.code, file=sys.stderr)
        return 1
    except BaseException as e:
        traceback.print_exception(type(e), e, e.__traceback__.tb_next)
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    return 0

run
`;

let ready: Promise<(src: string) => number> | undefined;

async function init(indexURL: string) {
  const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  const py: PyodideAPI = await loadPyodide({ indexURL });
  const decoder = new TextDecoder();
  const writer = {
    write: (buf: Uint8Array) => {
      post(decoder.decode(buf, { stream: true }));
      return buf.length;
    },
  };
  py.setStdout(writer);
  py.setStderr(writer);
  py.setStdin({ error: true });
  return py.runPython(HARNESS);
}

onmessage = async ({ data }) => {
  if (data.init) {
    ready = init(data.init);
    return;
  }
  postMessage({ type: 'status', text: 'Loading Python' });
  let run;
  try {
    run = await ready!;
  } catch (e) {
    post(`Failed to load Python: ${e}\n`);
    return postMessage({ type: 'exit', code: 1 });
  }
  postMessage({ type: 'start' });
  postMessage({ type: 'exit', code: run(data) });
};
