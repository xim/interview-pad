// Two-browser smoke test: node e2e/smoke.mjs [url]
// Without a url, starts a fresh server from ../server (serving ./dist, so build first).
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const password = process.env.PASSWORD ?? 'pw';
let server;
let url = process.argv[2];
if (!url) {
  const port = 20000 + Math.floor(Math.random() * 10000);
  url = `http://localhost:${port}/`;
  server = spawn('uv', ['run', 'uvicorn', 'app:create_app', '--factory', '--port', String(port)], {
    cwd: new URL('../../server', import.meta.url),
    env: { ...process.env, INTERVIEWER_PASSWORD: password },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stderr.on('data', (d) => d.includes('Application startup complete') && resolve());
    server.on('exit', reject);
  });
}
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
  await iv.type('#login-form input', password);
  await iv.click('#login-form button');
  await iv.waitForSelector('#pad:not([hidden])');
  step('interviewer logged in');

  const cand = await open('candidate');
  await cand.type('#join-form input', 'Ada');
  await cand.click('#join-form button');
  await cand.waitForSelector('#waiting:not([hidden])');
  step('candidate waiting');

  await iv.waitForSelector('.request button');
  await iv.click('.request button');
  await cand.waitForSelector('#pad:not([hidden])');
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

  await iv.click('#vim');
  await iv.click('.view-lines');
  await iv.keyboard.press('Escape');
  await iv.keyboard.type('ggOvim_ok');
  await iv.keyboard.press('Escape');
  await cand.waitForFunction(() => editorText().startsWith('vim_ok'));
  await iv.click('#vim');
  step('vim mode edit synced');
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
  await runCase(cand, iv, 'python', 'x = 1 / 0', 'ZeroDivisionError: division by zero');
  await runCase(cand, iv, 'python', 'while True: pass', '[killed: timeout after 10 s]');
  await runCase(cand, iv, 'python', 'print("recovered")', 'recovered');

  await runCase(iv, cand, 'cpp', null, 'Hello from C++: [3, 1, 2]', 120000);
  await runCase(iv, cand, 'cpp', 'int main() { return x; }', '[compilation failed]');
  await runCase(cand, iv, 'cpp', '#include <vector>\nint main() { std::vector<int> v; return v.at(1); }', 'uncaught exception of type std::out_of_range');
  await runCase(cand, iv, 'cpp', '#include <cstdio>\nint main() { std::puts("bye"); return 7; }', 'bye');
  await iv.waitForFunction(() => document.querySelector('#run-status').textContent.startsWith('Exit 7'));
  step('cpp exit code shared');

  await cand.click('#flags', { count: 3 });
  await cand.keyboard.type('-std=c++26 -Wall -Werror');
  await cand.keyboard.press('Enter');
  await iv.waitForFunction(() => document.querySelector('#flags').value.includes('-Werror'));
  step('flags synced');
  await runCase(iv, cand, 'cpp', 'int main() { int unused; }', '$ clang++ -std=c++26 -Wall -Werror main.cpp');
  await iv.waitForFunction(() => document.querySelector('#output').textContent.includes('[compilation failed]'));
  step('flags applied');
  await runCase(cand, iv, 'c', null, 'Hello from C\n');
  await runCase(cand, iv, 'c', '#include <stdlib.h>\nint main(void) { abort(); }', '[RuntimeError: unreachable]');

  if (process.env.SCREENSHOT) await iv.screenshot({ path: process.env.SCREENSHOT });
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
