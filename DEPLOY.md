# Connectus — hosting

The app is served from the cloud (Supabase `settings.library_html` via the `medcircuit`
function). A host only has to serve a **tiny loader** that pulls the live build.

## Live entry points

| Where | URL | Notes |
|---|---|---|
| GitHub Pages | https://connectus-med.github.io/Connectus-med/ | free, HTTPS, no deploy limits |
| Cloudflare Pages | (set up after OAuth) | free, unlimited bandwidth, private repos OK |
| Supabase function | https://vcsfjzlelpwditxdbaea.supabase.co/functions/v1/medcircuit?api=loader | always current, no host needed |
| Netlify | https://connectus-med.netlify.app | legacy; credit-limited, can be dropped |

## Files

- `index.html` — the loader (the deployed entry point). ~3.8 KB. It fetches the live
  build and renders it, so the deployed page can never go stale. **Do not** put the
  full app here.
- `loader.html` — same file, kept for reference.
- `src/library.html` — the full app build (backup / first install).
- `terms.html`, `refund.html`, `privacy.html` — policy pages.

## Rules

1. The loader is version-agnostic — a deploy is only needed if the loader itself changes
   (rare). New app builds reach everyone through the cloud.
2. The app must never overwrite a same-or-newer cloud build (`publishSelf` guard).
3. `ui_version` in `settings` must equal the `APP_BUILD` inside `library_html`.
