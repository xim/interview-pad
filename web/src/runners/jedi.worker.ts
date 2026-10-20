import type { PyodideAPI } from 'pyodide';

// Editor intelligence for Python via Jedi, in its own Pyodide so it never waits on (or for) a running program.
const HELPERS = `
import jedi, json

_env = jedi.InterpreterEnvironment()  # the default would spawn a subprocess

def _script(src):
    return jedi.Script(src, path="main.py", environment=_env)

def complete(src, line, col):
    return json.dumps([[c.name, c.type] for c in _script(src).complete(line, col)[:200]])

def signatures(src, line, col):
    return json.dumps([[s.to_string(), s.index, [p.to_string() for p in s.params], s.docstring(raw=True)]
                       for s in _script(src).get_signatures(line, col)])

def hover(src, line, col):
    return json.dumps([d.docstring() for d in _script(src).help(line, col) if d.docstring()])
`;

let ready: Promise<PyodideAPI> | undefined;

async function init(indexURL: string) {
  const { loadPyodide } = await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`);
  const py: PyodideAPI = await loadPyodide({ indexURL });
  await py.loadPackage('jedi', { messageCallback: () => {} });
  py.runPython(HELPERS);
  return py;
}

onmessage = async ({ data }) => {
  if (data.init) {
    ready = init(data.init);
    return;
  }
  const { id, kind, src, line, col } = data;
  let result = [];
  try {
    const py = await ready!;
    // so e.g. numpy members complete once imported
    await py.loadPackagesFromImports(src, { messageCallback: () => {}, errorCallback: () => {} });
    result = JSON.parse(py.globals.get(kind)(src, line, col));
  } catch {}
  postMessage({ id, result });
};
