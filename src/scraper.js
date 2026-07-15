import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { CONFIG, PORTAL_URL, HOME_URL } from './config.js';

/**
 * AP eProcurement scraper — v3 (performance rewrite).
 *
 * Changes vs v2:
 *  - ONE browser + ONE portal session per cycle: the login → More... →
 *    TenderDetails chain runs once; every search reuses the page by
 *    re-opening Advanced Search with new filters.
 *  - Condition-based waits everywhere (wait for the thing, not a timer):
 *    login readiness, sub-department AJAX, results rows, pagination.
 *  - Junk resources (images/media/fonts) are blocked — the scraper only
 *    needs DOM + scripts. Faster loads, less RAM on the 1 GB server.
 *
 * Proven portal mechanics preserved unchanged:
 *  - Session must be minted on login.html; deep links bounce.
 *  - Navigation to TenderDetails = the portal's own More... handler:
 *      loginForm.hdnType="current"; temp(tempName,'loginForm'); POST.
 *  - Apply = advsearchBtn() invoked DIRECTLY (duplicate id="searchTender"
 *    makes clicking-by-id hit the wrong button) → full page reload.
 *  - Results live in the #pagetable13 DataTables grid.
 */

// ------------------------- utilities -------------------------

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

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

// ------------------- tender extraction (unchanged logic) -------------------

const TENDER_KEY_HINTS = [
  'tender', 'nit', 'work', 'department', 'closing', 'publish', 'emd', 'ecv', 'notice',
];

function extractTenderArray(json) {
  const looksLikeTender = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj).join(' ').toLowerCase();
    return TENDER_KEY_HINTS.filter((h) => keys.includes(h)).length >= 2;
  };
  const search = (node) => {
    if (Array.isArray(node)) {
      if (node.length && looksLikeTender(node[0])) return node;
      for (const item of node) {
        const found = search(item);
        if (found) return found;
      }
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) {
        const found = search(v);
        if (found) return found;
      }
    }
    return null;
  };
  return search(json);
}

function normalizeFromJson(raw) {
  const get = (...hints) => {
    for (const [k, v] of Object.entries(raw)) {
      const lk = k.toLowerCase();
      if (hints.some((h) => lk.includes(h)) && v != null && v !== '') return String(v);
    }
    return null;
  };
  return {
    tenderId: get('tenderid', 'tender_id', 'nitno', 'nit_no', 'tendernumber', 'refno'),
    noticeNumber: get('notice'),
    category: get('category'),
    title: get('tendername', 'workname', 'nameofwork', 'title', 'description') || 'Untitled tender',
    department: get('department', 'organisation', 'organization'),
    publishedDate: get('publish', 'startdate', 'releasedate', 'bidstart'),
    closingDate: get('closing', 'lastdate', 'enddate', 'duedate', 'bidsubmission'),
    value: get('ecv', 'estimat', 'tendervalue', 'contractvalue'),
    emd: get('emd'),
    _raw: raw,
  };
}

/** Columns: 0 Dept | 1 Tender ID | 2 Notice No | 3 Category | 4 Name of Work
 *  | 5 ECV | 6 Start | 7 Closing | 8 Action. ID must be numeric. */
function rowToTender(clean) {
  if (clean.length < 8) return null;
  if (!/^\d{4,}$/.test(clean[1])) return null;
  return {
    department: clean[0] || null,
    tenderId: clean[1],
    noticeNumber: clean[2] || null,
    category: clean[3] || null,
    title: clean[4] || 'Untitled tender',
    value: clean[5] || null,
    publishedDate: clean[6] || null,
    closingDate: clean[7] || null,
    emd: null,
    _raw: clean,
  };
}

async function parseResultsTable(page) {
  // Read the whole table in ONE evaluate round-trip (much faster than
  // per-cell locator calls over the wire).
  const rows = await page
    .evaluate(() => {
      const table =
        document.querySelector('#pagetable13') ||
        [...document.querySelectorAll('table')].find((t) => {
          const head = (t.querySelector('tr')?.innerText || '')
            .toLowerCase()
            .replace(/\s+/g, ' ');
          return head.includes('tender id') && head.includes('name of work');
        });
      if (!table) return [];
      return [...table.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) =>
          (td.innerText || '').replace(/\s+/g, ' ').trim()
        )
      );
    })
    .catch(() => []);
  return rows.map(rowToTender).filter(Boolean);
}

