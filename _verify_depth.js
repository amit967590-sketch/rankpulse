'use strict';

// Fixture-driven harness for the direct DuckDuckGo scraper.
// No network access and no API keys are required.
//
//   node _verify_depth.js
//
// axios is stubbed so pagination, deduplication, partial results, and the soft
// deadline can be checked deterministically.

const ROOT = __dirname;
process.env.DDG_PROXY_FALLBACK = 'false';

const axios = require(require.resolve('axios', { paths: [ROOT] }));
const { checkKeywordRank } = require(ROOT + '/utils/scraperHelper');

function resultBlock(index) {
  const url = `https://site${index}.example/page${index}`;
  const encoded = encodeURIComponent(url);
  return [
    '<div class="result">',
    `<a class="result__a" href="https://duckduckgo.com/l/?uddg=${encoded}">Result ${index}</a>`,
    `<a class="result__url" href="https://duckduckgo.com/l/?uddg=${encoded}">site${index}.example</a>`,
    `<div class="result__snippet">Snippet ${index}</div>`,
    '</div>',
  ].join('');
}

function pageHtml({
  offset,
  formOffset,
  startIndex,
  count,
  vqd,
  duplicateOf,
  repeatOfPageOne,
}) {
  const blocks = [];
  for (let i = 0; i < count; i += 1) {
    blocks.push(resultBlock(startIndex + i));
  }
  if (duplicateOf) blocks.push(resultBlock(duplicateOf));
  if (repeatOfPageOne) blocks.push(resultBlock(1));

  const form =
    formOffset !== null
      ? [
          '<div class="nav-link"><form action="/html/" method="post">',
          '<input type="submit" value="Next">',
          `<input type="hidden" name="s" value="${formOffset}">`,
          `<input type="hidden" name="vqd" value="${vqd}">`,
          '<input type="hidden" name="q" value="test query">',
          '</form></div>',
        ].join('')
      : '';

  // Real DDG pages also expose the token in links/scripts, which is what keeps
  // pagination possible when the "Next" form itself is absent.
  const tokenLink = `<a href="/html/?q=test+query&vqd=${vqd}" class="vqd-token"></a>`;

  return `<!DOCTYPE html><html><body><h1>offset ${offset}</h1><div id="links">${blocks.join(
    ''
  )}</div>${form}${tokenLink}</body></html>`;
}

const requests = [];
let htmlForOffset = () => '';
let failOffset = null;
let challengeAll = false;
let directBlocked = false;

axios.request = async (config) => {
  const proxy = config.url.startsWith('https://r.jina.ai/');
  const target = proxy ? config.url.slice('https://r.jina.ai/'.length) : config.url;
  const url = new URL(target);
  const offset = Number(url.searchParams.get('s') || 0);
  const vqd = url.searchParams.get('vqd') || '';
  requests.push({ offset, vqd, q: url.searchParams.get('q'), proxy });

  if (directBlocked && !proxy) {
    return { status: 403, data: 'Forbidden', headers: {}, config };
  }

  if (challengeAll) {
    return {
      status: 200,
      data:
        '<html><body><div id="anomaly-modal">Unusual traffic from your computer network</div></body></html>',
      headers: {},
      config,
    };
  }

  if (failOffset !== null && offset === failOffset) {
    return { status: 429, data: 'Too many requests', headers: {}, config };
  }

  return {
    status: 200,
    data: htmlForOffset({ offset, vqd }),
    headers: {},
    config,
  };
};

function reset() {
  requests.length = 0;
  failOffset = null;
  challengeAll = false;
  directBlocked = false;
}

function report(name, result) {
  console.log(
    name,
    JSON.stringify({
      found: result.found,
      page: result.page,
      providerPage: result.providerPage,
      position: result.position,
      resultsScanned: result.resultsScanned,
      pagesChecked: result.pagesChecked,
      unavailable: result.unavailable || false,
      code: result.code || null,
      message: result.message,
    })
  );
}

let failures = 0;

function assert(name, condition, detail) {
  if (!condition) {
    failures += 1;
    console.error('FAIL:', name, detail || '');
  } else {
    console.log('PASS:', name);
  }
}

