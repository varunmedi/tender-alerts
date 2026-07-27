import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { CONFIG, HOME_URL } from './config.js';

/**
 * AP eProcurement scraper (v9).
 *
 * Architecture:
 *  - ONE fresh, isolated browser context PER SEARCH (own cookies/session/
 *    anti-tamper tokens). Shared sessions leaked #subDeptId between searches
 *    and re-navigating a live session made the portal bounce Apply to
 *    SessionTimeOut — both are structurally impossible now.
 *  - Results stream from an async generator; each is fully processed by the
 *    caller before the next search starts (sequential, not concurrent).
 *  - Condition-based waits only; images/media/fonts blocked.
 *
 * Correctness guards (all fail closed, none assume portal behaviour that
 * field runs disproved):
 *  - POST body asserted against config's numeric deptId/subDeptId.
 *  - Columns located by HEADER text; required headers must map exactly once.
 *  - Pagination pages until Next disables, deduping by ID; conflicting
 *    duplicates refuse. Completeness is reported as `integrity`:
 *    'verified' when the DataTables count (page.info() API, else tolerant
 *    text parse) matches what we collected, else 'best-effort' — the caller
 *    suppresses withdrawal sweeps for 'best-effort' so unread pages can
 *    never be mistaken for withdrawn tenders.
 *  - Transient failures (navigation, session timeout, AJAX, browser death,
 *    Playwright timeouts) get ONE retry in a fresh context; config/schema
 *    errors (dept not found, ambiguous match, header changes) never retry.
 *
 * Proven portal mechanics that must not be "simplified":
 *  - Session must be minted on login.html; deep links bounce.
 *  - Navigation replicates the portal's own More... handler
 *    (loginForm.hdnType='current'; temp(tempName,'loginForm'); POST).
 *  - Apply = advsearchBtn() invoked DIRECTLY (Search and Apply share a
 *    duplicate id="searchTender").
 *  - Drive the portal only the way its own UI does: synthetic DOM surgery or
 *    calling its AJAX helpers with wrong args makes the anti-tamper backend
 *    invalidate the session server-side.
 */

// ------------------------- utilities -------------------------

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

/** Transient errors get ONE same-cycle retry with a fresh session;
 *  config/schema errors (dept not found, headers missing) never do. */
const scrapeError = (msg, transient = false) =>
  Object.assign(new Error(msg), { transient });

function dbg(...args) {
  if (CONFIG.debug) console.log('[debug]', ...args);
}

function ensureDebugDir() {
  fs.mkdirSync(CONFIG.debugDir, { recursive: true });
}

async function saveDebug(name, content) {
  try {
    ensureDebugDir();
    fs.writeFileSync(path.join(CONFIG.debugDir, name), content);
  } catch (e) {
    dbg(`saveDebug ${name} failed: ${e.message}`);
  }
}

async function screenshot(page, name) {
  if (!CONFIG.debug) return;
  try {
    ensureDebugDir();
    await page.screenshot({
      path: path.join(CONFIG.debugDir, `${name}.png`),
      fullPage: true,
    });
  } catch (e) {
    dbg(`screenshot ${name} failed: ${e.message}`);
  }
}

// ------------------- tender extraction -------------------

/** Columns: 0 Dept | 1 Tender ID | 2 Notice No | 3 Category | 4 Name of Work
 *  | 5 ECV | 6 Start | 7 Closing | 8 Action. ID must be numeric. */
const REQUIRED_HEADERS = {
  tenderId: ['tender id'],
  title: ['name of work'],
  closingDate: ['closing date'],
};
const OPTIONAL_HEADERS = {
  department: ['department name', 'department'],
  noticeNumber: ['tender notice number', 'notice no', 'notice number'],
  category: ['tender category', 'category'],
  value: ['estimated contract value', 'value'],
  publishedDate: ['start date', 'published date'],
};

/** Map column indexes by HEADER TEXT, not position — an inserted or
 *  reordered portal column must fail loudly, never silently mis-map. */
