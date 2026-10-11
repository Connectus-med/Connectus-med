"""qbank_build.py — semi-auto builder for Pedia Qbank Ed8 MCQ decks.

For a topic it: fetches content.md + every answer-key table (merged), parses each
MCQ into a ready card {id,type,q,options,answer,explain,src,tag}, separates the
image-description text, applies tag rules, and reports which questions need a
human (image-based / broken / missing key). Nothing is inserted unless asked.
"""
import asyncio, json, re, os
from sarvam_tools import sarvam_kb_download_kb_files, supabase_execute_sql

COLL = "col_b92ae989c18a446085d4b16a16499823"
PROJ = "vcsfjzlelpwditxdbaea"
ANCHOR = re.compile(r"\^p\d+-\d+")
CITE = re.compile(r"\[cite:[0-9a-f]+\]")
IMG = re.compile(r"^(An illustration|A photograph|A close-up|A grayscale|A medical (illustration|X-ray|photograph)|"
                 r"A high-angle|A side-by-side|A composite|A microscopic|A simplified|An anatomical|"
                 r"A diagram|An intraoral|A full-body|A stylized|A posteroanterior|An anteroposterior|"
                 r"A chest X-ray|An X-ray|A CT |An MRI|A scan|A histopath|A peripheral smear|"
                 r"This image|The image|The (following|above|given) image|©MARROW)", re.I)
VIGNETTE = re.compile(r"^(A|An)\s+(\d+[- ]?(year|month|day|week)|newborn|infant|neonate|boy|girl|man|woman|child|mother|patient|baby|lady|male|female|toddler|preterm)", re.I)

def fetch(path):
    async def _f():
        for attempt in range(4):
            try:
                dl = await sarvam_kb_download_kb_files(collection_id=COLL, paths=[path])
                return open(dl["artifacts"][0]["workspace_path"]).read()
            except Exception:
                if attempt == 3: raise
                await asyncio.sleep(2.0)
    return _f()

def _qs(content):
    body = content.split("## Answer Key")[0]
    ch = re.split(r"(?m)^#*\s*Question (\d+):", body)
    return {int(ch[i]): ch[i+1] for i in range(1, len(ch), 2)}

def _exps(content):
    if "Detailed Explanations" not in content: return {}
    ex = content.split("Detailed Explanations", 1)[1]
    ch = re.split(r"(?m)^#*\s*Solution to Question (\d+):", ex)
    return {int(ch[i]): ch[i+1].strip() for i in range(1, len(ch), 2)}

def _split(raw):
    raw = CITE.sub("", ANCHOR.sub("", raw))
    pos = {}
    for L in "abcd":
        m = re.search(r"(?m)^\s*%s\)\s*" % L, raw)
        if m: pos[L] = m.start()
    stem, opts = raw.strip(), []
    if "a" in pos:
        stem = raw[:pos["a"]].strip()
        order = sorted(pos.items(), key=lambda kv: kv[1])
        for i, (L, p) in enumerate(order):
            end = order[i+1][1] if i+1 < len(order) else len(raw)
            chunk = re.sub(r"^\s*[a-d]\)\s*", "", raw[p:end])
            opts.append(" ".join(chunk.split()))
    return stem, opts

def _separate_images(stem):
    """Return (clean_stem, image_description_text)."""
    paras = [p.strip() for p in re.split(r"\n\s*\n", stem) if p.strip()]
    keep, img = [], []
    in_img = False
    for p in paras:
        if p.startswith("### Text in image"): in_img = True; continue
        if IMG.match(p) or "©MARROW" in p or in_img:
            img.append(re.sub(r"### Text in image", "", p).strip()); continue
        keep.append(p)
    clean = " ".join(" ".join(keep).split())
    if not clean: clean = " ".join(stem.split())
    return clean, " ".join(img).strip()

def _tag(stem, n):
    s = stem.strip()
    if VIGNETTE.match(s): return "Integrated&Complex"
    if re.search(r"(mode of inheritance|which of the following is (an? )?(x-?linked|autosomal)|is defined|"
                 r"definition|criteria for|classif|which of the following is not true|normal (value|range)|"
                 r"physiolog|what is the (normal|most common cause|mechanism|mode)|which (organism|virus|bacterium|parasite|enzyme)|"
                 r"deficiency of which|is caused by|characteristic (feature|finding) of|pathognomonic|karyotype|what is the diagnosis of)", s, re.I):
        return "Basics&Fundamentals"
    return "MainConcepts"

async def build(FOLDER, meta, overrides=None, insert=False):
    overrides = overrides or {}
    content = await fetch(FOLDER + "/content.md")
    qs, exps = _qs(content), _exps(content)
    # answer keys: download every table, keep those with a 'Correct Option' header
    tbl = await fetch(FOLDER + "/tables/__none__") if False else None
    # list tables via the collection tree is unavailable here; instead parse refs from content
    refs = set(re.findall(r"\((tables/p[\d-]+\.md)\)", content))
    ans = {}
    for r in refs:
        try:
            data = await fetch(FOLDER + "/" + r.replace(".md", ".csv"))
        except Exception:
            continue
        for line in data.splitlines():
            m = re.match(r"\s*(\d+)\s*,\s*([a-dA-D])\s*$", line)
            if m: ans[int(m.group(1))] = "abcd".index(m.group(2).lower())
    cards, report = [], []
    for n in sorted(qs):
        stem, opts = _split(qs[n]); stem, imgdesc = _separate_images(stem)
        exp = " ".join(CITE.sub("", ANCHOR.sub("", exps.get(n, ""))).split())
        ov = overrides.get(n, {})
        if "q" in ov: stem = ov["q"]
        if "options" in ov: opts = ov["options"]
        if imgdesc and "q" not in ov:
            stem = (stem + " [Image: " + " ".join(imgdesc.split())[:150] + "]").strip()
        a = ov.get("answer", ans.get(n))
        flags = []
        if len(opts) != 4: flags.append("opts=%d" % len(opts))
        if a is None: flags.append("no-answer")
        if imgdesc and "q" not in ov: flags.append("image")
        if re.match(r"^([A-E]|\d+)(\s*(,|and)\s*([A-E]|\d+))+", (opts[0] if opts else ""), re.I): flags.append("combo")
        card = {"id": "%s_q%d" % (meta["deck_key"], n), "type": "mcq",
                "q": stem, "options": opts, "answer": a,
                "explain": ov.get("explain", exp), "src": "%s — Pedia Qbank Ed8 (Q%d)%s" % (meta["topic"], n, ov.get("srcnote", "")),
                "tag": ov.get("tag", _tag(stem, n))}
        cards.append(card)
        report.append((n, flags, stem, imgdesc))
    out = {"cards": cards, "report": report}
    json.dump(cards, open("/scratch/work/%s.cards.json" % meta["deck_key"], "w"), ensure_ascii=False)
    return out

async def insert(deck_key, topic, subject, unit, category, cards):
    cj = json.dumps(cards, ensure_ascii=False)
    sql = f"""insert into public.decks (user_id, deck_key, topic, subject, unit, category, set_no, filed, cards)
select id, '{deck_key}', '{topic}', '{subject}', '{unit}', '{category}', 1, true, $fd${cj}$fd$::jsonb
from auth.users where email = 'life.rknain@gmail.com'
on conflict (user_id, deck_key) do update set subject=excluded.subject, unit=excluded.unit,
  category=excluded.category, set_no=1, topic=excluded.topic, filed=true, cards=excluded.cards, updated_at=now();"""
    return await supabase_execute_sql(project_id=PROJ, query=sql)
