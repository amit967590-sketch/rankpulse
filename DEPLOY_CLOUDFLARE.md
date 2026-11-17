# Deploy RankPulse to Cloudflare Pages (free)

> Looking for a deployment where the rank-check form actually works? Use Vercel instead — see [`VERCEL.md`](VERCEL.md). Cloudflare Pages below is **static-only**.

This repo is already production-ready as **static files**. Everything Cloudflare Pages needs is inside `public/`:

```
public/
  index.html
  styles.css
  app.js
  og-image.png
```

There is **no build step**. `public/` is uploaded as-is, and `index.html` must sit at the **root** of the upload.

---

## READ THIS FIRST — what will and will not work

Cloudflare Pages serves **static files only**. It does not run `server.js` (Express), so:

| Feature | Works on Pages? |
| --- | --- |
| Homepage, styling, SEO tags, OG image | Yes |
| Form validation, loading states, UI animation | Yes |
| Actual rank check (`POST /api/check-rank`) | **No** |

`public/app.js` (line 395) calls the relative endpoint `/api/check-rank`. On Pages that URL returns 404, so the form will show an error.

You have three options:

1. **UI-only deploy now** — deploy the site, form will fail until you add a backend.
2. **Host `server.js` elsewhere** (Render, Railway, Fly.io, a VPS) and change the frontend to call that URL.
3. **Add a Pages Function** at `/api/check-rank` that proxies to your hosted backend (needed if you want everything on the same domain).

Option 2 or 3 is required for a working rank checker. Ask before editing `public/app.js`.

---

## Files added for deployment

| File | Purpose |
| --- | --- |
| `wrangler.jsonc` | Tells Wrangler that the Pages output directory is `./public`. |
| `deploy.ps1` | One-command deploy, or `-Zip` to build the dashboard upload archive. |
| `.gitignore` | Now ignores `.wrangler/` (local Wrangler cache) and `rankpulse-site.zip`. |

> **PowerShell script blocked?** This machine's execution policy disables `.ps1` files. Run it like this instead:
>
> ```powershell
> powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1
> ```
>
> Or skip the script entirely and use the raw commands shown in each method.

Project name used everywhere below: **`rankpulse`** (change it to anything unique).

---

## Method A — Cloudflare Dashboard (no Git, no terminal)

Free plan, no card required.

### 1. Zip the contents of `public/`

The zip must contain `index.html` at the top level, **not** a `public/` folder inside it.

PowerShell:

```powershell
cd E:\Project_software\Keywords_checker
Compress-Archive -Path .\public\* -DestinationPath .\rankpulse-site.zip -Force
```

Or use the bundled script (same result):

```powershell
cd E:\Project_software\Keywords_checker
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1 -Zip
```

Correct structure inside the zip:

```
index.html
styles.css
app.js
og-image.png
```

Wrong structure (site will not load):

```
public/index.html
```

### 2. Create the Pages project

1. Go to <https://dash.cloudflare.com> and sign in (create a free account if needed).
2. Left sidebar: **Workers & Pages**.
3. Click **Create** (or **Create application**).
4. Open the **Pages** tab.
5. Click **Upload assets**.

### 3. Upload

1. Project name: `rankpulse` (this becomes `rankpulse.pages.dev`).
2. Click **Create project**.
3. Drag `rankpulse-site.zip` into the upload box, or click to browse and select it.
4. Wait for the file list to appear and confirm you see `index.html`, `styles.css`, `app.js`, `og-image.png`.
5. Click **Deploy site**.

### 4. Open your site

After ~30 seconds you get a URL like:

```
https://rankpulse.pages.dev
```

Open it, hard-refresh with `Ctrl + F5` if you see an old version.

### 5. Update the site later

Dashboard upload flow has no auto-update. To publish changes:

1. Rebuild the zip with the same `Compress-Archive` command above.
2. Go to **Workers & Pages** → `rankpulse` → **Deployments** tab.
3. Click **Create new deployment** → **Upload assets**.
4. Upload the new zip → **Deploy**.

---

## Method B — Wrangler CLI (terminal, faster updates)

Node is not on your `PATH`, so use the full path to `npx`.

### 1. First-time login (one time only)

```powershell
cd E:\Project_software\Keywords_checker
& 'C:\Program Files\nodejs\npx.cmd' wrangler@latest login
```

