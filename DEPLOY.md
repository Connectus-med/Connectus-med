# Connectus — hosting

The app is served from the cloud (Supabase `settings.library_html` via the `medcircuit`
function). A host only has to serve a **tiny loader** that pulls the live build.

## Live entry points

| Where | URL | Notes |
|---|---|---|
| GitHub Pages | https://connectus-med.github.io/Connectus-med/ | live now; free, but its terms disallow commercial use |
| Supabase function | https://vcsfjzlelpwditxdbaea.supabase.co/functions/v1/medcircuit?api=loader | always current, needs no host at all |
| Cloudflare Pages | (set up in 5 min, see below) | **the final home** — free, commercial use allowed |
| Netlify | https://connectus-med.netlify.app | legacy; credit-limited, can be dropped |

## Files

- `index.html` — the loader (the deployed entry point). ~6 KB. It fetches the live
  build and renders it, so the deployed page can never go stale. **Do not** put the
  full app here.
- `loader.html` — same file, kept for reference.
- `src/library.html` — the full app build (backup / first install).
- `terms.html`, `refund.html`, `privacy.html` — policy pages.
- `_headers` — Cloudflare Pages caching rules (ignored by GitHub Pages, harmless).

## Cloudflare Pages — exact steps (free, no card, no API key)

You do this once, in your own browser. Nothing here costs anything.

1. Go to https://dash.cloudflare.com and sign up with your email + a password.
   **No payment details are needed for the Free plan.**
2. Workers & Pages -> Create -> Pages -> **Connect to Git** -> authorise GitHub ->
   pick `Connectus-med/Connectus-med`.
3. Build settings:
   - Framework preset: **None**
   - Build command: **(leave empty)**
   - Build output directory: **`/`**
4. Deploy. You get a `*.pages.dev` URL in about a minute.
5. (Optional) Custom domain -> add your domain -> HTTPS is issued automatically.

Why Cloudflare rather than GitHub Pages, once you start selling:
- GitHub Pages' terms **disallow commercial use**; Cloudflare's Free plan **allows** it.
- Cloudflare gives **unlimited bandwidth** and works with a **private repo** for free.
- One Cloudflare Free rule: do not collect card details on the page — our Razorpay
  checkout is hosted by Razorpay, so we are compliant.

## Rules

1. The loader is version-agnostic — a deploy is only needed if the loader itself changes
   (rare). New app builds reach everyone through the cloud.
2. The app must never overwrite a same-or-newer cloud build (`publishSelf` guard).
3. `ui_version` in `settings` must equal the `APP_BUILD` inside `library_html`.
4. CI runs the regression suite on every push (free on public repos).
