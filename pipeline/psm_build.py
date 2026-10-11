"""psm_build.py — chapter-aware builder for the PSM Qbank Ed8 (one combined doc).

Splits the 1.2 MB content.md into chapters (each starts at '## Question 1:'), parses
each chapter's questions + explanations + its own answer-key table, builds MCQ cards
as-is, flags anomalies, and files one deck per chapter under Community Medicine.
"""
import asyncio, json, re, os, zipfile
from sarvam_tools import sarvam_kb_download_kb_files, sarvam_kb_list_kb_dir, supabase_execute_sql

PSM = "col_8945ccc9baf64c4b84e1e30cdc856a28"
FOLDER = "PSM_Qbank_ed8-7c1413787cd5471d889eeb80f3680983"
PROJ = "vcsfjzlelpwditxdbaea"
CITE = re.compile(r"\[cite:[0-9a-f]+\]")
ANCHOR = re.compile(r"\^p\d+-\d+")
SKIPHEAD = re.compile(r"^(Question \d+:|Solution to Question \d+:|Detailed Explanations|Contents|Text in image|Answer Key|[a-d]\) |©MARROW|• )")

_ns = {}
exec(open("/scratch/work/qbank_build.py").read(), _ns)
_split, _separate_images, _tag = _ns["_split"], _ns["_separate_images"], _ns["_tag"]

async def _dl(paths):
    for attempt in range(5):
        try:
            return await sarvam_kb_download_kb_files(collection_id=PSM, paths=paths)
        except Exception:
            if attempt == 4: raise
            await asyncio.sleep(2.0)

async def get_content():
    dl = await _dl([FOLDER + "/content.md"])
    return open(dl["artifacts"][0]["workspace_path"]).read()

async def get_tables():
    lst = await sarvam_kb_list_kb_dir(collection_id=PSM, path=FOLDER + "/tables")
    csvs = sorted(f for f in str(lst).split() if f.endswith(".csv"))
    out = {}
    for i in range(0, len(csvs), 60):
        chunk = [FOLDER + "/tables/" + f for f in csvs[i:i+60]]
        dl = await _dl(chunk)
        for a in dl["artifacts"]:
            p = a["workspace_path"]
            if p.endswith(".zip"):
                with zipfile.ZipFile(p) as z:
                    for nm in z.namelist():
                        if nm.endswith(".csv"): out[os.path.basename(nm)] = z.read(nm).decode()
            elif p.endswith(".csv"):
                out[os.path.basename(p)] = open(p).read()
    return out

def answer_map(text):
    d = {}
    for line in text.splitlines():
        m = re.match(r"\s*(\d+)\s*,\s*([a-dA-D])\s*$", line)
        if m: d[int(m.group(1))] = "abcd".index(m.group(2).lower())
    return d

def _blocks(text, marker):
    ch = re.split(r"(?m)^#*\s*%s (\d+):" % marker, text)
    return {int(ch[i]): ch[i+1] for i in range(1, len(ch), 2)}

def chapters(content):
    starts = [m.start() for m in re.finditer(r"(?m)^## Question 1:", content)]
    out = []
    for i, s in enumerate(starts):
        end = starts[i+1] if i+1 < len(starts) else len(content)
        name = "Chapter %d" % (i+1)
        for h in reversed(re.findall(r"(?m)^## (.+?)\s*$", content[:s])):
            h = re.sub(r"\s*\^p\d+-\d+\s*$", "", h).strip()
            if not SKIPHEAD.match(h): name = h; break
        out.append((name, content[s:end]))
    return out

def unit_of(name):
    n = name.lower()
    if re.search(r"epidemiolog|statistic|hypothesis|significance|correlat|clinical research|screening|disease and prevention|dynamics of|basic definitions|sterilization", n): return "Epidemiology & Biostatistics"
    if re.search(r"\bnational health programme|nvbdcp|nlep|ntep|naco|\bnis\b|jsy|rbsk|ayushman|sustainable|non-communicable|cardiovascular|diabetes|cancer|obesity|blindness", n): return "National Health Programmes"
    if re.search(r"immuniz|vaccin|family planning|obstetric|pediatric|geriatric|maternal", n): return "Maternal & Child Health"
    if re.search(r"demograph|health determinant", n): return "Demography & Health Indicators"
    if re.search(r"nutrition|macronutrient|micronutrient|food|water|meteorolog|housing|light|sound|radiation|waste|entomolog|pest|biomedical waste|disaster|occupational|esi|factories", n): return "Nutrition, Environment & Occupational Health"
    if re.search(r"respiratory infect|intestinal infect|arthropod|zoonotic|std|surface infect", n): return "Communicable Diseases"
    return "Health System & Administration"