A browser window opens. Click **Allow**. Wrangler stores the token locally.

Alternatives if the browser flow fails:

- Create an API token at **My Profile → API Tokens → Create Token → Edit Cloudflare Workers** template.
- Then in PowerShell: `$env:CLOUDFLARE_API_TOKEN = "your-token-here"`

### 2. Deploy

`wrangler.jsonc` already points at `./public`, so this is enough:

```powershell
npx wrangler@latest pages deploy
```

Or use the bundled script, which also handles the full path to `npx`:

```powershell
cd E:\Project_software\Keywords_checker
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy.ps1
```

Fully-qualified version if `npx` is not on `PATH`:

```powershell
& 'C:\Program Files\nodejs\npx.cmd' wrangler@latest pages deploy
```

Explicit equivalent (works even without `wrangler.jsonc`):

```powershell
& 'C:\Program Files\nodejs\npx.cmd' wrangler@latest pages deploy public --project-name rankpulse --branch main
```

First run asks to create the project — accept the default. Output ends with your live URL:

```
Deployment complete! Take a peek over at https://<hash>.rankpulse.pages.dev
```

### 3. Update after code changes

Run the same deploy command again. Every run creates a new deployment; the production alias keeps pointing at the `main` branch deploy.

### 4. Preview deploys (optional)

```powershell
& 'C:\Program Files\nodejs\npx.cmd' wrangler@latest pages deploy public --project-name rankpulse --branch preview
```

That gives a separate preview URL without touching production.

### 5. List and inspect

```powershell
& 'C:\Program Files\nodejs\npx.cmd' wrangler@latest pages project list
& 'C:\Program Files\nodejs\npx.cmd' wrangler@latest deployments list
```

---

## Custom domain (optional, free)

1. **Workers & Pages** → `rankpulse` → **Custom domains** tab.
2. **Set up a custom domain**.
3. Enter e.g. `rankpulse.yourdomain.com`.
4. If the domain's DNS is already on Cloudflare, the `CNAME` record is created automatically.
5. If DNS is elsewhere, add the `CNAME` record Cloudflare shows you at your registrar/DNS host.
6. HTTPS certificate is issued automatically (usually under a minute).

Apex domains (`yourdomain.com`) work too, but moving the domain's nameservers to Cloudflare is the easiest path.

---

## Free plan limits (more than enough here)

| Limit | Free tier |
| --- | --- |
| Static requests | Unlimited |
| Bandwidth | Unlimited |
| Deployments | 500 per month |
| Custom domains per project | 100 |
| Build minutes | 500 per month (irrelevant — no build) |
| Cost | $0 |

`*.pages.dev` subdomain and HTTPS included.

---

## Verify the deploy

After deploying, check:

1. <https://rankpulse.pages.dev> loads the homepage.
2. `Ctrl + U` → view source → `<title>` and meta description are present.
3. <https://rankpulse.pages.dev/styles.css> returns the CSS (not 404).
4. `https://rankpulse.pages.dev/app.js` returns the JS (not 404).
5. DevTools → Console: no 404s for `styles.css`, `app.js`, `og-image.png`.

The rank-check form will still fail with a 404 on `/api/check-rank` — that is expected until a backend is connected.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Blank page, 404 on everything | Zip contained the `public/` folder. Re-zip the **contents**: `Compress-Archive -Path .\public\* ...` |
| CSS/JS missing | Files were not in the upload list. Re-upload all four files. |
| `wrangler` not recognized | Use the full path: `& 'C:\Program Files\nodejs\npx.cmd' wrangler@latest ...` |
| `Authentication error` | Run `wrangler login` again, or set `$env:CLOUDFLARE_API_TOKEN`. |
| Stale content after deploy | `Ctrl + F5`; check the **Deployments** tab to confirm the new deployment is the production one. |
| Form shows "Request failed with status 404" | Expected: no backend on Pages. See options at the top of this file. |

---

## Optional: nicer caching (only if you want it)

Create `public/_headers` **before** deploying:

```
/_next/static/*
  Cache-Control: public, max-age=31536000, immutable

/*.css
  Cache-Control: public, max-age=3600

/*.js
  Cache-Control: public, max-age=3600

/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: SAMEORIGIN
```

Pages reads this file automatically; it is not served to visitors. Keep the max-age values low until the design is final, otherwise visitors keep old CSS/JS.
