import { CONFIG, SEARCHES, assertConfig } from './config.js';
import { scrapeSearchesStream } from './scraper.js';
import { isNewTender, isReReleased, markSent, sweepMissing, isFirstRunFor, markSearchKnown } from './store.js';
import { sendTelegram, deleteTelegramMessage, formatTenderMessage, pause } from './notifier.js';

/**
 * Orchestrator:
 *   node src/index.js --once   → single check (good for testing)
 *   node src/index.js          → runs forever on the adaptive schedule
 *
 * Results STREAM from the scraper (async generator): each search's
 * tenders are alerted the moment that search finishes, instead of
 * waiting for the whole cycle — first alert arrives up to ~1 min sooner.
 */

// ---- self-monitoring ----
// After FAIL_NOTIFY_AT consecutive unhealthy checks for a search (scrape
// threw OR returned zero tenders), send ONE warning to the group; the next
// healthy check sends a recovery note. Failure DURATION is measured from
// real timestamps, so the message stays accurate whatever the schedule.
const FAIL_NOTIFY_AT = 6;
const failState = {}; // id -> { count, firstAt }

async function notifyHealth(text) {
  try {
    await sendTelegram(text);
  } catch (e) {
    console.error(`health notification failed: ${e.message}`);
  }
}

function humanDuration(ms) {
  const mins = Math.round(ms / 60000);
  return mins >= 90 ? `${(mins / 60).toFixed(1)} h` : `${mins} min`;
}

async function trackHealth(search, ok, detail) {
  const st = failState[search.id] || (failState[search.id] = { count: 0, firstAt: null });
  if (ok) {
    if (st.count >= FAIL_NOTIFY_AT) {
      await notifyHealth(
        `✅ <b>Tender bot recovered</b> — "${search.label}" is returning results again.`
      );
    }
    st.count = 0;
    st.firstAt = null;
    return;
  }
  if (st.count === 0) st.firstAt = Date.now();
  st.count += 1;
  if (st.count === FAIL_NOTIFY_AT) {
    await notifyHealth(
      `⚠️ <b>Tender bot needs attention</b>\n` +
        `"${search.label}" has had ${FAIL_NOTIFY_AT} consecutive unhealthy checks ` +
        `over ~${humanDuration(Date.now() - st.firstAt)}.\n` +
        `Last issue: ${detail}\n\n` +
        `Either the department genuinely has no live tenders right now, or the ` +
        `portal changed and the scraper needs a fix. ` +
        `SSH in and run: pm2 logs tender-alerts --lines 50 --nostream`
    );
  }
}

function tenderKey(t, searchId) {
  // The parser guarantees a numeric tenderId (rows without one are
  // rejected), so this is stable; title fallback is a last-resort only.
  return `${searchId}::${t.tenderId || t.title}`;
}

// ---- per-search processing (called as each search's results stream in) ----

async function processSearchResult({ search, tenders, error }) {
  const firstRun = isFirstRunFor(search.id);
  if (firstRun) {
    console.log(
      `[${search.id}] first check for this search — recording current ` +
        'tenders WITHOUT alerting. New tenders alert from the next run.'
    );
  }
  if (error) {
    await trackHealth(search, false, `scrape error: ${error}`.slice(0, 300));
    return; // one department's failure never blocks the others
  }
  await trackHealth(search, tenders.length > 0, 'scrape succeeded but extracted 0 tenders');

  if (!tenders.length) {
    console.warn(
      `[${search.id}] 0 tenders returned. Either there are genuinely no ` +
        'live tenders for this department right now, or the selectors ' +
        'need tuning — run `npm run debug` to check screenshots.'
    );
    return;
  }

  let newCount = 0;
  const currentKeys = new Set(tenders.map((t) => tenderKey(t, search.id)));

  for (const t of tenders) {
    const key = tenderKey(t, search.id);
    if (!isNewTender(key)) continue;

    if (firstRun) {
      markSent(key); // record silently
      continue;
    }

    try {
      if (newCount > 0) await pause(3500); // rate-limit BETWEEN messages only
      const reReleased = isReReleased(key);
      const resp = await sendTelegram(formatTenderMessage(t, search.label, reReleased));
      markSent(key, resp?.result?.message_id ?? null);
      newCount++;
    } catch (e) {
      console.error(`[${search.id}] Telegram send failed: ${e.message}`);
      // don't markSent — we'll retry this tender next cycle
    }
  }

  // Age-out tenders that have left the portal so a same-ID re-release
  // will alert again. Only runs when the scrape returned real results.
  const retiredNow = sweepMissing(search.id, currentKeys, tenders.length > 0);
  markSearchKnown(search.id); // baseline recorded; future runs alert

  // Withdrawn tender → remove its alert from the group (keeps the group
  // showing only live tenders). Requires bot admin for messages >48h old.
  if (CONFIG.deleteWithdrawnAlerts) {
    for (const r of retiredNow) {
      if (!r.msgId) continue; // alert predates msgId tracking, or silent baseline
      try {
        await deleteTelegramMessage(r.msgId);
        console.log(`[${search.id}] deleted group alert for withdrawn ${r.key}`);
        await pause(1200);
      } catch (e) {
        console.warn(
          `[${search.id}] could not delete alert for ${r.key}: ${e.message} ` +
            '(is the bot a group admin with Delete-messages permission?)'
        );
      }
    }
  }

  console.log(
    `[${search.id}] done. ${tenders.length} tenders found, ${newCount} new alert(s) sent.`
  );
}

