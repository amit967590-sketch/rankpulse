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

// Google shows 10 organic results per HTML result page.
const GOOGLE_RESULTS_PER_PAGE = 10;

// Collect up to 100 organic links (ten result pages) per check. The scan stops
// early as soon as the target domain is matched.
const TARGET_ORGANIC_RESULTS = 100;

// Both engines show roughly ten organic results per HTML page.
const DUCKDUCKGO_RESULTS_PER_PAGE = 10;

// A paged scan stops when less than this much time is left, so an in-flight
// request can still finish and the caller receives partial results instead of
// a hard timeout.
const MIN_PAGE_BUDGET_MS = 10000;

function nowMs() {
  return Date.now();
}

function isAbortError(error, signal) {
  return (
    Boolean(signal?.aborted) ||
    error?.name === 'AbortError' ||
    error?.name === 'CanceledError' ||
    error?.code === 'ERR_CANCELED'
  );
}

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
  maxPages: toPositiveInt(process.env.MAX_RESULT_PAGES, 10),
  targetResults: toPositiveInt(
    process.env.TARGET_ORGANIC_RESULTS,
    TARGET_ORGANIC_RESULTS
  ),
  requestDelayMs: toNonNegativeInt(process.env.REQUEST_DELAY_MS, 1000),
  timeoutMs: toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 15000),
  retries: 1,
  engine: normalizeEngine(process.env.SEARCH_ENGINE || 'google'),
  // Google is the primary source. When Google serves a challenge page or no
  // result nodes, the scan falls back to DuckDuckGo automatically. Set
  // DUCKDUCKGO_FALLBACK=false to disable the fallback.
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

/**
 * Dedicated Google request headers: a stable, current Windows Chrome profile
 * with matching Client Hints, English locale, and a consent cookie. Keeping a
 * coherent header set (instead of mixing random profiles) gives Google far
 * fewer reasons to serve its JavaScript-only retry page.
 */
const GOOGLE_CHROME_PROFILE = BROWSER_PROFILES[0];
const GOOGLE_CONSENT_COOKIE =
  'SOCS=CAI; CONSENT=YES+cb.20210328-17-p0.en+FX+410';

/**
 * Browser header set sent with every Google SERP request. These must reach
 * axios (see requestPage) or Google treats the caller as a bare HTTP client and
 * answers datacenter IPs with its JavaScript-only retry page.
 */
const BROWSER_HEADERS = {
  'User-Agent': GOOGLE_CHROME_PROFILE.userAgent,
  Accept: CHROME_ACCEPT,
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  DNT: '1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  Connection: 'keep-alive',
  'sec-ch-ua': GOOGLE_CHROME_PROFILE.chUa,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': GOOGLE_CHROME_PROFILE.platform,
  Cookie: GOOGLE_CONSENT_COOKIE,
};

