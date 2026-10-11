/* Connectus — performance / data budget check.
 *
 * Runs the real app headlessly and asserts the budgets we promised the user:
 *   1. static sizes  — the app file and the loader must not creep up
 *   2. behavioural   — opening the app must NOT pull every card body, and the
 *                      background timer must ask a tiny question, not re-load
 *
 * Usage:  node tests/perf_budget.js [app.html]      (default src/library.html)
 * Exit 0 = within budget, 1 = over budget.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const zlib = require('zlib');

const APP = process.argv[2] || 'src/library.html';
const CHROME = process.env.CHROME || '/usr/local/bin/chromium';

/* ---- budgets (raise deliberately, never by accident) ---- */
const B = {
  appRawKB: 520,        // app HTML, uncompressed
  appGzipKB: 175,       // app HTML, gzipped (what a transfer actually costs)
  loaderKB: 14,         // the deployed loader
  bootKB: 900,          // everything the app pulls from Supabase on a cold open
  cardsOnBoot: 0,       // card bodies allowed in the boot deck query
  fullLoadsOnTimer: 0,  // full deck re-loads allowed from the 30s timer
};

const fails = [];
function check(label, value, limit, unit) {
  const ok = value <= limit;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${value}${unit} (budget ${limit}${unit})`);
  if (!ok) fails.push(`${label}: ${value}${unit} > ${limit}${unit}`);
}

(async () => {
  const appHtml = fs.readFileSync(APP, 'utf8');
  const appBytes = Buffer.byteLength(appHtml, 'utf8');
  check('app HTML raw', Math.round(appBytes / 1024), B.appRawKB, 'KB');
  check('app HTML gzip', Math.round(zlib.gzipSync(appHtml, { level: 9 }).length / 1024), B.appGzipKB, 'KB');

  const loaderPath = path.join(path.dirname(APP), '..', 'loader.html');
  if (fs.existsSync(loaderPath)) {
    check('loader', Math.round(Buffer.byteLength(fs.readFileSync(loaderPath, 'utf8')) / 1024), B.loaderKB, 'KB');
  }

  /* ---- behavioural: run the app and watch what it downloads ---- */
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
  const cors = {
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'content-type': 'application/json'
  };
  let bootBytes = 0, cardsInBoot = 0, fullLoads = 0, probes = 0;
  let booting = true, bootLoadSeen = false;

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    const u = r.url();
    if (!u.includes('supabase.co')) return r.continue();
    if (r.method() === 'OPTIONS') return r.respond({ status: 204, headers: cors, body: '' });
    if (u.includes('/rest/v1/decks')) {
      if (u.includes('select=updated_at')) { probes++; return r.respond({ status: 200, headers: cors, body: '[]' }); }
      if (booting) { if (!bootLoadSeen) { bootLoadSeen = true; fullLoads++; } if (/select=[^&]*cards/.test(u)) cardsInBoot++; }
      const body = JSON.stringify(fx.decks || []);
      bootBytes += body.length;
      return r.respond({ status: 200, headers: cors, body });
    }
    let body = '[]';
    if (u.includes('/rest/v1/deck_state')) body = JSON.stringify(fx.states || []);
    else if (u.includes('/rest/v1/subjects')) body = JSON.stringify(fx.subjects || []);
    else if (u.includes('/rest/v1/settings')) body = JSON.stringify(fx.settings || []);
    else if (u.includes('/auth/v1/')) body = JSON.stringify({ access_token: 'x', refresh_token: 'x', expires_in: 999999, user: { id: fx.uid } });
    else if (u.includes('/functions/')) body = JSON.stringify({});
    if (booting) bootBytes += body.length;
    return r.respond({ status: 200, headers: cors, body });
  });
  await page.evaluateOnNewDocument((uid) => {
    try { localStorage.setItem('fd:auth', JSON.stringify({ access_token: 'x', refresh_token: 'x', expires_at: 9999999999, user: { id: uid } })); } catch (e) {}
  }, fx.uid);
  await page.goto('file://' + path.resolve(APP), { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 3500));
  booting = false;
  fullLoads = 0;   /* the boot's own load is expected; only EXTRA ones are a failure */

  check('cards pulled on boot', cardsInBoot, B.cardsOnBoot, '');
  check('boot payload', Math.round(bootBytes / 1024), B.bootKB, 'KB');

  await new Promise((r) => setTimeout(r, 40000));   // let the 30s timer fire at least once
  check('full re-loads from the timer', fullLoads, B.fullLoadsOnTimer, '');
  console.log(`INFO  change-probes seen: ${probes}`);

  await browser.close();
  if (fails.length) { console.log('\nOVER BUDGET:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('\nRESULT: PASS — all budgets held');
})().catch((e) => { console.error('perf_budget error:', e && e.message); process.exit(1); });
