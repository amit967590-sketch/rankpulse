'use strict';

/**
 * Serverless-safe configuration.
 *
 * Vercel gives each invocation a fresh (or warm) Node process, so every value
 * is read from the environment once per cold start. Set these in
 * Vercel Dashboard -> Project -> Settings -> Environment Variables.
 */

const MAX_RESULT_PAGES_LIMIT = 10;
const TARGET_RESULTS_LIMIT = 100;

// A single invocation should finish before Vercel's maxDuration timer fires
// (see vercel.json). The scraper receives this as an AbortSignal deadline so a
// slow provider returns a clean 504 JSON response instead of a raw platform
// timeout.
const DEFAULT_TIME_BUDGET_MS = 280000;
const MAX_TIME_BUDGET_MS = 290000;

const VALIDATION_LIMITS = {
  domain: 300,
  keyword: 200,
};

function toInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const config = {
  // DuckDuckGo's HTML endpoint is scraped directly; no paid provider is used.
  engine: 'duckduckgo',

  // 10 pages ~= 100 organic results, which is the deepest scan the function's
  // 300s budget can support. The scan stops early once the target domain is
  // found or the per-engine time budget is used up.
  maxPages: clamp(
    toInt(process.env.MAX_RESULT_PAGES, 10),
    1,
    MAX_RESULT_PAGES_LIMIT
  ),
  targetResults: clamp(
    toInt(process.env.TARGET_ORGANIC_RESULTS, 100),
    1,
    TARGET_RESULTS_LIMIT
  ),

  // Retries give transient DuckDuckGo blocks one more chance. Each retry adds
  // one request timeout to the worst-case latency, so keep the default low.
  retries: clamp(toInt(process.env.SCRAPER_RETRIES, 1), 0, 2),

  // Retry a blocked direct request through the free Jina Reader proxy. Enabled
  // by default because datacenter IPs (Vercel included) are often blocked.
  proxyFallback: !['0', 'false', 'no', 'off'].includes(
    String(process.env.DDG_PROXY_FALLBACK ?? 'true').trim().toLowerCase()
  ),

  timeBudgetMs: clamp(
    toInt(process.env.API_TIME_BUDGET_MS, DEFAULT_TIME_BUDGET_MS),
    5000,
    MAX_TIME_BUDGET_MS
  ),

  allowedOrigins: toList(process.env.ALLOWED_ORIGINS),

  rateLimit: {
    windowMs: Math.max(toInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000), 1000),
    max: Math.max(toInt(process.env.RATE_LIMIT_MAX, 60), 1),
  },
};

module.exports = {
  config,
  VALIDATION_LIMITS,
  MAX_RESULT_PAGES_LIMIT,
  TARGET_RESULTS_LIMIT,
};
