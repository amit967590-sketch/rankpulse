'use strict';

/**
 * utils/scraperHelper.js
 *
 * SERP scraper for the SEO Keyword Rank Checker.
 *
 * Google is the primary engine. The scraper reads Google's public results
 * markup, follows `start` pagination, and counts organic results across pages.
 * If Google serves a captcha/consent page or the request fails, it automatically
 * falls back to DuckDuckGo's lightweight HTML endpoint.
 *
 * Usage:
 *   const { checkKeywordRank } = require('./utils/scraperHelper');
 *   const result = await checkKeywordRank('https://archquake.co.in/', 'archquake');
 */

const axios = require('axios');
const cheerio = require('cheerio');

const GOOGLE_ORIGIN = 'https://www.google.com';
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const DUCKDUCKGO_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const DUCKDUCKGO_ORIGIN = 'https://html.duckduckgo.com';
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br'
};
// Google shows 10 organic results per HTML result page.
const GOOGLE_RESULTS_PER_PAGE = 10;

// A 3-5 page scan should yield 30-50 organic results. If Google stops early
// with fewer results, the DuckDuckGo fallback is given a chance to fill in a
// complete scan.
const MIN_ORGANIC_RESULTS = 30;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizeEngine(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'duckduckgo' || normalized === 'ddg'
    ? 'duckduckgo'
    : 'google';
}

function engineLabel(engine) {
  return engine === 'duckduckgo' ? 'DuckDuckGo' : 'Google';
}

const DEFAULTS = {
  maxPages: toPositiveInt(process.env.MAX_RESULT_PAGES, 5),
  requestDelayMs: toNonNegativeInt(process.env.REQUEST_DELAY_MS, 1000),
  timeoutMs: toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 15000),
  retries: 1,
  engine: normalizeEngine(process.env.SEARCH_ENGINE || 'google'),
  fallbackToDuckDuckGo: toBoolean(process.env.DUCKDUCKGO_FALLBACK, true),
};

class ScraperError extends Error {
  constructor(message, { code = 'SCRAPER_ERROR', status, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ScraperError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// ---------------------------------------------------------------------------
// User-Agent & header generation
// ---------------------------------------------------------------------------

const CHROME_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const FIREFOX_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const SAFARI_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const BROWSER_PROFILES = [
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: CHROME_ACCEPT,
    chUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"Windows"',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: CHROME_ACCEPT,
    chUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"macOS"',
  },
  {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    accept: CHROME_ACCEPT,
    chUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"Linux"',
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    accept: CHROME_ACCEPT,
    chUa: '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"Windows"',
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    accept: CHROME_ACCEPT,
    chUa: '"Microsoft Edge";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: '"macOS"',
  },
  {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    accept: FIREFOX_ACCEPT,
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    accept: FIREFOX_ACCEPT,
  },
  {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    accept: SAFARI_ACCEPT,
  },
];

const ACCEPT_LANGUAGES = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.9',
  'en-CA,en;q=0.9,fr;q=0.8',
  'en-AU,en;q=0.9',
  'en-US,en;q=0.9,es;q=0.8',
];

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Build a fresh set of realistic browser headers for every request.
 * Chrome/Edge profiles include matching Client Hints.
 */
function buildHeaders({ referer, origin, contentType } = {}) {
  const profile = pickRandom(BROWSER_PROFILES);

  const headers = {
    'User-Agent': profile.userAgent,
    Accept: profile.accept || CHROME_ACCEPT,
    'Accept-Language': pickRandom(ACCEPT_LANGUAGES),
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    DNT: '1',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    Connection: 'keep-alive',
  };

  if (profile.chUa) {
    headers['sec-ch-ua'] = profile.chUa;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = profile.platform;
  }

  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;
  if (contentType) headers['Content-Type'] = contentType;

  return headers;
}

// ---------------------------------------------------------------------------
// URL, domain, and input helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDuckDuckGoHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com');
}

function isGoogleHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return /(^|\.)google\.[a-z]{2,}(\.[a-z]{2,})?$/.test(host);
}

function isGoogleOwnedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return (
    isGoogleHost(host) ||
    host === 'gstatic.com' ||
    host.endsWith('.gstatic.com') ||
    host === 'googleusercontent.com' ||
    host.endsWith('.googleusercontent.com') ||
    host === 'googleadservices.com' ||
    host.endsWith('.googleadservices.com')
  );
}

function getHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * Normalize a hostname for comparisons: lowercase, no trailing dot, and no
 * leading "www." so www.example.com and example.com compare as equal.
 */
function normalizeComparableDomain(value) {
  const host = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return host.startsWith('www.') ? host.slice(4) : host;
}

/**
 * Normalize user input such as "https://www.Example.com/path/" to
 * "example.com". Protocol, path, query, and "www." are intentionally dropped.
 * Throws on invalid input.
 */
function normalizeDomain(input) {
  if (typeof input !== 'string') {
    throw new ScraperError('Domain must be a string.', { code: 'INVALID_DOMAIN' });
  }

  let value = input.trim();
  if (!value) {
    throw new ScraperError('Domain must not be empty.', { code: 'INVALID_DOMAIN' });
  }

  if (value.startsWith('//')) {
    value = `https:${value}`;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = `https://${value}`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ScraperError(`Invalid domain: "${input}".`, { code: 'INVALID_DOMAIN' });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ScraperError('Domain must use http or https.', { code: 'INVALID_DOMAIN' });
  }

  const hostname = normalizeComparableDomain(url.hostname);
  if (!hostname) {
    throw new ScraperError(`Invalid domain: "${input}".`, { code: 'INVALID_DOMAIN' });
  }

  return hostname;
}

/**
 * Return a canonical "host/path" string for URL comparisons. Protocol, "www.",
 * trailing slashes, query strings, and hashes are removed. This is used for
 * diagnostics/equality checks; ranking matches compare hostnames only so any
 * path on the target domain is accepted.
 */
