import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { CONFIG, PORTAL_URL, HOME_URL } from './config.js';

/**
 * AP eProcurement scraper — v4, encoding the portal's REAL navigation
 * path (confirmed by the user, screenshot by screenshot):
 *
 *   1. Deep link to TenderDetailsHome.html gets bounced to an
 *      "APPLICATION SECURITY ERROR" page (SessionTimeOut.jsp)
 *      → click the "click here to [home]" link.
 *   2. login.html loads with a full-screen AD POPUP
 *      → click the round "X" close button (top-right).
 *   3. On login.html, in the "Current Tenders" panel, click "More..."
 *      → this opens TenderDetailsHome.html with a valid session.
 *   4. Click "Advanced Search" → the Department / Sub-department
 *      dropdowns and filter row appear.
 *   5. Select Department (+ Sub-department for GVMC), click "Apply".
 *   6. Parse the Tender List table (+ pagination via Next).
 *
 * We navigate straight to login.html first (skipping the error page
 * when possible), but every recovery path above is still handled.
 */

const TENDER_KEY_HINTS = [
  'tender', 'nit', 'work', 'department', 'closing', 'publish', 'emd', 'ecv', 'notice',
];

function dbg(...args) {
  if (CONFIG.debug) console.log('[debug]', ...args);
}

async function saveDebug(name, content) {
  if (!CONFIG.debug) return;
  fs.mkdirSync(CONFIG.debugDir, { recursive: true });
  fs.writeFileSync(path.join(CONFIG.debugDir, name), content);
}

async function screenshot(page, name) {
  if (!CONFIG.debug) return;
  try {
    fs.mkdirSync(CONFIG.debugDir, { recursive: true });
    await page.screenshot({
      path: path.join(CONFIG.debugDir, `${name}.png`),
      fullPage: true,
    });
  } catch (e) {
    dbg(`screenshot ${name} failed: ${e.message}`);
  }
}

/** Click the first matching selector from a list; returns true if clicked. */
async function clickFirst(page, candidates, what, timeout = 5000) {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.click({ timeout });
        dbg(`clicked ${what} via "${sel}"`);
        return true;
      }
    } catch {
      /* try next */
    }
  }
  dbg(`could not click ${what}`);
  return false;
}

/** Close the advertisement popup on login.html, if present. */
async function closeAdIfPresent(page) {
  await page.waitForTimeout(2500); // give the ad time to appear
  const closed = await clickFirst(
    page,
    [
      'button:has-text("X")',
      'a:has-text("X")',
      'span:has-text("X")',
      '[class*="close" i]',
      '[id*="close" i]',
      '[aria-label="Close"]',
      '.modal button',
    ],
    'ad close (X)'
  );
  if (closed) await page.waitForTimeout(1500);
  return closed;
}

/** From the SessionTimeOut error page, click "click here to [home]". */
async function clickHomeFromErrorPage(page) {
  return clickFirst(
    page,
    [
      'a:has-text("click here")',
      'text=click here to',
      'a:has(img)',
      'img[src*="home" i]',
    ],
    'error-page home link',
    8000
  );
}

/**
 * Get the browser onto TenderDetailsHome.html with a valid session,
 * following the portal's required human path.
 */