/**
 * Build a fixture with a configurable result count per page.
 *
 * `omitFormPages` hides DDG's "Next" form on those pages while still serving
 * later pages, which exercises the offset fallback.
 */
function fixture({
  pageCount = 5,
  page1Count = 10,
  perPage = 10,
  omitFormPages = [],
  repeatPageOne = false,
  vqd = '4-test-token',
} = {}) {
  const offsets = [0];
  let total = page1Count;
  for (let page = 2; page <= pageCount; page += 1) {
    offsets.push(total);
    total += perPage;
  }

  return ({ offset }) => {
    let index = offsets.indexOf(offset);
    const page = index >= 0 ? index + 1 : Math.floor(offset / perPage) + 1;

    if (repeatPageOne) {
      return pageHtml({
        offset,
        formOffset: 10,
        startIndex: 1,
        count: page1Count,
        vqd,
      });
    }

    const startIndex =
      page === 1 ? 1 : page1Count + (page - 2) * perPage + 1;
    const count = page === 1 ? page1Count : perPage;
    const nextOffset = page < pageCount ? offsets[page] : null;
    const showForm = !omitFormPages.includes(page);

    return pageHtml({
      offset,
      formOffset: showForm ? nextOffset : null,
      startIndex,
      count,
      vqd,
    });
  };
}

