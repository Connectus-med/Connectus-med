#!/usr/bin/env node
/*
 * Connectus - whole-app smoke test.
 *   CHROME=/usr/local/bin/chromium-headless-shell node tests/smoke.js <app.html>
 * Boots the app against the fixture, walks every main screen and the key flows,
 * and checks the app never stops responding and never throws. Run before every delivery.
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const appPath = process.argv[2];
if (!appPath) { console.error('usage: node tests/smoke.js <app.html>'); process.exit(2); }
const CHROME = process.env.CHROME || '/usr/local/bin/chromium';
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
const html = fs.readFileSync(appPath, 'utf8');
const w = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const out = [];
const ck = (n, ok, d) => { out.push({ n, ok: !!ok, d: d == null ? '' : String(d) }); ok ? pass++ : fail++; };

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message)));
  page.on('dialog', async d => { await d.accept(); });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'content-type': 'application/json' };
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (!u.includes('supabase.co')) return req.continue();
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors, body: '' });
    let body = '[]';
    if (u.includes('/rest/v1/decks')) body = JSON.stringify(fx.decks);
    else if (u.includes('/rest/v1/deck_state')) body = JSON.stringify(fx.states || []);
    else if (u.includes('/rest/v1/subjects')) body = JSON.stringify(fx.subjects);
    else if (u.includes('/rest/v1/settings')) body = JSON.stringify(fx.settings);
    else if (u.includes('/auth/v1/')) body = JSON.stringify({ access_token: 'x', refresh_token: 'x', expires_in: 999999, user: { id: fx.uid } });
    else if (u.includes('/functions/')) body = JSON.stringify({});
    return req.respond({ status: 200, headers: cors, body });
  });
  await page.evaluateOnNewDocument((uid) => { try {
    localStorage.setItem('fd:auth', JSON.stringify({ access_token: 'x', refresh_token: 'x', expires_at: 9999999999, user: { id: uid } }));
    localStorage.removeItem('fd:testrun'); localStorage.removeItem('fd:testseen'); localStorage.removeItem('fd:errors');
    localStorage.removeItem('fd:errnotes'); localStorage.removeItem('fd:qstats');
  } catch (e) {} }, fx.uid);
  await page.goto('file://' + path.resolve(appPath), { waitUntil: 'domcontentloaded' });
  await w(3200);

  const alive = async (label) => {
    const t0 = Date.now();
    const txt = await page.evaluate(() => (document.getElementById('content') || {}).innerText || '');
    const ms = Date.now() - t0;
    ck('responsive: ' + label, ms < 400 && txt.trim().length > 0, ms + 'ms · ' + txt.slice(0, 24).replace(/\n/g, ' '));
  };
  const tab = async (n) => { const ok = await page.evaluate(x => { const b = document.querySelector('#tabbar .tab[data-tab="' + x + '"]'); if (b) { b.click(); return true; } return false; }, n); await w(800); return ok; };
  const clickTxt = async (re) => { const ok = await page.evaluate(r => { const b = [...document.querySelectorAll('button')].find(x => new RegExp(r).test(x.textContent)); if (b) { b.click(); return true; } return false; }, re); await w(700); return ok; };

  for (const t of ['home', 'learn', 'revise', 'test']) { ck('reached tab: ' + t, await tab(t), ''); await alive(t); }

  await tab('test');
  for (const seg of ['Paper', 'Qbank', 'PYQ', 'Strategy', 'History']) { ck('segment: ' + seg, await clickTxt('^' + seg + '$'), ''); await alive('Test › ' + seg); }
  await clickTxt('^Paper$');

  ck('mode: Question of the day', await clickTxt('Question of the day'), '');
  await alive('QOTD');
  const answered = await page.evaluate(() => { const o = document.querySelector('.qotd-opt'); if (o) { o.click(); return true; } return false; });
  await w(500);
  ck('QOTD: option taps and reveals', answered && await page.evaluate(() => !!document.querySelector('.qotd-exp') || !!document.querySelector('.qotd-opt.right')), '');
  ck('QOTD: next', await clickTxt('Next question'), '');

  await tab('home');
  await page.evaluate(() => { const b = document.getElementById('profileBtn'); if (b) b.click(); });
  await w(500);
  ck('Settings opens', await clickTxt('Settings'), ''); await alive('Settings');
  ck('Owner opens', await clickTxt('Owner'), ''); await alive('Owner');
  await tab('home'); await alive('back home');

  // a question must always carry its source line
  await tab('test');
  await clickTxt('Start a test'); await w(700);
  await page.evaluate(() => { const b = [...document.querySelectorAll('.tstart')].find(x => /Start/.test(x.textContent)); if (b) b.click(); });
  await w(1800);
  const srcOk = await page.evaluate(() => { const e = document.querySelector('.qsrc'); return !!e && /^Source: /.test(e.textContent); });
  ck('test run shows the source line', srcOk, '');
  await tab('home');

  ck('no page errors across the whole sweep', errs.length === 0, errs.slice(0, 3).join(' | '));

  await browser.close();
  console.log('');
  for (const r of out) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? '   (' + r.d + ')' : ''}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASHED:', e && e.message); process.exit(2); });
