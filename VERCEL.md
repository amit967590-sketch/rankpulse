# Deploy RankPulse on Vercel (free)

> **Live now:** <https://rankpulse-teal.vercel.app> — production deployment on the `amit-aa60` team (project `rankpulse`). Verify with <https://rankpulse-teal.vercel.app/api/health>.
>
> Production scrapes DuckDuckGo's HTML endpoint directly. No scraping provider or API key is used; the only optional variables are page caps and rate limits.

The Express app was split into Vercel-compatible pieces:

- **Static frontend** → served from `public/` (no build step)
- **API** → `/api/check-rank` and `/api/health` as Node.js Serverless Functions
- **Shared logic** → `lib/` (validation, CORS, rate limiting, time budget)
- **Scraper** → `utils/scraperHelper.js` (direct DuckDuckGo HTML scraping)

`server.js` is untouched and still runs the old Express app locally with `npm start`.

---

## 1. What changed

| File | Purpose |
| --- | --- |
| `api/check-rank.js` | `POST /api/check-rank` Serverless Function entry point. |
| `api/health.js` | `GET /api/health` — verifies runtime + env vars without leaking keys. |
| `lib/rankHandler.js` | Validation, rate limiting, scraper call, error/status mapping. |
| `lib/healthHandler.js` | Health payload. |
| `lib/config.js` | Reads env vars once per cold start (page caps, time budget, etc.). |
| `lib/http.js` | JSON responses, CORS, safe body parsing. |
| `lib/rateLimit.js` | Best-effort per-IP limiter (serverless instances are ephemeral). |
| `vercel.json` | Routing, function durations, security headers, `/health` alias. |
| `.vercelignore` | Keeps deployment uploads small. |
| `public/app.js` | One small addition: a friendly message for HTTP 504 / `REQUEST_TIMEOUT`. |

Nothing was deleted. The Cloudflare docs (`DEPLOY_CLOUDFLARE.md`, `wrangler.jsonc`, `deploy.ps1`) are ignored by Vercel.

---

## 2. How Vercel routes this project

```
https://your-project.vercel.app/
  ├── /                  → public/index.html          (static, CDN)
  ├── /styles.css        → public/styles.css          (static, CDN)
  ├── /app.js            → public/app.js              (static, CDN)
  ├── /og-image.png      → public/og-image.png        (static, CDN)
  ├── /api/check-rank    → api/check-rank.js          (function, POST)
  ├── /api/health        → api/health.js              (function, GET)
  └── /health            → rewrite → /api/health
```

`vercel.json` sets `"outputDirectory": "public"` and `"framework": null` (the "Other" preset), so the static site is served exactly as it is in `public/`. There is **no build command** — `package.json` has none, so Vercel only installs dependencies and uploads the files.

### API contract (unchanged)

```json
POST /api/check-rank
{ "domain": "example.com", "keyword": "example keyword" }
```

Success returns the same fields the frontend already reads: `success`, `found`, `position`, `page`, `url`, `title`, `snippet`, `resultsScanned`, `scannedResults`, `pagesChecked`, `checkedAt`.

### Frontend configuration

No API URL change was needed. `public/app.js` calls the **relative** path `/api/check-rank`, which resolves correctly on:

- `https://your-project.vercel.app` (production)
- preview deployment URLs
- `http://localhost:3000` with `vercel dev`
- `http://localhost:3000` with `npm start` (Express)

That is why there is no `API_BASE_URL` constant to maintain. Same-origin also means no CORS setup is required.

---

## 3. Environment variables

`.env` is gitignored, so a Git deployment will **not** receive local secrets. Add them in **Vercel → Project → Settings → Environment Variables** (or with `vercel env add`).

