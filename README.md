# Connectus

A medical study app for NEET-PG / INI-CET / RUHS-MO aspirants — flashcards plus a real-exam MCQ engine.

**Live:** https://connectus-med.netlify.app

## What is in here

| Path | What it is |
|---|---|
| `src/library.html` | **The app's source of truth.** Identical to the live `library_html` settings row. Edit this. |
| `index.html` | The last published build — the file the Netlify site serves. Kept in sync with `src/library.html` on every publish. |
| `terms.html` · `refund.html` · `privacy.html` | The policy pages the app links to. **Deploy all four together** — a lone `index.html` leaves dead links. |
| `tests/` | The regression suite + its synthetic fixture. |
| `functions/medcircuit/index.ts` | The backend edge function (public link, catalogue, deck content, payments). Deployed from here. |
| `docs/BUILD.md` | The build / test / publish / rollback loop, and the backend deploy rules. **Read this before changing anything.** |

## The app in one paragraph

One self-contained HTML file. It renders every deck from the `deck_template` settings row, so a UI change reaches decks that already exist without rebuilding them. Progress, ratings, edits and deletions sync across a signed-in user's devices through Supabase. Guest and customer content is served only by the `medcircuit` edge function — the tables are never opened to the public.

The **Real Exam Grand Test** builds a paper to a chosen exam's real pattern:

| Exam | Paper | Sections | Marking |
|---|---|---|---|
| NEET-PG | 200 Q · 3 h 30 min | 5 × 40, 42 min each | +4 / −1 |
| INI-CET | 200 Q · 3 h | 4 × 50, 45 min each | +1 / −⅓ |
| RUHS-MO | 100 Q · 2 h | one paper | +1, no negative |

Each paper aims at the exam's subject, tag, difficulty and image mix; it is reproducible from a seed; and it avoids the questions used in the last five papers.

## Changing the app

```
node tests/regression.js src/library.html      # must be 17/17 PASS
```

Then bump the build and publish — full instructions in `docs/BUILD.md`.
