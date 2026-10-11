"""qbank_parse.py — proof-of-concept parser for Pedia Qbank Ed8 topics. READ-ONLY.

Fetches a topic's content.md + answer-key CSV via download_kb_files (which writes
them to disk), parses each MCQ into {n, stem, options[4], answer(index), explain},
and flags questions that cannot be auto-built. Nothing is written to Supabase.
"""
import asyncio, json, re, os
from sarvam_tools import sarvam_kb_download_kb_files

COLL = "col_b92ae989c18a446085d4b16a16499823"
FOLDER = "12_Mendelian_and_Non-Mendelian_Disorders_27_Questions-9bd971a096d64071b3d080d97699c9d7"

def decode_entities(t):
    """Turn stray HTML entities into the characters they stand for.

    The source PDFs/KB sometimes carry '&lt;', '&gt;', '&amp;' through extraction
    (e.g. "rate of &lt;5 mg/dl"). Decode BEFORE the card is built - the app renders
    text as plain text, not HTML, so an undecoded code shows up literally.
    """
    if t is None:
        return t
    t = str(t)
    pairs = (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'),
             ("&#39;", "'"), ("&apos;", "'"), ("&nbsp;", " "),
             ("&hellip;", "\u2026"), ("&ndash;", "\u2013"),
             ("&mdash;", "\u2014"), ("&amp;", "&"))
    for _ in range(2):          # two passes: a double-encoded &amp;lt; also resolves
        before = t
        for a, b in pairs:
            t = t.replace(a, b)
        if t == before:
            break
    return t

def parse_questions(content):
    body = content.split("## Answer Key")[0]
    chunks = re.split(r"(?m)^## Question (\d+):", body)
    return {int(chunks[i]): re.sub(r"\[cite:[0-9a-f]+\]", "", chunks[i+1])
            for i in range(1, len(chunks), 2)}

def parse_explanations(content):
    if "## Detailed Explanations" not in content: return {}
    ex = content.split("## Detailed Explanations", 1)[1]
    chunks = re.split(r"(?m)^## Solution to Question (\d+):", ex)
    return {int(chunks[i]): re.sub(r"\[cite:[0-9a-f]+\]", "", chunks[i+1]).strip()
            for i in range(1, len(chunks), 2)}

def split_q(raw):
    idx = {}
    for L in "abcd":
        m = re.search(r"(?m)^\s*%s\)\s*(.*)$" % L, raw)
        if m: idx[L] = m
    stem, opts = raw.strip(), []
    if "a" in idx:
        stem = raw[:idx["a"].start()].strip()
        for L in "abcd":
            if L in idx:
                start = idx[L].end(); nxt = None
                for M in "abcd":
                    if M in idx and idx[M].start() > idx[L].start(): nxt = idx[M].start(); break
                opts.append(" ".join(raw[start: nxt if nxt else len(raw)].split()))
    return " ".join(stem.split()), opts

IMG_MARK = re.compile(r"(An illustration|A photograph|A close-up|A grayscale|A medical (illustration|X-ray)|"
                      r"A black-and-white|A high-angle|A side-by-side|A composite|A microscopic|A simplified|"
                      r"An anatomical|A diagram|An intraoral|A clinical|©MARROW|### Text in image)", re.I)
COMBO = re.compile(r"^([A-E]|\d+)(\s*(,|and)\s*([A-E]|\d+))+\s*(only)?$", re.I)

async def fetch(path):
    dl = await sarvam_kb_download_kb_files(collection_id=COLL, paths=[path])
    return open(dl["artifacts"][0]["workspace_path"]).read()

async def main():
    content = await fetch(FOLDER + "/content.md")
    qs, exps = parse_questions(content), parse_explanations(content)
    m = re.search(r"\[Answer Key\]\((tables/[^)]+)\)", content)
    ans = {}
    if m:
        for line in (await fetch(FOLDER + "/" + m.group(1).replace(".md", ".csv"))).splitlines():
            mm = re.match(r"\s*(\d+)\s*,\s*([a-dA-D])\s*$", line)
            if mm: ans[int(mm.group(1))] = "abcd".index(mm.group(2).lower())
    print("questions:", len(qs), "| answer rows:", len(ans), "| explanations:", len(exps))
    clean, flagged = [], []
    for n in sorted(qs):
        stem, opts = split_q(qs[n]); reasons = []
        if len(opts) != 4: reasons.append("opts=%d" % len(opts))
        if any(COMBO.match(o) for o in opts): reasons.append("combo-options")
        if IMG_MARK.search(stem): reasons.append("image-in-stem")
        if n not in ans: reasons.append("no-answer-key")
        if not exps.get(n): reasons.append("no-explanation")
        rec = {"n": n, "stem": stem[:95], "answer": ans.get(n), "flags": reasons}
        (clean if not reasons else flagged).append(rec)
    print("\nCLEAN (auto-buildable): %d" % len(clean))
    for r in clean: print("  Q%-2d ans=%s  %s" % (r["n"], r["answer"], r["stem"]))
    print("\nFLAGGED (need human/LLM): %d" % len(flagged))
    for r in flagged: print("  Q%-2d [%s]  %s" % (r["n"], ",".join(r["flags"]), r["stem"]))

asyncio.run(main())
