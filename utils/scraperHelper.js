'use strict';

/**
 * utils/scraperHelper.js
 *
 * Free SERP scraper for the SEO Keyword Rank Checker.
 *
 * Results are fetched directly from DuckDuckGo's HTML endpoint with axios and
 * parsed with cheerio. No API keys or paid providers are required.
 *
 * Pagination works by following the `s` offset of DuckDuckGo's own "Next" form
 * and carrying the per-query `vqd` token forward. Without that token DuckDuckGo
 * ignores the offset and serves page 1 again, so the token is required for any
 * page after the first.
 *
 * Usage:
 *   const { checkKeywordRank } = require('./utils/scraperHelper');
 *   const result = await checkKeywordRank('https://archquake.co.in/', 'archquake');
 */

const axios = require('axios');
const cheerio = require('cheerio');

const DUCKDUCKGO_SEARCH_URL = 'https://html.duckduckgo.com/html/';
const DUCKDUCKGO_ORIGIN = 'https://html.duckduckgo.com';

// Some hosts (notably Vercel's datacenter IPs) are blocked by DuckDuckGo. The
// free Jina Reader service fetches the same DuckDuckGo HTML from its own IPs and
// returns it unchanged when asked for HTML, so the same parser and pagination
// keep working. No API key is required.
const JINA_READER_URL = 'https://r.jina.ai/';
const JINA_MIN_TIMEOUT_MS = 30000;
const PROXY_PAGE_DELAY_MS = 3000;

// DuckDuckGo's HTML endpoint serves roughly ten organic results per page.
const DUCKDUCKGO_RESULTS_PER_PAGE = 10;

// Collect up to 100 organic links (ten result pages) per check. The scan stops
// early as soon as the target domain is matched.
const TARGET_ORGANIC_RESULTS = 100;

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

const DEFAULTS = {
  maxPages: toPositiveInt(process.env.MAX_RESULT_PAGES, 10),
  targetResults: toPositiveInt(
    process.env.TARGET_ORGANIC_RESULTS,
    TARGET_ORGANIC_RESULTS
  ),
  // A short pause between pages keeps the scan polite and makes page-to-page
  // timing less mechanical, which reduces the chance of a rate-limit response.
  requestDelayMs: toNonNegativeInt(process.env.REQUEST_DELAY_MS, 1200),
  timeoutMs: toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 15000),
  retries: 1,
  // When a direct request is blocked, retry through the free Jina Reader proxy.
  // Set DDG_PROXY_FALLBACK=false to keep direct-only behaviour.
  proxyFallback: toBoolean(process.env.DDG_PROXY_FALLBACK, true),
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
function buildHeaders({ referer, origin } = {}) {
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

function resolveResultUrl(href) {
  return resolveDuckDuckGoUrl(href);
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

  return includeSubdomains && normalizedHost.endsWith(`.${normalizedTarget}`);
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

function detectChallenge(html) {
  const text = String(html || '');
  return DUCKDUCKGO_CHALLENGE_PATTERNS.some((pattern) => pattern.test(text))
    ? 'CHALLENGE'
    : null;
}

function hasOrganicMarkup(html) {
  return /result__a|result-link/.test(html);
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

    let url = resolveDuckDuckGoUrl($anchor.attr('href'));
    if (!url) {
      url = resolveDuckDuckGoUrl(
        $result.find('a.result__url').first().attr('href')
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
 * DuckDuckGo exposes the result offset in a hidden `s` input.
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

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

/**
 * Validate a SERP response and return its HTML. Shared by the direct and proxy
 * transports so both classify blocks, challenges, and HTTP errors identically.
 */
function readResponse(html, status, provider) {
  if (status === 403 || status === 429) {
    throw new ScraperError(`${provider} blocked the request (HTTP ${status}).`, {
      code: 'BLOCKED',
      status,
    });
  }

  if (status === 202 && !hasOrganicMarkup(html)) {
    throw new ScraperError(`${provider} returned a challenge page (HTTP 202).`, {
      code: 'CHALLENGE',
      status,
    });
  }

  if (status < 200 || status >= 300) {
    throw new ScraperError(`${provider} returned HTTP ${status}.`, {
      code: 'HTTP_ERROR',
      status,
    });
  }

  const challengeCode = detectChallenge(html);
  if (challengeCode && !hasOrganicMarkup(html)) {
    throw new ScraperError(
      `${provider} returned a bot challenge page instead of results.`,
      { code: challengeCode, status }
    );
  }

  return html;
}

/**
 * Fetch one SERP page directly from DuckDuckGo.
 *
 * Each attempt uses a fresh browser header profile. Axios resolves non-2xx
 * responses so block/challenge pages can be classified instead of surfacing as
 * generic network errors.
 */
async function fetchDirect({ url, referer, origin, timeoutMs, retries, signal }) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.request({
        method: 'GET',
        url,
        headers: buildHeaders({ referer, origin }),
        timeout: timeoutMs,
        responseType: 'text',
        maxRedirects: 5,
        signal,
        validateStatus: () => true,
      });

      const html =
        typeof response.data === 'string'
          ? response.data
          : String(response.data ?? '');

      return readResponse(html, response.status, 'DuckDuckGo');
    } catch (error) {
      lastError = error;

      if (isAbortError(error, signal)) throw error;

      if (attempt < retries) {
        // Brief jittered backoff before retrying with a fresh User-Agent.
        await sleep(1500 + attempt * 1000 + Math.floor(Math.random() * 750));
      }
    }
  }

  if (lastError instanceof ScraperError) throw lastError;

  throw new ScraperError(
    `Failed to fetch DuckDuckGo results: ${lastError?.message || 'unknown error'}`,
    { code: 'REQUEST_FAILED', cause: lastError }
  );
}

/**
 * Fetch the same DuckDuckGo page through Jina Reader.
 *
 * `X-Return-Format: html` makes Jina return the upstream DuckDuckGo markup
 * unchanged, so the vqd token, next-page form, and result nodes all survive and
 * the normal parser can be reused.
 */
async function fetchViaProxy({ url, timeoutMs, retries, signal }) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.request({
        method: 'GET',
        url: `${JINA_READER_URL}${url}`,
        headers: {
          'X-Return-Format': 'html',
          Accept: 'text/html,application/xhtml+xml',
          'User-Agent': pickRandom(BROWSER_PROFILES).userAgent,
        },
        timeout: Math.max(timeoutMs, JINA_MIN_TIMEOUT_MS),
        responseType: 'text',
        maxRedirects: 5,
        signal,
        validateStatus: () => true,
      });

      const html =
        typeof response.data === 'string'
          ? response.data
          : String(response.data ?? '');

      // Jina reports upstream failures as a 200 text response. Treat those as a
      // provider error instead of a legitimate "no results" page.
      if (
        !hasOrganicMarkup(html) &&
        /Target URL returned error|Failed to fetch|Unable to fetch/i.test(html)
      ) {
        throw new ScraperError(
          'The DuckDuckGo proxy could not fetch search results.',
          { code: 'REQUEST_FAILED', status: response.status }
        );
      }

      return readResponse(html, response.status, 'The DuckDuckGo proxy');
    } catch (error) {
      lastError = error;

      if (isAbortError(error, signal)) throw error;

      if (attempt < retries) {
        await sleep(2000 + attempt * 1000 + Math.floor(Math.random() * 750));
      }
    }
  }

  if (lastError instanceof ScraperError) throw lastError;

  throw new ScraperError(
    `Failed to fetch DuckDuckGo results through the proxy: ${
      lastError?.message || 'unknown error'
    }`,
    { code: 'REQUEST_FAILED', cause: lastError }
  );
}

