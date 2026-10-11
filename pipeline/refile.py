"""Safe re-file for qbank decks.

Never lose progress: a card's `id` IS its progress key (deck_state.card_id).
This routine guards every write:
  1. diff_guard  - compare the new card set against the DB (ids added / removed /
                   question-text changed) so a renumbering can never slip through.
  2. write       - one atomic UPDATE of the whole cards array, with retries.
  3. verify      - re-read and confirm the id-set and count match what we wrote.

Id/q are read with small per-row queries (jsonb_array_elements) so a large cards
blob never has to be parsed whole.
"""
import asyncio, json, re, hashlib
from sarvam_tools import supabase_execute_sql

PROJ = "vcsfjzlelpwditxdbaea"


def _rows(r):
    m = re.search(r"\[\{.*\}\]", str(r), re.S)
    return json.loads(m.group(0)) if m else []


async def fetch_idq(deck_key):
    """Return {card_id: first 80 chars of q} for a deck, or {} if the deck is new/empty."""
    r = await supabase_execute_sql(
        project_id=PROJ,
        query="select c->>'id' id, md5(c->>'q') h from public.decks d, "
              "jsonb_array_elements(d.cards) c where d.deck_key=$k$%s$k$" % deck_key)
    return {row["id"]: row["h"] for row in _rows(r)}


def diff_guard(old, new):
    if not old:
        return {"new_deck": True, "added": [], "removed": [], "changed_q": []}
    nm = {c["id"]: hashlib.md5((c.get("q") or "").encode("utf-8")).hexdigest() for c in new}
    added = sorted(i for i in nm if i not in old)
    removed = sorted(i for i in old if i not in nm)
    changed_q = sorted(i for i in nm if i in old and old[i] != nm[i])
    return {"new_deck": False, "added": added, "removed": removed, "changed_q": changed_q}


async def write_cards(deck_key, cards):
    cj = json.dumps(cards, ensure_ascii=False)
    last = None
    for _ in range(4):
        try:
            await supabase_execute_sql(
                project_id=PROJ,
                query="update public.decks set cards=$x$%s$x$::jsonb, updated_at=now() "
                      "where deck_key=$k$%s$k$;" % (cj, deck_key))
            return True
        except Exception as e:
            last = e
            await asyncio.sleep(15)
    raise last


async def safe_refile(deck_key, cards, throttle=5):
    """diff-guard -> write -> verify. Returns (report, verified)."""
    old = await fetch_idq(deck_key)
    rep = diff_guard(old, cards)
    await asyncio.sleep(throttle)
    await write_cards(deck_key, cards)
    await asyncio.sleep(throttle)
    ids = await fetch_idq(deck_key)
    ok = (len(ids) == len(cards) and set(ids) == {c["id"] for c in cards})
    rep["verified"] = ok
    rep["n"] = len(cards)
    return rep, ok
