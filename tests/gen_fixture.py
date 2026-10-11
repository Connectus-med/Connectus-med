#!/usr/bin/env python3
"""Build the compact, deterministic fixture the regression suite runs against.
4 subjects, 500 MCQs, every card labelled (tag / diff / img) so the paper
builder's mix targets can actually be exercised. No real content, no real ids."""
import json, os

TAGS = ["Basics&Fundamentals", "MainConcepts", "Integrated&Complex"]
SUBJECTS = [("General Medicine", 6, 40), ("General Surgery", 3, 40),
            ("Community Medicine", 2, 40), ("Pediatrics", 2, 30)]

def cards_for(key, subj, n):
    out = []
    for j in range(n):
        m = j % 20
        tag = TAGS[0] if m < 2 else (TAGS[1] if m < 7 else TAGS[2])   # 10 / 25 / 65
        d = j % 10
        diff = "easy" if d < 4 else ("mod" if d < 8 else "hard")      # 40 / 40 / 20
        c = {"id": "%s_q%d" % (key, j + 1), "type": "mcq",
             "q": "[%s] fixture question %d?" % (subj, j + 1),
             "options": ["Option A", "Option B", "Option C", "Option D"],
             "answer": j % 4, "explain": "fixture.", "src": "fixture p1",
             "tag": tag, "diff": diff, "qt": "sba"}
        if j % 3 == 0:
            c["img"] = "x"
        out.append(c)
    return out

def main():
    decks = []
    for subj, nd, per in SUBJECTS:
        for i in range(nd):
            key = "%s_%d" % ("".join(w[0] for w in subj.split()), i)
            decks.append({"deck_key": key, "topic": "%s set %d" % (subj, i + 1),
                          "subject": subj, "unit": "Fixture Unit", "category": "Fixture Cat",
                          "set_no": 1, "filed": True, "cards": cards_for(key, subj, per)})
    # the app treats the signed-in user as the OWNER only when a `title`
    # settings row comes back for them — without it it takes the guest path and
    # never reads /rest/v1/decks, so the pool is empty and no paper can start.
    fx = {"uid": "00000000-0000-0000-0000-000000000000",
          "subjects": [], "settings": [{"key": "title", "value": "Connectus"}],
          "decks": decks}
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "fixtures.json"), "w", encoding="utf-8") as f:
        json.dump(fx, f, ensure_ascii=False)
    n = sum(len(d["cards"]) for d in decks)
    print("fixtures.json: %d decks, %d questions" % (len(decks), n))

if __name__ == "__main__":
    main()
