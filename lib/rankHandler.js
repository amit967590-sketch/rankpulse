'use strict';

const { checkKeywordRank, ScraperError } = require('../utils/scraperHelper');
const { config, VALIDATION_LIMITS } = require('./config');
const {
  setCommonHeaders,
  sendJson,
  applyCors,
  readJsonBody,
} = require('./http');
const { createRateLimiter } = require('./rateLimit');

const limiter = createRateLimiter(config.rateLimit);

// HTTP status for each scraper error code.
const STATUS_BY_CODE = {
  INVALID_DOMAIN: 400,
  INVALID_KEYWORD: 400,
  CHALLENGE: 503,
  BLOCKED: 503,
  CONSENT: 503,
  EMPTY_RESULTS: 502,
  INSUFFICIENT_RESULTS: 502,
  HTTP_ERROR: 502,
  REQUEST_FAILED: 502,
};

const BLOCKED_CODES = new Set(['CHALLENGE', 'BLOCKED', 'CONSENT']);

// Reserve part of the function budget for the page already in flight plus the
// JSON response, so the scraper stops paging and returns partial results
// instead of being killed by the hard AbortSignal below.
const SCANNER_DEADLINE_MARGIN_MS = 45000;

function readField(body, name, limit) {
  const value = body?.[name];

  if (typeof value !== 'string') return { value: '', tooLong: false };

  const trimmed = value.trim();

  return { value: trimmed, tooLong: trimmed.length > limit };
}

function validateInput(body) {
  const domain = readField(body, 'domain', VALIDATION_LIMITS.domain);
  const keyword = readField(body, 'keyword', VALIDATION_LIMITS.keyword);

  if (domain.tooLong || keyword.tooLong) {
    return {
      error: {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: `Domain must be under ${VALIDATION_LIMITS.domain} characters and keyword under ${VALIDATION_LIMITS.keyword}.`,
      },
    };
  }

  if (!domain.value || !keyword.value) {
    const missing = [];

    if (!domain.value) missing.push('domain');
    if (!keyword.value) missing.push('keyword');

    return {
      error: {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(
          ', '
        )}.`,
      },
    };
  }

  return { domain: domain.value, keyword: keyword.value };
}

function buildSuccessPayload(result) {
  const resultsScanned = Number.isFinite(result.resultsScanned)
    ? result.resultsScanned
    : Number.isFinite(result.scannedResults)
      ? result.scannedResults
      : 0;

  return {
    success: true,
    found: result.found,
    domain: result.domain,
    keyword: result.keyword,
    engine: result.engine,
    position: result.position,
    page: result.page,
    providerPage: result.providerPage,
    url: result.url,
    title: result.title,
    snippet: result.snippet,
    resultsScanned,
    // Kept for backwards compatibility with the existing frontend.
    scannedResults: resultsScanned,
    pagesChecked: result.pagesChecked,
    checkedAt: result.checkedAt,
    message: result.message || null,
  };
}

function isAbortError(error, signal) {
  return (
    Boolean(signal?.aborted) ||
    error?.name === 'AbortError' ||
    error?.name === 'CanceledError' ||
    error?.code === 'ERR_CANCELED'
  );
}

async function handleCheckRank(req, res) {
  setCommonHeaders(res);

  if (!applyCors(req, res, config.allowedOrigins)) {
    return sendJson(res, 403, {
      success: false,
      code: 'ORIGIN_NOT_ALLOWED',
      error: 'This origin is not allowed to call the rank checker.',
    });
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'POST') {
    return sendJson(
      res,
      405,
      {
        success: false,
        code: 'METHOD_NOT_ALLOWED',
        error: 'Use POST with a JSON body of { "domain": "...", "keyword": "..." }.',
      },
      { Allow: 'POST, OPTIONS' }
    );
  }

  const limit = limiter(req);
  if (!limit.allowed) {
    return sendJson(
      res,
      429,
      {
        success: false,
        code: 'RATE_LIMITED',
        error: 'Too many requests, please try again later.',
      },
      { 'Retry-After': String(limit.retryAfter) }
    );
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      success: false,
      code: 'INVALID_BODY',
      error: error.message || 'Could not read the request body.',
    });
  }

  const input = validateInput(body);
  if (input.error) {
    return sendJson(res, input.error.status, {
      success: false,
      code: input.error.code,
      error: input.error.message,
    });
  }

  // Hard deadline well inside the function's maxDuration so the client always
  // gets a JSON answer instead of Vercel's FUNCTION_INVOCATION_TIMEOUT page.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.timeBudgetMs);
  if (typeof deadline.unref === 'function') deadline.unref();

  try {
    const result = await checkKeywordRank(input.domain, input.keyword, {
      maxPages: config.maxPages,
      targetResults: config.targetResults,
      retries: config.retries,
      proxyFallback: config.proxyFallback,
      timeBudgetMs: Math.max(
        config.timeBudgetMs - SCANNER_DEADLINE_MARGIN_MS,
        5000
      ),
      signal: controller.signal,
    });

    // The scraper reports "could not read any engine" as unavailable instead of
    // throwing. Surface that as a real error so the UI never shows a false
    // "not found" result for a blocked scan.
    if (result && result.unavailable === true) {
      const status = BLOCKED_CODES.has(result.code) ? 503 : 502;

      console.error(`[check-rank] ${result.code || 'UNAVAILABLE'}: ${result.message}`);

      return sendJson(
        res,
        status,
        {
          success: false,
          code: result.code || 'REQUEST_FAILED',
          error: result.message || 'The search provider could not be read.',
        },
        status === 503 ? { 'Retry-After': '60' } : {}
      );
    }

    return sendJson(res, 200, buildSuccessPayload(result));
  } catch (error) {
    if (isAbortError(error, controller.signal)) {
      console.error(
        `[check-rank] REQUEST_TIMEOUT after ${config.timeBudgetMs}ms`
      );

      return sendJson(res, 504, {
        success: false,
        code: 'REQUEST_TIMEOUT',
        error:
          'The scan took too long to finish. Try again, or reduce MAX_RESULT_PAGES.',
      });
    }

    if (error instanceof ScraperError) {
      const status = STATUS_BY_CODE[error.code] || 500;

      console.error(`[check-rank] ${error.code}: ${error.message}`);

      return sendJson(
        res,
        status,
        {
          success: false,
          code: error.code,
          error: error.message,
        },
        status === 503 ? { 'Retry-After': '60' } : {}
      );
    }

    console.error('[check-rank] Unexpected error:', error);

    return sendJson(res, 500, {
      success: false,
      code: 'INTERNAL_ERROR',
      error: 'An unexpected error occurred while checking the keyword rank.',
    });
  } finally {
    clearTimeout(deadline);
  }
}

module.exports = {
  handleCheckRank,
  buildSuccessPayload,
  validateInput,
  STATUS_BY_CODE,
};
