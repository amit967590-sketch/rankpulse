'use strict';

const pkg = require('../package.json');
const { config } = require('./config');
const { setCommonHeaders, sendJson } = require('./http');

/**
 * GET /api/health (also reachable at /health via a rewrite in vercel.json).
 * Exposes only non-sensitive configuration so a deployment can be verified
 * without leaking API keys.
 */
function handleHealth(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(
      res,
      405,
      { success: false, code: 'METHOD_NOT_ALLOWED', error: 'Use GET.' },
      { Allow: 'GET, HEAD' }
    );
  }

  setCommonHeaders(res);

  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end();
  }

  return sendJson(res, 200, {
    status: 'ok',
    service: 'RankPulse — SEO Keyword Rank Checker',
    version: pkg.version,
    runtime: 'vercel',
    engine: config.engine,
    maxPages: config.maxPages,
    targetResults: config.targetResults,
    retries: config.retries,
    proxyFallback: config.proxyFallback,
    timeBudgetMs: config.timeBudgetMs,
    region: process.env.VERCEL_REGION || null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA
      ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
      : null,
    timestamp: new Date().toISOString(),
  });
}

module.exports = { handleHealth };
