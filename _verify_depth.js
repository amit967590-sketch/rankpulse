'use strict';

// Temporary harness: stubs axios + timers so scan depth and pacing are observable.
const assert = require('assert');

const CASE = process.env.CASE;
const delays = [];
const calls = [];

if (CASE === 'proxied-pacing' || CASE === 'page1-blocked-fallback') {
  process.env.SCRAPER_API_KEY = 'test-key';
} else {
  delete process.env.SCRAPER_API_KEY;
}
delete process.env.MAX_RESULT_PAGES;
delete process.env.TARGET_ORGANIC_RESULTS;

// Record sleeps instead of waiting for them.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...rest) => {
  delays.push(ms);
  return realSetTimeout(fn, 0, ...rest);
};

function googleHtml(page) {
  const items = [];
  for (let i = 0; i < 10; i += 1) {
    const pos = (page - 1) * 10 + i + 1;
    items.push(
      `<div class="g"><a href="https://site${pos}.com/page"><h3>Result ${pos}</h3></a></div>`
    );
  }
  return (
    '<html><body><div id="rso">' +
    items.join('') +
    `</div><a id="pnnext" href="/search?q=x&start=${page * 10}">Next</a></body></html>`
  );
}

function ddgHtml() {
  return (
    '<html><body><div id="links">' +
    '<div class="result"><h2 class="result__title">' +
    '<a class="result__a" href="https://target.example.com/a">Target</a></h2></div>' +
    '</div></body></html>'
  );
}

const axios = require('axios');
axios.request = async (config) => {
  const url = String(config.url);
  const viaProxy = url.startsWith('https://api.scraperapi.com');
  const target = viaProxy ? new URL(url).searchParams.get('url') : url;
  calls.push({ target, viaProxy });

  if (CASE === 'page1-blocked-fallback') {
    if (target.includes('google.com')) return { status: 429, data: 'blocked' };
    return { status: 200, data: ddgHtml() };
  }

  const start = Number(new URL(target).searchParams.get('start') || 0);
  const page = start / 10 + 1;

  if (CASE === 'rate-limit-page-4' && page >= 4) {
    return { status: 429, data: 'rate limited' };
  }

  return { status: 200, data: googleHtml(page) };
};

require('./utils/scraperHelper')
  .checkKeywordRank(
    CASE === 'match-page-7'
      ? 'site61.com'
      : CASE === 'page1-blocked-fallback'
        ? 'target.example.com'
        : 'absent-domain.com',
    'best coffee beans',
    {
      retries: 0,
      ...(CASE === 'proxied-pacing' ? { maxPages: 3 } : {}),
    }
  )
  .then((r) => {
    const starts = calls.map((c) => {
      const u = new URL(c.target);
      return Number(u.searchParams.get('start') || 0);
    });
    console.log(
      `result found=${r.found} engine=${r.engine} position=${r.position} ` +
        `scanned=${r.resultsScanned} pages=${r.pagesChecked} requests=${calls.length}`
    );
    console.log('starts=' + JSON.stringify(starts));
    console.log('delays=' + JSON.stringify(delays.filter((d) => d >= 100)));
    if (r.message) console.log('message=' + r.message);

    if (CASE === 'ten-pages') {
      assert.strictEqual(r.found, false);
      assert.strictEqual(r.pagesChecked, 10);
      assert.strictEqual(r.resultsScanned, 100);
      assert.deepStrictEqual(starts, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
      assert.ok(!/stopped early/.test(r.message));
      const gaps = delays.filter((d) => d >= 1000);
      assert.strictEqual(gaps.length, 9);
      assert.ok(gaps.every((d) => d < 2000), 'direct pacing stays around 1s');
    }

    if (CASE === 'match-page-7') {
      assert.strictEqual(r.found, true);
      assert.strictEqual(r.position, 61);
      assert.strictEqual(r.pagesChecked, 7);
      assert.strictEqual(calls.length, 7);
    }

    if (CASE === 'rate-limit-page-4') {
      assert.strictEqual(r.found, false);
      assert.strictEqual(r.pagesChecked, 3);
      assert.strictEqual(r.resultsScanned, 30);
      assert.ok(/stopped early/.test(r.message), 'message explains the early stop');
      console.log('PASS kept partial scan');
    }

    if (CASE === 'page1-blocked-fallback') {
      assert.strictEqual(r.found, true);
      assert.strictEqual(r.engine, 'duckduckgo');
      assert.strictEqual(r.fallback, true);
      assert.ok(calls[1].viaProxy, 'fallback still proxied');
      console.log('PASS page-1 block still falls back');
    }

    if (CASE === 'proxied-pacing') {
      assert.strictEqual(r.pagesChecked, 3);
      const gaps = delays.filter((d) => d >= 1000);
      assert.strictEqual(gaps.length, 2);
      assert.ok(
        gaps.every((d) => d >= 3000 && d < 3600),
        'proxied pages wait >= 3000ms, got ' + JSON.stringify(gaps)
      );
      assert.ok(calls.every((c) => c.viaProxy));
      console.log('PASS proxied pacing');
    }

    console.log('ALL_OK');
  })
  .catch((e) => {
    console.error('FAIL', e.message);
    process.exit(1);
  });