/** Wait (condition-based) until at least one valid tender row exists. */
async function waitForResults(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tenders = await parseResultsTable(page);
    if (tenders.length) return tenders;
    await page.waitForTimeout(700);
  }
  return [];
}

async function collectAllPages(page, maxPages = 10) {
  let all = await waitForResults(page);
  if (!all.length) return all;

  for (let p = 2; p <= maxPages; p++) {
    const firstId = all[all.length - 1]?.tenderId;
    const advanced = await page
      .evaluate(() => {
        const next = document.querySelector('#pagetable13_next');
        if (!next || next.classList.contains('disabled')) return false;
        next.click();
        return true;
      })
      .catch(() => false);
    if (!advanced) break;

    // DataTables repaints client-side — wait for the first row to change.
    await page
      .waitForFunction(
        (prev) => {
          const td = document.querySelector(
            '#pagetable13 tbody tr td:nth-child(2)'
          );
          return td && td.textContent.trim() !== prev;
        },
        firstId,
        { timeout: 5000 }
      )
      .catch(() => {});

    const more = await parseResultsTable(page);
    if (!more.length) break;
    if (more[0] && all.some((t) => t.tenderId === more[0].tenderId)) break;
    all = all.concat(more);
  }
  return all;
}

// ------------------------- navigation -------------------------

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
  await page.goto(HOME_URL, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.navTimeout,
  });

  if (page.url().includes('SessionTimeOut')) {
    dbg('security-error page — clicking home link');
    await clickHomeFromErrorPage(page);
    await page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 })
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
      { timeout: 30000 }
    )
    .catch(() => {
      throw new Error(
        'login.html loaded but loginForm/temp/tempName never became ready. ' +
          'Run with --debug and check ' + tag + '-01-homepage.png.'
      );
    });

  // Replicate the portal's own "More..." handler (from login_emudhra.js).
  console.log(`[${tag}] submitting loginForm -> TenderDetailsHome.html…`);
  const navPromise = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeout })
    .catch(() => null);
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
  await navPromise;

  await page
    .waitForSelector('#pagetable13', { state: 'attached', timeout: 20000 })
    .catch(() => {});

  if (!(await onDetails())) {
    await saveDebug(`${tag}-homepage-dump.html`, await page.content().catch(() => ''));
    await screenshot(page, `${tag}-homepage-dump`);
    throw new Error(
      `Could not reach TenderDetailsHome.html (stuck at ${page.url()}). ` +
        'See debug/' + tag + '-homepage-dump.* for what rendered.'
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
  return page
    .evaluate(
      ({ selector, target }) => {
        const normJs = (s) => s.toLowerCase().replace(/\s+/g, '');
        const el = document.querySelector(selector);
        if (!el) return null;
        let best = null;
        for (const o of el.options) {
          const n = normJs(o.textContent.trim());
          let rank = null;
          if (n === target) rank = 0;
          else if (n.startsWith(target)) rank = 1;
          else if (n.includes(target)) rank = 2;
          if (rank !== null && (!best || rank < best.rank)) {
            best = { value: o.value, label: o.textContent.trim(), rank };
            if (rank === 0) break;
          }
        }
        if (!best) return null;
        el.value = best.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return best.label;
      },
      { selector, target: norm(optionText) }
    )
    .catch(() => null);
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

  // Department — its change handler (getCircles) AJAX-loads sub-departments.
  const deptLabel = await selectInSelect(page, '#nDepartmentID', search.department);
  if (!deptLabel) {
    await saveDebug(
      `${tag}-selects.json`,
      JSON.stringify(await describeSelects(page), null, 2)
    );
    throw new Error(
      `Department "${search.department}" not found — see debug/${tag}-selects.json for available options.`
    );
  }
  console.log(`[${tag}] department set: ${deptLabel}`);

  // Sub-department: wait until getCircles has delivered an option that
  // matches, then select it. Condition-based — typically <1s.
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

    if (appeared) {
      const subLabel = await selectInSelect(page, '#subDeptId', search.subDepartment);
      console.log(`[${tag}] sub-department set: ${subLabel}`);
    } else {
      await saveDebug(
        `${tag}-selects.json`,
        JSON.stringify(await describeSelects(page), null, 2)
      );
      console.warn(
        `[${tag}] Sub-department "${search.subDepartment}" never appeared — ` +
          `searching department-only. See debug/${tag}-selects.json.`
      );
    }
  }
  await screenshot(page, `${tag}-02-filters-set`);
}

