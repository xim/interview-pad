// Two-browser smoke test: node e2e/smoke.mjs [url]
// Without a url, starts a fresh server from ../server (serving ./dist, so build first).
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const password = process.env.PASSWORD ?? 'pw';
const port = 20000 + Math.floor(Math.random() * 10000);
let server;

async function startServer() {
  server = spawn('uv', ['run', 'uvicorn', 'app:create_app', '--factory', '--port', String(port)], {
    cwd: new URL('../../server', import.meta.url),
    env: { ...process.env, INTERVIEWER_PASSWORD: password },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => /Traceback|ERROR/.test(d) && process.stderr.write(`[server] ${d}`));
  await new Promise((resolve, reject) => {
    server.stderr.on('data', (d) => d.includes('Application startup complete') && resolve());
    server.on('exit', reject);
  });
}

const url = process.argv[2] ?? `http://localhost:${port}/`;
if (!process.argv[2]) await startServer();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: !process.env.HEADFUL,
  defaultViewport: { width: 1280, height: 720 },
});

async function open(label) {
  const page = await (await browser.createBrowserContext()).newPage();
  page.on('pageerror', (e) => console.log(`[${label}] pageerror:`, e.message));
  page.on('console', (m) => !m.text().includes('401') && !m.text().includes('[vite]') && console.log(`[${label}] console.${m.type()}:`, m.text()));
  await page.evaluateOnNewDocument(() => {
    window.editorText = () => document.querySelector('.view-lines')?.textContent.replace(/\u00a0/g, ' ') ?? '';
  });
  await page.goto(url);
  pages.push([label, page]);
  return page;
}

async function setCode(page, code) {
  await page.click('.view-lines');
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.sendCharacter(code);
}

// Runs `code` in `lang` from `runner`, expects `expected` in both pages' output.
async function runCase(runner, other, lang, code, expected, timeout = 30000) {
  await runner.select('#lang', lang);
  await other.waitForFunction((l) => document.querySelector('#lang').value === l, {}, lang);
  if (code) await setCode(runner, code);
  await runner.waitForSelector('#run:not([disabled])');
  await runner.click('#run');
  for (const page of [runner, other]) {
    await page.waitForFunction(
      (e) => document.querySelector('#output').textContent.includes(e) && !document.querySelector('#run').disabled,
      { timeout },
      expected,
    );
  }
  step(`${lang} run: ${JSON.stringify(expected)}`);
}

function step(name) {
  console.log('✓', name);
}

