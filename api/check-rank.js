'use strict';

/**
 * POST /api/check-rank
 *
 * Vercel Node.js Function. The frontend calls this relative URL, so it works
 * on localhost (`vercel dev`, `npm start`) and on any deployment domain.
 */

const { handleCheckRank } = require('../lib/rankHandler');

module.exports = handleCheckRank;
