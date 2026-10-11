# Connectus — build, test, publish, roll back

Everything about changing the app. Read this before touching `index.html`.

## 1. What is live, and where

| Thing | Where it lives | Note |
|---|---|---|
| **The app** | `public.settings.library_html` (Supabase, project `vcsfjzlelpwditxdbaea`) | The **cloud is the update.** Every visitor's page self-updates on load when the cloud build is newer. |
| **The build number** | `public.settings.ui_version` | Must **equal** the `APP_BUILD` string inside `library_html`. |
| **The deck template** | `public.settings.deck_template` | Every deck renders from this. |
| **The published copy** | `index.html` + `terms.html`, `refund.html`, `privacy.html` + the PWA files (`manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`) | A **backup / first install**, and what the Netlify deploy serves. |
| **The source of truth for editing** | `src/library.html` in this repo | Identical to `library_html`. Start every change from here. |

**Never deploy to update the app.** Publishing the two settings rows is the update. A production Netlify deploy costs ~15 of 300 free monthly credits and is only for the one-off deploy. **The deploy must carry all nine files together** — a lone `index.html` breaks the policy links, and without `manifest.webmanifest` + `sw.js` + the icons the app cannot be installed or open offline.

**The PWA only activates at a deploy.** The cloud self-update can swap the page's *DOM*, but it cannot put new *files* on the origin — and a service worker must be a same-origin file. So until the deploy runs, the manifest and worker 404 quietly and the app behaves exactly as before (no breakage — the registration is wrapped and the manifest is a progressive enhancement).

## 2. The loop

```
1. restore   src/library.html  (or the current library_html)  ->  work
2. edit      one change at a time
3. test      node tests/regression.js <your-app.html>       ->  17 checks, all PASS
4. bump      APP_BUILD + BUILD_NOTE + a CHANGELOG entry (same file)
5. publish   library_html + ui_version  (the SQL in §5)
6. sync      push index.html to the repo  (keeps the backup current)
```

**Step 3 is not optional.** A change that has not been through the suite does not ship.

## 3. The build number

On **every** change — UI, feature, bug, template:

- `APP_BUILD` inside `library_html` and `ui_version` → the same **new** value, `YYYY-MM-DD HH:MM` (IST).
- `BUILD_NOTE` → one line describing what changed.
- A new entry **prepended** to the `CHANGELOG` array (`{build, title, items}`).

The library shows its own build (a header chip and the ☰ menu), and a `✓ Updated to build <X>` toast appears when a viewer's page moves to a newer build — that is how the update is confirmed on screen.

`ui_version` must never be *ahead* of the file's own `APP_BUILD`; the self-update compares the two and rejects a mismatch.

## 4. Running the regression suite

```
node tests/regression.js src/library.html
```

18 checks. Needs `puppeteer-core` and a Chromium on the box (`CHROME=/path/to/chromium` to override).

It boots the app headlessly against a **synthetic fixture** (`tests/fixtures.json` — 4 subjects, 500 labelled MCQs; regenerate with `python3 tests/gen_fixture.py`) and checks the things that have actually broken before:

1. the embedded script parses
2. the app boots with zero page errors
3. the Real Exam Grand Test exists
4. NEET-PG = 200 Q in 5 sections of 40, 42 min each
5. the paper is spread across every deck
6. the tag mix lands within 8 points of the exam target
7. the image share lands within 8 points
8. NEET-PG marking (+4 / −1) → 3 / 800 for one right + one wrong
9. the review screen carries the question palette
10. the same seed rebuilds the identical paper
11. a new paper avoids the previous one where the library allows
12. INI-CET = 200 Q in 4 sections of 50, +1 / −⅓ → 0.67 / 200
13. RUHS-MO = 100 Q, no sections, +1 no negative → 1 / 100
14. the error log opens with a palette, holding only wrong + marked
15. a **deleted** card is kept out of the test pool — i.e. the library really did read per-card state back from the cloud (this is the check that would have caught the missing `card_id` in the deck_state pull)

Exit code is non-zero on any FAIL.

**Fixture trap worth knowing:** the app only takes the *owner* path — and therefore only reads `/rest/v1/decks` — when a `title` row comes back for the signed-in user. Without it the app falls to the guest catalogue, the pool is empty, and no paper can start. The fixture carries `{"key":"title","value":"Connectus"}` for exactly this reason.

## 5. Publishing (SQL)

Dollar-quote the file text (`$fd$…$fd$`) and copy it **verbatim**.

```sql
-- keep the previous build so a bad publish can be undone (see §6)
insert into public.settings (user_id, key, value, updated_at)
select id, 'library_html_prev', value, now() from public.settings
 where key = 'library_html' and user_id = (select id from auth.users where email='life.rknain@gmail.com')
on conflict (user_id, key) do update set value = excluded.value, updated_at = now();

insert into public.settings (user_id, key, value, updated_at)
select id, 'library_html', $fd$<file contents>$fd$, now()
  from auth.users where email = 'life.rknain@gmail.com'
on conflict (user_id, key) do update set value = excluded.value, updated_at = now();

insert into public.settings (user_id, key, value, updated_at)
select id, 'ui_version', '<YYYY-MM-DD HH:MM>', now()
  from auth.users where email = 'life.rknain@gmail.com'
on conflict (user_id, key) do update set value = excluded.value, updated_at = now();
```

## 6. Rolling back

`library_html_prev` always holds the build that was live before the last publish. To undo:

```sql
insert into public.settings (user_id, key, value, updated_at)
select id, 'library_html', value, now() from public.settings
 where key = 'library_html_prev' and user_id = (select id from auth.users where email='life.rknain@gmail.com')
on conflict (user_id, key) do update set value = excluded.value, updated_at = now();

insert into public.settings (user_id, key, value, updated_at)
select id, 'ui_version',
       substring(value from 'APP_BUILD = ''([^'']+)'), now()
  from public.settings
 where key = 'library_html' and user_id = (select id from auth.users where email='life.rknain@gmail.com')
on conflict (user_id, key) do update set value = excluded.value, updated_at = now();
```

Then tell the user to reload. A rollback is a publish — it always moves **forward** to a known-good build, so the self-update carries it to every device.

## 7. Hard rules

- **Never** change a deck's file name (it is the deck's sync key), the sync code, or the Supabase URL/key.
- **Never** add a public/anon RLS policy. Guest and customer content comes only from the `medcircuit` edge function.
- **Never** put an API key, token or secret in the app, a settings row, a file, or chat.
- A card's `id` is its progress key — never renumber or delete-and-recreate a card.
- Only `select`/`insert`/`update` on `public.decks`, `public.subjects`, `public.settings`. Never `delete`/`drop`/`alter`/`truncate`, and never touch `auth` or `deck_state`.
