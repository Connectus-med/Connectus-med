"""med_build.py — chapter-aware builder for the Medicine Qbank Ed8 (one combined doc).

Splits the 2.6 MB content.md into its 104 chapters (using the printed Table of
Contents), parses each chapter's questions + explanations + its own answer-key
table, builds MCQ cards as-is, flags anomalies, and files one deck per chapter
under General Medicine.
"""
import asyncio, json, re, os, csv, io, zipfile
from sarvam_tools import sarvam_kb_download_kb_files, sarvam_kb_list_kb_dir, supabase_execute_sql

MED = "col_c6670e444dd44b989829a929e06af5fa"
FOLDER = "04._Medicine_Qbank_ed8_-_linked_navigation-fd4c0aaf32e7410bbad538a5e414b123"
PROJ = "vcsfjzlelpwditxdbaea"
CITE = re.compile(r"\[cite:[0-9a-f]+\]")
ANCHOR = re.compile(r"\^p\d+-\d+")
TOCFILES = ["p2-2.csv", "p3-1.csv", "p4-1.csv", "p5-1.csv", "p6-1.csv"]

_ns = {}
exec(open("/scratch/work/qbank_build.py").read(), _ns)
_split, _separate_images, _tag = _ns["_split"], _ns["_separate_images"], _ns["_tag"]


async def _dl(paths):
    for attempt in range(5):
        try:
            return await sarvam_kb_download_kb_files(collection_id=MED, paths=paths)
        except Exception:
            if attempt == 4:
                raise
            await asyncio.sleep(2.0)


def _unpack(dl, out):
    for a in dl["artifacts"]:
        p = a["workspace_path"]
        if p.endswith(".zip"):
            with zipfile.ZipFile(p) as z:
                for nm in z.namelist():
                    if nm.endswith(".csv"):
                        out[os.path.basename(nm)] = z.read(nm).decode()
        elif p.endswith(".csv"):
            out[os.path.basename(p)] = open(p).read()
    return out


async def get_content():
    dl = await _dl([FOLDER + "/content.md"])
    return open(dl["artifacts"][0]["workspace_path"]).read()


async def get_tables():
    lst = await sarvam_kb_list_kb_dir(collection_id=MED, path=FOLDER + "/tables")
    csvs = sorted(f for f in str(lst).split() if f.endswith(".csv"))
    out = {}
    for i in range(0, len(csvs), 60):
        dl = await _dl([FOLDER + "/tables/" + f for f in csvs[i:i + 60]])
        _unpack(dl, out)
    return out


async def get_toc():
    D = FOLDER + "/tables/"
    txt = _unpack(await _dl([D + p for p in TOCFILES]), {})
    rows = []
    for f in TOCFILES:
        for row in csv.DictReader(io.StringIO(txt.get(f, ""))):
            if row.get("Chapter"):
                rows.append((int(row["Chapter"]), row["Title"].strip()))
    return rows


def chapters(content, toc):
    marks = []
    for num, title in toc:
        key = title.replace("...", "").strip()[:30]
        m = re.search(r"(?m)^## " + re.escape(key), content)
        if m:
            marks.append((num, title, m.start()))
    out = []
    for i, (num, title, s) in enumerate(marks):
        end = marks[i + 1][2] if i + 1 < len(marks) else len(content)
        out.append((num, title, content[s:end]))
    return out


def _opt_letter(s):
    s = (s or "").strip()
    if not s:
        return None
    m = re.search(r"Back to Q\s*\d+\s*(.*)$", s, re.I)
    tail = m.group(1) if m else s
    letters = re.findall(r"[a-dA-D]", tail)
    return letters[-1].lower() if letters else None


def answer_map(text):
    d = {}
    for row in csv.reader(io.StringIO(text)):
        cells = [c.strip() for c in row if c is not None]
        num = None
        for c in cells:
            if re.fullmatch(r"\d+", c):
                num = int(c); break
        if num is None:
            continue
        let = None
        for c in reversed(cells):
            if re.fullmatch(r"\d+", c):
                continue
            l = _opt_letter(c)
            if l:
                let = l; break
        if let:
            d[num] = "abcd".index(let)
    return d


def _blocks(text, marker):
    ch = re.split(r"(?m)^#*\s*%s (\d+):" % marker, text)
    return {int(ch[i]): ch[i + 1] for i in range(1, len(ch), 2)}