export function mapHeaders(headerCells) {
  const normH = (h) => h.toLowerCase().replace(/\s+/g, ' ').trim();
  const cells = headerCells.map(normH);
  const map = {};
  const missing = [];
  for (const [field, aliases] of Object.entries({ ...REQUIRED_HEADERS, ...OPTIONAL_HEADERS })) {
    const matches = cells
      .map((c, i) => (aliases.some((a) => c.includes(a)) ? i : -1))
      .filter((i) => i >= 0);
    if (matches.length > 1 && field in REQUIRED_HEADERS) {
      throw scrapeError(
        `results table header "${field}" matched ${matches.length} columns — ambiguous schema`
      );
    }
    if (matches.length >= 1) map[field] = matches[0];
    else if (field in REQUIRED_HEADERS) missing.push(field);
  }
  if (missing.length) {
    throw scrapeError(
      `results table headers changed — required column(s) not found: ${missing.join(', ')} ` +
        `(saw: ${cells.join(' | ')})`
    );
  }
  return map;
}

export function rowToTenderMapped(clean, map) {
  const id = (clean[map.tenderId] || '').trim();
  if (!/^\d{4,}$/.test(id)) return null; // rejects filter rows / headers
  const pick = (f) => (map[f] != null ? clean[map[f]] || null : null);
  return {
    department: pick('department'),
    tenderId: id,
    noticeNumber: pick('noticeNumber'),
    category: pick('category'),
    title: pick('title') || 'Untitled tender',
    value: pick('value'),
    publishedDate: pick('publishedDate'),
    closingDate: pick('closingDate'),
    emd: null,
    _raw: clean,
  };
}

async function parseResultsTable(page) {
  // NOTE: no broad .catch here — during the final parse an evaluation
  // failure must THROW, not masquerade as an empty (valid-looking) result.
  const data = await page.evaluate(() => {
    const table =
      document.querySelector('#pagetable13') ||
      [...document.querySelectorAll('table')].find((t) => {
        const head = (t.querySelector('tr')?.innerText || '')
          .toLowerCase()
          .replace(/\s+/g, ' ');
        return head.includes('tender id') && head.includes('name of work');
      });
    if (!table) return null;
    const headerCells = [...(table.querySelector('thead tr, tr')?.querySelectorAll('th, td') || [])]
      .map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').replace(/\s+/g, ' ').trim())
    );
    return { headerCells, rows };
  });
  if (!data) return [];
  const map = mapHeaders(data.headerCells);
  return data.rows.map((r) => rowToTenderMapped(r, map)).filter(Boolean);
}

/** DataTables' own reported total ("Showing 1 to 10 of 27 entries"). */
async function getReportedTotal(page) {
  // Preferred: DataTables' own API (authoritative; immune to text phrasing).
  // Fallback: parse the visible info element, whose wording varies by portal
  // customisation — this portal's element EXISTS (pagination advance detection
  // relies on its text changing) but doesn't always use the stock
  // "of N entries" phrasing, which is why v7's strict count check saw null.
  // Final fallback: null → the caller warns and pages until Next disables.
  return page
    .evaluate(() => {
      // --- 1. DataTables API ---
      try {
        const jq = window.jQuery || window.$;
        if (jq && jq.fn && jq.fn.dataTable && jq.fn.dataTable.isDataTable('#pagetable13')) {
          const info = jq('#pagetable13').DataTable().page.info();
          if (info && Number.isInteger(info.recordsDisplay)) return info.recordsDisplay;
        }
      } catch {
        /* API unavailable or table not initialised — fall through to text */
      }

      // --- 2. Visible info text, tolerant of several phrasings ---
      const parse = (txt) => {
        const t = (txt || '').replace(/\s+/g, ' ');
        const patterns = [
          /of\s+([\d,]+)\s+entr/i,        // "of 27 entries"
          /of\s+([\d,]+)\s+record/i,      // "of 27 records"
          /of\s+([\d,]+)\s*$/i,           // "Showing 1 to 10 of 27"
          /of\s+([\d,]+)\s+total/i,       // "of 27 total"
          /total\s*[:\-]?\s*([\d,]+)/i,   // "Total: 27"
          /\b([\d,]+)\s+entr(?:y|ies)\b/i, // "27 entries found"
        ];
        for (const re of patterns) {
          const m = t.match(re);
          if (m) {
            const n = parseInt(m[1].replace(/,/g, ''), 10);
            if (Number.isInteger(n)) return n;
          }
        }
        return null;
      };
      const candidates = [
        document.querySelector('#pagetable13_info'),
        document.querySelector('[id$="_info"]'),
        document.querySelector('.dataTables_info'),
      ];
      for (const el of candidates) {
        const n = parse(el?.textContent);
        if (Number.isInteger(n)) return n;
      }
      // Restrict the text fallback to the table's DataTables wrapper so an
      // unrelated "Total: 15" elsewhere on the page can't be mistaken for the
      // result count.
      const wrapper =
        document.querySelector('#pagetable13_wrapper') ||
        document.querySelector('#pagetable13')?.closest('.dataTables_wrapper');
      if (wrapper) {
        for (const el of wrapper.querySelectorAll('div, span, td, p')) {
          const n = parse(el.textContent);
          if (Number.isInteger(n)) return n;
        }
      }
      return null;
    })
    .catch(() => null); // advisory only — never fails a scrape
}

