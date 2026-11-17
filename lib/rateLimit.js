'use strict';

/**
 * Best-effort in-memory rate limiter for serverless deployments.
 *
 * Vercel may run many isolated instances and recycle them at any time, so this
 * cannot be as strict as a shared Redis counter. It still stops a single client
 * from hammering a warm instance (and burning scraper credits) in a burst.
 */

const buckets = new Map();

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];

  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).split(',')[0].trim();
  }

  return req.socket?.remoteAddress || 'unknown';
}

function pruneExpired(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function createRateLimiter({ windowMs, max }) {
  let calls = 0;

  return function hit(req) {
    const now = Date.now();

    // Cheap housekeeping so the Map cannot grow without bound on a long-lived
    // warm instance.
    calls += 1;
    if (calls % 200 === 0) pruneExpired(now);

    const key = clientIp(req);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: Math.max(max - 1, 0), retryAfter: 0 };
    }

    bucket.count += 1;

    if (bucket.count > max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    return {
      allowed: true,
      remaining: Math.max(max - bucket.count, 0),
      retryAfter: 0,
    };
  };
}

module.exports = { createRateLimiter, clientIp };