(async () => {
  // 1. Domain on page 3 -> aggregation, position tracking, vqd propagation.
  reset();
  htmlForOffset = fixture({ pageCount: 5 });

  let result = await checkKeywordRank('site22.example', 'test query', {
    maxPages: 10,
    targetResults: 150,
    retries: 0,
  });
  report('page 3 match', result);
  assert('found on page 3', result.found && result.page === 3);
  assert('position 22', result.position === 22, result.position);
  assert('30 results scanned', result.resultsScanned === 30);
  assert('3 pages checked', result.pagesChecked === 3);
  assert(
    'vqd sent on later pages',
    requests.slice(1).every((request) => request.vqd === '4-test-token'),
    JSON.stringify(requests)
  );
  assert(
    'offsets follow next form',
    JSON.stringify(requests.map((request) => request.offset)) === '[0,10,20]',
    JSON.stringify(requests.map((request) => request.offset))
  );

  // 2. Duplicate URL across pages is returned once but positions stay intact.
  reset();
  htmlForOffset = ({ offset }) => {
    const page = offset / 10 + 1;
    return pageHtml({
      offset,
      formOffset: page < 2 ? 10 : null,
      startIndex: (page - 1) * 10 + 1,
      count: 10,
      vqd: '4-dup',
      duplicateOf: page > 1 ? 1 : undefined,
    });
  };

  result = await checkKeywordRank('site12.example', 'test query', {
    maxPages: 10,
    targetResults: 150,
    retries: 0,
  });
  report('duplicate page', result);
  assert('duplicate does not break positions', result.position === 12, result.position);

  // 3. Later page rate-limit ends the scan with partial results.
  reset();
  failOffset = 10;
  htmlForOffset = fixture({ pageCount: 5 });

  result = await checkKeywordRank('site99.example', 'test query', {
    maxPages: 10,
    targetResults: 150,
    retries: 0,
  });
  report('rate limit on page 2', result);
  assert('partial scan survives page 2 error', result.pagesChecked === 1);
  assert('partial results returned', result.resultsScanned === 10);
  assert(
    'partial message explains early stop',
    /rate-limiting/.test(result.message || ''),
    result.message
  );

  // 4. The default depth scans all ten pages when the result cap allows it.
  reset();
  htmlForOffset = fixture({ pageCount: 10 });

  result = await checkKeywordRank('missing.example', 'test query', {
    maxPages: 10,
    targetResults: 150,
    retries: 0,
  });
  report('ten pages', result);
  assert('ten pages checked', result.pagesChecked === 10, result.pagesChecked);
  assert('100 results scanned', result.resultsScanned === 100);
  assert('ten requests made', requests.length === 10, requests.length);
  assert(
    'offset advances through every page',
    JSON.stringify(requests.map((request) => request.offset)) ===
      '[0,10,20,30,40,50,60,70,80,90]',
    JSON.stringify(requests.map((request) => request.offset))
  );

  // 5. Missing "Next" forms no longer stop the scan before later pages.
  reset();
  htmlForOffset = fixture({ pageCount: 5, omitFormPages: [1, 2] });

  result = await checkKeywordRank('site22.example', 'test query', {
    maxPages: 10,
    targetResults: 150,
    retries: 0,
  });
  report('missing next form', result);
  assert('missing form still finds page 3', result.found && result.page === 3);
  assert('missing form position 22', result.position === 22, result.position);
  assert(
    'fallback offsets advance by page size',
    JSON.stringify(requests.map((request) => request.offset)) === '[0,10,20]',
    JSON.stringify(requests.map((request) => request.offset))
  );

  // 6. A provider that ignores the offset (serving page 1 again) is detected
  //    instead of inflating positions with duplicates.
  reset();
  htmlForOffset = fixture({ pageCount: 10, repeatPageOne: true });

  result = await checkKeywordRank('missing.example', 'test query', {
    maxPages: 10,
    targetResults: 150,
    retries: 0,
  });
  report('repeated page', result);
  assert('repeated page stops after two requests', requests.length === 2, requests.length);
  assert('repeated page does not inflate results', result.resultsScanned === 10);
  assert(
    'repeated page message',
    /repeated the same results/.test(result.message || ''),
    result.message
  );

  // 7. Page numbers are conventional (10 results/page), not DDG's own pages.
  reset();
  htmlForOffset = fixture({ pageCount: 3, page1Count: 15, perPage: 15 });

  result = await checkKeywordRank('site21.example', 'test query', {
    maxPages: 10,
    targetResults: 150,
    retries: 0,
  });
  report('conventional page mapping', result);
  assert('position 21', result.position === 21, result.position);
  assert('provider page 2', result.providerPage === 2, result.providerPage);
  assert('reported as page 3', result.page === 3, result.page);

  // 8. Soft deadline returns partial results instead of throwing.
  reset();
  htmlForOffset = fixture({ pageCount: 10 });

  result = await checkKeywordRank('missing.example', 'test query', {
    maxPages: 10,
    targetResults: 150,
    retries: 0,
    timeBudgetMs: 1,
  });
  report('soft deadline', result);
  assert('deadline stops after page 1', result.pagesChecked === 1);
  assert(
    'deadline message',
    /time limit/.test(result.message || ''),
    result.message
  );

  // 9. A first-page challenge is reported as unavailable, not "not found".
  reset();
  challengeAll = true;

  result = await checkKeywordRank('missing.example', 'test query', {
    maxPages: 10,
    targetResults: 150,
    retries: 0,
  });
  report('first-page challenge', result);
  assert('challenge is unavailable', result.unavailable === true);
  assert('challenge code', result.code === 'CHALLENGE', result.code);
  assert('challenge is marked blocked', result.blocked === true);

  // 10. A blocked direct request falls back to the free proxy for the whole scan.
  reset();
  directBlocked = true;
  htmlForOffset = fixture({ pageCount: 3 });

  result = await checkKeywordRank('site15.example', 'test query', {
    maxPages: 3,
    targetResults: 150,
    retries: 0,
    requestDelayMs: 0,
    proxyFallback: true,
  });
  report('proxy fallback', result);
  assert('proxy fallback finds page 2 match', result.found && result.page === 2);
  assert('proxy fallback position 15', result.position === 15, result.position);
  assert(
    'direct tried once then proxy used',
    requests.filter((request) => !request.proxy).length === 1 &&
      requests.filter((request) => request.proxy).length === 2,
    JSON.stringify(requests)
  );
  assert(
    'proxy pagination keeps vqd',
    requests.filter((request) => request.proxy).slice(1).every((request) => request.vqd === '4-test-token'),
    JSON.stringify(requests)
  );

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll assertions passed.');
  }
})();
