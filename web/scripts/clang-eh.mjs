// The bundled clang sysroot has no exception runtime. Build the missing pieces (libunwind's wasm unwinder and
// libc++abi's throw/catch/personality) from llvm-project with -fwasm-exceptions into public/clang/libeh.a.
import { commands } from '@yowasp/clang';
import { mkdir, writeFile } from 'node:fs/promises';
import { download } from './download.mjs';

const TAG = 'llvmorg-22.1.8';
const SOURCES = [
  'libunwind/src/Unwind-wasm.c',
  'libunwind/src/config.h',
  'libunwind/include/unwind.h',
  'libunwind/include/__libunwind_config.h',
  'libunwind/include/libunwind.h',
  'libunwind/include/unwind_itanium.h',
  'libunwind/include/unwind_arm_ehabi.h',
  'libcxxabi/src/cxa_exception.cpp',
  'libcxxabi/src/cxa_exception.h',
  'libcxxabi/src/cxa_personality.cpp',
  'libcxxabi/src/cxa_handlers.h',
  'libcxxabi/src/abort_message.h',
  'libcxxabi/src/fallback_malloc.h',
  'libcxxabi/src/private_typeinfo.h',
  'libcxxabi/include/cxxabi.h',
  'libcxxabi/include/__cxxabi_config.h',
  ['libcxxabi/src/include/atomic_support.h', 'libcxx/src/include/atomic_support.h'],
];
// newer libunwind defines this tag; 22.1.8 still expects wasm-ld to, which this clang snapshot no longer does
const TAG_SOURCE = '__asm__(".globl __cpp_exception\\n.tagtype __cpp_exception i32\\n__cpp_exception:\\n");';

const dest = new URL('../public/clang/', import.meta.url);
const tree = { 'tag.c': TAG_SOURCE };
for (const entry of SOURCES) {
  const [path, from] = Array.isArray(entry) ? entry : [entry, entry];
  const text = (await download(`https://raw.githubusercontent.com/llvm/llvm-project/${TAG}/${from}`)).toString();
  const parts = path.split('/');
  let dir = tree;
  for (const p of parts.slice(0, -1)) dir = dir[p] ??= {};
  dir[parts.at(-1)] = text;
}

const EH = ['-fwasm-exceptions', '-O2', '-DNDEBUG'];
const ABI = [...EH, '-std=c++23', '-D_LIBCXXABI_BUILDING_LIBRARY', '-D_LIBCPP_BUILDING_LIBRARY',
  '-DLIBCXXABI_USE_LLVM_UNWINDER', '-D_LIBCXXABI_HAS_NO_THREADS', '-Ilibcxxabi/include', '-Ilibunwind/include'];
const UNWIND = [...EH, '-std=c23', '-D_LIBUNWIND_HIDE_SYMBOLS', '-Ilibunwind/include'];
const builds = [
  ['clang', [...EH, 'tag.c'], 'tag.o'],
  ['clang', [...UNWIND, 'libunwind/src/Unwind-wasm.c'], 'unwind.o'],
  ['clang++', [...ABI, 'libcxxabi/src/cxa_exception.cpp'], 'cxa_exception.o'],
  ['clang++', [...ABI, 'libcxxabi/src/cxa_personality.cpp'], 'cxa_personality.o'],
];
const options = { fetchProgress: () => {}, stderr: (b) => b && process.stderr.write(b) };
const objects = {};
for (const [cc, args, out] of builds) {
  objects[out] = (await commands[cc]([...args, '-c', '-o', out], tree, options))[out];
}
const { 'libeh.a': archive } = await commands.ar(['rcs', 'libeh.a', ...Object.keys(objects)], objects, options);
await mkdir(dest, { recursive: true });
await writeFile(new URL('libeh.a', dest), archive);
console.log(`clang-eh: built libeh.a (${archive.length} bytes) from ${TAG}`);
