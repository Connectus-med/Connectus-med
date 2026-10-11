// Connectus backend: app file, public catalogue, deck content, and Razorpay passes.
const FREE_DEFAULT = ['Aortic_Stenosis','Atrial_Fibrillation','Ischemic_Stroke','Nutrition','Basic_Epidemiology','Immunization','Appendicitis','Trauma_and_Burns','Breast_Cancer'];
const OWNER_DEFAULT = 'life.rknain@gmail.com';
const PASSES_DEFAULT = [
  { id: 'day1', label: '1 day', days: 1, amount: 1000 },
  { id: 'day10', label: '10 days', days: 10, amount: 5000 },
  { id: 'day30', label: '30 days', days: 30, amount: 10000 }
];

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, cors()) });
}
function safeEq(a: string, b: string) {
  const A = new TextEncoder().encode(a), B = new TextEncoder().encode(b);
  if (A.length !== B.length) return false;
  let d = 0; for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i];
  return d === 0;
}
async function hmacHex(msg: string, secret: string) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL') as string;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') as string;
  const H = { apikey: key, Authorization: 'Bearer ' + key };
  const q = new URL(req.url).searchParams;
  const api = q.get('api');

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() });

  const sbGet = (path: string) => fetch(url + path, { headers: H }).then((r) => r.json());
  const sbWrite = (path: string, body: unknown, method = 'POST') =>
    fetch(url + path, {
      method,
      headers: Object.assign({}, H, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(body)
    });

  const setting = async (k: string, d: string) => {
    try {
      const r = await sbGet('/rest/v1/settings?select=value&key=eq.' + k + '&limit=1');
      return Array.isArray(r) && r.length && r[0].value ? String(r[0].value) : d;
    } catch (_e) { return d; }
  };
  const passList = async () => {
    try { const p = JSON.parse(await setting('passes', '')); return Array.isArray(p) && p.length ? p : PASSES_DEFAULT; }
    catch (_e) { return PASSES_DEFAULT; }
  };
  const freeList = async () => {
    const v = await setting('free_decks', '');
    const l = String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
    return l.length ? l : FREE_DEFAULT;
  };
  const caller = async () => {
    const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!t) return null;
    try {
      const r = await fetch(url + '/auth/v1/user', { headers: { apikey: key, Authorization: 'Bearer ' + t } });
      if (!r.ok) return null;
      const u = await r.json();
      return u && u.email ? { id: String(u.id), email: String(u.email) } : null;
    } catch (_e) { return null; }
  };
  const entitlement = async (user: { id: string; email: string } | null) => {
    if (!user) return { role: 'guest', unlocked: false, access_until: null };
    const owners = String(await setting('owner_email', OWNER_DEFAULT)).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (owners.indexOf(user.email.toLowerCase()) >= 0) return { role: 'owner', unlocked: true, access_until: null };
    let au: string | null = null;
    try {
      const r = await sbGet('/rest/v1/passes?select=access_until&user_id=eq.' + user.id);
      if (Array.isArray(r) && r.length) au = r[0].access_until;
    } catch (_e) { /* none */ }
    return { role: 'customer', unlocked: !!(au && new Date(au).getTime() > Date.now()), access_until: au };
  };
  const extend = async (userId: string, days: number) => {
    let base = Date.now();
    try {
      const r = await sbGet('/rest/v1/passes?select=access_until&user_id=eq.' + userId);
      if (Array.isArray(r) && r.length && r[0].access_until) base = Math.max(base, new Date(r[0].access_until).getTime());
    } catch (_e) { /* fresh */ }
    const until = new Date(base + days * 86400000).toISOString();
    await sbWrite('/rest/v1/passes?on_conflict=user_id', { user_id: userId, access_until: until, updated_at: new Date().toISOString() });
    return until;
  };
  const catalogue = async () => {
    try { const r = await sbGet('/rest/v1/rpc/deck_catalog'); return Array.isArray(r) ? r : []; } catch (_e) { return []; }
  };

  // ---- version (public build check, for self-update on every device) ----
  if (api === 'version') {
    return json({ ui_version: await setting('ui_version', '') });
  }

  // ---- catalogue / legacy guest payload ----
  if (api === 'catalog' || api === 'guest') {
    const user = await caller();
    const ent = await entitlement(user);
    const cat = await catalogue();
    const catKeys: Record<string, boolean> = {};
    cat.forEach((d: Record<string, unknown>) => { catKeys[String(d.deck_key)] = true; });
    /* SAFEGUARD: only a FILED deck that is listed in free_decks is treated as free.
       A stray / mistyped / non-filed key can never expose any content. */
    const free = (await freeList()).filter((k) => catKeys[k]);
    let subs: unknown = [];
    try { subs = await sbGet('/rest/v1/subjects?select=year,name,sort_order&order=year,sort_order,name'); } catch (_e) { subs = []; }
    const decks = cat.map((d: Record<string, unknown>) => ({
      key: d.deck_key, topic: d.topic, subject: d.subject, set_no: d.set_no, n: d.n,
      unit: d.unit, category: d.category,
      free: free.indexOf(String(d.deck_key)) >= 0
    }));
    if (api === 'guest') {
      const inList = 'in.(' + free.map((k) => '%22' + encodeURIComponent(k) + '%22').join(',') + ')';
      let rows: any[] = [];
      try { const r = await sbGet('/rest/v1/decks?select=deck_key,html,cards&filed=is.true&deck_key=' + inList); if (Array.isArray(r)) rows = r; } catch (_e) { /* none */ }
      let base = ''; const fm: Record<string, unknown[]> = {};
      for (const d of rows) { if (!base && d.html) base = d.html; fm[d.deck_key] = d.cards || []; }
      return json({
        subjects: Array.isArray(subs) ? subs : [],
        decks: decks.map((d) => Object.assign({}, d, { free: !!fm[d.key] })),
        free: Object.keys(fm).map((k) => ({ key: k, cards: fm[k] })),
        base_html: base
      });
    }
    return json({
      subjects: Array.isArray(subs) ? subs : [],
      decks,
      passes: await passList(),
      role: ent.role,
      unlocked: ent.unlocked,
      access_until: ent.access_until
    });
  }

  // ---- one deck's content (?api=deck&key=K  or  ?deck=K) ----
  const deckKey = q.get('deck') || q.get('key') || '';
  if (api === 'deck' || q.get('deck')) {
    const user = await caller();
    const ent = await entitlement(user);
    const free = await freeList();
    /* SAFEGUARD: a deck's cards leave the server ONLY for the owner, an active pass, or a free deck */
    if (!(ent.unlocked || free.indexOf(deckKey) >= 0)) return json({ error: 'locked' }, 403);
    try {
      const rows = await sbGet('/rest/v1/decks?select=deck_key,topic,subject,set_no,cards,html&filed=is.true&deck_key=eq.' + encodeURIComponent(deckKey) + '&limit=1');
      if (!Array.isArray(rows) || !rows.length) return json({ error: 'not_found' }, 404);
      const d = rows[0];
      if (q.get('probe') === '1') {
        return json({ key: d.deck_key, topic: d.topic, subject: d.subject, set_no: d.set_no, cards: (d.cards || []).length, html_bytes: String(d.html || '').length, unlocked: ent.unlocked });
      }
      return json({ key: d.deck_key, topic: d.topic, subject: d.subject, set_no: d.set_no, cards: d.cards || [], html: d.html || '' });
    } catch (e) { return json({ error: String(e) }, 500); }
  }

  // ---- owner recovery: trade the recovery code for a real session on the owner account ----
  if (api === 'recover' && req.method === 'POST') {
    const want = Deno.env.get('OWNER_RECOVERY_CODE') || '';
    if (!want) return json({ error: 'recover_not_configured' }, 503);
    let b: any = {};
    try { b = await req.json(); } catch (_e) { b = {}; }
    const code = String((b && b.code) || '');
    if (!safeEq(code, want)) {
      await new Promise((r) => setTimeout(r, 800));
      return json({ error: 'bad_code' }, 401);
    }
    const owners = String(await setting('owner_email', OWNER_DEFAULT)).split(',').map((x) => x.trim()).filter(Boolean);
    const target = owners[0] || OWNER_DEFAULT;
    try {
      const r = await fetch(url + '/auth/v1/admin/generate_link', {
        method: 'POST',
        headers: Object.assign({}, H, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ type: 'magiclink', email: target })
      });
      const j: any = await r.json();
      const th = String((j && (j.hashed_token || (j.properties && j.properties.hashed_token))) || '');
      if (!r.ok || !th) return json({ error: 'link_failed' }, 502);
      return json({ ok: true, email: target, token_hash: th });
    } catch (e) { return json({ error: String(e) }, 502); }
  }

  // ---- create a Razorpay order ----
  if (api === 'order' && req.method === 'POST') {
    const user = await caller();
    if (!user) return json({ error: 'sign_in_required' }, 401);
    const kid = Deno.env.get('RAZORPAY_KEY_ID');
    const ksec = Deno.env.get('RAZORPAY_KEY_SECRET');
    if (!kid || !ksec) return json({ error: 'payments_not_configured' }, 503);
    let body: any = {};
    try { body = await req.json(); } catch (_e) { body = {}; }
    const list = await passList();
    const p = list.find((x: any) => x.id === body.pass_id);
    if (!p) return json({ error: 'unknown_pass' }, 400);
    try {
      const r = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(kid + ':' + ksec) },
        body: JSON.stringify({ amount: p.amount, currency: 'INR', receipt: 'c' + Date.now(), notes: { user_id: user.id, pass_id: p.id, days: String(p.days) } })
      });
      const order = await r.json();
      if (!r.ok) return json({ error: 'order_failed' }, 502);
      await sbWrite('/rest/v1/payments?on_conflict=order_id', { order_id: order.id, user_id: user.id, pass_id: p.id, days: p.days, amount: p.amount, status: 'created', updated_at: new Date().toISOString() });
      return json({ order_id: order.id, amount: p.amount, currency: 'INR', key_id: kid, pass: { id: p.id, label: p.label, days: p.days } });
    } catch (e) { return json({ error: String(e) }, 502); }
  }

  // ---- verify a payment and grant the pass ----
  if (api === 'verify' && req.method === 'POST') {
    const user = await caller();
    if (!user) return json({ error: 'sign_in_required' }, 401);
    const ksec = Deno.env.get('RAZORPAY_KEY_SECRET');
    if (!ksec) return json({ error: 'payments_not_configured' }, 503);
    let b: any = {};
    try { b = await req.json(); } catch (_e) { b = {}; }
    if (!b.order_id || !b.payment_id || !b.signature) return json({ error: 'bad_request' }, 400);
    const expected = await hmacHex(b.order_id + '|' + b.payment_id, ksec);
    if (expected !== String(b.signature)) return json({ error: 'bad_signature' }, 400);
    try {
      const rows = await sbGet('/rest/v1/payments?select=days,status&order_id=eq.' + encodeURIComponent(b.order_id) + '&user_id=eq.' + user.id + '&limit=1');
      if (!Array.isArray(rows) || !rows.length) return json({ error: 'unknown_order' }, 404);
      let until: string | null = null;
      if (rows[0].status !== 'paid') {
        until = await extend(user.id, Number(rows[0].days) || 1);
        await sbWrite('/rest/v1/payments?order_id=eq.' + encodeURIComponent(b.order_id), { status: 'paid', payment_id: b.payment_id, updated_at: new Date().toISOString() }, 'PATCH');
      } else {
        const r2 = await sbGet('/rest/v1/passes?select=access_until&user_id=eq.' + user.id);
        until = Array.isArray(r2) && r2.length ? r2[0].access_until : null;
      }
      return json({ ok: true, unlocked: true, access_until: until });
    } catch (e) { return json({ error: String(e) }, 500); }
  }

  // ---- Razorpay webhook (belt and braces) ----
  if (api === 'webhook' && req.method === 'POST') {
    const raw = await req.text();
    const secret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET');
    /* A webhook we cannot verify must never be trusted. Without the secret the
       old code processed the payload anyway, so a signed-in account could mint
       an order and then POST a forged webhook for it to be granted a pass with
       no payment. Refuse instead. */
    if (!secret) return json({ error: 'webhook_not_configured' }, 503);
    const sig = req.headers.get('x-razorpay-signature') || '';
    const expected = await hmacHex(raw, secret);
    if (!sig || !safeEq(expected, sig)) return json({ error: 'bad_signature' }, 400);
    try {
      const ev = JSON.parse(raw);
      const pe = ev && ev.payload && ev.payload.payment && ev.payload.payment.entity;
      const oid = pe && pe.order_id;
      if (oid && (ev.event === 'payment.captured' || ev.event === 'order.paid')) {
        const rows = await sbGet('/rest/v1/payments?select=user_id,days,status&order_id=eq.' + encodeURIComponent(oid) + '&limit=1');
        if (Array.isArray(rows) && rows.length && rows[0].status !== 'paid' && rows[0].user_id) {
          await extend(rows[0].user_id, Number(rows[0].days) || 1);
          await sbWrite('/rest/v1/payments?order_id=eq.' + encodeURIComponent(oid), { status: 'paid', payment_id: (pe && pe.id) || null, updated_at: new Date().toISOString() }, 'PATCH');
        }
      }
    } catch (_e) { /* ignore malformed */ }
    return json({ ok: true });
  }

  // ---- default: the app file ----
  let html = '';
  try {
    const r = await fetch(url + '/rest/v1/settings?select=value&key=eq.library_html&limit=1', { headers: H });
    const rows = await r.json();
    if (Array.isArray(rows) && rows.length && rows[0].value) html = rows[0].value;
  } catch (_e) { /* ignore */ }
  if (!html) html = 'Connectus is starting up. Please reload in a moment.\n';
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...cors()
    }
  });
});