def slug(name):
    return "PSM_" + re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")[:60]

def fix_opts(opts):
    # recover a 4th option merged into the 3rd as '## d) ...'
    if len(opts) == 3 and re.search(r"##\s*[cd]\)", opts[2]):
        a, b = re.split(r"##\s*[cd]\)\s*", opts[2], maxsplit=1)
        return [opts[0], opts[1], a.strip(), b.strip()]
    if len(opts) == 2 and re.search(r"##\s*[bc]\)", opts[1]):
        a, b = re.split(r"##\s*[bc]\)\s*", opts[1], maxsplit=1)
        return [opts[0], a.strip(), b.strip()]
    return opts

REF = re.compile(r"\s*>?\s*\[[^\]]*\]\(tables/[^)]+\)[^\n]*")
def clean_refs(t):
    t = REF.sub(" ", t)
    t = re.sub(r"\s*>?\s*Answer Key\s*", " ", t)
    return re.sub(r"\s+", " ", t).strip()

OVERRIDES = {
 ("Health Determinants and Indicators", 16): ("Which of the following are the components of the Physical Quality of Life Index (PQLI)?", ["Infant mortality rate, literacy rate and life expectancy at 1 year of age", "Birth rate, literacy rate and life expectancy at birth", "Infant mortality rate, per capita income and literacy rate", "Life expectancy, maternal mortality rate and literacy rate"], 0),
 ("Principles of Epidemiology", 19): ("Which of the following statements about incidence is TRUE?", ["Incidence is not affected by the duration of the disease", "Incidence is affected by the duration of the disease", "Incidence measures all existing cases at a point in time", "Incidence decreases as the duration of the disease increases"], 0),
 ("Descriptive Epidemiology", 3): ("Which of the following is included in descriptive epidemiology?", ["Description of the disease by time, place and person", "Testing of a hypothesis about a risk factor", "Estimation of relative risk", "Randomised allocation of study subjects"], 0),
 ("Principles of Immunization and Vaccination", 9): ("Which of the following is a live vaccine?", ["Yellow fever vaccine", "Hepatitis B vaccine", "Tetanus vaccine", "Human papillomavirus vaccine"], 0),
 ("Sterilization and Disinfection", 5): ("Which of the following is sterilised by a hot air oven?", ["Glassware, oils and powders", "Surgical instruments", "Culture media", "Rubber gloves and plastic syringes"], 0),
 ("Screening", 1): ("Which of the following is TRUE for a screening test?", ["It is done on apparently healthy individuals", "It gives a definitive diagnosis", "It is highly accurate", "It is done only on symptomatic patients"], 0),
 ("STDs and Surface Infections", 12): ("According to the 2025 targets of the Global AIDS Strategy 2021-2026, what proportion of HIV-exposed children should be tested by 2 months of age?", ["95%", "75%", "50%", "90%"], 0),
 ("National Health Programmes I - NVBDCP", 3): ("Under the National Vector Borne Disease Control Programme for Malaria, the Drug Distribution Centres are meant for:", ["Dispensing anti-malarial drugs only", "Indoor residual spraying", "Larval control", "Distribution of DDT"], 0),
 ("Preventive Obstetrics, Pediatrics and Geriatrics", 13): ("Which of the following is used in calculating the perinatal mortality rate?", ["Late fetal deaths and early neonatal deaths", "Late fetal deaths and post-neonatal deaths", "Infant deaths and maternal deaths", "Neonatal deaths and under-5 deaths"], 0),
 ("Energy Metabolism and Macronutrients", 16): ("Waterlow's classification uses which of the following indicators?", ["Height for age and weight for height", "Weight for age only", "Mid-upper arm circumference only", "Weight for age and height for age"], 0),
 ("Social Organization and Economics", 10): ("Which of the following components are included in the modified Kuppuswamy scale for socio-economic status?", ["Income, education and occupation of the head of the family", "Income, caste and religion", "Education, caste and occupation", "Income, education and family size"], 0),
 ("Water - I: Sources and purification of water", 18): ("Which of the following is a part of a slow sand filter?", ["Under-drainage system", "Alum dosing chamber", "Rapid mixing chamber", "Flocculation chamber"], 0),
 ("Water - III: Water Quality and Standards", 9): ("While testing drinking water for faecal contamination, the presence of which of the following indicates a POSITIVE test?", ["Escherichia coli", "Staphylococcus", "Klebsiella aerogenes", "Pseudomonas"], 0),
 ("Health Planning and Management", 3): ("What is the FIRST step in the planning cycle of a health programme?", ["Analysis of the health situation", "Establishment of objectives", "Assessment of resources", "Evaluation"], 0),
 ("Healthcare In India", 8): ("Which of the following duties is performed by a male health worker?", ["Chlorination of water bodies and distribution of contraceptives", "Maintenance of eligible couple registers", "Immunization of children", "Antenatal care of pregnant women"], 0),
 ("International Health", 12): ("Which of the following is a component of UNICEF's GOBI-FFF strategy?", ["Growth monitoring and oral rehydration therapy", "DOTS for tuberculosis", "Antiretroviral therapy", "Cataract surgery"], 0),
 ("Descriptive Statistics III - Measures of Dispersion", 9): ("Which of the following is TRUE about the standard normal distribution?", ["It has a mean of 0 and a standard deviation of 1", "It has a mean of 1 and a standard deviation of 0", "It is skewed to the right", "It has a variance of 0"], 0),
 ("Descriptive Statistics IV - Measures of Position", 2): ("Which of the following statements about quantiles is TRUE?", ["Quantiles divide the data into equal groups", "Quantiles are used only for categorical data", "The median is not a quantile", "Quintiles divide the data into four equal groups"], 0),
}

