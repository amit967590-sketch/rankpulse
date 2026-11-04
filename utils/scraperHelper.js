'use strict';

/**
 * utils/scraperHelper.js
 *
 * DuckDuckGo HTML search scraper for the SEO Keyword Rank Checker.
 *
 * It queries the lightweight HTML endpoint (https://html.duckduckgo.com/html/)
 * instead of Google, parses the organic results with Cheerio, and walks the
 * result pages until the target domain is found or MAX_RESULT_PAGES is reached.
 *
 * Usage:
 *   const { checkKeywordRank } = require('./utils/scraperHelper');
 *   const result = await checkKeywordRank('example.com', 'node.js framework');
 */

const axios = require('axios');
const cheerio = require('cheerio');

const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const SEARCH_ORIGIN = 'https://html.duckduckgo.com';

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

const DEFAULTS = {
  maxPages: toPositiveInt(process.env.MAX_RESULT_PAGES, 5),
  requestDelayMs: toNonNegativeInt(process.env.REQUEST_DELAY_MS, 1000),
  timeoutMs: toPositiveInt(process.env.REQUEST_TIMEOUT_MS, 15000),
  retries: 1,
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
// Small helpers
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
 * Normalize user input such as "https://www.Example.com/path/" to
 * "example.com". Throws on invalid input.
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

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) {
    throw new ScraperError(`Invalid domain: "${input}".`, { code: 'INVALID_DOMAIN' });
  }

  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
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
function resolveResultUrl(href) {
  if (!href || typeof href !== 'string') return null;

  let url;
  try {
    url = new URL(href, SEARCH_ORIGIN);
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
 * True when the result hostname is the target domain or one of its subdomains.
 * e.g. target "example.com" matches "example.com" and "blog.example.com".
 */
function matchesDomain(resultUrl, targetDomain, includeSubdomains = true) {
  const hostname = getHostname(resultUrl);
  if (!hostname) return false;

  const normalizedHost = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  if (normalizedHost === targetDomain) return true;

  return includeSubdomains && normalizedHost.endsWith(`.${targetDomain}`);
}

// ---------------------------------------------------------------------------
// DuckDuckGo parsing
// ---------------------------------------------------------------------------

function looksLikeChallenge(html) {
  return [
    /id=["']anomaly-modal["']/i,
    /class=["'][^"']*\banomaly-modal\b/i,
    /challenge-form/i,
    /unusual traffic/i,
    /bots use DuckDuckGo/i,
  ].some((pattern) => pattern.test(html));
}

/**
 * Parse one results page.
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

    organicCount += 1;
    const position = startPosition + organicCount - 1;

    const $anchor = $result.find('a.result__a').first();
    if ($anchor.length === 0) return;

    let url = resolveResultUrl($anchor.attr('href'));
    if (!url) {
      url = resolveResultUrl($result.find('a.result__url').first().attr('href'));
    }
    if (!url) return;

    const title = cleanText($anchor.text());
    if (!title) return;

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
  const actionUrl = new URL(form.action, SEARCH_ORIGIN);

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

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

async function requestPage({
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

      if (response.status === 403 || response.status === 429) {
        throw new ScraperError(
          `DuckDuckGo blocked the request (HTTP ${response.status}).`,
          { code: 'BLOCKED', status: response.status }
        );
      }

      if (response.status === 202 && !html.includes('result__a')) {
        throw new ScraperError(
          'DuckDuckGo returned a challenge page (HTTP 202).',
          { code: 'CHALLENGE', status: response.status }
        );
      }

      if (response.status < 200 || response.status >= 300) {
        throw new ScraperError(`DuckDuckGo returned HTTP ${response.status}.`, {
          code: 'HTTP_ERROR',
          status: response.status,
        });
      }

      if (!html.includes('result__a') && looksLikeChallenge(html)) {
        throw new ScraperError('DuckDuckGo returned a bot challenge page.', {
          code: 'CHALLENGE',
          status: response.status,
        });
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
    `Failed to fetch DuckDuckGo results: ${lastError?.message || 'unknown error'}`,
    { code: 'REQUEST_FAILED', cause: lastError }
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check where `domain` ranks for `keyword` in DuckDuckGo organic results.
 *
 * @param {string} domain  Domain or URL, e.g. "example.com" or "https://www.example.com".
 * @param {string} keyword Search query.
 * @param {object} [options]
 * @param {number} [options.maxPages]           Maximum result pages to scan (default: MAX_RESULT_PAGES or 5).
 * @param {number} [options.requestDelayMs]     Delay between page requests in ms (default: REQUEST_DELAY_MS or 1000).
 * @param {number} [options.timeoutMs]          Per-request timeout in ms (default: REQUEST_TIMEOUT_MS or 15000).
 * @param {number} [options.retries]            Retry attempts per page request (default: 1).
 * @param {boolean} [options.includeSubdomains] Match subdomains too (default: true).
 * @param {AbortSignal} [options.signal]        Optional abort signal.
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

  const searchUrl = new URL(SEARCH_URL);
  searchUrl.searchParams.set('q', query);

  let request = {
    method: 'GET',
    url: searchUrl.toString(),
    data: undefined,
    referer: undefined,
    origin: undefined,
  };

  let page = 1;
  let startPosition = 1;
  let scannedResults = 0;
  let pagesChecked = 0;
  const seenUrls = new Set();
  const checkedAt = new Date().toISOString();

  while (page <= maxPages) {
    if (page > 1) {
      // Small jitter makes page-to-page timing less mechanical.
      await sleep(requestDelayMs + Math.floor(Math.random() * 500));
    }

    const html = await requestPage({
      ...request,
      timeoutMs,
      retries,
      signal,
    });

    const $ = cheerio.load(html);
    const { results, organicCount } = parseResults(
      $,
      page,
      startPosition,
      seenUrls
    );

    const pageLastPosition = startPosition + organicCount - 1;
    if (organicCount > 0) scannedResults = pageLastPosition;
    pagesChecked = page;

    for (const result of results) {
      if (matchesDomain(result.url, targetDomain, includeSubdomains)) {
        return {
          found: true,
          keyword: query,
          domain: targetDomain,
          position: result.position,
          page: result.page,
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          resultDomain: result.domain,
          displayUrl: result.displayUrl,
          scannedResults,
          pagesChecked,
          checkedAt,
        };
      }
    }

    if (page >= maxPages) break;

    const nextForm = extractNextPageForm($);
    if (!nextForm) break;

    // DDG's hidden "s" field is the number of results already shown, so it
    // gives us the exact offset for the next page (10, 25, 40, ...).
    const nextOffset = Number(nextForm.fields.s);
    startPosition =
      Number.isFinite(nextOffset) && nextOffset >= 0
        ? Math.max(pageLastPosition + 1, nextOffset + 1)
        : pageLastPosition + 1;

    request = {
      ...buildPageRequest(nextForm),
      referer: searchUrl.toString(),
      origin: SEARCH_ORIGIN,
    };

    page += 1;
  }

  return {
    found: false,
    keyword: query,
    domain: targetDomain,
    position: null,
    page: null,
    url: null,
    title: null,
    snippet: null,
    resultDomain: null,
    displayUrl: null,
    scannedResults,
    pagesChecked,
    checkedAt,
  };
}

module.exports = {
  checkKeywordRank,
  normalizeDomain,
  normalizeKeyword,
  parseResults,
  extractNextPageForm,
  resolveResultUrl,
  matchesDomain,
  buildHeaders,
  ScraperError,
  SEARCH_URL,
};
