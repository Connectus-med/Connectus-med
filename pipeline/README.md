# Content pipeline (Flashcard Daily)

Scripts that turn a source qbank (already extracted into the knowledge base) into
Connectus MCQ flashcard decks, and file them into Supabase safely.

- `qbank_parse.py`  - low-level parsing helpers (question / option splitting).
- `qbank_build.py`  - the Pediatrics qbank builder (per-topic folders).
- `psm_build.py`    - the Community Medicine (PSM) qbank builder (one combined doc, chapter-aware).
- `med_build.py`    - the General Medicine qbank builder (Medicine Qbank Ed8, 104 chapters,
                      answer keys parsed from the per-chapter answer-key tables).
- `refile.py`       - safe re-file: diff-guard -> atomic write -> verify, so a card's `id`
                      (its progress key in `deck_state.card_id`) is never lost or renumbered.

Card schema written to `public.decks.cards`:
`{id, type:"mcq", q, options[], answer (0-based), explain, src, tag}` — plus `gen:true`
when the card was AI-regenerated from its explanation because the source statements were missing.

Run from a sandbox that has the KB tools and Supabase access.
