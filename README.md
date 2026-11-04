# RankPulse — Free Keyword Rank Checker & SEO Rank Tracker

A small Node.js/Express app that checks where a domain ranks in DuckDuckGo search results. It scrapes the public HTML SERP directly — no paid API keys, no accounts, no database.

## Features

- **Free rank checks** against live DuckDuckGo results
- **Deep SERP scans** — checks up to 10 DuckDuckGo pages (~100 organic results) so lower-ranking domains are still found
- **Position and page** for the matched result (or a clear “not found” state)
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
  "position": 1,
  "page": 1,
  "url": "https://expressjs.com/",
  "title": "Express.js · Node.js web application framework",
  "snippet": "Fast, unopinionated, minimalist web framework for Node.js",
  "scannedResults": 10,
  "pagesChecked": 1,
  "checkedAt": "2026-11-04T09:03:00.000Z"
}
```

Error responses use a stable shape:

```json
{ "success": false, "code": "CHALLENGE", "error": "DuckDuckGo returned a verification challenge." }
```

| Status | Code               | Meaning                                        |
| ------ | ------------------ | ---------------------------------------------- |
| 400    | `VALIDATION_ERROR` | `domain` or `keyword` is missing               |
| 400    | `INVALID_DOMAIN`   | The domain could not be parsed                 |
| 429    | —                  | Rate limit exceeded                            |
| 502    | `HTTP_ERROR`       | DuckDuckGo returned an unexpected status       |
| 502    | `REQUEST_FAILED`   | The search request failed (network/timeout)    |
| 503    | `CHALLENGE`        | DuckDuckGo served a bot-verification page      |
| 503    | `BLOCKED`          | The search provider is rate-limiting requests  |
| 500    | `INTERNAL_ERROR`   | Unexpected server error                        |

### `GET /health` and `GET /api/health`

Return service status, version, timestamp, and uptime.

## Configuration

Settings live in `.env` (see `.env.example`):

| Variable             | Default | Purpose                                          |
| -------------------- | ------- | ------------------------------------------------ |
| `PORT`               | `3000`  | HTTP port                                        |
| `ALLOWED_ORIGINS`    | empty   | Comma-separated CORS allow-list (empty = any)    |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate-limit window in milliseconds             |
| `RATE_LIMIT_MAX`     | `100`   | Requests allowed per window per IP               |
| `MAX_RESULT_PAGES`   | `10`    | SERP pages to scan per check (~100 results)      |
| `REQUEST_DELAY_MS`   | `1000`  | Delay between paginated requests                 |
| `REQUEST_TIMEOUT_MS` | `15000` | Outbound request timeout                         |

## Project structure

```
server.js               Express app, API routes, static hosting
utils/scraperHelper.js  DuckDuckGo scraping, parsing, and matching
public/index.html       Frontend markup and SEO metadata
public/styles.css       Dark responsive design system
public/app.js           Form, fetch, result rendering, toasts
public/og-image.png     1200×630 social preview image
```

## Deployment notes

- Before deploying, replace the relative `og:image` and `twitter:image` paths with absolute production URLs (for example `https://your-domain.com/og-image.png`) so social crawlers can fetch the card reliably.
- Add the production domain to `ALLOWED_ORIGINS` if the API is called cross-origin.
- Serve the app over HTTPS, then add an absolute `<link rel="canonical">` once the production domain is known.

## Notes

- DuckDuckGo can occasionally serve a `202` verification challenge during rapid or repeated checks. The API maps this to `503 CHALLENGE`; wait about a minute and retry.
- Rankings vary by region, personalization, and time. Results are a point-in-time snapshot.
- This project is not affiliated with DuckDuckGo.

## License

MIT
