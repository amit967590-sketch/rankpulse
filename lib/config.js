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

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(
    String(value).trim().toLowerCase()
  );
}

function toList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const engine =
  String(process.env.SEARCH_ENGINE || 'google')
    .trim()
    .toLowerCase() === 'duckduckgo'
    ? 'duckduckgo'
    : 'google';

const config = {
  // Google is the primary source; DuckDuckGo is only a fallback when enabled.
  engine,
  fallbackToDuckDuckGo: toBoolean(process.env.DUCKDUCKGO_FALLBACK, true),

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

  // Retries double the worst-case latency (ScraperAPI pages can take 60s), so
  // serverless defaults to no retry and relies on the fallback engine instead.
  retries: clamp(toInt(process.env.SCRAPER_RETRIES, 0), 0, 2),

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

  scraperApiConfigured: Boolean(String(process.env.SCRAPER_API_KEY || '').trim()),
};

module.exports = {
  config,
  VALIDATION_LIMITS,
  MAX_RESULT_PAGES_LIMIT,
  TARGET_RESULTS_LIMIT,
};
