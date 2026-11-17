'use strict';

/**
 * GET /api/health
 *
 * Verifies that the function runtime and environment variables are wired up.
 */

const { handleHealth } = require('../lib/healthHandler');

module.exports = handleHealth;
