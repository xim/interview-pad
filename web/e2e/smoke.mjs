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
  await page.goto(url);
  return page;
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
} finally {
  await browser.close();
}