def build_cards(name, block, tables):
    body, _, ex = block.partition("Detailed Explanations")
    qs = _blocks(body, "Question")
    exps = _blocks(ex, "Solution to Question")
    ans = {}
    for r in re.findall(r"tables/(p[\d-]+)\.md", block):
        ans.update(answer_map(tables.get(r + ".csv", "")))
    dk = slug(name); cards = []; flags = []
    for n in sorted(qs):
        stem, opts = _split(qs[n]); opts = fix_opts(opts); stem, img = _separate_images(stem)
        stem = clean_refs(" ".join(CITE.sub("", ANCHOR.sub("", stem)).split()))
        opts = [clean_refs(o) for o in opts]
        if (name, n) in OVERRIDES:
            q_, o_, a_ = OVERRIDES[(name, n)]; stem = q_; opts = o_; ov_ans = a_
        else:
            ov_ans = None
        exp = " ".join(CITE.sub("", ANCHOR.sub("", exps.get(n, ""))).split())
        a = ov_ans if ov_ans is not None else ans.get(n); f = []
        if len(opts) != 4: f.append("opts=%d" % len(opts))
        if a is None: f.append("no-answer")
        if re.match(r"^([A-E]|\d+)(\s*(,|and)\s*([A-E]|\d+))+", (opts[0] if opts else ""), re.I): f.append("combo")
        if not exp: f.append("no-explain")
        if img: f.append("image")
        if img and stem: stem = (stem + " [Image: " + clean_refs(img)[:150] + "]").strip()
        pg = re.search(r"\^p(\d+)-\d+", qs[n])
        page = pg.group(1) if pg else ""
        src = "%s — PSM Qbank Ed8, p.%s (Q%d)" % (name, page, n) if page else "%s — PSM Qbank Ed8 (Q%d)" % (name, n)
        card = {"id": "%s_q%d" % (dk, n), "type": "mcq", "q": stem, "options": opts, "answer": a,
                "explain": exp, "src": src, "tag": _tag(stem, n)}
        if ov_ans is not None:
            card["gen"] = True; card["src"] += " [AI-regenerated from explanation]"
        cards.append(card)
        if f: flags.append((n, f))
    return dk, name, cards, flags

async def insert(dk, name, unit, cards):
    cj = json.dumps(cards, ensure_ascii=False)
    sql = f"""insert into public.decks (user_id, deck_key, topic, subject, unit, category, set_no, filed, cards)
select id, '{dk}', $x${name}$x$, 'Community Medicine', $x${unit}$x$, $x${name}$x$, 1, true, $x${cj}$x$::jsonb
from auth.users where email = 'life.rknain@gmail.com'
on conflict (user_id, deck_key) do update set subject=excluded.subject, unit=excluded.unit,
  category=excluded.category, set_no=1, topic=excluded.topic, filed=true, cards=excluded.cards, updated_at=now();"""
    return await supabase_execute_sql(project_id=PROJ, query=sql)