// ---- cycle ----

let cycleRunning = false;

async function runOnce() {
  // Overlap guard: never run two Chromium sessions at once (fatal on 1 GB).
  if (cycleRunning) {
    console.warn('previous check still running — skipping this tick.');
    return;
  }
  cycleRunning = true;
  try {
    await runSearches();
  } finally {
    cycleRunning = false;
  }
}

async function runSearches() {
  const processed = new Set();
  try {
    // STREAMING: alert on each search's tenders as soon as that search
    // finishes, while the browser continues with the next search.
    for await (const result of scrapeSearchesStream(SEARCHES)) {
      processed.add(result.search.id);
      await processSearchResult(result);
    }
  } catch (e) {
    // Browser/session died mid-cycle: mark every UNPROCESSED search failed.
    console.error(`cycle failed: ${e.message}`);
    for (const search of SEARCHES) {
      if (!processed.has(search.id)) {
        await trackHealth(search, false, `cycle error: ${e.message}`.slice(0, 300));
      }
    }
  }
}

// ---------------- entrypoint ----------------
assertConfig();

if (process.argv.includes('--once')) {
  runOnce().then(() => {
    console.log('Single run complete.');
    process.exit(0);
  });
} else {
  // Adaptive scheduler: frequent checks during office hours (when
  // departments actually publish), relaxed at night and on Sundays.
  // Always at least 10 minutes between checks (politeness floor).
  function nextDelayMinutes() {
    if (!CONFIG.adaptiveSchedule) {
      return Math.max(10, CONFIG.pollIntervalMinutes);
    }
    const now = new Date(); // server timezone is Asia/Kolkata
    const day = now.getDay(); // 0=Sun … 6=Sat
    const hour = now.getHours();
    const officeHours =
      day >= 1 && day <= 6 &&
      hour >= CONFIG.activeStartHour && hour < CONFIG.activeEndHour;
    return Math.max(
      10,
      officeHours ? CONFIG.activeIntervalMin : CONFIG.quietIntervalMin
    );
  }

  async function loop() {
    console.log(`\n[${new Date().toISOString()}] scheduled check…`);
    try {
      await runOnce();
    } catch (e) {
      console.error(`cycle error: ${e.message}`);
    }
    const mins = nextDelayMinutes();
    console.log(`next check in ${mins} minutes.`);
    setTimeout(loop, mins * 60 * 1000);
  }

  console.log(
    CONFIG.adaptiveSchedule
      ? `Adaptive scheduler started — every ${CONFIG.activeIntervalMin} min ` +
        `(Mon–Sat ${CONFIG.activeStartHour}:00–${CONFIG.activeEndHour}:00 IST), ` +
        `every ${CONFIG.quietIntervalMin} min otherwise.`
      : `Scheduler started — checking every ${Math.max(10, CONFIG.pollIntervalMinutes)} minutes.`
  );
  loop();
}