/**
 * Fetch one SERP page, preferring a direct request and falling back to the free
 * proxy when the host's IP is blocked. `transport` is carried across pages so a
 * scan that falls back once keeps using the proxy for the rest of its pages.
 */
async function requestPage({
  url,
  referer,
  origin,
  timeoutMs,
  retries,
  signal,
  transport,
  proxyFallback,
}) {
  if (transport === 'proxy') {
    return {
      html: await fetchViaProxy({ url, timeoutMs, retries, signal }),
      transport: 'proxy',
    };
  }

  try {
    const html = await fetchDirect({
      url,
      referer,
      origin,
      timeoutMs,
      retries,
      signal,
    });
    return { html, transport: 'direct' };
  } catch (error) {
    if (isAbortError(error, signal) || !proxyFallback) throw error;

    return {
      html: await fetchViaProxy({ url, timeoutMs, retries, signal }),
      transport: 'proxy',
    };
  }
}

// ---------------------------------------------------------------------------
// Result objects
// ---------------------------------------------------------------------------

function buildFoundResult({
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
    engine: 'duckduckgo',
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
    engine: 'duckduckgo',
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
      `${pageWord} on DuckDuckGo.` +
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
  'DuckDuckGo is temporarily rate-limiting requests from this server, so the ' +
  'ranking could not be measured. Please try again in a minute.';

const UNAVAILABLE_MESSAGE =
  'Search results could not be fetched right now, so the ranking could not be ' +
  'measured. Please try again in a minute.';

/**
 * Soft failure: the ranking is not claimed, but callers still receive a normal
 * result object with a readable message instead of a thrown scraper error, so a
 * block page never surfaces as a verification-challenge popup.
 */
function buildUnavailableResult({
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
    engine: 'duckduckgo',
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
// DuckDuckGo scanner
// ---------------------------------------------------------------------------

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
  proxyFallback,
}) {
  const seenUrls = new Set();
  let resultsScanned = 0;
  let pagesChecked = 0;
  let startPosition = 1;
  let offset = 0;
  let vqd = '';
  let partialReason = null;
  let referer;
  let transport;

  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1) {
      const remainingMs = deadlineAt ? deadlineAt - nowMs() : Infinity;

      // Finish with the pages already collected rather than letting the caller
      // abort mid-request and lose everything.
      if (remainingMs < minPageBudgetMs) {
        partialReason = 'TIME_BUDGET';
        break;
      }

      // Proxy requests are slower and rate-limited, so space them out further.
      const pageDelay =
        transport === 'proxy'
          ? Math.max(requestDelayMs, PROXY_PAGE_DELAY_MS)
          : requestDelayMs;

      // Small jitter makes page-to-page timing less mechanical.
      await sleep(pageDelay + Math.floor(Math.random() * 500));
    }

    const pageUrl = buildDuckDuckGoPageUrl(query, offset, vqd);

    let html;
    try {
      const response = await requestPage({
        url: pageUrl,
        referer,
        origin: page > 1 ? DUCKDUCKGO_ORIGIN : undefined,
        timeoutMs,
        retries,
        signal,
        transport,
        proxyFallback,
      });

      html = response.html;
      if (response.transport === 'proxy') transport = 'proxy';
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
    // reached. This bounds the number of outbound requests per check.
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
 * Check where `domain` ranks for `keyword` in DuckDuckGo's organic results.
 *
 * @param {string} domain  Domain or URL, e.g. "example.com" or "https://www.example.com/path".
 * @param {string} keyword Search query.
 * @param {object} [options]
 * @param {number} [options.maxPages]              Hard cap on SERP pages (default: MAX_RESULT_PAGES or 10).
 * @param {number} [options.targetResults]         Stop after this many organic links (default: TARGET_ORGANIC_RESULTS or 100).
 * @param {number} [options.requestDelayMs]        Delay between page requests in ms (default: REQUEST_DELAY_MS or 1200).
 * @param {number} [options.timeoutMs]             Per-request timeout in ms (default: REQUEST_TIMEOUT_MS or 15000).
 * @param {number} [options.retries]               Retry attempts per page request (default: 1).
 * @param {number} [options.timeBudgetMs]          Soft scan deadline in ms; paging stops early and returns partial results when time runs out.
 * @param {boolean} [options.includeSubdomains]    Match subdomains too (default: true).
 * @param {boolean} [options.proxyFallback]        Retry blocked direct requests through the free reader proxy (default: DDG_PROXY_FALLBACK or true).
 * @param {AbortSignal} [options.signal]           Optional abort signal.
 * @returns {Promise<object>} Ranking result. `found` is false when the domain is not in the scanned pages, and `unavailable` is true when DuckDuckGo could not be read at all.
 */
async function checkKeywordRank(domain, keyword, options = {}) {
  try {
    return await runKeywordCheck(domain, keyword, options);
  } catch (error) {
    if (isAbortError(error, options?.signal)) {
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

    const code = error?.code || 'REQUEST_FAILED';

    return buildUnavailableResult({
      keyword: safeKeyword,
      targetDomain: safeDomain,
      checkedAt: new Date().toISOString(),
      code,
      message: ['CHALLENGE', 'BLOCKED', 'CONSENT'].includes(code)
        ? BLOCKED_MESSAGE
        : UNAVAILABLE_MESSAGE,
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
  const requestDelayMs = toNonNegativeInt(
    options.requestDelayMs,
    DEFAULTS.requestDelayMs
  );
  const timeoutMs = toPositiveInt(options.timeoutMs, DEFAULTS.timeoutMs);
  const retries = toNonNegativeInt(options.retries, DEFAULTS.retries);
  const includeSubdomains = options.includeSubdomains !== false;
  const proxyFallback =
    options.proxyFallback === undefined
      ? DEFAULTS.proxyFallback
      : Boolean(options.proxyFallback);
  const signal = options.signal;

  // Soft deadline: the scanner stops starting new pages once the remaining
  // time cannot cover one more request, so the caller gets partial results
  // before its hard AbortSignal fires. Proxy requests can take longer than a
  // direct scrape, so reserve enough time for one of those.
  const timeBudgetMs = toNonNegativeInt(options.timeBudgetMs, 0);
  const deadlineAt = timeBudgetMs > 0 ? nowMs() + timeBudgetMs : null;
  const minPageBudgetMs = Math.max(
    timeoutMs + 5000,
    proxyFallback ? JINA_MIN_TIMEOUT_MS + 5000 : 0,
    MIN_PAGE_BUDGET_MS
  );

  return scanDuckDuckGo({
    query,
    targetDomain,
    maxPages,
    targetResults,
    requestDelayMs,
    timeoutMs,
    retries,
    includeSubdomains,
    signal,
    checkedAt: new Date().toISOString(),
    deadlineAt,
    minPageBudgetMs,
    proxyFallback,
  });
}

module.exports = {
  checkKeywordRank,
  normalizeDomain,
  normalizeKeyword,
  normalizeUrlForComparison,
  parseResults,
  parseDuckDuckGoResults: parseResults,
  extractNextPageForm,
  buildDuckDuckGoPageUrl,
  extractDuckDuckGoVqd,
  resolveDuckDuckGoNextOffset,
  resolveResultUrl,
  matchesDomain,
  buildHeaders,
  detectChallenge,
  ScraperError,
  DUCKDUCKGO_SEARCH_URL,
};
