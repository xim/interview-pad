// Two-browser smoke test against a running server: node e2e/smoke.mjs [url]
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:8765/';
const password = process.env.PASSWORD ?? 'pw';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: !process.env.HEADFUL,
});

async function open(label) {
  const page = await (await browser.createBrowserContext()).newPage();
  page.on('pageerror', (e) => console.log(`[${label}] pageerror:`, e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('401') && console.log(`[${label}] console:`, m.text()));
  await page.evaluateOnNewDocument(() => {
    window.editorText = () => document.querySelector('.view-lines')?.textContent.replace(/\u00a0/g, ' ') ?? '';
  });
  await page.goto(url);
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

  if (process.env.SCREENSHOT) await iv.screenshot({ path: process.env.SCREENSHOT });
} finally {
  await browser.close();
}