| Variable | Code default | Required on Vercel? |
| --- | --- | --- |
| `MAX_RESULT_PAGES` | `10` | No. 10 pages ≈ 100 organic results. Hard cap 10. |
| `TARGET_ORGANIC_RESULTS` | `100` | No. Stop after this many organic links. Cap 100. |
| `SCRAPER_RETRIES` | `1` | No. Retries per page after a transient block; `0`–`2`. |
| `API_TIME_BUDGET_MS` | `280000` | No. Internal deadline; must stay below `maxDuration` (300s). |
| `REQUEST_TIMEOUT_MS` | `15000` | No. Per-request timeout for direct DuckDuckGo scrapes. |
| `REQUEST_DELAY_MS` | `1200` | No. Delay between SERP pages. |
| `DDG_PROXY_FALLBACK` | `true` | No. Retry blocked direct requests through the free Jina Reader proxy. No API key required. |
| `ALLOWED_ORIGINS` | empty = allow all | No. Comma-separated list if you want to lock the API to specific domains. |
| `RATE_LIMIT_WINDOW_MS` | `900000` | No. 15 minutes. |
| `RATE_LIMIT_MAX` | `60` | No. Requests per IP per window. |

Do **not** add `PORT` or `NODE_ENV`; Vercel manages both. No scraping API key is required.

Copy-paste for the CLI (run once per variable, only if you want to override a default):

```powershell
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest env add MAX_RESULT_PAGES production
```

---

## 4. Deploy with Git (recommended, auto-deploys)

### 4.1 Push the project to GitHub

The repo remote is already `https://github.com/amit967590-sketch/rankpulse.git`.

```powershell
cd E:\Project_software\Keywords_checker
& 'C:\Program Files\Git\cmd\git.exe' add -A
& 'C:\Program Files\Git\cmd\git.exe' commit -m "Add Vercel serverless API and routing"
& 'C:\Program Files\Git\cmd\git.exe' push origin main
```

> `.env` is gitignored — do not force-add it. Keys go into Vercel settings instead.

### 4.2 Import the repo on Vercel

1. Go to <https://vercel.com/new> and sign in with GitHub (free Hobby plan).
2. **Import Git Repository** → choose `rankpulse`.
3. Configure the project:
   - **Framework Preset:** `Other`
   - **Root Directory:** `./` (repo root)
   - **Build Command:** leave empty
   - **Output Directory:** `public`
   - **Install Command:** leave default
4. Open **Environment Variables** only if you want to override defaults. No scraping API key is needed.
5. Click **Deploy**.
6. You get `https://<project>.vercel.app`.

`vercel.json` already contains these settings, so the dashboard fields are just a visual confirmation.

From now on, every `git push` to `main` creates a production deployment, and pushes to other branches create preview URLs.

> Hobby limitation: Vercel Hobby cannot connect Git repos owned by a GitHub **organization**; use a personal repo/account.

---

## 5. Deploy with the Vercel CLI

Node is not on `PATH` on this machine, so use the full path to `npx`.

### 5.1 Log in (one time)

```powershell
cd E:\Project_software\Keywords_checker
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest login
```

The browser opens; approve the CLI.

### 5.2 Link and deploy

```powershell
# Preview deployment (creates/links the project on first run)
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest

# Production deployment
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest --prod
```

First run asks a few questions:

| Prompt | Answer |
| --- | --- |
| Set up and deploy? | `Y` |
| Which scope? | your personal account |
| Link to existing project? | `N` (first run) |
| Project name? | `rankpulse` |
| Directory? | `./` |
| Override settings? | `N` — `vercel.json` already has them |

### 5.3 Optional environment variables, then redeploy

Environment variables are read at deploy time; after changing one, deploy again.

```powershell
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest env add MAX_RESULT_PAGES production
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest --prod
```

Useful commands:

```powershell
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest env list
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest logs <deployment-url>
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest inspect <deployment-url> --json
```

---

## 6. Verify the deployment

### 6.1 Health endpoint

Open `https://<project>.vercel.app/api/health` (or `/health`). Expected:

```json
{
  "status": "ok",
  "runtime": "vercel",
  "engine": "duckduckgo",
  "maxPages": 10,
  "targetResults": 100,
  "retries": 1,
  "proxyFallback": true,
  "timeBudgetMs": 280000,
  "region": "iad1"
}
```

`engine: "duckduckgo"` confirms the free direct scraper is deployed. `proxyFallback: true` means blocked direct requests are retried through Jina Reader.

### 6.2 A real check