const pages = [];
try {
  const iv = await open('interviewer');
  await iv.click('summary');
  await iv.type('#login-form input[name=name]', 'Grace');
  await iv.type('#login-form input[name=password]', password);
  await iv.click('#login-form button');
  await iv.waitForSelector('#pad:not([hidden])');
  step('interviewer logged in');

  const cand = await open('candidate');
  await cand.type('#join-form input', 'Ada');
  await cand.click('#join-form button');
  await cand.waitForSelector('#waiting:not([hidden])');
  step('candidate waiting');

  await iv.waitForSelector('#requests-dialog[open] .request button');
  if (process.env.SCREENSHOT) await iv.screenshot({ path: process.env.SCREENSHOT.replace('.png', '-admit.png') });
  await iv.click('.request button');
  await cand.waitForSelector('#pad:not([hidden])');
  await iv.waitForSelector('#requests-dialog:not([open])');
  step('candidate admitted');

  await iv.waitForFunction(() => document.querySelectorAll('.participant').length === 2);
  step('participants: 2');

  await cand.select('#lang', 'python');
  await iv.waitForFunction(() => document.querySelector('#lang').value === 'python');
  await iv.waitForFunction(() => editorText().includes('Hello from'));
  step('language switch synced');

  const marker = `marker_${Date.now()}`;
  await cand.click('.view-lines');
  await cand.keyboard.press('End');
  await cand.keyboard.type(` # ${marker}`);
  await iv.waitForFunction((m) => editorText().includes(m), {}, marker);
  step('edit synced');

  const toggleSetting = async (page, id) => {
    await page.click('#settings');
    await page.click(`#${id}`);
    await page.click('#settings-dialog button');
  };
  await toggleSetting(iv, 'vim');
  await iv.click('.view-lines');
  await iv.keyboard.press('Escape');
  await iv.keyboard.type('ggOvim_ok');
  await iv.keyboard.press('Escape');
  await cand.waitForFunction(() => editorText().startsWith('vim_ok'));
  await toggleSetting(iv, 'vim');
  step('vim mode edit synced');
  await iv.click('#settings');
  await iv.select('#theme', 'vs');
  await iv.click('#settings-dialog button');
  await iv.waitForSelector('.monaco-editor.vs');
  if (process.env.SCREENSHOT) await iv.screenshot({ path: process.env.SCREENSHOT.replace('.png', '-light.png') });
  await iv.click('#settings');
  await iv.select('#theme', 'vs-dark');
  await iv.click('#settings-dialog button');
  step('theme setting');
  await runCase(cand, iv, 'ts', 'console.log([1, 2, 3].map((x: number) => x * 2), new Map([[1, "a"]]))', '[2,4,6] Map([[1,"a"]])');
  await runCase(iv, cand, 'ts', 'throw new Error("boom")', 'Uncaught Error: boom');

  await setCode(cand, 'while (true) {}');
  await cand.click('#run');
  await cand.waitForSelector('#stop:not([hidden])');
  await iv.waitForSelector('#run[disabled]');
  await cand.click('#stop');
  await iv.waitForFunction(() => document.querySelector('#output').textContent.includes('[killed: stopped]'));
  step('stop kills a hung run');

  await runCase(iv, cand, 'python', 'import sys; print("py", sum(range(10)), __name__); print("err", file=sys.stderr); sys.exit(3)', 'py 45 __main__\nerr\n');
  await iv.waitForFunction(() => document.querySelector('#run-status').textContent.startsWith('Exit 3'));
  step('python exit code shared');
  await runCase(cand, iv, 'python', 'x = 1 / 0', 'File "main.py", line 1, in <module>\n    x = 1 / 0\n');
  await runCase(cand, iv, 'python', 'import numpy as np, yaml, tomllib; print(np.arange(4).sum(), yaml.safe_load("a: 1"), tomllib.loads("b = 2"))', "6 {'a': 1} {'b': 2}");
  await runCase(cand, iv, 'python', 'import scipy', "ModuleNotFoundError: No module named 'scipy'");
  await runCase(cand, iv, 'python', 'import pandas as pd; print(pd.DataFrame({"a": [1, 2]}).a.sum())', '3');
  await runCase(cand, iv, 'python', 'import pytest\ndef test_x(): assert 1 + 1 == 3\nif __name__ == "__main__": pytest.main(["-q", "main.py"])', '1 failed');
  await runCase(cand, iv, 'python', 'while True: pass', '[killed: timeout after 10 s]');
  await runCase(cand, iv, 'python', 'print("recovered")', 'recovered');
  await setCode(cand, 'import collections\ncollections.Coun');
  await cand.keyboard.down('Control');
  await cand.keyboard.press('Space');
  await cand.keyboard.up('Control');
  await cand.waitForFunction(
    () => [...document.querySelectorAll('.suggest-widget .monaco-list-row')].some((r) => r.textContent.includes('Counter')),
    { timeout: 60000 },
  );
  await cand.keyboard.press('Escape');
  step('python completion (jedi)');
  await toggleSetting(cand, 'completion');
  await cand.click('.view-lines');
  await cand.keyboard.press('End');
  await cand.keyboard.down('Control');
  await cand.keyboard.press('Space');
  await cand.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 2000));
  if (await cand.$('.suggest-widget.visible .monaco-list-row')) throw new Error('suggestions shown with completion off');
  await toggleSetting(cand, 'completion');
  step('completion can be turned off');

  await runCase(iv, cand, 'cpp', null, 'Hello from C++: [3, 1, 2]', 120000);
  await runCase(iv, cand, 'cpp', 'int main() { return x; }', '[compilation failed]');
  await runCase(cand, iv, 'cpp', '#include <vector>\nint main() { std::vector<int> v; return v.at(1); }', "terminate called after throwing an instance of 'std::out_of_range'\n  what():  vector\n");
  await runCase(cand, iv, 'cpp', '#include <cstdio>\n#include <stdexcept>\nint main() { try { throw std::runtime_error("boom"); } catch (const std::exception& e) { std::puts(e.what()); } }', 'boom');
  await runCase(cand, iv, 'cpp', '#include <cstdio>\nint main() { std::printf("buffered "); throw 42; }', "buffered terminate called after throwing an instance of 'int'");
  await runCase(cand, iv, 'cpp', '#include <cstdio>\nint main() { std::puts("bye"); return 7; }', 'bye');
  await iv.waitForFunction(() => document.querySelector('#run-status').textContent.startsWith('Exit 7'));
  step('cpp exit code shared');

  if ((await fetch(new URL('clangd/clangd.wasm', url), { method: 'HEAD' })).ok) {
    await setCode(cand, '#include <limits>\nint main() { std::numeric_li');
    await cand.waitForFunction(() => !document.querySelector('#lsp-status').textContent, { timeout: 120000 });
    await cand.keyboard.down('Control');
    await cand.keyboard.press('Space');
    await cand.keyboard.up('Control');
    await cand.waitForFunction(
      () => [...document.querySelectorAll('.suggest-widget .monaco-list-row')].some((r) => r.textContent.includes('numeric_limits')),
      { timeout: 60000 },
    );
    await cand.keyboard.press('Escape');
    step('cpp completion (clangd)');
    await setCode(cand, 'int main() { undeclared_fn(); }');
    await cand.waitForSelector('.squiggly-error', { timeout: 30000 });
    step('cpp diagnostics (clangd)');
    await setCode(cand, 'int main() { fpri');
    await cand.keyboard.down('Control');
    await cand.keyboard.press('Space');
    await cand.keyboard.up('Control');
    await cand.waitForFunction(
      () => document.querySelector('.suggest-widget .monaco-list-row.focused')?.textContent.includes('fprintf'),
      { timeout: 30000 },
    );
    await cand.keyboard.press('Enter');
    await iv.waitForFunction(() => editorText().includes('#include <cstdio>') || editorText().includes('#include <stdio.h>'));
    step('cpp header insertion (clangd)');
  } else {
    console.log('- clangd not built, skipping its checks');
  }
  await runCase(cand, iv, 'cpp', '#include <vector>\nint main() { std::vector<int> v(3); return v[1000]; }', 'vector[] index out of bounds');

  await cand.click('#flags', { count: 3 });
  await cand.keyboard.type('-std=c++26 -Wall -Werror');
  await cand.keyboard.press('Enter');
  await iv.waitForFunction(() => document.querySelector('#flags').value.includes('-Werror'));
  step('flags synced');
  await runCase(iv, cand, 'cpp', 'int main() { int unused; }', '> clang++ -std=c++26 -Wall -Werror main.cpp');
  await iv.waitForFunction(() => document.querySelector('#output').textContent.includes('[compilation failed]'));
  step('flags applied');
  await runCase(cand, iv, 'c', null, 'Hello from C\n');
  await runCase(cand, iv, 'c', '#include <stdlib.h>\n__attribute__((noinline)) void f(void) { abort(); }\nint main(void) { f(); }', '[Aborted]\n    at f\n    at main\n');
  await runCase(cand, iv, 'c', '#include <stdio.h>\nint main(int argc, char** argv) { int* p = argc > 5 ? &argc : 0; printf("%d", *p); }', 'main.c:2:79: runtime error: load of null pointer of type \'int\'');
  await runCase(cand, iv, 'c', 'int f(int n) { return f(n + 1) + 1; }\nint main(void) { return f(0); }', '[Crashed: Maximum call stack size exceeded]');

  await cand.click('.tab[data-tab=input]');
  await cand.type('#args', 'a "b c"');
  await cand.type('#stdin', '3\n4\n');
  await iv.waitForFunction(() => document.querySelector('.tab[data-tab=input]').textContent === 'Input •');
  step('input synced');
  await iv.waitForFunction(() => document.querySelector('#input').offsetParent === null);
  const box = await (await iv.$('#splitter')).boundingBox();
  await iv.mouse.move(box.x + 2, box.y + box.height / 2);
  await iv.mouse.down();
  await iv.mouse.move(400, box.y + box.height / 2, { steps: 5 });
  await iv.mouse.up();
  await iv.waitForFunction(() => Math.abs(document.querySelector('#left').getBoundingClientRect().width - 400) < 10);
  step('splitter resizes panes');
  await runCase(iv, cand, 'python', 'import sys; print(sys.argv[1:], sum(int(l) for l in sys.stdin))', "['a', 'b c'] 7");
  await runCase(iv, cand, 'cpp', '#include <iostream>\nint main(int argc, char** argv) { int a, b; std::cin >> a >> b; std::cout << argc << argv[2] << a + b << "\\n"; }', '3b c7');
  await runCase(iv, cand, 'ts', 'console.log(process.argv.slice(2), Number(prompt()) + Number(prompt()), prompt())', '["a","b c"] 7 null');

  if (process.env.SCREENSHOT) await iv.screenshot({ path: process.env.SCREENSHOT });

  iv.once('dialog', (d) => d.accept());
  await iv.click('#end');
  await cand.waitForFunction(() => document.querySelector('#waiting-text').textContent === 'The interview has ended.');
  await iv.waitForFunction(() => document.querySelectorAll('.participant').length === 1);
  step('end interview kicks the candidate');

  if (server) {
    const stopped = new Promise((resolve) => server.once('exit', resolve));
    server.kill();
    await stopped;
    await iv.waitForSelector('#offline:not([hidden])');
    step('disconnect banner shown');
    await startServer();
    await iv.waitForFunction(() => document.querySelector('#landing-error').textContent.includes('session ended'), { timeout: 15000 });
    step('lost session after server restart sends back to login');
  }
} catch (e) {
  for (const [label, page] of pages) {
    const dump = await page.evaluate(() => [document.querySelector('#run-status')?.textContent, document.querySelector('#output')?.textContent]);
    console.log(`[${label}] status: ${dump[0]}\n[${label}] output: ${dump[1]}`);
  }
  throw e;
} finally {
  await browser.close();
  server?.kill();
}
