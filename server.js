'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { checkKeywordRank, ScraperError } = require('./utils/scraperHelper');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Deep-scan configuration: each DuckDuckGo HTML page returns roughly 10
// organic results, so 10 pages covers approximately 100 positions.
const DEFAULT_MAX_RESULT_PAGES = 10;
const MAX_RESULT_PAGES_LIMIT = 10;
const configuredMaxResultPages = Number(process.env.MAX_RESULT_PAGES);
const MAX_RESULT_PAGES =
  Number.isFinite(configuredMaxResultPages) && configuredMaxResultPages > 0
    ? Math.min(Math.floor(configuredMaxResultPages), MAX_RESULT_PAGES_LIMIT)
    : DEFAULT_MAX_RESULT_PAGES;

// Trust the first proxy so client IPs (and rate limiting) work correctly
// when the app runs behind a reverse proxy such as nginx or a PaaS router.
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// CORS: allow all origins by default, or restrict to ALLOWED_ORIGINS.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve the single-page frontend from /public.
app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  })
);

// Rate limiting for the API surface. The health check stays unrestricted.
const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/api', apiLimiter);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check
const healthPayload = () => ({
  status: 'ok',
  service: 'SEO Keyword Rank Checker',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
  uptime: process.uptime(),
});

app.get('/health', (req, res) => {
  res.status(200).json(healthPayload());
});

app.get('/api/health', (req, res) => {
  res.status(200).json(healthPayload());
});

// Check a keyword's ranking for a domain
app.post('/api/check-rank', async (req, res) => {
  const domain =
    typeof req.body?.domain === 'string' ? req.body.domain.trim() : '';
  const keyword =
    typeof req.body?.keyword === 'string' ? req.body.keyword.trim() : '';

  if (!domain || !keyword) {
    const missing = [];
    if (!domain) missing.push('domain');
    if (!keyword) missing.push('keyword');

    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      error: `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(
        ', '
      )}.`,
    });
  }

  try {
    const result = await checkKeywordRank(domain, keyword, {
      maxPages: MAX_RESULT_PAGES,
    });

    return res.status(200).json({
      success: true,
      found: result.found,
      domain: result.domain,
      keyword: result.keyword,
      position: result.position,
      page: result.page,
      url: result.url,
      title: result.title,
      snippet: result.snippet,
      scannedResults: result.scannedResults,
      pagesChecked: result.pagesChecked,
      checkedAt: result.checkedAt,
    });
  } catch (error) {
    if (error instanceof ScraperError) {
      const statusByCode = {
        INVALID_DOMAIN: 400,
        INVALID_KEYWORD: 400,
        CHALLENGE: 503,
        BLOCKED: 503,
        HTTP_ERROR: 502,
        REQUEST_FAILED: 502,
      };

      const status = statusByCode[error.code] || 500;
      if (status === 503) res.set('Retry-After', '60');

      console.error(`[check-rank] ${error.code}: ${error.message}`);

      return res.status(status).json({
        success: false,
        code: error.code,
        error: error.message,
      });
    }

    console.error('[check-rank] Unexpected error:', error);

    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      error: 'An unexpected error occurred while checking the keyword rank.',
    });
  }
});

// 404 handler: JSON for API calls, a small HTML page for everything else.
app.use((req, res) => {
  const payload = {
    success: false,
    code: 'NOT_FOUND',
    error: 'Not Found',
    path: req.originalUrl,
  };

  if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
    return res.status(404).json(payload);
  }

  res.status(404).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 — Page not found | RankPulse</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #05070d; color: #f3f6fc; font-family: system-ui, sans-serif; text-align: center; }
    h1 { font-size: 3rem; margin: 0 0 8px; background: linear-gradient(135deg,#22d3ee,#c084fc); -webkit-background-clip: text; background-clip: text; color: transparent; }
    p { color: #94a3b8; margin: 0 0 22px; }
    a { color: #67e8f9; text-decoration: none; font-weight: 600; }
  </style>
</head>
<body>
  <main>
    <h1>404</h1>
    <p>That page does not exist.</p>
    <a href="/">Back to RankPulse</a>
  </main>
</body>
</html>`);
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);

  const status = err.status || err.statusCode || 500;
  const isServerError = status >= 500;

  res.status(status).json({
    success: false,
    code:
      err.code || err.type || (isServerError ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    error: isServerError ? 'Internal Server Error' : err.message,
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SEO Keyword Rank Checker listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
