import { commands, Exit } from '@yowasp/clang';

// The bundled sysroot has no libunwind, so real exceptions can't link: make `throw` report and abort instead.
const STUB = `
#include <cstdio>
#include <cstdlib>
#include <typeinfo>

extern "C" char* __cxa_demangle(const char*, char*, std::size_t*, int*);

extern "C" void* __cxa_allocate_exception(std::size_t size) noexcept { return std::malloc(size); }

extern "C" [[noreturn]] void __cxa_throw(void*, std::type_info* type, void (*)(void*)) {
    int status;
    char* name = __cxa_demangle(type->name(), nullptr, nullptr, &status);
    std::fflush(stdout);
    std::fprintf(stderr, "terminate: uncaught exception of type %s (exceptions are not supported here)\\n", name ? name : type->name());
    std::abort();
}
`;

const clang = commands['clang++'];
const ARGS = ['-std=c++26', '-O2', '-Wall', '-Wextra', 'main.cpp', 'stub.cpp', '-o', 'main.wasm'];

const post = (text: string) => postMessage({ type: 'out', text });
const decoder = new TextDecoder();
const write = (bytes: Uint8Array | null) => bytes && post(decoder.decode(bytes, { stream: true }));

let lastPct = -1;
const fetchProgress = ({ doneLength, totalLength }: { doneLength: number; totalLength: number }) => {
  const pct = Math.floor((doneLength / totalLength) * 20) * 5;
  if (pct === lastPct) return;
  lastPct = pct;
  postMessage({ type: 'status', text: pct < 100 ? `Downloading compiler ${pct}%` : 'Compiling' });
};

onmessage = async ({ data }) => {
  if (data.preload) {
    try {
      await clang(['--version'], {}, { stdout: null, fetchProgress });
    } catch {}
    return;
  }
  postMessage({ type: 'status', text: 'Compiling' });
  try {
    const out = await clang(ARGS, { 'main.cpp': data, 'stub.cpp': STUB }, { stdout: write, stderr: write, fetchProgress });
    const wasm = out!['main.wasm'] as Uint8Array;
    postMessage({ type: 'exit', code: 0, wasm });
  } catch (e) {
    if (!(e instanceof Exit)) post(`${e}\n`);
    postMessage({ type: 'exit', code: e instanceof Exit ? e.code : 1 });
  }
};
