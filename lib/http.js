'use strict';

/**
 * Small HTTP helpers shared by the Vercel Functions.
 * They intentionally use only Node's ServerResponse primitives so the same
 * handlers work under `vercel dev`, `vercel deploy`, and plain Node tests.
 */

const MAX_BODY_BYTES = 64 * 1024;

function setCommonHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent) return;

  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }

  res.end(JSON.stringify(payload));
}

/**
 * Apply CORS headers. Mirrors the old Express setup: no ALLOWED_ORIGINS means
 * "allow any origin", a configured list means only those origins get a pass.
 *
 * @returns {boolean} false when the caller's Origin is explicitly disallowed.
 */
function applyCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;

  res.setHeader('Vary', 'Origin');

  if (allowedOrigins.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else if (!origin) {
    // Non-browser clients (curl, uptime checks) do not send Origin.
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0]);
  } else {
    return false;
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');

  return true;
}

function parseBody(value) {
  if (!value) return {};

  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    return value;
  }

  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);

  if (!text.trim()) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * Vercel parses JSON bodies automatically for the Node runtime. This fallback
 * reads the raw stream when it does not (for example a missing Content-Type).
 */
async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return parseBody(req.body);
  }

  if (typeof req[Symbol.asyncIterator] !== 'function') {
    return {};
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body too large.');
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  return parseBody(Buffer.concat(chunks));
}

module.exports = {
  MAX_BODY_BYTES,
  setCommonHeaders,
  sendJson,
  applyCors,
  readJsonBody,
};
