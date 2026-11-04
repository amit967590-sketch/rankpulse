'use strict';

(() => {
  const form = document.getElementById('rank-form');
  const domainInput = document.getElementById('domain');
  const keywordInput = document.getElementById('keyword');
  const domainError = document.getElementById('domain-error');
  const keywordError = document.getElementById('keyword-error');
  const submitBtn = document.getElementById('submit-btn');
  const submitLabel = document.getElementById('submit-label');
  const exampleChips = document.querySelectorAll('.example-chip');

  const resultsSection = document.getElementById('results');
  const resultCard = document.getElementById('result-card');
  const newCheckBtn = document.getElementById('new-check-btn');
  const rankLabel = document.getElementById('rank-label');
  const rankNumber = document.getElementById('rank-number');
  const rankPage = document.getElementById('rank-page');
  const resultDomain = document.getElementById('result-domain');
  const resultStatusText = document.getElementById('result-status-text');
  const resultTitleLink = document.getElementById('result-title-link');
  const resultUrl = document.getElementById('result-url');
  const resultSnippet = document.getElementById('result-snippet');
  const resultTags = document.getElementById('result-tags');
  const summaryScanned = document.getElementById('summary-scanned');
  const summaryPages = document.getElementById('summary-pages');
  const summaryTime = document.getElementById('summary-time');

  const toast = document.getElementById('toast');
  const toastIcon = document.getElementById('toast-icon');
  const toastTitle = document.getElementById('toast-title');
  const toastMessage = document.getElementById('toast-message');
  const toastClose = document.getElementById('toast-close');
  const year = document.getElementById('year');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const scrollBehavior = () => (reduceMotion.matches ? 'auto' : 'smooth');

  let isLoading = false;
  let activeController = null;
  let requestSequence = 0;
  let toastTimer = null;
  let toastHideTimer = null;

  year.textContent = String(new Date().getFullYear());

  /* ------------------------------------------------------------------------
     Toast notifications
     ------------------------------------------------------------------------ */

  function showToast(title, message, variant = 'error') {
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);

    const iconId =
      variant === 'info' ? 'icon-info' : variant === 'success' ? 'icon-check' : 'icon-alert';

    toastTitle.textContent = title;
    toastMessage.textContent = message;
    toastIcon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#${iconId}"></use></svg>`;
    toast.className = `toast toast--${variant}`;
    toast.hidden = false;

    // Force a reflow so repeated toasts replay the entrance transition.
    void toast.offsetWidth;
    toast.classList.add('is-visible');

    toastTimer = setTimeout(hideToast, 6500);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    clearTimeout(toastHideTimer);
    toast.classList.remove('is-visible');

    toastHideTimer = setTimeout(() => {
      toast.hidden = true;
    }, 220);
  }

  toastClose.addEventListener('click', hideToast);

  toast.addEventListener('mouseenter', () => {
    clearTimeout(toastTimer);
  });

  toast.addEventListener('mouseleave', () => {
    if (!toast.hidden) {
      toastTimer = setTimeout(hideToast, 2500);
    }
  });

  /* ------------------------------------------------------------------------
     Field helpers & formatting
     ------------------------------------------------------------------------ */

  function setFieldError(input, errorEl, message) {
    input.setAttribute('aria-invalid', 'true');
    errorEl.textContent = message;
    errorEl.classList.add('is-visible');
  }

  function clearFieldError(input, errorEl) {
    input.removeAttribute('aria-invalid');
    errorEl.textContent = '';
    errorEl.classList.remove('is-visible');
  }

  function formatCount(value) {
    if (value === null || value === undefined || value === '') return '—';
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
      ? new Intl.NumberFormat('en-US').format(number)
      : '—';
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function safeHttpUrl(value) {
    if (!value) return null;

    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function engineName(value) {
    if (value === 'duckduckgo') return 'DuckDuckGo';
    if (value === 'google') return 'Google';
    return 'Google';
  }

  /* ------------------------------------------------------------------------
     Results rendering
     ------------------------------------------------------------------------ */

  function renderResult(data) {
    const found = data.found === true && Number(data.position) > 0;
    const domain = data.resultDomain || data.domain || domainInput.value.trim();
    const keyword = data.keyword || keywordInput.value.trim();
    const safeUrl = found ? safeHttpUrl(data.url) : null;
    const pagesChecked = Number(data.pagesChecked);
    const resultsScanned =
      data.resultsScanned === undefined ? data.scannedResults : data.resultsScanned;

    resultCard.classList.toggle('is-miss', !found);

    rankLabel.textContent = found ? 'Ranking position' : 'Ranking status';
    rankNumber.textContent = found ? `#${data.position}` : '—';
    rankPage.textContent = found
      ? `Page ${data.page ?? '—'}`
      : Number.isFinite(pagesChecked) && pagesChecked > 0
        ? `Top ${pagesChecked} page${pagesChecked === 1 ? '' : 's'}`
        : 'No results';

    resultDomain.textContent = domain;
    resultDomain.title = domain;
    resultStatusText.textContent = found ? 'Rank found' : 'Not found';

    if (found) {
      resultTitleLink.textContent = data.title || 'Untitled result';

      if (safeUrl) {
        resultTitleLink.href = safeUrl;
      } else {
        resultTitleLink.removeAttribute('href');
      }

      resultUrl.hidden = !safeUrl;
      if (safeUrl) {
        resultUrl.href = safeUrl;
        resultUrl.textContent = data.url;
      } else {
        resultUrl.removeAttribute('href');
        resultUrl.textContent = '';
      }

      resultSnippet.textContent = data.snippet || 'No snippet was returned for this result.';
    } else {
      resultTitleLink.removeAttribute('href');
      resultTitleLink.textContent = 'Your domain was not found in the scanned results';
      resultUrl.hidden = true;
      resultUrl.removeAttribute('href');
      resultUrl.textContent = '';

      const scanned = formatCount(resultsScanned);
      const pages = formatCount(data.pagesChecked);
      const pageWord = Number(data.pagesChecked) === 1 ? 'page' : 'pages';

      resultSnippet.textContent =
        data.message ||
        `We scanned ${scanned} organic results across ${pages} ${pageWord} for ` +
          `“${keyword}” but couldn’t find ${domain}. Try a broader keyword or run ` +
          'the check again.';
    }

    resultTags.replaceChildren();

    const keywordTag = document.createElement('span');
    keywordTag.className = 'result-tag';
    keywordTag.textContent = `Keyword: ${keyword}`;
    resultTags.append(keywordTag);

    const sourceTag = document.createElement('span');
    sourceTag.className = 'result-tag';
    sourceTag.textContent = `Source: ${engineName(data.engine)}`;
    resultTags.append(sourceTag);

    summaryScanned.textContent = formatCount(resultsScanned);
    summaryPages.textContent = formatCount(data.pagesChecked);
    summaryTime.textContent = formatDateTime(data.checkedAt);
  }

  function hideResults() {
    resultsSection.hidden = true;
    resultsSection.classList.remove('is-visible');
  }

  function revealResults() {
    resultsSection.hidden = false;
    resultsSection.classList.remove('is-visible');

    // Restart the entrance animation when a new result is rendered.
    void resultsSection.offsetWidth;
    resultsSection.classList.add('is-visible');

    window.requestAnimationFrame(() => {
      resultsSection.scrollIntoView({
        behavior: scrollBehavior(),
        block: 'start',
      });
    });
  }

  /* ------------------------------------------------------------------------
     Loading state
     ------------------------------------------------------------------------ */

  function setLoading(loading) {
    isLoading = loading;
    form.setAttribute('aria-busy', String(loading));
    submitBtn.disabled = loading;
    domainInput.disabled = loading;
    keywordInput.disabled = loading;
    submitBtn.classList.toggle('loading', loading);
    submitLabel.textContent = loading ? 'Scanning SERPs…' : 'Check My Ranking';

    exampleChips.forEach((chip) => {
      chip.disabled = loading;
    });
  }

  /* ------------------------------------------------------------------------
     Error messages
     ------------------------------------------------------------------------ */

  function friendlyError(error) {
    if (error.code === 'CHALLENGE' || error.code === 'CONSENT') {
      return {
        title: 'Verification challenge',
        message:
          'The search engine is asking for a quick bot check. Wait about a minute, then try again.',
      };
    }

    if (error.code === 'BLOCKED') {
      return {
        title: 'Temporarily blocked',
        message:
          'The search provider is rate-limiting requests right now. Give it a minute and retry.',
      };
    }

    if (error.status === 429) {
      return {
        title: 'Too many requests',
        message:
          'You have run a lot of checks in a short time. Wait a few minutes before trying again.',
      };
    }

    if (
      error.code === 'HTTP_ERROR' ||
      error.code === 'REQUEST_FAILED' ||
      error.code === 'EMPTY_RESULTS' ||
      error.code === 'INSUFFICIENT_RESULTS' ||
      error.status === 502 ||
      error.status === 503
    ) {
      return {
        title: 'Search provider unavailable',
        message:
          'Google and DuckDuckGo did not respond as expected. Please try again in a moment.',
      };
    }

    if (error.code === 'VALIDATION_ERROR') {
      return {
        title: 'Check your inputs',
        message: 'Enter both a target domain and a keyword to run a check.',
      };
    }

    if (error.code === 'NOT_FOUND') {
      return {
        title: 'API unavailable',
        message:
          'The rank-check endpoint was not found. Make sure the server is running and try again.',
      };
    }

    if (error.code === 'INTERNAL_ERROR') {
      return {
        title: 'Server error',
        message: 'The server hit an unexpected error. Please try again.',
      };
    }

    if (error.name === 'TypeError') {
      return {
        title: 'Network error',
        message: 'Could not reach the server. Check your connection and try again.',
      };
    }

    return {
      title: 'Something went wrong',
      message: error.message || 'An unexpected error occurred. Please try again.',
    };
  }

  function handleError(error) {
    const { title, message } = friendlyError(error);
    showToast(title, message, 'error');
  }

  /* ------------------------------------------------------------------------
     Form submission
     ------------------------------------------------------------------------ */

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (isLoading) return;

    clearFieldError(domainInput, domainError);
    clearFieldError(keywordInput, keywordError);

    const domain = domainInput.value.trim();
    const keyword = keywordInput.value.trim();
    let firstInvalid = null;

    if (!domain) {
      setFieldError(domainInput, domainError, 'Enter a domain to check.');
      firstInvalid = domainInput;
    }

    if (!keyword) {
      setFieldError(keywordInput, keywordError, 'Enter a keyword to check.');
      firstInvalid = firstInvalid || keywordInput;
    }

    if (firstInvalid) {
      showToast(
        'Missing details',
        'Enter both a target domain and a keyword to run a check.',
        'error'
      );
      firstInvalid.focus();
      return;
    }

    if (activeController) activeController.abort();

    const controller = new AbortController();
    activeController = controller;
    const requestId = ++requestSequence;

    hideResults();
    setLoading(true);

    try {
      const response = await fetch('/api/check-rank', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ domain, keyword }),
        signal: controller.signal,
      });

      let payload = {};
      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        payload = await response.json().catch(() => ({}));
      }

      if (!response.ok || payload.success !== true) {
        const message =
          payload.error ||
          (response.ok
            ? 'The server returned an unexpected response.'
            : `Request failed with status ${response.status}.`);

        const error = new Error(message);
        error.code = payload.code;
        error.status = response.status;
        throw error;
      }

      if (requestId !== requestSequence) return;

      renderResult(payload);
      revealResults();
    } catch (error) {
      if (error.name === 'AbortError' || requestId !== requestSequence) return;
      handleError(error);
    } finally {
      if (requestId === requestSequence) {
        setLoading(false);
        activeController = null;
      }
    }
  });

  /* ------------------------------------------------------------------------
     Input & example interactions
     ------------------------------------------------------------------------ */

  domainInput.addEventListener('input', () => {
    clearFieldError(domainInput, domainError);
  });

  keywordInput.addEventListener('input', () => {
    clearFieldError(keywordInput, keywordError);
  });

  exampleChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      domainInput.value = chip.dataset.domain || '';
      keywordInput.value = chip.dataset.keyword || '';
      clearFieldError(domainInput, domainError);
      clearFieldError(keywordInput, keywordError);
      keywordInput.focus();
    });
  });

  newCheckBtn.addEventListener('click', () => {
    hideResults();
    document.getElementById('checker').scrollIntoView({
      behavior: scrollBehavior(),
      block: 'center',
    });
    domainInput.focus({ preventScroll: true });
    domainInput.select();
  });
})();
