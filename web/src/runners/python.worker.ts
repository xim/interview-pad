import type { PyodideAPI } from 'pyodide';

const post = (text: string) => postMessage({ type: 'out', text });

// Fresh __main__ globals per run; returns the exit code. Drops the harness frame from tracebacks.
const HARNESS = `
import sys, traceback

def run(src, argv):
    sys.argv = ["main.py", *argv]
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

let ready: Promise<{ py: PyodideAPI; run: (src: string, args: string[]) => number }> | undefined;

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
  return { py, run: py.runPython(HARNESS) };
}

onmessage = async ({ data }) => {
  if (data.init) {
    ready = init(data.init);
    return;
  }
  postMessage({ type: 'status', text: 'Loading Python' });
  let py, run;
  try {
    ({ py, run } = await ready!);
  } catch (e) {
    post(`Failed to load Python: ${e}\n`);
    return postMessage({ type: 'exit', code: 1 });
  }
  // fetches only the bundled packages (see scripts/pyodide.mjs) that the code imports
  await py.loadPackagesFromImports(data.src, {
    messageCallback: () => postMessage({ type: 'status', text: 'Loading packages' }),
    errorCallback: post,
  });
  let stdin: string | undefined = data.stdin;
  py.setStdin({
    stdin: () => {
      const s = stdin;
      stdin = undefined;
      return s;
    },
  });
  postMessage({ type: 'start' });
  postMessage({ type: 'exit', code: run(data.src, data.args) });
};