/**
 * Wait for a terminal table state: 'rows' (valid tenders present),
 * 'empty' (portal explicitly says no records), or 'timeout'.
 */
async function waitForTenderTable(page, timeoutMs = 20000) {
  try {
    const handle = await page.waitForFunction(
      () => {
        const tbody = document.querySelector('#pagetable13 tbody');
        if (!tbody) return false;
        // Derive the Tender ID column from the HEADER, not position — a
        // reordered column must not cause a bogus timeout here.
        const table = document.querySelector('#pagetable13');
        const headers = [...(table?.querySelectorAll('thead th, tr th') || [])]
          .map((c) => (c.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim());
        const idIdx = headers.findIndex((h) => h.includes('tender id'));
        const rows = [...tbody.querySelectorAll('tr')];
        // Terminal-state detection only: rows are "real" if the mapped ID
        // column (when the header is found) or ANY cell (when it isn't)
        // holds a numeric tender ID. No positional assumptions — strict
        // schema validation belongs to the header-mapped parser, which
        // throws a proper error if required headers are missing.
        const hasRows = rows.some((row) => {
          const cells = [...row.querySelectorAll('td')];
          if (cells.length < 3) return false;
          if (idIdx >= 0) return /^\d{4,}$/.test((cells[idIdx]?.textContent || '').trim());
          return cells.some((td) => /^\d{4,}$/.test((td.textContent || '').trim()));
        });
        if (hasRows) return 'rows';
        const text = (tbody.textContent || '').toLowerCase();
        if (
          text.includes('no matching records') ||
          text.includes('no data available') ||
          text.includes('no records')
        ) {
          return 'empty';
        }
        return false;
      },
      undefined, // arg slot — options must be the THIRD parameter
      { timeout: timeoutMs }
    );
    return await handle.jsonValue();
  } catch {
    return 'timeout';
  }
}

async function collectAllPages(page, maxPages = 50) {
  const all = [];
  const byId = new Map();
  const reportedTotal = await getReportedTotal(page);

  // Whether the result set spans multiple pages (a Next control exists and
  // is enabled). Single-page results legitimately have NO info element on
  // this portal, so requiring a total there would false-fail good scrapes
  // (it did — v7 broke 3 working searches). We therefore require the total
  // ONLY when pagination is present, since that's the only case where a
  // missing/unparseable count could hide truncated results.
  // Evaluation failure here must NEVER read as "not paginated" — that would
  // fail open and let a partial single page pass as complete. Only a real,
  // successful evaluation may report the pagination state.
  let isPaginated;
  try {
    isPaginated = await page.evaluate(() => {
      const next = document.querySelector('#pagetable13_next');
      return !!next && !next.classList.contains('disabled');
    });
  } catch (e) {
    throw scrapeError(`could not evaluate pagination state: ${e.message}`, true);
  }

  if (Number.isInteger(reportedTotal)) {
    console.log(`  (portal reports ${reportedTotal} total entries — count cross-check armed)`);
  }
  if (isPaginated && !Number.isInteger(reportedTotal)) {
    // The count element isn't reliably present on this portal even when
    // paginated. Rather than fail good data, fall back to the proven
    // behavior: page until Next disables, deduping by ID. We lose only the
    // extra cross-check, not the tenders. (Was a hard failure in v7 — that
    // blocked GVMC-Electrical's 15 real tenders.)
    console.warn(
      'paginated results but DataTables total is unreadable — ' +
        'paging until Next disables (count cross-check skipped this run).'
    );
  }

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    const current = await parseResultsTable(page);
    for (const t of current) {
      const existing = byId.get(t.tenderId);
      if (!existing) {
        byId.set(t.tenderId, t);
        all.push(t);
      } else if (JSON.stringify(existing._raw) !== JSON.stringify(t._raw)) {
        // Same ID, different data: never silently pick one — a lifecycle
        // sweep from ambiguous data could retire/alert the wrong thing.
        throw scrapeError(
          `tender ${t.tenderId} appeared twice with conflicting data — refusing results`
        );
      }
    }

    // Advance-detection via the DataTables info text ("Showing 11 to 20 of
    // 27 entries") — robust against two pages starting with the same ID and
    // free of any hardcoded column position.
    let previousInfo;
    try {
      // A missing info element legitimately yields null (advisory count);
      // only an evaluation FAILURE throws.
      previousInfo = await page.evaluate(
        () => document.querySelector('#pagetable13_info')?.textContent.trim() ?? null
      );
    } catch (e) {
      throw scrapeError(`pagination info evaluation failed: ${e.message}`, true);
    }

    let advanced;
    try {
      advanced = await page.evaluate(() => {
        const next = document.querySelector('#pagetable13_next');
        if (!next || next.classList.contains('disabled')) return false;
        next.click();
        return true;
      });
    } catch (e) {
      // "Next legitimately disabled" is healthy; an evaluation FAILURE is not.
      throw scrapeError(`pagination click evaluation failed: ${e.message}`, true);
    }

    if (!advanced) {
      // Verify against the portal's own count when we have it; a single-page
      // result with no info element simply returns the rows we parsed.
      if (Number.isInteger(reportedTotal) && byId.size !== reportedTotal) {
        throw scrapeError(
          `pagination integrity failure: portal reports ${reportedTotal} entries, collected ${byId.size}`,
          true
        );
      }
      // 'verified' only when the portal's own count confirmed completeness;
      // otherwise 'best-effort' (paged until Next disabled, but unconfirmed).
      all._integrity = Number.isInteger(reportedTotal) ? 'verified' : 'best-effort';
      return all;
    }

    const advancedOk = await page
      .waitForFunction(
        (prev) => {
          const info = document.querySelector('#pagetable13_info');
          return info && info.textContent.trim() !== prev;
        },
        previousInfo,
        { timeout: 5000 }
      )
      .then(() => true)
      .catch(() => false);
    if (!advancedOk) {
      throw scrapeError(`pagination failed to advance after page ${pageNumber}`, true);
    }
  }
  throw scrapeError(`pagination exceeded ${maxPages} pages; refusing partial results`, true);
}