```powershell
Invoke-RestMethod -Method Post `
  -Uri "https://<project>.vercel.app/api/check-rank" `
  -ContentType "application/json" `
  -Body '{"domain":"example.com","keyword":"example"}' `
  -TimeoutSec 180 | ConvertTo-Json
```

### 6.3 Frontend

Open the site, submit a domain and keyword. The result card should appear. Then check **Vercel → Project → Logs** for `[check-rank]` lines if something fails.

---

## 7. Local development

Run the exact production setup (static + functions) locally:

```powershell
cd E:\Project_software\Keywords_checker
& 'C:\Program Files\nodejs\npx.cmd' vercel@latest dev
```

`vercel dev` serves `public/` and `api/` at <http://localhost:3000>, and picks up values from your linked project's env vars. You can also keep `.env` locally — it is read by `vercel dev`.

The old Express server still works:

```powershell
npm start   # http://localhost:3000
```

Both paths use the same URL (`/api/check-rank`), so the frontend needs no switching.

---

## 8. Free plan notes

Vercel Hobby is free and does not require a card for this setup:

| Item | Hobby limit |
| --- | --- |
| Function max duration | 300s (this project sets 300s) |
| Function memory | 2 GB / 1 vCPU |
| Deployments per day | 100 |
| Static requests | Served from the CDN within the Hobby allowance |
| Cost | $0 |

Each rank check is **one function invocation**. DuckDuckGo's HTML endpoint is free, and each scan requests up to `MAX_RESULT_PAGES` pages. A 10-page scan stops as soon as 100 organic links are read or the time budget runs out, so requests are not spent on pages that can no longer change the result.

Vercel's datacenter IPs are sometimes blocked by DuckDuckGo outright. With `DDG_PROXY_FALLBACK=true` (the default) the scraper retries a blocked request through the free [Jina Reader](https://r.jina.ai/) service, which returns the same DuckDuckGo HTML from its own IPs. It needs no API key and is used only after a direct request fails; the rest of that scan then stays on the proxy.

`maxDuration` is 300s in `vercel.json`. The handler aborts itself at `API_TIME_BUDGET_MS` (280s) and the scraper stops paging 45s earlier, returning partial results (with `pagesChecked`/`resultsScanned`) instead of hitting a platform timeout.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `404` on `/api/check-rank` | `api/` folder was not deployed, or the project root is wrong. Confirm the deployment's **Functions** tab lists `api/check-rank`. |
| `503 CHALLENGE` / "bot challenge" | DuckDuckGo blocked the function's IP and the proxy fallback also failed. Confirm `DDG_PROXY_FALLBACK` is not set to `false`, wait a minute, and retry. Lower `MAX_RESULT_PAGES` if it happens often. |
| `504 REQUEST_TIMEOUT` | Scan exceeded the time budget. Lower `MAX_RESULT_PAGES` or `TARGET_ORGANIC_RESULTS`, or raise `maxDuration` and `API_TIME_BUDGET_MS` together. |
| `403 ORIGIN_NOT_ALLOWED` | `ALLOWED_ORIGINS` is set and does not include the site's domain. Add it or clear the variable. |
| `429 RATE_LIMITED` | Hit `RATE_LIMIT_MAX` from one IP. Raise it or wait for the window to reset. |
| Blank page / 404 on assets | Output directory is wrong. It must be `public` (set in `vercel.json`). |
| Build error "No Output Directory named public" | The `public` folder is missing from the repo or excluded by `.vercelignore`. |
| Env change has no effect | Vercel snapshots env vars per deployment — always redeploy. |

---

## 10. Optional next steps

- **Custom domain:** Vercel → Project → Settings → Domains → add `rankpulse.yourdomain.com` and point the `CNAME` (or the domain's nameservers) as shown.
- **Better Open Graph previews:** `public/index.html` uses `og:image` = `/og-image.png`. Social platforms prefer an absolute URL, so after you have a domain, change it to `https://your-domain/og-image.png`.
- **Shared rate limiting:** the current limiter is per-instance. For strict global limits, back it with Upstash Redis (free tier) inside `lib/rateLimit.js`.
- **Never** put secrets in `public/app.js`; the current scraper needs no API key at all.
