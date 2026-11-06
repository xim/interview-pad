import type { PyodideAPI } from 'pyodide';
import type { PyCallable } from 'pyodide/ffi';

const post = (text: string) => postMessage({ type: 'out', text });

// Fresh __main__ globals per run; returns the exit code. Drops the harness frame from tracebacks.
const HARNESS = `
import os, shutil, sys, traceback

os.environ["FORCE_COLOR"] = "1"  # e.g. pytest/rich colors; the output pane renders ANSI
HOME = os.getcwd()

def run(src, argv):
    # files are fresh each run, as for C/C++ (the worker, and so its in-memory filesystem, outlives runs)
    os.chdir("/")  # the current directory can't be removed
    for d in (HOME, "/tmp"):
        shutil.rmtree(d)
        os.mkdir(d)
    os.chdir(HOME)
    # a real file: tracebacks show source lines, and tools like pytest can import it
    with open("main.py", "w") as f:
        f.write(src)
    sys.argv = ["main.py", *argv]
    sys.modules.pop("main", None)
    try:
        exec(compile(src, "main.py", "exec"), {"__name__": "__main__", "__file__": "main.py"})
    except SystemExit as e:
        if e.code is None or isinstance(e.code, int):
            return e.code or 0
        print(e.code, file=sys.stderr)
        return 1
    except BaseException as e:
        traceback.print_exception(type(e), e, e.__traceback__.tb_next, colorize=True)
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    return 0

run
`;

let ready: Promise<{ py: PyodideAPI; run: PyCallable }> | undefined;

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
  const code = 'Suspending' in WebAssembly ? await run.callPromising(data.src, data.args) : run(data.src, data.args);
  postMessage({ type: 'exit', code });
};
