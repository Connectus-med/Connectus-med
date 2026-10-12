#!/usr/bin/env node
/*
 * Connectus — regression suite for the library app (index.html / library_html).
 *
 *   node tests/regression.js <path-to-app.html> [--fixture tests/fixtures.json]
 *
 * Boots the app headlessly against a synthetic fixture, then checks the things
 * that have actually broken before: JS syntax, clean boot, the three exam
 * papers, exam-aware marking, the seed rebuild, the no-repeat window, the mix
 * targets, and the review/error-log palettes. Prints one line per check and
 * exits non-zero if any FAIL. No network, no real data.
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const appPath = args[0];
if (!appPath) { console.error('usage: node tests/regression.js <app.html> [--fixture <json>]'); process.exit(2); }
const fi = args.indexOf('--fixture');
const fixturePath = fi >= 0 ? args[fi + 1] : path.join(__dirname, 'fixtures.json');
const CHROME = process.env.CHROME || '/usr/local/bin/chromium';

const fx = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const html = fs.readFileSync(appPath, 'utf8');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  if (ok) pass++; else fail++;
}
const near = (got, want, tol) => Math.abs(got - want) <= tol;

(async () => {
  // ---- 1. the embedded script must be syntactically valid ----
  const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(b => b.trim());
  let syntaxOk = blocks.length > 0;
  for (const b of blocks) {
    try { new vm.Script(b); } catch (e) { syntaxOk = false; }
  }
  check('script syntax', syntaxOk, blocks.length + ' script block(s)');

  // ---- 2. boot with the fixture, zero page errors ----
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 900, isMobile: true });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message)));
  page.on('dialog', async d => { await d.accept(); });

  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
                 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', 'content-type': 'application/json' };
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
  await page.evaluateOnNewDocument((uid) => {
    try {
      localStorage.setItem('fd:auth', JSON.stringify({ access_token: 'x', refresh_token: 'x', expires_at: 9999999999, user: { id: uid } }));
      localStorage.removeItem('fd:testrun'); localStorage.removeItem('fd:testseen'); localStorage.removeItem('fd:errors');
      localStorage.removeItem('fd:errnotes'); localStorage.removeItem('fd:qstats');
    } catch (e) {}
  }, fx.uid);
  await page.goto('file://' + path.resolve(appPath), { waitUntil: 'domcontentloaded' });
  const w = ms => new Promise(r => setTimeout(r, ms));
  await w(3200);
  check('boots with no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  const clickTxt = re => page.evaluate(r => {
    const b = [...document.querySelectorAll('button')].find(x => new RegExp(r).test(x.textContent));
    if (b) b.click();
    return !!b;
  }, re);
  const waitSel = async (sel, ms) => {
    const t = Date.now();
    while (Date.now() - t < (ms || 15000)) {
      if (await page.evaluate(s => document.querySelectorAll(s).length, sel)) return true;
      await w(200);
    }
    return false;
  };
  const runState = () => page.evaluate(() => {
    const t = JSON.parse(localStorage.getItem('fd:testrun') || '{}');
    if (!t || !t.qs) return { n: 0, exam: null, secOn: false, secN: 0, secQ: 0, secMins: 0, seed: null,
                              byTag: {}, bySub: {}, img: 0, ids: [], decks: 0, empty: true };
    const byTag = {}, bySub = {}, byDeck = {}, ids = [];
    let img = 0;
    (t.qs || []).forEach(q => {
      byTag[q.tag || 'none'] = (byTag[q.tag || 'none'] || 0) + 1;
      bySub[q.s] = (bySub[q.s] || 0) + 1;
      byDeck[q.k] = (byDeck[q.k] || 0) + 1;
      if (q.img) img++;
      ids.push(q.k + '|' + q.id);
    });
    return { n: t.n, exam: t.exam, secOn: t.secOn, secN: t.secN, secQ: t.secQ, secMins: t.secMins,
             seed: t.seed, byTag, bySub, img, ids, subjects: Object.keys(bySub).length,
             decks: Object.keys(byDeck).length };
  });
  const submit = async () => {
    await page.evaluate(() => { const b = [...document.querySelectorAll('.tend')].find(x => x.textContent === 'Submit'); if (b) b.click(); });
    await w(900);
  };
  // the result screen now has two sub-sections; the review work needs the Review tab
  const showReview = async () => {
    await page.evaluate(() => { const b = [...document.querySelectorAll('.tchip')].find(x => x.textContent === 'Review'); if (b) b.click(); });
    await w(500);
  };
  const setSeed = async v => {
    // the seed box now lives under "Advanced options" on the Real Exam setup
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /Advanced options/.test(x.textContent)); if (b) b.click(); });
    await w(250);
    await page.evaluate(vv => {
      if (vv === null || vv === undefined) return;
      const i = document.getElementById('seedInput') || [...document.querySelectorAll('input.tsel')].find(x => /^[0-9]*$/.test(x.value));
      if (i) { i.value = String(vv); i.dispatchEvent(new Event('change')); }
    }, v);
    await w(250);
  };
  const openGrand = async () => {
    await page.evaluate(() => document.querySelector('#tabbar .tab[data-tab="test"]').click());
    await w(400);
    await clickTxt('Real Exam Grand Test');
    await w(800);
  };
  const pickExam = async name => { await clickTxt('^' + name + '$'); await w(700); };
  // the Start button stays disabled until the library has loaded — wait for it
  const waitStartEnabled = async () => {
    for (let i = 0; i < 60; i++) {
      const st = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.tstart')].find(x => /^Start /.test(x.textContent));
        return b ? { dis: !!b.disabled, n: document.querySelectorAll('.qrow, .tchip').length } : null;
      });
      if (st && !st.dis) return true;
      await w(250);
    }
    return false;
  };
  const startPaper = async name => {
    await waitStartEnabled();
    await clickTxt('Start ' + name + ' paper');
    await w(800);
    await waitSel('.tpalcell', 20000);
    await w(300);
  };

  await page.evaluate(() => document.querySelector('#tabbar .tab[data-tab="test"]').click());
  await w(400);
  check('Real Exam Grand Test tile exists', await clickTxt('Real Exam Grand Test'), '');
  await w(800);
  // the library must read per-card state back from the cloud: one fixture card
  // is deleted, so the pool has to be one short. If card_id is missing from the
  // pull this reads the full count and fails.
  const poolInfo = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.tsub.small')].map(x => x.textContent).find(x => /MCQs available/.test(x)) || '';
    const m = t.match(/^(\d+) MCQs available/);
    return m ? Number(m[1]) : -1;
  });
  const expected = fx.decks.reduce((a, d) => a + d.cards.length, 0) - (fx.states || []).filter(s => s.deleted).length;
  check('deleted cards are kept out of the pool (per-card state is read back)', poolInfo === expected, poolInfo + ' vs ' + expected);
  if (!(await page.evaluate(() => !!document.querySelector('.tbig')))) {
    console.log('DIAG screen after tile click:', (await page.evaluate(() => (document.body.innerText || '').slice(0, 260))).replace(/\n/g, ' / '));
  }

  // ---- 3. the three real papers ----
  await startPaper('NEET-PG');
  const neet = await runState();
  check('NEET-PG paper = 180 Q in 5 sections of 36',
    neet.n === 180 && neet.secOn === true && neet.secN === 5 && neet.secQ === 36,
    `n=${neet.n} sec=${neet.secN}x${neet.secQ} on=${neet.secOn}`);
  check('NEET-PG section time = 42 min', neet.secMins === 42, neet.secMins);
  check('paper spread across every deck', neet.decks === fx.decks.length, neet.decks + '/' + fx.decks.length + ' decks, ' + neet.subjects + ' subjects');
  const tagPct = k => Math.round((neet.byTag[k] || 0) / neet.n * 100);
  check('NEET-PG tag mix within 8 pts of 10/30/60',
    near(tagPct('Basics&Fundamentals'), 10, 8) && near(tagPct('MainConcepts'), 30, 8) && near(tagPct('Integrated&Complex'), 60, 8),
    `${tagPct('Basics&Fundamentals')}/${tagPct('MainConcepts')}/${tagPct('Integrated&Complex')}`);
  const imgPct = Math.round(neet.img / neet.n * 100);
  check('NEET-PG image share within 8 pts of 30', near(imgPct, 30, 8), imgPct + '%');

  // marking: one right + one wrong
  await page.evaluate(() => {
    const t = JSON.parse(localStorage.getItem('fd:testrun') || '{}');
    if (!t.qs) return;
    document.querySelectorAll('.tqopt')[t.qs[0].answer].click();
  });
  await w(200);
  await clickTxt('Next');
  await w(300);
  await page.evaluate(() => {
    const t = JSON.parse(localStorage.getItem('fd:testrun') || '{}');
    if (!t.qs) return;
    document.querySelectorAll('.tqopt')[[0,1,2,3].find(k => k !== t.qs[t.i].answer)].click();
  });
  await w(200);
  await submit();
  const neetScore = await page.evaluate(() => (document.querySelector('.tscore') || {}).textContent);
  check('NEET-PG marking +4 / -1  => 3 / 720', neetScore === '3 / 720', neetScore);
  await showReview();
  const palOnResult = await page.evaluate(() => document.querySelectorAll('.qpal .qpalcell').length);
  check('review screen shows the question palette', palOnResult === 180, palOnResult);
  await clickTxt('New paper');
  await w(800);

  // ---- 4. seed rebuild ----
  const seed1 = neet.seed;
  await setSeed(seed1);
  await w(500);
  await startPaper('NEET-PG');
  const again = await runState();
  const sameIds = again.ids.filter(x => neet.ids.includes(x)).length;
  check('same seed rebuilds the identical paper', sameIds === neet.n && again.seed === seed1, `${sameIds}/${neet.n}`);
  await submit();
  await clickTxt('New paper');
  await w(800);

  // ---- 5. no-repeat ----
  await clickTxt('New seed');
  await w(500);
  await startPaper('NEET-PG');
  const fresh = await runState();
  check('a new paper avoids the previous one where the library allows',
    fresh.ids.filter(x => neet.ids.includes(x)).length < neet.n,
    `${fresh.ids.filter(x => neet.ids.includes(x)).length} reused`);
  await submit();
  await clickTxt('New paper');
  await w(800);

  // ---- 6. INI-CET ----
  await pickExam('INI-CET');
  await startPaper('INI-CET');
  const ini = await runState();
  check('INI-CET paper = 200 Q in 4 sections of 50',
    ini.n === 200 && ini.secOn === true && ini.secN === 4 && ini.secQ === 50 && ini.secMins === 45,
    `n=${ini.n} sec=${ini.secN}x${ini.secQ}@${ini.secMins}`);
  await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('fd:testrun') || '{}'); if (t.qs) document.querySelectorAll('.tqopt')[t.qs[0].answer].click(); });
  await w(200);
  await clickTxt('Next');
  await w(300);
  await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('fd:testrun') || '{}'); if (t.qs) document.querySelectorAll('.tqopt')[[0,1,2,3].find(k => k !== t.qs[t.i].answer)].click(); });
  await w(200);
  await submit();
  const iniScore = await page.evaluate(() => (document.querySelector('.tscore') || {}).textContent);
  check('INI-CET marking +1 / -1/3  => 0.67 / 200', iniScore === '0.67 / 200', iniScore);
  await clickTxt('New paper');
  await w(800);

  // ---- 7. RUHS-MO ----
  await pickExam('RUHS-MO');
  await startPaper('RUHS-MO');
  const ruhs = await runState();
  check('RUHS-MO paper = 100 Q, no sections', ruhs.n === 100 && ruhs.secOn === false, `n=${ruhs.n} on=${ruhs.secOn}`);
  await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('fd:testrun') || '{}'); if (t.qs) document.querySelectorAll('.tqopt')[t.qs[0].answer].click(); });
  await w(200);
  await clickTxt('Next');
  await w(300);
  await page.evaluate(() => { const t = JSON.parse(localStorage.getItem('fd:testrun') || '{}'); if (t.qs) document.querySelectorAll('.tqopt')[[0,1,2,3].find(k => k !== t.qs[t.i].answer)].click(); });
  await w(200);
  await submit();
  const ruhsScore = await page.evaluate(() => (document.querySelector('.tscore') || {}).textContent);
  check('RUHS-MO marking +1, no negative  => 1 / 100', ruhsScore === '1 / 100', ruhsScore);
  // write our own line on the review screen — the error log must show ONLY this
  await showReview();
  await page.evaluate(() => {
    const ta = document.querySelector('.errnote');
    if (ta) { ta.value = 'regression: my own line'; ta.dispatchEvent(new Event('change')); }
    const b = [...document.querySelectorAll('button')].find(x => /Save to error log/.test(x.textContent));
    if (b) b.click();
  });
  await w(400);
  await clickTxt('New paper');
  await w(800);

  // ---- 8. error log = the user's own write-ups only ----
  await clickTxt('All test modes');
  await w(600);
  await clickTxt('^History$');       // the Error log button lives in the History segment now
  await w(600);
  await clickTxt('Error log');
  await w(900);
  const errlog = await page.evaluate(() => {
    const notes = JSON.parse(localStorage.getItem('fd:errnotes') || '{}');
    return { n: Object.keys(notes).length, boxes: document.querySelectorAll('.errbox').length,
             txt: (document.querySelector('.errnotetxt') || {}).textContent || '',
             dump: (JSON.parse(localStorage.getItem('fd:errors') || '[]') || []).length,
             head: (document.querySelector('.vhead') || {}).textContent };
  });
  check('error log shows your own write-ups only', errlog.head === 'Error log' && errlog.n > 0 && /my own line/.test(errlog.txt) && errlog.dump === 0,
    `notes=${errlog.n} boxes=${errlog.boxes} txt="${errlog.txt}" dump=${errlog.dump}`);

  await browser.close();

  // ---- report ----
  console.log('');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   (' + r.detail + ')' : ''}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE CRASHED:', e && e.message); process.exit(2); });