// ------------------------- apply + parse -------------------------

async function applyAndParse(page, search, postCaptures) {
  const tag = search.id;
  const before = postCaptures.length;

  console.log(`[${tag}] invoking Apply (advsearchBtn)…`);
  const navPromise = page
    .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeout })
    .catch(() => null);
  await page.evaluate(() => {
    if (typeof window.advsearchBtn === 'function') {
      window.advsearchBtn();
    } else {
      const btn = document.querySelector('input[value="Apply"]');
      if (btn) btn.click();
      else throw new Error('Neither advsearchBtn() nor an Apply input found');
    }
  });
  await navPromise;

  if (page.url().includes('SessionTimeOut')) {
    throw new Error('Apply POST bounced to SessionTimeOut.jsp');
  }

  // Persist the POST body for diagnostics (same artifact as before).
  const body = postCaptures.slice(before).pop() || '(no POST captured)';
  await saveDebug(`${tag}-post-auto.txt`, body);
  try {
    const params = new URLSearchParams(body);
    const brief = ['nDepartmentID', 'subDeptId', 'hdnSearch', 'hdnSearch4', 'hdnadvsearch', 'hdnnoSearch']
      .map((k) => `${k}=${params.get(k)}`)
      .join(' | ');
    console.log(`[${tag}] POST (auto): ${brief}`);
  } catch {
    /* non-fatal */
  }

  await page
    .waitForSelector('#pagetable13 tbody tr td', { timeout: 25000 })
    .catch(() => {});
  await screenshot(page, `${tag}-03-results`);

  const tenders = await collectAllPages(page);
  console.log(`[${tag}] extracted ${tenders.length} tenders from results table`);
  return tenders;
}

// ------------------------- public API -------------------------

/**
 * Run ALL configured searches in a single browser + portal session.
 * Returns [{ search, tenders, error }] — one entry per search; a failure
 * in one search never blocks the others.
 */
export async function scrapeAllSearches(searches) {
  const browser = await chromium.launch({
    headless: !CONFIG.debug,
    args: [
      '--disable-blink-features=AutomationControlled',
      ...(CONFIG.debug ? ['--start-maximized'] : []),
    ],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ...(CONFIG.debug ? { viewport: null } : { viewport: { width: 1920, height: 1080 } }),
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
  });

  // Block resources the scraper never needs — big speed/RAM win.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') {
      return route.abort();
    }
    return route.continue();
  });

  const postCaptures = [];
  context.on('request', (req) => {
    try {
      if (req.method() === 'POST' && req.url().includes('TenderDetailsHome.html')) {
        postCaptures.push(req.postData() || '');
      }
    } catch {
      /* ignore */
    }
  });

  const jsonResponses = [];
  context.on('response', async (res) => {
    try {
      const ct = res.headers()['content-type'] || '';
      if (ct.includes('json')) {
        jsonResponses.push({ url: res.url(), body: await res.json() });
      }
    } catch {
      /* ignore */
    }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.actionTimeout);

  const results = [];
  let forceFresh = false;

  try {
    for (const search of searches) {
      const started = Date.now();
      try {
        await ensureTenderDetails(page, search.id, forceFresh);
        forceFresh = false;
        await setFilters(page, search);
        const tenders = await applyAndParse(page, search, postCaptures);
        results.push({ search, tenders, error: null });
        console.log(
          `[${search.id}] search completed in ${((Date.now() - started) / 1000).toFixed(1)}s`
        );
      } catch (e) {
        console.error(`[${search.id}] scrape failed: ${e.message}`);
        results.push({ search, tenders: [], error: e.message });
        forceFresh = true; // next search re-establishes the session from scratch
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}
