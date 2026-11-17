# RankPulse — Free Keyword Rank Checker & SEO Rank Tracker

A small Node.js/Express app that checks where a domain ranks in Google search results, with an automatic DuckDuckGo fallback. It scrapes the public HTML SERP directly — no paid API keys, no accounts, no database.

## Features

- **Google-first rank checks** against live Google organic results
- **Automatic DuckDuckGo fallback** when Google serves a captcha, consent page, or is unavailable
- **Deep SERP scans** — 5 pages by default (~50 organic results), configurable up to 10 pages (~100 results), so lower-ranking domains are still found
- **Position and page** for the matched result (or a clear “not found” state with scan counts)
- **Smart request handling** — randomized browser headers, user-agent rotation, and jittered pacing
- **Polished dark UI** with responsive layouts, loading states, result cards, and error toasts
- **On-page SEO** — keyword-focused title/description, Open Graph and Twitter cards, JSON-LD, and semantic heading structure
- **Rate limiting** on the API surface and validation on every request

## Getting started

Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env   # Windows: copy .env.example .env
npm start
```

Open <http://localhost:3000>.

For development with automatic restarts:

```bash
npm run dev
```

## API

### `POST /api/check-rank`

```json
{ "domain": "expressjs.com", "keyword": "express framework" }
```

Successful response:

```json
{
  "success": true,
  "found": true,
  "domain": "expressjs.com",
  "keyword": "express framework",
  "engine": "google",
  "position": 7,
  "page": 1,
  "url": "https://expressjs.com/",
  "title": "Express.js · Node.js web application framework",
  "snippet": "Fast, unopinionated, minimalist web framework for Node.js",
  "resultsScanned": 30,
  "scannedResults": 30,
  "pagesChecked": 3,
  "checkedAt": "2026-11-04T09:03:00.000Z",
  "message": null,
  "fallback": false
}
```

When the domain is not found, the endpoint still returns `200` with a clear message and the real scan counts:

```json
{
  "success": true,
  "found": false,
  "engine": "google",
  "position": null,
  "resultsScanned": 50,
  "pagesChecked": 5,
  "message": "No match found for \"example.com\" after scanning 50 organic results across 5 pages on Google."
}
```

`resultsScanned` is the number of organic results actually parsed. `pagesChecked` is the number of SERP pages actually fetched. `scannedResults` is retained as a backwards-compatible alias.

Error responses use a stable shape:

```json
{ "success": false, "code": "CHALLENGE", "error": "Google and DuckDuckGo could not return organic results right now (captcha, consent, or a JavaScript-only response). Wait about a minute, then try again." }
```

| Status | Code                   | Meaning                                           |
| ------ | ---------------------- | ------------------------------------------------- |
| 400    | `VALIDATION_ERROR`     | `domain` or `keyword` is missing                  |
| 400    | `INVALID_DOMAIN`       | The domain could not be parsed                    |
| 429    | —                      | Rate limit exceeded                               |
| 502    | `HTTP_ERROR`           | The search provider returned an unexpected status |
| 502    | `REQUEST_FAILED`       | The search request failed (network/timeout)       |
| 502    | `EMPTY_RESULTS`        | No organic results could be parsed                |
| 502    | `INSUFFICIENT_RESULTS` | The provider stopped before a full scan           |
| 503    | `CHALLENGE`            | A search engine served a captcha/challenge page   |
| 503    | `BLOCKED`              | The search provider is rate-limiting requests     |
| 503    | `CONSENT`              | Google served a consent page instead of results   |
| 500    | `INTERNAL_ERROR`       | Unexpected server error                           |

### `GET /health` and `GET /api/health`

Return service status, version, timestamp, and uptime.

## Configuration

Settings live in `.env` (see `.env.example`):

| Variable             | Default  | Purpose                                             |
| -------------------- | -------- | --------------------------------------------------- |
| `PORT`               | `3000`   | HTTP port                                           |
| `ALLOWED_ORIGINS`    | empty    | Comma-separated CORS allow-list (empty = any)       |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window in milliseconds                 |
| `RATE_LIMIT_MAX`     | `100`    | Requests allowed per window per IP                  |
| `SEARCH_ENGINE`      | `google` | Primary engine: `google` or `duckduckgo`            |
| `DUCKDUCKGO_FALLBACK`| `true`   | Fall back to DDG when Google is blocked/unavailable |
| `MAX_RESULT_PAGES`   | `10`     | Pages to scan (10 ≈ 100 results, max 10)            |
| `REQUEST_DELAY_MS`   | `1000`   | Delay between pages (3s minimum via ScraperAPI)     |
| `REQUEST_TIMEOUT_MS` | `15000`  | Outbound request timeout                            |

## Project structure

```
server.js               Express app for local development and traditional hosts
api/check-rank.js       Vercel Function for POST /api/check-rank
api/health.js           Vercel Function for GET /api/health
lib/                    Shared serverless helpers (config, CORS, rate limit, handler)
utils/scraperHelper.js  Google/DuckDuckGo scraping, parsing, and matching
public/index.html       Frontend markup and SEO metadata
public/styles.css       Dark responsive design system
public/app.js           Form, fetch, result rendering, toasts
public/og-image.png     1200×630 social preview image
```

## Deployment notes

- **Vercel (free):** see [`VERCEL.md`](VERCEL.md). The API runs as Serverless Functions in `api/`, the UI is served from `public/`, and `vercel.json` handles routing. No build step is required; add `SCRAPER_API_KEY` in the Vercel dashboard.
- **Cloudflare Pages (static only):** see [`DEPLOY_CLOUDFLARE.md`](DEPLOY_CLOUDFLARE.md). Static hosting alone cannot run the rank-check API.
- Before deploying, replace the relative `og:image` and `twitter:image` paths with absolute production URLs (for example `https://your-domain.com/og-image.png`) so social crawlers can fetch the card reliably.
- Add the production domain to `ALLOWED_ORIGINS` if the API is called cross-origin.
- Serve the app over HTTPS, then add an absolute `<link rel="canonical">` once the production domain is known.

## Notes

- Google frequently serves captchas or consent pages to automated traffic. When that happens, the scraper automatically retries the same query on DuckDuckGo and returns `engine: "duckduckgo"` with `fallback: true`.
- If both providers are blocked, the API maps this to `503 CHALLENGE`; wait about a minute and retry.
- Rankings vary by region, personalization, and time. Results are a point-in-time snapshot.
- This project is not affiliated with Google or DuckDuckGo.

## License

MIT