async function reachTenderDetails(page, tag) {
  // CRITICAL (proven via POST-body capture): arriving at
  // TenderDetailsHome.html through the "More..." link is what arms the
  // session's CSRF/encrypted-state tokens. A direct GET renders the
  // page, but every search from it silently returns 0 results.
  // Therefore the More... click is MANDATORY — retry, never bypass.
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[${tag}] opening portal homepage… (attempt ${attempt}/3)`);
    await page.goto(HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.navTimeout,
    });
    await page.waitForTimeout(3000);

    // Recover from the security-error page if it appears.
    if (page.url().includes('SessionTimeOut')) {
      await screenshot(page, `${tag}-00-error-page`);
      console.log(`[${tag}] on security-error page — clicking home…`);
      await clickHomeFromErrorPage(page);
      await page.waitForTimeout(3000);
    }
    await screenshot(page, `${tag}-01-homepage`);

    // Close the ad popup — it can appear late and it covers the page,
    // so keep trying for up to ~10 seconds.
    for (let i = 0; i < 5; i++) {
      const closed = await clickFirst(
        page,
        [
          'button:has-text("X")',
          'a:has-text("X")',
          'span:has-text("X")',
          '[class*="close" i]',
          '[id*="close" i]',
          '[aria-label="Close"]',
        ],
        'ad close (X)',
        2000
      );
      if (closed) break;
      await page.waitForTimeout(2000);
    }
    await screenshot(page, `${tag}-02-ad-closed`);

    // Navigate to Tender Details by replicating the portal's own
    // "More..." handler EXACTLY (read from login_emudhra.js):
    //     loginForm.hdnType = "current";
    //     temp(tempName, 'loginForm');          // anti-tamper encryption
    //     loginForm.action = "TenderDetailsHome.html"; POST; submit
    // Executing this directly is deterministic — no click simulation.
    console.log(`[${tag}] submitting loginForm -> TenderDetailsHome.html (More... handler)…`);
    const navPromise = page
      .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeout })
      .catch(() => null);
    const diag = await page
      .evaluate(() => {
        const out = { form: false, temp: false, tempName: false, error: null };
        try {
          const f = document.loginForm || document.getElementById('loginForm');
          if (!f) {
            out.error = 'loginForm not found on page';
            return out;
          }
          out.form = true;
          if (f.hdnType) f.hdnType.value = 'current';
          out.temp = typeof window.temp === 'function';
          out.tempName = typeof window.tempName !== 'undefined';
          try {
            if (out.temp && out.tempName) window.temp(window.tempName, 'loginForm');
          } catch (e) {
            out.error = 'temp() threw: ' + (e && e.message);
          }
          f.action = 'TenderDetailsHome.html';
          f.method = 'POST';
          f.submit();
        } catch (e) {
          out.error = String((e && e.message) || e);
        }
        return out;
      })
      .catch((e) => ({ form: false, temp: false, tempName: false, error: 'evaluate failed: ' + e.message }));
    console.log(`[${tag}] submit diagnostics: ${JSON.stringify(diag)}`);
    await navPromise;
    await page.waitForTimeout(3000);

    if (page.url().includes('TenderDetails') && !page.url().includes('SessionTimeOut')) {
      console.log(`[${tag}] on Tender Details page (via More link).`);
      await screenshot(page, `${tag}-03-tender-details`);
      return page; // return the ACTIVE page (may be the new tab)
    }
    console.warn(`[${tag}] not on Tender Details yet (at ${page.url()}) — retrying…`);
  }

  // FINAL FAILURE: dump full evidence regardless of debug mode, so the
  // user can share exactly what the automated browser saw.
  try {
    fs.mkdirSync(CONFIG.debugDir, { recursive: true });
    fs.writeFileSync(
      path.join(CONFIG.debugDir, `${tag}-homepage-dump.html`),
      await page.content()
    );
    await page.screenshot({
      path: path.join(CONFIG.debugDir, `${tag}-homepage-dump.png`),
      fullPage: true,
    });
    console.warn(
      `[${tag}] saved debug\\${tag}-homepage-dump.html and .png — ` +
        'please share these to diagnose the homepage layout.'
    );
  } catch {
    /* best effort */
  }

  throw new Error(
    'Could not reach TenderDetailsHome.html via the "More..." link after 3 ' +
      'attempts. See debug\\' + tag + '-homepage-dump.html/.png for what the ' +
      'automated browser actually rendered.'
  );
}

/** All frames (main + iframes). */
function allFrames(page) {
  return page.frames();
}

/**
 * Find the <select> (in any frame) containing an option matching text.
 * Matching is whitespace-insensitive and prefers, in order:
 *   1. exact match ("greater visakhapatnam municipal corporation")
 *   2. option that STARTS WITH the target
 *   3. option that merely CONTAINS the target
 * This prevents "Greater Visakhapatnam" from grabbing
 * "Greater Visakhapatnam Smart City Corporation Limited".
 */
async function selectByOptionText(page, optionText) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
  const target = norm(optionText);

  let best = null; // { sel, value, label, rank } — lower rank wins

  for (const frame of allFrames(page)) {
    let selects;
    try {
      selects = frame.locator('select');
    } catch {
      continue;
    }
    const n = await selects.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const sel = selects.nth(i);
      const match = await sel
        .evaluate((el, t) => {
          const normJs = (s) => s.toLowerCase().replace(/\s+/g, '');
          let found = null;
          for (const o of el.options) {
            const opt = normJs(o.textContent.trim());
            let rank = null;
            if (opt === t) rank = 0;
            else if (opt.startsWith(t)) rank = 1;
            else if (opt.includes(t)) rank = 2;
            if (rank !== null && (!found || rank < found.rank)) {
              found = { value: o.value, label: o.textContent.trim(), rank };
              if (rank === 0) break;
            }
          }
          return found;
        }, target)
        .catch(() => null);

      if (match && (!best || match.rank < best.rank)) {
        best = { frame, sel, ...match };
        if (best.rank === 0) break;
      }
    }
    if (best && best.rank === 0) break;
  }

  if (!best) return null;
  await best.sel.selectOption(best.value, { force: true });
  await best.sel.evaluate((el) =>
    el.dispatchEvent(new Event('change', { bubbles: true }))
  );
  dbg(`selected "${best.label}" (match rank ${best.rank})`);
  return { frame: best.frame, label: best.label };
}

/** Diagnostics: what selects/options exist right now. */
async function describeSelects(page) {
  const report = [];
  for (const frame of allFrames(page)) {
    const info = await frame
      .evaluate(() =>
        [...document.querySelectorAll('select')].map((s) => ({
          id: s.id || null,
          name: s.name || null,
          options: [...s.options].slice(0, 5).map((o) => o.textContent.trim()),
          totalOptions: s.options.length,
        }))
      )
      .catch(() => []);
    if (info.length) report.push({ frame: frame.url(), selects: info });
  }
  return report;
}

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
      if (hints.some((h) => lk.includes(h)) && v != null && v !== '') {
        return String(v);
      }
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

/**
 * Locate the ACTUAL Tender List table — the one whose header row
 * contains "Tender ID" and "Name of Work". Header cells can wrap onto
 * multiple lines ("Tender\nID"), so all whitespace is normalized to
 * single spaces before matching.
 */
async function findTenderTable(frame) {
  const tables = frame.locator('table');
  const n = await tables.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const table = tables.nth(i);
    const headerText = (
      await table.locator('tr').first().innerText().catch(() => '')
    )
      .toLowerCase()
      .replace(/\s+/g, ' '); // "tender\nid" -> "tender id"
    if (headerText.includes('tender id') && headerText.includes('name of work')) {
      return table;
    }
  }
  return null;
}

/** Turn one row's cells into a tender object, or null if not a tender row. */
function rowToTender(clean) {
  if (clean.length < 8) return null;
  if (!/^\d{4,}$/.test(clean[1])) return null; // Tender ID must be numeric
  return {
    department:    clean[0] || null,
    tenderId:      clean[1],
    noticeNumber:  clean[2] || null,
    category:      clean[3] || null,
    title:         clean[4] || 'Untitled tender',
    value:         clean[5] || null,
    publishedDate: clean[6] || null,
    closingDate:   clean[7] || null,
    emd:           null,
    _raw: clean,
  };
}

/**
 * Parse the Tender List. Confirmed columns:
 * 0 Department Name | 1 Tender ID | 2 Tender Notice Number
 * 3 Tender Category | 4 Name of Work | 5 Estimated Contract Value
 * 6 Start Date & Time | 7 Closing Date & Time | 8 Action
 *
 * Primary: rows of the header-identified table.
 * Fallback: if header matching fails (markup change), scan EVERY table
 * and keep rows that validate as tenders (>=8 cells, numeric ID) —
 * the numeric-ID rule keeps filter rows out either way.
 */
async function parseResultsTable(frame) {
  // The portal's tender list is the DataTables grid #pagetable13
  // (confirmed from the page source). Try it directly first, then the
  // header-matching approach, then a scan of every table row.
  let scope = null;
  if (await frame.locator('#pagetable13').count().catch(() => 0)) {
    scope = frame.locator('#pagetable13 tbody tr');
  } else {
    const table = await findTenderTable(frame);
    scope = table ? table.locator('tbody tr') : frame.locator('table tr');
    if (!table) dbg('header match failed — falling back to all-tables scan');
  }

  const count = await scope.count().catch(() => 0);
  const tenders = [];
  for (let i = 0; i < count; i++) {
    const cells = await scope.nth(i).locator('td').allInnerTexts().catch(() => []);
    const clean = cells.map((c) => c.replace(/\s+/g, ' ').trim());
    const t = rowToTender(clean);
    if (t) tenders.push(t);
  }
  return tenders;
}

/**
 * After clicking Apply, results render asynchronously — poll for up to
 * ~24s until at least one VALID tender row (numeric ID) appears.
 */
async function waitForResults(frame) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const tenders = await parseResultsTable(frame);
    if (tenders.length) return tenders;
    await frame.waitForTimeout(2000);
  }
  return [];
}

async function collectAllPages(frame, maxPages = 10) {
  let all = await waitForResults(frame);
  for (let p = 2; p <= maxPages; p++) {
    const next = frame
      .locator('#pagetable13_next, a:has-text("Next"), button:has-text("Next")')
      .first();
    if (!(await next.count().catch(() => 0))) break;
    const disabled = await next
      .evaluate((el) => el.classList.contains('disabled') || el.hasAttribute('disabled'))
      .catch(() => true);
    if (disabled) break;
    await next.click().catch(() => {});
    await frame.waitForTimeout(2500);
    const more = await parseResultsTable(frame);
    if (!more.length) break;
    if (more[0] && all.some((t) => t.tenderId && t.tenderId === more[0].tenderId)) break;
    all = all.concat(more);
  }
  return all;
}

export async function scrapeSearch(search) {
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
    // Debug: use the real (maximized) window size so nothing is cut off.
    // Headless: full-HD viewport so the layout matches a normal desktop.
    ...(CONFIG.debug ? { viewport: null } : { viewport: { width: 1920, height: 1080 } }),
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
  });

  let page = await context.newPage();
  page.setDefaultTimeout(CONFIG.actionTimeout);

  // Capture the exact body of every form POST to TenderDetailsHome.html
  // so automated vs manual submissions can be diffed field-by-field.
  // Bound at CONTEXT level so captures keep working if the portal opens
  // the tender page in a new tab.
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
        const body = await res.json();
        jsonResponses.push({ url: res.url(), body });
      }
    } catch {
      /* ignore */
    }
  });

  try {
    // Steps 1–3: error page → home → close ad → More... → Tender Details
    // (returns the ACTIVE page — More... may have opened a new tab)
    page = await reachTenderDetails(page, search.id);

    // Step 4: open Advanced Search (this reveals the dropdowns).
    console.log(`[${search.id}] opening Advanced Search…`);
    await clickFirst(
      page,
      ['button:has-text("Advanced Search")', 'text=Advanced Search'],
      'Advanced Search',
      10000
    );
    await page.waitForTimeout(3000); // dropdowns render + dept list loads
    await screenshot(page, `${search.id}-04-advanced-open`);

    const selectReport = await describeSelects(page);
    await saveDebug(`${search.id}-selects.json`, JSON.stringify(selectReport, null, 2));

    // Step 5: Department
    const dept = await selectByOptionText(page, search.department);
    if (!dept) {
      throw new Error(
        `Department "${search.department}" not found in any dropdown. ` +
          'See debug/' + search.id + '-selects.json for available options.'
      );
    }
    console.log(`[${search.id}] department set: ${dept.label}`);
    await page.waitForTimeout(3000); // sub-department list loads

    // Sub-department (GVMC only)
    if (search.subDepartment) {
      const sub = await selectByOptionText(page, search.subDepartment);
      if (!sub) {
        console.warn(
          `[${search.id}] Sub-department "${search.subDepartment}" not found — ` +
            'searching with department only. Check debug/' + search.id + '-selects.json.'
        );
      } else {
        console.log(`[${search.id}] sub-department set: ${sub.label}`);
      }
      await page.waitForTimeout(1500);
    }
    await screenshot(page, `${search.id}-05-filters-set`);

    // Click "Apply" (#searchTender). IMPORTANT: advsearchBtn() performs
    // a full form POST and PAGE NAVIGATION — the results arrive in a
    // freshly server-rendered page. So we must wait for that navigation
    // to complete before looking for the table.
    if (CONFIG.debug) {
      // DEBUG = manual mode: YOU click Apply in the opened browser.
      // This lets us compare a human-clicked POST with the automated one.
      console.log(
        `\n[${search.id}] >>> DEBUG MODE: please click the APPLY button ` +
          'manually in the browser window now. Waiting up to 120s…\n'
      );
      await page
        .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 })
        .catch(() => console.warn(`[${search.id}] no navigation detected after 120s`));
    } else {
      console.log(`[${search.id}] invoking Apply (advsearchBtn) and waiting for results page…`);
      // Call the portal's own Apply function DIRECTLY. Clicking by
      // element proved ambiguous (the click fired searchBtn() — the
      // plain Search — instead of advsearchBtn(), observed via POST
      // body capture). Invoking the function by name cannot miss.
      await Promise.all([
        page
          .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.navTimeout })
          .catch(() => null),
        page.evaluate(() => {
          if (typeof window.advsearchBtn === 'function') {
            window.advsearchBtn();
          } else {
            const btn = document.querySelector('input[value="Apply"]');
            if (btn) btn.click();
            else throw new Error('Neither advsearchBtn() nor an Apply input found');
          }
        }),
      ]);
    }
    await page.waitForTimeout(2000);
    dbg(`after Apply, url: ${page.url()}`);

    // Persist the captured POST body (ALWAYS — tiny file, huge diagnostic value)
    try {
      fs.mkdirSync(CONFIG.debugDir, { recursive: true });
      const mode = CONFIG.debug ? 'manual' : 'auto';
      const body = postCaptures[postCaptures.length - 1] || '(no POST captured)';
      // Save EVERY captured POST — if two fired, that itself is a clue.
      fs.writeFileSync(
        path.join(CONFIG.debugDir, `${search.id}-post-${mode}.txt`),
        postCaptures.length
          ? postCaptures.map((p, i) => `--- POST #${i + 1} ---\n${p}`).join('\n\n')
          : '(no POST captured)'
      );
      // Console summary of the fields that matter
      const params = new URLSearchParams(body);
      const brief = ['nDepartmentID', 'subDeptId', 'hdnSearch', 'hdnSearch4', 'hdnadvsearch', 'hdnnoSearch', 'ddlDistrict', 'ddlMandal']
        .map((k) => `${k}=${params.get(k)}`)
        .join(' | ');
      console.log(`[${search.id}] POST (${mode}): ${brief}`);
    } catch (e) {
      dbg(`post capture save failed: ${e.message}`);
    }

    if (page.url().includes('SessionTimeOut')) {
      throw new Error(
        'The Apply POST was bounced to SessionTimeOut.jsp. ' +
          'Re-run — if it persists, the portal session handling changed.'
      );
    }

    // Results are server-rendered into #pagetable13 — wait for rows.
    await page
      .waitForSelector('#pagetable13 tbody tr td', { timeout: 30000 })
      .catch(() => dbg('no #pagetable13 rows appeared within 30s'));
    await screenshot(page, `${search.id}-06-results`);

    await saveDebug(`${search.id}-responses.json`, JSON.stringify(jsonResponses, null, 2));

    // Strategy 1: backend JSON captured during Apply
    for (let i = jsonResponses.length - 1; i >= 0; i--) {
      const arr = extractTenderArray(jsonResponses[i].body);
      if (arr && arr.length) {
        console.log(
          `[${search.id}] extracted ${arr.length} tenders from portal JSON (${jsonResponses[i].url})`
        );
        return arr.map(normalizeFromJson);
      }
    }

    // Strategy 2: visible table + pagination (on the fresh results page)
    const fromTable = await collectAllPages(page.mainFrame());
    console.log(`[${search.id}] extracted ${fromTable.length} tenders from results table`);

    if (!fromTable.length) {
      // Zero results: dump the rendered page so we can SEE what the
      // server returned (rows we failed to parse vs. a genuine
      // "No matching records found"). Saved regardless of debug mode.
      try {
        fs.mkdirSync(CONFIG.debugDir, { recursive: true });
        fs.writeFileSync(
          path.join(CONFIG.debugDir, `${search.id}-results-page.html`),
          await page.content()
        );
        await page.screenshot({
          path: path.join(CONFIG.debugDir, `${search.id}-results-page.png`),
          fullPage: true,
        });
        console.log(
          `[${search.id}] saved debug/${search.id}-results-page.html and .png for inspection`
        );
      } catch (e) {
        dbg(`results-page dump failed: ${e.message}`);
      }
    }
    return fromTable;
  } finally {
    await browser.close();
  }
}