def unit_of(num):
    if num <= 2: return "Misc Topics"
    if 3 <= num <= 18: return "Endocrinology"
    if 19 <= num <= 32: return "Gastroenterology & Hepatology"
    if 33 <= num <= 41: return "Rheumatology & Immunology"
    if 42 <= num <= 49: return "Respiratory System"
    if 50 <= num <= 56: return "Nephrology"
    if 57 <= num <= 71: return "Cardiovascular System"
    if 72 <= num <= 86: return "Central Nervous System"
    if 87 <= num <= 98: return "Hematology"
    if 99 <= num <= 104: return "Infectious Diseases"
    return "Misc Topics"


def slug(num, name):
    return "Med_%02d_%s" % (num, re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")[:50])


def fix_opts(opts):
    if len(opts) == 3 and re.search(r"##\s*[cd]\)", opts[2]):
        a, b = re.split(r"##\s*[cd]\)\s*", opts[2], maxsplit=1)
        return [opts[0], opts[1], a.strip(), b.strip()]
    if len(opts) == 2 and re.search(r"##\s*[bc]\)", opts[1]):
        a, b = re.split(r"##\s*[bc]\)\s*", opts[1], maxsplit=1)
        return [opts[0], a.strip(), b.strip()]
    return opts


REF = re.compile(r"\s*>?\s*\[[^\]]*\]\(tables/[^)]+\)[^\n]*")
LEAD = re.compile(r"^(?:\s*(?:Answer Key|Explanation)\b\s*(?:\(p\.\d+\))?|\s*\(p\.\d+\)|\s*\^p\d+-\d+)+\s*", re.I)
def clean_refs(t):
    t = REF.sub(" ", t)
    t = re.sub(r"\s*>?\s*Answer Key\s*", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def build_cards(num, name, block, tables):
    body, _, ex = block.partition("Detailed Explanations")
    qs = _blocks(body, "Question")
    exps = _blocks(ex, "Solution to Question")
    ans = {}
    for r in re.findall(r"tables/(p[\d-]+)\.md", block):
        ans.update(answer_map(tables.get(r + ".csv", "")))
    dk = slug(num, name); cards = []; flags = []
    for n in sorted(qs):
        stem, opts = _split(qs[n]); opts = fix_opts(opts)
        stem = LEAD.sub("", re.sub(r"(?m)^#+\s*", " ", ANCHOR.sub("", stem)))
        stem, img = _separate_images(stem)
        stem = clean_refs(" ".join(CITE.sub("", ANCHOR.sub("", stem)).split()))
        opts = [clean_refs(o) for o in opts]
        exp = " ".join(CITE.sub("", ANCHOR.sub("", exps.get(n, ""))).split())
        a = ans.get(n); f = []
        if len(opts) != 4: f.append("opts=%d" % len(opts))
        if a is None: f.append("no-answer")
        if re.match(r"^([A-E]|\d+)(\s*(,|and)\s*([A-E]|\d+))+", (opts[0] if opts else ""), re.I): f.append("combo")
        if not exp: f.append("no-explain")
        if img: f.append("image")
        if img and stem: stem = (stem + " [Image: " + clean_refs(img)[:150] + "]").strip()
        pg = re.search(r"\^p(\d+)-\d+", qs[n])
        page = pg.group(1) if pg else ""
        src = "%s — Medicine Qbank Ed8, p.%s (Q%d)" % (name, page, n) if page else "%s — Medicine Qbank Ed8 (Q%d)" % (name, n)
        card = {"id": "%s_q%d" % (dk, n), "type": "mcq", "q": stem, "options": opts, "answer": a,
                "explain": exp, "src": src, "tag": _tag(stem, n)}
        cards.append(card)
        if f: flags.append((n, f))
    return dk, name, cards, flags


async def insert(dk, name, unit, cards):
    cj = json.dumps(cards, ensure_ascii=False)
    sql = f"""insert into public.decks (user_id, deck_key, topic, subject, unit, category, set_no, filed, cards)
select id, '{dk}', $x${name}$x$, 'General Medicine', $x${unit}$x$, $x${name}$x$, 1, true, $x${cj}$x$::jsonb
from auth.users where email = 'life.rknain@gmail.com'
on conflict (user_id, deck_key) do update set subject=excluded.subject, unit=excluded.unit,
  category=excluded.category, set_no=1, topic=excluded.topic, filed=true, cards=excluded.cards, updated_at=now();"""
    return await supabase_execute_sql(project_id=PROJ, query=sql)