// ------------------------- navigation -------------------------


/**
 * Wait for a form-POST navigation without deprecated waitForNavigation():
 * plant a marker on the CURRENT document, run the submit, and wait until a
 * NEW document (without the marker) is in place. Robust even when the URL
 * doesn't change (the portal's Apply posts to the same URL).
 */
async function submitAndAwaitNewDocument(page, submitFn, timeout) {
  await page.evaluate(() => { window.__preNavMarker = true; });
  await submitFn();
  const ok = await page
    .waitForFunction(() => !window.__preNavMarker, undefined, { timeout })
    .then(() => true)
    .catch(() => false);
  if (!ok) throw scrapeError('form submission did not navigate to a new document', true);
}

async function clickHomeFromErrorPage(page) {
  return page
    .evaluate(() => {
      const el = [...document.querySelectorAll('a')].find((a) =>
        /click here/i.test(a.textContent || '')
      ) || document.querySelector('a:has(img), a');
      if (el) {
        el.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
}

/**
 * Ensure the page is on TenderDetailsHome with a valid session.
 * Fast no-op when already there (session reuse between searches).
 */
async function ensureTenderDetails(page, tag, force = false) {
  const onDetails = async () =>
    page.url().includes('TenderDetails') &&
    !page.url().includes('SessionTimeOut') &&
    (await page.locator('#pagetable13').count().catch(() => 0)) > 0;

  if (!force && (await onDetails())) return;

  console.log(`[${tag}] establishing portal session…`);
  try {
    await page.goto(HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.navTimeout,
    });
  } catch (e) {
    throw scrapeError(`portal navigation failed: ${e.message}`, true);
  }

  if (page.url().includes('SessionTimeOut')) {
    dbg('security-error page — clicking home link');
    await clickHomeFromErrorPage(page);
    // Wait for the actual state we need (the login form), not a generic
    // navigation event — waitForNavigation is deprecated and racy.
    await page
      .waitForFunction(
        () => document.loginForm || document.getElementById('loginForm'),
        undefined,
        { timeout: 15000 }
      )
      .catch(() => {});
  }
  await screenshot(page, `${tag}-01-homepage`);

  // Condition-based: wait for the login form AND the anti-tamper helpers
  // that the More... handler needs — no fixed sleeps.
  await page
    .waitForFunction(
      () =>
        (document.loginForm || document.getElementById('loginForm')) &&
        typeof window.temp === 'function' &&
        typeof window.tempName !== 'undefined',
      undefined, // arg slot — options must be the THIRD parameter
      { timeout: 30000 }
    )
    .catch(() => {
      throw scrapeError(
        'login.html loaded but loginForm/temp/tempName never became ready. ' +
          'Run with --debug and check ' + tag + '-01-homepage.png.',
        true
      );
    });

  // Replicate the portal's own "More..." handler (from login_emudhra.js).
  console.log(`[${tag}] submitting loginForm -> TenderDetailsHome.html…`);
  await submitAndAwaitNewDocument(page, async () => {
    const diag = await page
      .evaluate(() => {
        const out = { error: null };
        try {
          const f = document.loginForm || document.getElementById('loginForm');
          if (f.hdnType) f.hdnType.value = 'current';
          window.temp(window.tempName, 'loginForm');
          f.action = 'TenderDetailsHome.html';
          f.method = 'POST';
          f.submit();
        } catch (e) {
          out.error = String((e && e.message) || e);
        }
        return out;
      })
      .catch((e) => ({ error: 'evaluate failed: ' + e.message }));
    if (diag.error) dbg(`submit diag: ${diag.error}`);
  }, CONFIG.navTimeout);

  await page
    .waitForSelector('#pagetable13', { state: 'attached', timeout: 20000 })
    .catch(() => {});

  if (!(await onDetails())) {
    await saveDebug(`${tag}-homepage-dump.html`, await page.content().catch(() => ''));
    await screenshot(page, `${tag}-homepage-dump`);
    throw scrapeError(
      `Could not reach TenderDetailsHome.html (stuck at ${page.url()}). ` +
        'See debug/' + tag + '-homepage-dump.* for what rendered.',
      true
    );
  }
  console.log(`[${tag}] on Tender Details page.`);
}

// ------------------------- filter selection -------------------------

/**
 * Select an option in a specific <select> by visible text.
 * Ranking: exact > startsWith > contains (whitespace-insensitive) —
 * prevents "…Smart City Corporation" grabbing a GVMC prefix match.
 */
async function selectInSelect(page, selector, optionText) {
  const result = await page
    .evaluate(
      ({ selector, target }) => {
        const normJs = (s) => s.toLowerCase().replace(/\s+/g, '');
        const el = document.querySelector(selector);
        if (!el) return { status: 'missing', matches: [] };
        let bestRank = null;
        const matches = [];
        for (const o of el.options) {
          const n = normJs(o.textContent.trim());
          let rank = null;
          if (n === target) rank = 0;
          else if (n.startsWith(target)) rank = 1;
          else if (n.includes(target)) rank = 2;
          if (rank === null) continue;
          if (bestRank === null || rank < bestRank) {
            bestRank = rank;
            matches.length = 0;
          }
          if (rank === bestRank) matches.push({ value: o.value, label: o.textContent.trim(), rank });
        }
        if (!matches.length) return { status: 'missing', matches: [] };
        if (matches.length > 1) return { status: 'ambiguous', matches };
        el.value = matches[0].value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { status: 'matched', matches };
      },
      { selector, target: norm(optionText) }
    )
    .catch((e) => {
      // A destroyed execution context / browser comms error / navigation race
      // is NOT "option absent" — reporting it as missing turned a retryable
      // glitch into a permanent "Department not found". Rethrow as transient.
      throw scrapeError(
        `dropdown evaluation failed for ${selector}: ${e.message}`,
        true
      );
    });

  if (result.status === 'ambiguous') {
    // A portal label change must fail loudly, never silently pick option #1.
    throw scrapeError(
      `"${optionText}" matches ${result.matches.length} options equally in ${selector}: ` +
        result.matches.map((m) => `"${m.label}"`).join(', ')
    );
  }
  return result.status === 'matched' ? result.matches[0].label : null;
}

async function describeSelects(page) {
  return page
    .evaluate(() =>
      [...document.querySelectorAll('select')].map((s) => ({
        id: s.id || null,
        options: [...s.options].slice(0, 8).map((o) => o.textContent.trim()),
        totalOptions: s.options.length,
      }))
    )
    .catch(() => []);
}

async function setFilters(page, search) {
  const tag = search.id;

  // Open the Advanced Search panel via the portal's own function
  // (deterministic; falls back to clicking the control).
  await page
    .evaluate(() => {
      if (typeof window.Advancedsearch === 'function') window.Advancedsearch();
    })
    .catch(() => {});
  const deptReady = await page
    .waitForSelector('#nDepartmentID', { state: 'attached', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!deptReady) {
    await page.locator('text=Advanced Search').first().click().catch(() => {});
    await page.waitForSelector('#nDepartmentID', {
      state: 'attached',
      timeout: 10000,
    });
  }

  const deptLabel = await selectInSelect(page, '#nDepartmentID', search.department);
  if (!deptLabel) {
    await saveDebug(
      `${tag}-selects.json`,
      JSON.stringify(await describeSelects(page), null, 2)
    );
    throw scrapeError(
      `Department "${search.department}" not found — see debug/${tag}-selects.json for available options.`
    ); // permanent: config/portal-schema mismatch, retrying can't help
  }
  console.log(`[${tag}] department set: ${deptLabel}`);

  // Sub-department: wait until getCircles has delivered a FRESH list (the
  // stale marker cleared) containing an option that matches, then select it.
  if (search.subDepartment) {
    const target = norm(search.subDepartment);
    const appeared = await page
      .waitForFunction(
        (t) => {
          const el = document.querySelector('#subDeptId');
          if (!el) return false;
          const normJs = (s) => s.toLowerCase().replace(/\s+/g, '');
          return [...el.options].some((o) => {
            const n = normJs(o.textContent.trim());
            return n === t || n.startsWith(t) || n.includes(t);
          });
        },
        target,
        { timeout: 20000 }
      )
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      await saveDebug(
        `${tag}-selects.json`,
        JSON.stringify(await describeSelects(page), null, 2)
      );
      // Distinguish a SLOW/FAILED getCircles() AJAX (transient — worth one
      // fresh-context retry) from a genuinely populated list that simply
      // lacks our configured label (permanent config/portal-schema error).
      let optionCount = null;
      try {
        optionCount = await page.evaluate(
          () => document.querySelector('#subDeptId')?.options.length ?? null
        );
      } catch {
        optionCount = null; // couldn't even evaluate — treat as transient below
      }
      const listNeverLoaded = optionCount === null || optionCount <= 1;
      // HARD FAIL either way — a department-only fallback would alert
      // unrelated tenders (silent wrongness). Only retryability differs.
      throw scrapeError(
        `Sub-department "${search.subDepartment}" never appeared in #subDeptId ` +
          `(${optionCount === null ? 'select unreadable' : optionCount + ' option(s) present'}) — ` +
          `see debug/${tag}-selects.json for available options.`,
        listNeverLoaded
      );
    }
    const subLabel = await selectInSelect(page, '#subDeptId', search.subDepartment);
    if (!subLabel) {
      throw scrapeError(
        `Sub-department "${search.subDepartment}" appeared but could not be selected.`,
        true // selection race — a fresh context is worth one attempt
      );
    }

    // Read-only VERIFY: the dropdown's post-selection value must match the
    // option we chose (belt) — the POST-body guard in applyAndParse is the
    // braces. Both are passive checks that cannot disturb the session.
    const verified = await page
      .evaluate(
        (wantLabel) => {
          const el = document.querySelector('#subDeptId');
          if (!el) return { ok: false, got: null };
          const sel = el.options[el.selectedIndex];
          const normJs = (s) => s.toLowerCase().replace(/\s+/g, '');
          return {
            ok: sel ? normJs(sel.textContent.trim()) === normJs(wantLabel) : false,
            got: sel ? sel.textContent.trim() : null,
            value: el.value,
          };
        },
        subLabel
      )
      .catch(() => ({ ok: false, got: null }));

    if (!verified.ok) {
      throw scrapeError(
        `sub-department selection did not stick for "${search.subDepartment}" — ` +
          `dropdown shows "${verified.got}" (value ${verified.value}). ` +
          `Likely a late getCircles() reset; retrying with a fresh session.`,
        true
      );
    }
    if (search.subDeptId && verified.value !== search.subDeptId) {
      throw scrapeError(
        `sub-department value mismatch before submit: expected ${search.subDeptId}, ` +
          `dropdown holds ${verified.value}`,
        true
      );
    }
    console.log(`[${tag}] sub-department set: ${subLabel} (value ${verified.value})`);
  }
  await screenshot(page, `${tag}-02-filters-set`);
}

// ------------------------- apply + parse -------------------------

async function applyAndParse(page, search, postCaptures) {
  const tag = search.id;
  const before = postCaptures.length;

  console.log(`[${tag}] invoking Apply (advsearchBtn)…`);
  await submitAndAwaitNewDocument(page, () =>
    page.evaluate(() => {
      if (typeof window.advsearchBtn === 'function') {
        window.advsearchBtn();
      } else {
        const btn = document.querySelector('input[value="Apply"]');
        if (btn) btn.click();
        else throw new Error('Neither advsearchBtn() nor an Apply input found');
      }
    }), CONFIG.navTimeout);

  if (page.url().includes('SessionTimeOut')) {
    throw scrapeError('Apply POST bounced to SessionTimeOut.jsp', true);
  }

  // Persist the POST body for diagnostics (same artifact as before).
  const body = postCaptures.slice(before).pop() || '(no POST captured)';
  await saveDebug(`${tag}-post-auto.txt`, body);
  let params;
  try {
    params = new URLSearchParams(body);
    const brief = ['nDepartmentID', 'subDeptId', 'hdnSearch', 'hdnSearch4', 'hdnadvsearch', 'hdnnoSearch']
      .map((k) => `${k}=${params.get(k)}`)
      .join(' | ');
    console.log(`[${tag}] POST (auto): ${brief}`);
  } catch {
    params = null;
  }

  // GROUND-TRUTH GUARD: the POST body is what the portal actually filtered
  // on — trust it over any dropdown label we logged earlier. If config
  // declares the expected IDs, assert the POST used them; fail closed on any
  // mismatch so we never ingest (and alert) the wrong sub-department's
  // tenders. This is the definitive fix for the subDeptId=74/5889 leak.
  if (params) {
    const gotDept = params.get('nDepartmentID');
    const gotSub = params.get('subDeptId');
    if (search.deptId && gotDept !== search.deptId) {
      throw scrapeError(
        `POST department mismatch for "${search.id}": expected nDepartmentID=${search.deptId}, ` +
          `got ${gotDept}. Refusing results (wrong department).`,
        true
      );
    }
    if (search.subDeptId && gotSub !== search.subDeptId) {
      throw scrapeError(
        `POST sub-department mismatch for "${search.id}": expected subDeptId=${search.subDeptId}, ` +
          `got ${gotSub}. Refusing results (stale dropdown state — wrong sub-department).`,
        true
      );
    }
  }

  // Wait for EITHER terminal state: valid tender rows OR an explicit
  // "No matching records" — a genuinely empty department returns in
  // ~1s instead of burning the full timeout every cycle.
  const state = await waitForTenderTable(page, 20000);
  await screenshot(page, `${tag}-03-results`);

  if (state === 'empty') {
    // Portal is HEALTHY and explicitly reports zero tenders — distinct from
    // a timeout, which is an unhealthy scrape and must not baseline/sweep.
    console.log(`[${tag}] portal reports no matching records (0 tenders).`);
    return { status: 'empty', tenders: [], integrity: 'verified' };
  }
  if (state === 'timeout') {
    // Neither rows nor an explicit empty marker: treat as a FAILED scrape so
    // the caller re-establishes the session and health tracking fires.
    throw scrapeError('results table reached neither rows nor an empty marker in 20s', true);
  }
  const tenders = await collectAllPages(page);
  const integrity = tenders._integrity || 'best-effort';
  console.log(`[${tag}] extracted ${tenders.length} tenders from results table`);
  return { status: 'ok', tenders, integrity };
}

// ------------------------- public API -------------------------

/**
 * Run ALL configured searches in a single browser + portal session,
 * YIELDING each search's result as soon as it completes so the caller
 * can send alerts while the next search runs. A failure in one search
 * never blocks the others.
 */
export async function* scrapeSearchesStream(searches) {
  // --debug  = save extra artifacts, stays HEADLESS (works on the server)
  // --headed = open a visible browser (needs a desktop; use on the laptop)
  const launchBrowser = () =>
    chromium.launch({
      headless: !CONFIG.headed,
      args: [
        '--disable-blink-features=AutomationControlled',
        ...(CONFIG.headed ? ['--start-maximized'] : []),
      ],
    });
  let browser;
  const ensureBrowser = async () => {
    if (!browser || !browser.isConnected()) {
      await browser?.close().catch(() => {});
      console.warn('browser process not connected — (re)launching Chromium…');
      browser = await launchBrowser();
    }
  };
  try {
  browser = await launchBrowser();
  // Each search runs in its OWN fresh context (isolated cookies, session, and
  // anti-tamper tokens). A shared context re-navigated per search caused the
  // portal to invalidate its own session tokens → "Apply bounced to
  // SessionTimeOut". Per-context isolation also fully eliminates the stale
  // #subDeptId leak between same-department searches (the subDeptId=74/5889
  // bug) — every search starts from a clean slate.
  const newSearchContext = async () => {
    const context = await browser.newContext({
      // No hardcoded userAgent: let Playwright send the UA of its actual
      // bundled Chromium, so the reported version matches the real engine.
      // (Override only if the portal ever demonstrates a UA requirement.)
      ...(CONFIG.headed ? { viewport: null } : { viewport: { width: 1920, height: 1080 } }),
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
    });
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') return route.abort();
      return route.continue();
    });
    return context;
  };

  const attemptSearch = async (search, postCaptures) => {
    const context = await newSearchContext();
    context.on('request', (req) => {
      try {
        // Navigation requests only: a future AJAX POST to the same endpoint
        // must never masquerade as the Apply submission we verify against.
        if (
          req.method() === 'POST' &&
          req.isNavigationRequest() &&
          new URL(req.url()).pathname.endsWith('/TenderDetailsHome.html')
        ) {
          postCaptures.push(req.postData() || '');
        }
      } catch {
        /* ignore */
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(CONFIG.actionTimeout);
    try {
      await ensureTenderDetails(page, search.id, false); // fresh context: no force needed
      await setFilters(page, search);
      return await applyAndParse(page, search, postCaptures);
    } finally {
      await context.close().catch(() => {});
    }
  };

  for (const search of searches) {
    const started = Date.now();
    let result;
    try {
      // One Chromium crash must not doom the remaining searches: relaunch.
      await ensureBrowser();
      const postCaptures = []; // per-search: no cross-talk between searches
      let outcome;
      try {
        outcome = await attemptSearch(search, postCaptures);
      } catch (e) {
        // ONE same-cycle retry in a brand-new context — transient only.
        // Browser-process death ("Target closed" etc.) counts as retryable:
        // it says nothing about the search config, only about Chromium.
        const browserDied = /target closed|browser has been closed|connection closed/i.test(
          e.message || ''
        );
        // Playwright TimeoutError is retryable by nature: it reports slowness,
        // never a wrong configuration.
        const timedOut = e.name === 'TimeoutError';
        if (!e.transient && !browserDied && !timedOut) throw e;
        console.warn(`[${search.id}] transient failure (${e.message}) — retrying with fresh context…`);
        await ensureBrowser(); // relaunch BEFORE the retry, or it dies in the dead browser
        outcome = await attemptSearch(search, []);
      }
      const { status, tenders, integrity } = outcome;
      console.log(
        `[${search.id}] search completed in ${((Date.now() - started) / 1000).toFixed(1)}s`
      );
      result = { search, status, tenders, integrity: integrity || 'best-effort', error: null };
    } catch (e) {
      console.error(`[${search.id}] scrape failed: ${e.message}`);
      result = { search, status: 'error', tenders: [], error: e.message };
    }
    yield result; // each result is processed before the next search starts
  }
  } finally {
    await browser?.close().catch(() => {});
  }
}