function normalizeUrlForComparison(value) {
  if (!value || typeof value !== 'string') return null;

  let url;
  try {
    const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.startsWith('//')
      ? value
      : `https://${value}`;
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const hostname = normalizeComparableDomain(url.hostname);
  if (!hostname) return null;

  const path = url.pathname.replace(/\/+$/, '');
  return path ? `${hostname}${path}` : hostname;
}

function normalizeKeyword(keyword) {
  if (typeof keyword !== 'string') {
    throw new ScraperError('Keyword must be a string.', { code: 'INVALID_KEYWORD' });
  }

  const normalized = cleanText(keyword);
  if (!normalized) {
    throw new ScraperError('Keyword must not be empty.', { code: 'INVALID_KEYWORD' });
  }

  return normalized;
}

/**
 * Resolve a DuckDuckGo result href to the real destination URL.
 * DDG wraps organic links as //duckduckgo.com/l/?uddg=<encoded-url>.
 */
function resolveDuckDuckGoUrl(href) {
  if (!href || typeof href !== 'string') return null;

  let url;
  try {
    url = new URL(href, DUCKDUCKGO_ORIGIN);
  } catch {
    return null;
  }

  if (isDuckDuckGoHost(url.hostname) && url.pathname.startsWith('/l/')) {
    const target = url.searchParams.get('uddg') || url.searchParams.get('url');
    if (!target) return null;

    try {
      url = new URL(target);
    } catch {
      try {
        url = new URL(decodeURIComponent(target));
      } catch {
        return null;
      }
    }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // If the redirect could not be decoded, do not treat DDG's own redirect
  // endpoints as organic results.
  if (
    isDuckDuckGoHost(url.hostname) &&
    (url.pathname.startsWith('/l/') || url.pathname === '/y.js')
  ) {
    return null;
  }

  url.hash = '';
  return url.toString();
}

/**
 * Resolve a Google result href to the destination URL.
 * Google wraps external links as /url?q=<encoded-url>&sa=U...
 */
function resolveGoogleUrl(href) {
  if (!href || typeof href !== 'string') return null;

  let url;
  try {
    url = new URL(href, GOOGLE_ORIGIN);
  } catch {
    return null;
  }

  if (isGoogleHost(url.hostname) && /^\/url\/?$/.test(url.pathname)) {
    const target = url.searchParams.get('q') || url.searchParams.get('url');
    if (!target) return null;

    try {
      url = new URL(target);
    } catch {
      try {
        url = new URL(decodeURIComponent(target));
      } catch {
        return null;
      }
    }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (isGoogleOwnedHost(url.hostname)) return null;

  url.hash = '';
  return url.toString();
}

function resolveResultUrl(href, engine = 'duckduckgo') {
  return engine === 'google'
    ? resolveGoogleUrl(href)
    : resolveDuckDuckGoUrl(href);
}

/**
 * Normalize a target that may be a bare domain, a hostname with a path, or a
 * full URL.
 */
function toComparableDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  try {
    return normalizeDomain(raw);
  } catch {
    return null;
  }
}

/**
 * True when the result hostname is the target domain or one of its subdomains.
 * Protocol, path, case, trailing dots, and the "www." prefix are ignored.
 * e.g. target "example.com" matches "https://www.example.com/any/path".
 */
function matchesDomain(resultUrl, targetDomain, includeSubdomains = true) {
  const hostname = getHostname(resultUrl);
  if (!hostname) return false;

  const normalizedHost = normalizeComparableDomain(hostname);
  const normalizedTarget = toComparableDomain(targetDomain);
  if (!normalizedHost || !normalizedTarget) return false;

  if (normalizedHost === normalizedTarget) return true;

  return (
    includeSubdomains && normalizedHost.endsWith(`.${normalizedTarget}`)
  );
}

// ---------------------------------------------------------------------------
// Challenge detection
// ---------------------------------------------------------------------------

const DUCKDUCKGO_CHALLENGE_PATTERNS = [
  /id=["']anomaly-modal["']/i,
  /class=["'][^"']*\banomaly-modal\b/i,
  /challenge-form/i,
  /unusual traffic/i,
  /bots use DuckDuckGo/i,
];

const GOOGLE_CHALLENGE_PATTERNS = [
  /id=["']captcha-form["']/i,
  /\/sorry\/index/i,
  /detected unusual traffic/i,
  /unusual traffic from your computer/i,
  /our systems have detected/i,
  /please show you['’]re not a robot/i,
  /id=["']recaptcha["']/i,
  /class=["'][^"']*g-recaptcha/i,
];

/**
 * Detect a captcha/consent/challenge page.
 * @returns {'CHALLENGE'|'CONSENT'|null}
 */
function detectChallenge(html, engine) {
  const text = String(html || '');

  if (engine === 'google') {
    if (/consent\.google\.com|before you continue to google/i.test(text)) {
      return 'CONSENT';
    }
    return GOOGLE_CHALLENGE_PATTERNS.some((pattern) => pattern.test(text))
      ? 'CHALLENGE'
      : null;
  }

  return DUCKDUCKGO_CHALLENGE_PATTERNS.some((pattern) => pattern.test(text))
    ? 'CHALLENGE'
    : null;
}

function hasOrganicMarkup(html, engine) {
  if (engine === 'google') return /id=["']rso["']/i.test(html);
  return /result__a/.test(html);
}

// ---------------------------------------------------------------------------
// Google parsing
// ---------------------------------------------------------------------------

/**
 * Parse one Google results page.
 *
 * Google's result DOM changes regularly, so the parser works from result
 * blocks that contain a link with an <h3> title. Ads and Google-owned links are
 * discarded. Positions are tracked globally across pages (1, 2, 3, ...).
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {number} page            1-based Google result page number.
 * @param {number} startPosition   Position of the first result on this page.
 * @param {Set<string>} seenUrls   URLs already collected on previous pages.
 * @returns {{ results: Array<object>, organicCount: number }}
 */
function parseGoogleResults($, page, startPosition, seenUrls = new Set()) {
  const results = [];
  let organicCount = 0;

  let $blocks = $('#rso > div');
  if ($blocks.length === 0) $blocks = $('#search div.g');
  if ($blocks.length === 0) $blocks = $('#rso div.g');
  if ($blocks.length === 0) $blocks = $('div.g');

  $blocks.each((_, element) => {
    const $block = $(element);

    // Sponsored placements are not organic rankings.
    if (
      $block.closest(
        '#tads, #bottomads, [data-text-ad], .uEierd, .commercial-unit-desktop-top'
      ).length > 0
    ) {
      return;
    }

    const $anchor = $block
      .find('a[href]')
      .filter((__, anchor) => $(anchor).find('h3').length > 0)
      .first();

    if ($anchor.length === 0) return;

    const title = cleanText($anchor.find('h3').first().text());
    if (!title) return;

    const url = resolveResultUrl($anchor.attr('href'), 'google');
    if (!url) return;

    organicCount += 1;
    const position = startPosition + organicCount - 1;

    // Keep the position open for a duplicate URL, but only return it once.
    if (seenUrls.has(url)) return;
    seenUrls.add(url);

    const hostname = getHostname(url);
    if (!hostname) return;

    const displayUrl = cleanText(
      $block.find('cite').first().text() ||
        $block.find('.VuuXrf').first().text() ||
        $block.find('.TbwUpd').first().text()
    );

    const snippet = cleanText(
      $block
        .find('div.VwiC3b, span.aCOpRe, div.IsZvec, div[data-sncf]')
        .first()
        .text()
    );

    results.push({
      position,
      page,
      title,
      url,
      domain: hostname,
      displayUrl,
      snippet,
    });
  });

  return { results, organicCount };
}

// ---------------------------------------------------------------------------
// DuckDuckGo parsing
// ---------------------------------------------------------------------------

/**
 * Parse one DuckDuckGo results page.
 *
 * Organic result positions are tracked across pages (1, 2, 3, ...).
 * Sponsored results are ignored and do not consume a position.
 *
 * @param {import('cheerio').CheerioAPI} $
 * @param {number} page            1-based DuckDuckGo result page number.
 * @param {number} startPosition   Position of the first result on this page.
 * @param {Set<string>} seenUrls   URLs already collected on previous pages.
 * @returns {{ results: Array<object>, organicCount: number }}
 */
function parseResults($, page, startPosition, seenUrls = new Set()) {
  const results = [];
  let organicCount = 0;

  let $containers = $('#links .result');
  if ($containers.length === 0) $containers = $('.result');

  $containers.each((_, element) => {
    const $result = $(element);

    // Ads / sponsored placements are not organic rankings.
    if (
      $result.hasClass('result--ad') ||
      $result.find('.result--ad').length > 0 ||
      $result.find('.result__badge').length > 0
    ) {
      return;
    }

    const $anchor = $result.find('a.result__a').first();
    if ($anchor.length === 0) return;

    let url = resolveResultUrl($anchor.attr('href'), 'duckduckgo');
    if (!url) {
      url = resolveResultUrl(
        $result.find('a.result__url').first().attr('href'),
        'duckduckgo'
      );
    }
    if (!url) return;

    const title = cleanText($anchor.text());
    if (!title) return;

    organicCount += 1;
    const position = startPosition + organicCount - 1;

    // Keep positions intact if a URL repeats, but only return it once.
    if (seenUrls.has(url)) return;
    seenUrls.add(url);

    const hostname = getHostname(url);
    if (!hostname) return;

    results.push({
      position,
      page,
      title,
      url,
      domain: hostname,
      displayUrl: cleanText($result.find('.result__url').first().text()),
      snippet: cleanText($result.find('.result__snippet').first().text()),
    });
  });

  return { results, organicCount };
}

/**
 * Find the "Next" pagination form and collect its hidden fields.
 * DuckDuckGo requires a POST with these fields for pages after the first.
 */
function extractNextPageForm($) {
  const forms = $('.nav-link form').toArray();

  for (const form of forms) {
    const $form = $(form);
    const submitValue = cleanText(
      $form.find('input[type="submit"]').first().attr('value')
    ).toLowerCase();

    if (submitValue !== 'next') continue;

    const fields = {};
    $form.find('input[name]').each((_, input) => {
      const $input = $(input);
      const name = $input.attr('name');
      if (name) fields[name] = $input.attr('value') ?? '';
    });

    return {
      action: $form.attr('action') || '/html/',
      method: ($form.attr('method') || 'post').toLowerCase(),
      fields,
    };
  }

  return null;
}

function buildPageRequest(form) {
  const actionUrl = new URL(form.action, DUCKDUCKGO_ORIGIN);

  if (form.method === 'get') {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(form.fields)) {
      params.set(name, value);
    }
    actionUrl.search = params.toString();
    return { method: 'GET', url: actionUrl.toString(), data: undefined };
  }

  return {
    method: 'POST',
    url: actionUrl.toString(),
    data: new URLSearchParams(form.fields).toString(),
  };
}

function buildGoogleSearchUrl(query, start = 0) {
  const url = new URL(GOOGLE_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(GOOGLE_RESULTS_PER_PAGE));
  url.searchParams.set('hl', 'en');
  url.searchParams.set('start', String(start));
  // Web-only results, signed out, without personalization.
  url.searchParams.set('udm', '14');
  url.searchParams.set('igu', '1');
  url.searchParams.set('pws', '0');
  return url.toString();
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

async function requestPage({
  engine,
  method,
  url,
  data,
  referer,
  origin,
  timeoutMs,
  retries,
  signal,
}) {
  let lastError;
  const provider = engineLabel(engine);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.request({
        method,
        url,
        data,
        headers: buildHeaders({
          referer,
          origin,
          contentType: data ? 'application/x-www-form-urlencoded' : undefined,
        }),
        timeout: timeoutMs,
        responseType: 'text',
        maxRedirects: 5,
        signal,
        validateStatus: () => true,
      });

      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      const status = response.status;

      if (status === 403 || status === 429) {
        throw new ScraperError(
          `${provider} blocked the request (HTTP ${status}).`,
          { code: 'BLOCKED', status }
        );
      }

      if (status === 202 && !hasOrganicMarkup(html, engine)) {
        throw new ScraperError(
          `${provider} returned a challenge page (HTTP 202).`,
          { code: 'CHALLENGE', status }
        );
      }

      if (status < 200 || status >= 300) {
        throw new ScraperError(`${provider} returned HTTP ${status}.`, {
          code: 'HTTP_ERROR',
          status,
        });
      }

      const challengeCode = detectChallenge(html, engine);
      if (challengeCode && !hasOrganicMarkup(html, engine)) {
        throw new ScraperError(
          challengeCode === 'CONSENT'
            ? `${provider} returned a consent page instead of results.`
            : `${provider} returned a bot challenge page.`,
          { code: challengeCode, status }
        );
      }

      return html;
    } catch (error) {
      lastError = error;

      if (
        signal?.aborted ||
        error.name === 'AbortError' ||
        error.code === 'ERR_CANCELED'
      ) {
        throw error;
      }

      if (attempt < retries) {
        // Brief jittered backoff before retrying with a fresh random User-Agent.
        await sleep(1500 + attempt * 1000 + Math.floor(Math.random() * 750));
      }
    }
  }

  if (lastError instanceof ScraperError) throw lastError;

  throw new ScraperError(
    `Failed to fetch ${provider} results: ${lastError?.message || 'unknown error'}`,
    { code: 'REQUEST_FAILED', cause: lastError }
  );
}

// ---------------------------------------------------------------------------
// Result objects
// ---------------------------------------------------------------------------

function buildFoundResult({
  engine,
  keyword,
  targetDomain,
  result,
  resultsScanned,
  pagesChecked,
  checkedAt,
}) {
  return {
    found: true,
    keyword,
    domain: targetDomain,
    engine,
    position: result.position,
    page: result.page,
    url: result.url,
    title: result.title,
    snippet: result.snippet,
    resultDomain: result.domain,
    displayUrl: result.displayUrl,
    resultsScanned,
    scannedResults: resultsScanned,
    pagesChecked,
    checkedAt,
    message: null,
  };
}

function buildNotFoundResult({
  engine,
  keyword,
  targetDomain,
  resultsScanned,
  pagesChecked,
  checkedAt,
}) {
  const resultWord = resultsScanned === 1 ? 'result' : 'results';
  const pageWord = pagesChecked === 1 ? 'page' : 'pages';

  return {
    found: false,
    keyword,
    domain: targetDomain,
    engine,
    position: null,
    page: null,
    url: null,
    title: null,
    snippet: null,
    resultDomain: null,
    displayUrl: null,
    resultsScanned,
    scannedResults: resultsScanned,
    pagesChecked,
    checkedAt,
    message:
      `No match found for "${targetDomain}" after scanning ` +
      `${resultsScanned} organic ${resultWord} across ${pagesChecked} ` +
      `${pageWord} on ${engineLabel(engine)}.`,
  };
}

// ---------------------------------------------------------------------------
// Engine scanners
// ---------------------------------------------------------------------------

async function scanGoogle({
  query,
  targetDomain,
  maxPages,
  requestDelayMs,
  timeoutMs,
  retries,
  includeSubdomains,
  signal,
  checkedAt,
}) {
  const seenUrls = new Set();
  let resultsScanned = 0;
  let pagesChecked = 0;
  let startPosition = 1;
  let referer;

  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1) {
      // Small jitter makes page-to-page timing less mechanical.
      await sleep(requestDelayMs + Math.floor(Math.random() * 500));
    }

    const url = buildGoogleSearchUrl(
      query,
      (page - 1) * GOOGLE_RESULTS_PER_PAGE
    );

    const html = await requestPage({
      engine: 'google',
      method: 'GET',
      url,
      data: undefined,
      referer,
      origin: page > 1 ? GOOGLE_ORIGIN : undefined,
      timeoutMs,
      retries,
      signal,
    });

    pagesChecked = page;

    const $ = cheerio.load(html);
    const { results, organicCount } = parseGoogleResults(
      $,
      page,
      startPosition,
      seenUrls
    );

    if (organicCount === 0) {
      if (page === 1) {
        const jsOnlyPage = /httpservice\/retry\/enablejs|enablejs/i.test(html);
        throw new ScraperError(
          jsOnlyPage
            ? 'Google returned a JavaScript-only page instead of organic results.'
            : 'Google returned no organic results for this keyword.',
          { code: 'EMPTY_RESULTS', status: 200 }
        );
      }
      break;
    }

    resultsScanned += organicCount;
    startPosition = resultsScanned + 1;

    for (const result of results) {
      if (matchesDomain(result.url, targetDomain, includeSubdomains)) {
        return buildFoundResult({
          engine: 'google',
          keyword: query,
          targetDomain,
          result,
          resultsScanned,
          pagesChecked,
          checkedAt,
        });
      }
    }

    if (page >= maxPages) break;

    const hasNextPage =
      $('#pnnext').length > 0 || $('a[aria-label="Next page"]').length > 0;
    if (!hasNextPage) break;

    referer = url;
  }

  const minimumExpected = Math.min(
    maxPages * GOOGLE_RESULTS_PER_PAGE,
    MIN_ORGANIC_RESULTS
  );

  if (maxPages >= 3 && resultsScanned < minimumExpected) {
    throw new ScraperError(
      `Google returned only ${resultsScanned} organic results (expected at least ${minimumExpected}).`,
      { code: 'INSUFFICIENT_RESULTS', status: 200 }
    );
  }

  return buildNotFoundResult({
    engine: 'google',
    keyword: query,
    targetDomain,
    resultsScanned,
    pagesChecked,
    checkedAt,
  });
}

async function scanDuckDuckGo({
  query,
  targetDomain,
  maxPages,
  requestDelayMs,
  timeoutMs,
  retries,
  includeSubdomains,
  signal,
  checkedAt,
}) {
  const searchUrl = new URL(DUCKDUCKGO_SEARCH_URL);
  searchUrl.searchParams.set('q', query);

  let request = {
    method: 'GET',
    url: searchUrl.toString(),
    data: undefined,
    referer: undefined,
    origin: undefined,
  };

  const seenUrls = new Set();
  let resultsScanned = 0;
  let pagesChecked = 0;
  let startPosition = 1;

  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1) {
      // Small jitter makes page-to-page timing less mechanical.
      await sleep(requestDelayMs + Math.floor(Math.random() * 500));
    }

    const html = await requestPage({
      engine: 'duckduckgo',
      ...request,
      timeoutMs,
      retries,
      signal,
    });

    pagesChecked = page;

    const $ = cheerio.load(html);
    const { results, organicCount } = parseResults(
      $,
      page,
      startPosition,
      seenUrls
    );

    if (organicCount === 0) {
      if (page === 1) {
        return buildNotFoundResult({
          engine: 'duckduckgo',
          keyword: query,
          targetDomain,
          resultsScanned,
          pagesChecked,
          checkedAt,
        });
      }
      break;
    }

    resultsScanned += organicCount;
    startPosition = resultsScanned + 1;

    for (const result of results) {
      if (matchesDomain(result.url, targetDomain, includeSubdomains)) {
        return buildFoundResult({
          engine: 'duckduckgo',
          keyword: query,
          targetDomain,
          result,
          resultsScanned,
          pagesChecked,
          checkedAt,
        });
      }
    }

    if (page >= maxPages) break;

    const nextForm = extractNextPageForm($);
    if (!nextForm) break;

    // DDG's hidden "s" field is the number of results already shown, so it
    // gives us the exact offset for the next page (10, 25, 40, ...).
    const nextOffset = Number(nextForm.fields.s);
    if (Number.isFinite(nextOffset) && nextOffset >= 0) {
      startPosition = Math.max(startPosition, nextOffset + 1);
    }

    request = {
      ...buildPageRequest(nextForm),
      referer: searchUrl.toString(),
      origin: DUCKDUCKGO_ORIGIN,
    };
  }

  return buildNotFoundResult({
    engine: 'duckduckgo',
    keyword: query,
    targetDomain,
    resultsScanned,
    pagesChecked,
    checkedAt,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check where `domain` ranks for `keyword` in organic search results.
 *
 * Google is scanned first. If Google is blocked or returns a captcha/consent
 * page, the scan transparently falls back to DuckDuckGo.
 *
 * @param {string} domain  Domain or URL, e.g. "example.com" or "https://www.example.com/path".
 * @param {string} keyword Search query.
 * @param {object} [options]
 * @param {number} [options.maxPages]                 Pages to scan (default: MAX_RESULT_PAGES or 5, ~30-50 results).
 * @param {number} [options.requestDelayMs]           Delay between page requests in ms (default: REQUEST_DELAY_MS or 1000).
 * @param {number} [options.timeoutMs]                Per-request timeout in ms (default: REQUEST_TIMEOUT_MS or 15000).
 * @param {number} [options.retries]                  Retry attempts per page request (default: 1).
 * @param {boolean} [options.includeSubdomains]       Match subdomains too (default: true).
 * @param {'google'|'duckduckgo'} [options.engine]    Primary engine (default: SEARCH_ENGINE or google).
 * @param {boolean} [options.fallbackToDuckDuckGo]    Fall back to DDG when Google fails (default: true).
 * @param {AbortSignal} [options.signal]              Optional abort signal.
 * @returns {Promise<object>} Ranking result. `found` is false when the domain is not in the scanned pages.
 */
async function checkKeywordRank(domain, keyword, options = {}) {
  const targetDomain = normalizeDomain(domain);
  const query = normalizeKeyword(keyword);

  const maxPages = toPositiveInt(options.maxPages, DEFAULTS.maxPages);
  const requestDelayMs = toNonNegativeInt(
    options.requestDelayMs,
    DEFAULTS.requestDelayMs
  );
  const timeoutMs = toPositiveInt(options.timeoutMs, DEFAULTS.timeoutMs);
  const retries = toNonNegativeInt(options.retries, DEFAULTS.retries);
  const includeSubdomains = options.includeSubdomains !== false;
  const signal = options.signal;
  const primaryEngine = normalizeEngine(
    options.engine === undefined ? DEFAULTS.engine : options.engine
  );
  const fallbackToDuckDuckGo =
    options.fallbackToDuckDuckGo === undefined
      ? DEFAULTS.fallbackToDuckDuckGo
      : Boolean(options.fallbackToDuckDuckGo);

  const engines =
    primaryEngine === 'duckduckgo'
      ? ['duckduckgo']
      : fallbackToDuckDuckGo
        ? ['google', 'duckduckgo']
        : ['google'];

  const checkedAt = new Date().toISOString();
  const attempts = [];

  for (const engine of engines) {
    try {
      const scanner = engine === 'google' ? scanGoogle : scanDuckDuckGo;
      const result = await scanner({
        query,
        targetDomain,
        maxPages,
        requestDelayMs,
        timeoutMs,
        retries,
        includeSubdomains,
        signal,
        checkedAt,
      });

      if (attempts.length > 0) {
        result.fallback = true;
        result.fallbackFrom = attempts.map((attempt) => attempt.engine);
        result.fallbackReason = attempts[0].message;
      }

      return result;
    } catch (error) {
      if (
        signal?.aborted ||
        error.name === 'AbortError' ||
        error.code === 'ERR_CANCELED'
      ) {
        throw error;
      }

      if (
        error instanceof ScraperError &&
        (error.code === 'INVALID_DOMAIN' || error.code === 'INVALID_KEYWORD')
      ) {
        throw error;
      }

      attempts.push({
        engine,
        code: error.code || 'REQUEST_FAILED',
        message: error.message,
        error,
      });
    }
  }

  const lastAttempt = attempts[attempts.length - 1];
  const challengeAttempt = attempts.find((attempt) =>
    ['CHALLENGE', 'BLOCKED', 'CONSENT'].includes(attempt.code)
  );

  if (challengeAttempt) {
    const providers = [
      ...new Set(attempts.map((attempt) => engineLabel(attempt.engine))),
    ].join(' and ');

    throw new ScraperError(
      `${providers} could not return organic results right now ` +
        '(captcha, consent, or a JavaScript-only response). ' +
        'Wait about a minute, then try again.',
      { code: 'CHALLENGE', status: 503, cause: lastAttempt?.error }
    );
  }

  throw new ScraperError(
    `Unable to fetch search results: ${
      lastAttempt?.message || 'unknown error'
    }`,
    {
      code: lastAttempt?.code || 'REQUEST_FAILED',
      status: lastAttempt?.error?.status,
      cause: lastAttempt?.error,
    }
  );
}

module.exports = {
  checkKeywordRank,
  normalizeDomain,
  normalizeKeyword,
  normalizeUrlForComparison,
  parseResults,
  parseGoogleResults,
  extractNextPageForm,
  resolveResultUrl,
  matchesDomain,
  buildHeaders,
  buildGoogleSearchUrl,
  detectChallenge,
  normalizeEngine,
  ScraperError,
  SEARCH_URL: GOOGLE_SEARCH_URL,
  GOOGLE_SEARCH_URL,
  DUCKDUCKGO_SEARCH_URL,
};