function buildGoogleHeaders({ referer } = {}) {
  const headers = { ...BROWSER_HEADERS };

  if (referer) {
    headers.Referer = referer;
    headers['Sec-Fetch-Site'] = 'same-origin';
  }

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
  /\/httpservice\/retry\/enablejs/i,
  /enablejs\?sei=/i,
  /id=["']captcha-form["']/i,
  /\/sorry\/index/i,
  /detected unusual traffic/i,
  /unusual traffic from your computer/i,
  /our systems have detected/i,
  /please show you['’]re not a robot/i,
  /id=["']recaptcha["']/i,
  /g-recaptcha/i,
  /recaptcha\/api\.js/i,
  /verification challenge/i,
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

  let $containers = $('#links .result, #links .web-result');
  if ($containers.length === 0) $containers = $('.result, .web-result');

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

    let $anchor = $result.find('a.result__a').first();
    if ($anchor.length === 0) $anchor = $result.find('h2 a[href]').first();
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

/**
 * Build the DuckDuckGo HTML endpoint URL for a result offset.
 *
 * DuckDuckGo accepts an `s` offset on the HTML endpoint, but it only honours it
 * when the `vqd` token from the first page is supplied; without the token the
 * offset is ignored and page 1 is served again. The remaining parameters mirror
 * the hidden fields of DDG's own "Next" form so the markup stays identical.
 */
function buildDuckDuckGoPageUrl(query, offset = 0, vqd = '') {
  const url = new URL(DUCKDUCKGO_SEARCH_URL);
  url.searchParams.set('q', query);

  if (offset > 0) {
    url.searchParams.set('s', String(offset));
    url.searchParams.set('dc', String(offset + 1));
    url.searchParams.set('v', 'l');
    url.searchParams.set('o', 'json');
    url.searchParams.set('api', 'd.js');
    if (vqd) url.searchParams.set('vqd', vqd);
  }

  return url.toString();
}

/**
 * Pull DuckDuckGo's `vqd` token out of a results page. Current responses keep
 * it in the hidden next-page form; some variants only expose it in links or
 * inline script, so fall back to those.
 */
function extractDuckDuckGoVqd($, html) {
  let vqd = '';

  $('input[name="vqd"]').each((_, input) => {
    if (vqd) return;
    const value = cleanText($(input).attr('value'));
    if (value) vqd = value;
  });

  if (vqd) return vqd;

  const text = String(html || '');
  const match =
    text.match(/[?&;]vqd=([\w-]+)/) ||
    text.match(/"vqd"\s*:\s*"([\w-]+)"/) ||
    text.match(/vqd=['"]([\w-]+)['"]/);

  return match ? match[1] : '';
}

/**
 * Work out the result offset for the next DuckDuckGo page. The hidden `s` field
 * of the next-page form is authoritative; otherwise fall back to the number of
 * organic results parsed so far.
 */
function resolveDuckDuckGoNextOffset($, currentOffset, resultsScanned) {
  const nextForm = extractNextPageForm($);
  const formOffset = Number(nextForm?.fields?.s);

  if (Number.isFinite(formOffset) && formOffset > currentOffset) {
    return formOffset;
  }

  return Math.max(
    currentOffset + DUCKDUCKGO_RESULTS_PER_PAGE,
    resultsScanned
  );
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
// ScraperAPI proxy (optional)
// ---------------------------------------------------------------------------

const SCRAPER_API_ENDPOINT = 'https://api.scraperapi.com';

// Google requests are rendered in a real browser (render=true) and exit from an
// Indian IP (country_code=in), which is what gets past the JS retry challenge.
const SCRAPER_API_GOOGLE_PARAMS = 'country_code=in&render=true';

// ScraperAPI solves Google's JS retry page in its own browser, which routinely
// takes longer than a direct scrape, so proxied requests get extra headroom.
const SCRAPER_API_MIN_TIMEOUT_MS = 60000;

// Rendered ScraperAPI fetches are slow and bill credits, so paging through
// them is spaced further apart than direct requests to stay clear of limits.
const SCRAPER_API_PAGE_DELAY_MS = 3000;

function getScraperApiKey() {
  return String(process.env.SCRAPER_API_KEY || '').trim();
}

/**
 * Wrap `targetUrl` in a ScraperAPI request. ScraperAPI fetches the URL from
 * its own IPs (so datacenter blocks and the JavaScript retry page are handled
 * upstream) and returns the engine response HTML unchanged. Returns null when
 * no key is configured, which makes callers hit the engine directly.
 */
function buildScraperApiUrl(targetUrl, extraQuery = '') {
  const apiKey = getScraperApiKey();
  if (!apiKey) return null;

  const suffix = extraQuery ? `&${extraQuery}` : '';
  return `${SCRAPER_API_ENDPOINT}?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}${suffix}`;
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
  // Both engines go through ScraperAPI when a key is configured, so Render's
  // IP is never sent to Google or DuckDuckGo directly.
  const scraperApiUrl = buildScraperApiUrl(
    url,
    engine === 'google' ? SCRAPER_API_GOOGLE_PARAMS : ''
  );
  const viaScraperApi = Boolean(scraperApiUrl);
  const provider = viaScraperApi ? 'ScraperAPI' : engineLabel(engine);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // ScraperAPI supplies its own browser fingerprint and solves Google's JS
      // retry page, so forwarded browser headers would only add noise. Direct
      // Google requests get BROWSER_HEADERS; other engines a rotated profile.
      let headers;
      if (viaScraperApi) {
        headers = {};
      } else if (engine === 'google') {
        headers = buildGoogleHeaders({ referer });
      } else {
        headers = buildHeaders({
          referer,
          origin,
          contentType: data ? 'application/x-www-form-urlencoded' : undefined,
        });
      }

      const response = await axios.request({
        method: viaScraperApi ? 'GET' : method,
        url: viaScraperApi ? scraperApiUrl : url,
        data: viaScraperApi ? undefined : data,
        headers,
        timeout: viaScraperApi
          ? Math.max(timeoutMs, SCRAPER_API_MIN_TIMEOUT_MS)
          : timeoutMs,
        responseType: 'text',
        maxRedirects: 5,
        signal,
        validateStatus: () => true,
      });

      const html =
        typeof response.data === 'string' ? response.data : String(response.data ?? '');
      const status = response.status;

      if (viaScraperApi && status === 401) {
        throw new ScraperError(
          'ScraperAPI rejected the request (HTTP 401) - check SCRAPER_API_KEY.',
          { code: 'AUTH', status }
        );
      }

      // ScraperAPI reports an exhausted monthly quota as HTTP 403 with an
      // explanatory body. Surface it as its own code so the UI does not claim
      // the search engine rate-limited us.
      if (
        viaScraperApi &&
        status === 403 &&
        /exhausted the API Credits|credit limit/i.test(html)
      ) {
        throw new ScraperError(
          'ScraperAPI has no credits left for this billing cycle, so search results could not be fetched.',
          { code: 'NO_CREDITS', status }
        );
      }

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
        const jsRetryPage =
          engine === 'google' &&
          /\/httpservice\/retry\/enablejs|enablejs\?sei=/i.test(html);

        throw new ScraperError(
          jsRetryPage
            ? 'Google returned a JavaScript-only retry page instead of organic results.'
            : challengeCode === 'CONSENT'
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
  partialReason,
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
      `${pageWord} on ${engineLabel(engine)}.` +
      (partialReason
        ? partialReason === 'TIME_BUDGET'
          ? ' The scan stopped early to stay inside the request time limit.'
          : partialReason === 'PAGINATION_UNAVAILABLE'
            ? ' The scan stopped early because the search provider did not return a pagination token.'
            : ' The scan stopped early because the search provider started rate-limiting requests.'
        : ''),
  };
}

const BLOCKED_MESSAGE =
  'Search engines are temporarily rate-limiting requests from this server, so ' +
  'the ranking could not be measured. Please try again in a minute.';

const UNAVAILABLE_MESSAGE =
  'Search results could not be fetched right now, so the ranking could not be ' +
  'measured. Please try again in a minute.';

const NO_CREDITS_MESSAGE =
  'The scraping provider has no credits left for this billing cycle, so the ' +
  'ranking could not be measured. Add credits or wait for the plan to reset.';

/**
 * Soft failure: the ranking is not claimed, but callers still receive a normal
 * result object with a readable message instead of a thrown scraper error, so a
 * block page never surfaces as a verification-challenge popup.
 */
function buildUnavailableResult({
  engine,
  keyword,
  targetDomain,
  checkedAt,
  code,
  message,
}) {
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
    resultsScanned: 0,
    scannedResults: 0,
    pagesChecked: 0,
    checkedAt,
    unavailable: true,
    blocked: ['CHALLENGE', 'BLOCKED', 'CONSENT'].includes(code),
    code: code || 'REQUEST_FAILED',
    message,
  };
}

// ---------------------------------------------------------------------------
// Engine scanners
// ---------------------------------------------------------------------------

async function scanGoogle({
  query,
  targetDomain,
  maxPages,
  targetResults,
  requestDelayMs,
  timeoutMs,
  retries,
  includeSubdomains,
  signal,
  checkedAt,
  deadlineAt,
  minPageBudgetMs,
}) {
  const seenUrls = new Set();
  let resultsScanned = 0;
  let pagesChecked = 0;
  let startPosition = 1;
  let referer;
  let partialReason = null;

  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1) {
      const remainingMs = deadlineAt ? deadlineAt - nowMs() : Infinity;

      // Return the pages already collected instead of losing everything to the
      // caller's hard timeout.
      if (remainingMs < minPageBudgetMs) {
        partialReason = 'TIME_BUDGET';
        break;
      }

      // Small jitter makes page-to-page timing less mechanical.
      await sleep(requestDelayMs + Math.floor(Math.random() * 500));
    }

    const url = buildGoogleSearchUrl(
      query,
      (page - 1) * GOOGLE_RESULTS_PER_PAGE
    );

    let html;
    try {
      html = await requestPage({
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
    } catch (error) {
      if (isAbortError(error, signal)) throw error;

      // Page 1 failing means Google is unusable right now, so let the caller
      // try the fallback engine. Once earlier pages are already scanned, a
      // rate limit should only end the deep scan: keep the work done so far.
      if (page === 1) throw error;
      partialReason = error.code || 'REQUEST_FAILED';
      break;
    }

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
        if (jsOnlyPage) {
          throw new ScraperError(
            'Google returned a JavaScript-only retry page instead of organic results.',
            { code: 'CHALLENGE', status: 503 }
          );
        }

        throw new ScraperError(
          'Google returned no organic results for this keyword.',
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

    // Stop as soon as enough organic links were read (default: 100 links from
    // ten pages), which also bounds ScraperAPI credit usage.
    if (resultsScanned >= targetResults) break;

    if (page >= maxPages) break;

    const hasNextPage =
      $('#pnnext').length > 0 || $('a[aria-label="Next page"]').length > 0;
    if (!hasNextPage) break;

    referer = url;
  }

  return buildNotFoundResult({
    engine: 'google',
    keyword: query,
    targetDomain,
    resultsScanned,
    pagesChecked,
    checkedAt,
    partialReason,
  });
}

async function scanDuckDuckGo({
  query,
  targetDomain,
  maxPages,
  targetResults,
  requestDelayMs,
  timeoutMs,
  retries,
  includeSubdomains,
  signal,
  checkedAt,
  deadlineAt,
  minPageBudgetMs,
}) {
  const seenUrls = new Set();
  let resultsScanned = 0;
  let pagesChecked = 0;
  let startPosition = 1;
  let offset = 0;
  let vqd = '';
  let partialReason = null;
  let referer;

  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1) {
      const remainingMs = deadlineAt ? deadlineAt - nowMs() : Infinity;

      // Finish with the pages already collected rather than letting the caller
      // abort mid-request and lose everything.
      if (remainingMs < minPageBudgetMs) {
        partialReason = 'TIME_BUDGET';
        break;
      }

      // Small jitter makes page-to-page timing less mechanical.
      await sleep(requestDelayMs + Math.floor(Math.random() * 500));
    }

    let html;
    const pageUrl = buildDuckDuckGoPageUrl(query, offset, vqd);

    try {
      html = await requestPage({
        engine: 'duckduckgo',
        method: 'GET',
        url: pageUrl,
        data: undefined,
        referer,
        origin: page > 1 ? DUCKDUCKGO_ORIGIN : undefined,
        timeoutMs,
        retries,
        signal,
      });
    } catch (error) {
      if (isAbortError(error, signal)) throw error;

      // Page 1 failing means DuckDuckGo is unusable right now. Once earlier
      // pages are already scanned, a rate limit should only end the deep scan.
      if (page === 1) throw error;

      partialReason = error.code || 'REQUEST_FAILED';
      break;
    }

    pagesChecked = page;

    const $ = cheerio.load(html);
    if (!vqd) vqd = extractDuckDuckGoVqd($, html);

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

    // Stop as soon as enough organic links were read, or when the page cap is
    // reached. This keeps ScraperAPI credit usage bounded.
    if (resultsScanned >= targetResults) break;
    if (page >= maxPages) break;

    // No next-page form means DuckDuckGo has no further results to serve.
    if (!extractNextPageForm($)) break;

    // DuckDuckGo ignores the offset without the per-query `vqd` token and would
    // serve page 1 again, so a missing token ends the deep scan.
    if (!vqd) {
      partialReason = 'PAGINATION_UNAVAILABLE';
      break;
    }

    offset = resolveDuckDuckGoNextOffset($, offset, resultsScanned);
    referer = pageUrl;
  }

  return buildNotFoundResult({
    engine: 'duckduckgo',
    keyword: query,
    targetDomain,
    resultsScanned,
    pagesChecked,
    checkedAt,
    partialReason,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check where `domain` ranks for `keyword` in organic search results.
 *
 * Google is the primary source. If Google serves a verification challenge
 * (captcha, "unusual traffic", g-recaptcha) or no result nodes at all, the
 * check automatically retries the keyword on DuckDuckGo. Pass
 * `fallbackToDuckDuckGo: false` (or DUCKDUCKGO_FALLBACK=false) to disable.
 *
 * @param {string} domain  Domain or URL, e.g. "example.com" or "https://www.example.com/path".
 * @param {string} keyword Search query.
 * @param {object} [options]
 * @param {number} [options.maxPages]                 Hard cap on SERP pages (default: MAX_RESULT_PAGES or 10).
 * @param {number} [options.targetResults]            Stop after this many organic links (default: TARGET_ORGANIC_RESULTS or 100).
 * @param {number} [options.requestDelayMs]           Delay between page requests in ms (default: REQUEST_DELAY_MS or 1000, raised to 3000 while paging through ScraperAPI).
 * @param {number} [options.timeoutMs]                Per-request timeout in ms (default: REQUEST_TIMEOUT_MS or 15000).
 * @param {number} [options.retries]                  Retry attempts per page request (default: 1).
 * @param {number} [options.timeBudgetMs]             Soft scan deadline in ms; paging stops early and returns partial results when time runs out (default: none).
 * @param {boolean} [options.includeSubdomains]       Match subdomains too (default: true).
 * @param {'google'|'duckduckgo'} [options.engine]    Primary engine (default: SEARCH_ENGINE or google).
 * @param {boolean} [options.fallbackToDuckDuckGo]    Fall back to DDG when Google is blocked or empty (default: true).
 * @param {AbortSignal} [options.signal]              Optional abort signal.
 * @returns {Promise<object>} Ranking result. `found` is false when the domain is not in the scanned pages, and `unavailable` is true when no engine could be read at all.
 */
async function checkKeywordRank(domain, keyword, options = {}) {
  try {
    return await runKeywordCheck(domain, keyword, options);
  } catch (error) {
    if (
      options?.signal?.aborted ||
      error?.name === 'AbortError' ||
      error?.code === 'ERR_CANCELED'
    ) {
      throw error;
    }

    if (
      error instanceof ScraperError &&
      (error.code === 'INVALID_DOMAIN' || error.code === 'INVALID_KEYWORD')
    ) {
      throw error;
    }

    // Unexpected failure (unparsable block page, socket error, ...): answer with
    // a readable message rather than letting a raw error break the UI.
    let safeDomain = String(domain ?? '').trim();
    let safeKeyword = String(keyword ?? '').trim();
    try {
      safeDomain = normalizeDomain(domain);
    } catch {
      /* keep the raw value */
    }
    try {
      safeKeyword = normalizeKeyword(keyword);
    } catch {
      /* keep the raw value */
    }

    return buildUnavailableResult({
      engine: normalizeEngine(options?.engine ?? DEFAULTS.engine),
      keyword: safeKeyword,
      targetDomain: safeDomain,
      checkedAt: new Date().toISOString(),
      code: error?.code || 'REQUEST_FAILED',
      message: UNAVAILABLE_MESSAGE,
    });
  }
}

async function runKeywordCheck(domain, keyword, options = {}) {
  const targetDomain = normalizeDomain(domain);
  const query = normalizeKeyword(keyword);

  const maxPages = toPositiveInt(options.maxPages, DEFAULTS.maxPages);
  const targetResults = toPositiveInt(
    options.targetResults,
    DEFAULTS.targetResults
  );
  // Rendered ScraperAPI pages are slow and bill credits, so deep scans space
  // them out further. An explicit caller delay still wins.
  const defaultPageDelayMs = getScraperApiKey()
    ? Math.max(DEFAULTS.requestDelayMs, SCRAPER_API_PAGE_DELAY_MS)
    : DEFAULTS.requestDelayMs;
  const requestDelayMs = toNonNegativeInt(
    options.requestDelayMs,
    defaultPageDelayMs
  );
  const timeoutMs = toPositiveInt(options.timeoutMs, DEFAULTS.timeoutMs);
  const retries = toNonNegativeInt(options.retries, DEFAULTS.retries);
  const includeSubdomains = options.includeSubdomains !== false;
  const signal = options.signal;

  // Soft deadline: the scanner stops starting new pages once the remaining
  // time cannot cover one more request, so the caller gets partial results
  // before its hard AbortSignal fires.
  const timeBudgetMs = toNonNegativeInt(options.timeBudgetMs, 0);
  const deadlineAt =
    timeBudgetMs > 0 ? nowMs() + timeBudgetMs : null;
  const minPageBudgetMs = getScraperApiKey()
    ? Math.max(SCRAPER_API_MIN_TIMEOUT_MS + 5000, MIN_PAGE_BUDGET_MS)
    : Math.max(timeoutMs + 5000, MIN_PAGE_BUDGET_MS);

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
        targetResults,
        requestDelayMs,
        timeoutMs,
        retries,
        includeSubdomains,
        signal,
        checkedAt,
        deadlineAt,
        minPageBudgetMs,
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
  const blockedAttempt =
    attempts.find((attempt) => attempt.code === 'NO_CREDITS') ||
    attempts.find((attempt) =>
      ['CHALLENGE', 'BLOCKED', 'CONSENT'].includes(attempt.code)
    ) ||
    lastAttempt;

  const finalCode = blockedAttempt?.code || 'REQUEST_FAILED';
  const message =
    finalCode === 'NO_CREDITS'
      ? NO_CREDITS_MESSAGE
      : ['CHALLENGE', 'BLOCKED', 'CONSENT'].includes(finalCode)
        ? BLOCKED_MESSAGE
        : UNAVAILABLE_MESSAGE;

  return buildUnavailableResult({
    engine: blockedAttempt?.engine || primaryEngine,
    keyword: query,
    targetDomain,
    checkedAt,
    code: finalCode,
    message,
  });
}

module.exports = {
  checkKeywordRank,
  normalizeDomain,
  normalizeKeyword,
  normalizeUrlForComparison,
  parseResults,
  parseGoogleResults,
  extractNextPageForm,
  buildDuckDuckGoPageUrl,
  extractDuckDuckGoVqd,
  resolveDuckDuckGoNextOffset,
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
