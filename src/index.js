
import { CONFIG, SEARCHES, assertConfig } from './config.js';
import { scrapeAllSearches } from './scraper.js';
import { isNewTender, isReReleased, markSent, sweepMissing, isFirstRunFor, markSearchKnown } from './store.js';
import { sendTelegram, deleteTelegramMessage, formatTenderMessage, pause } from './notifier.js';

/**
 * Orchestrator:
 *   node src/index.js --once   → single check (good for cron / testing)
 *   node src/index.js          → runs forever, checking every
 *                                POLL_INTERVAL_MINUTES (good for PM2)
 */

// ---- self-monitoring ----
// After this many consecutive unhealthy cycles for a search (scrape threw,
// OR returned zero tenders), send ONE warning to the Telegram group. A
// healthy cycle after a warning sends a recovery note. In-memory counters
// (reset on restart) are fine: a restart triggers an immediate check anyway.
const FAIL_NOTIFY_AT = 6;
const failStreak = {};

async function notifyHealth(text) {
  try {
    await sendTelegram(text);
  } catch (e) {
    console.error(`health notification failed: ${e.message}`);
  }
}

async function trackHealth(search, ok, detail) {
  const id = search.id;
  if (ok) {
    if ((failStreak[id] || 0) >= FAIL_NOTIFY_AT) {
      await notifyHealth(
        `✅ <b>Tender bot recovered</b> — "${search.label}" is returning results again.`
      );
    }
    failStreak[id] = 0;
    return;
  }
  failStreak[id] = (failStreak[id] || 0) + 1;
  if (failStreak[id] === FAIL_NOTIFY_AT) {
    await notifyHealth(
      `⚠️ <b>Tender bot needs attention</b>\n` +
        `"${search.label}" has had ${FAIL_NOTIFY_AT} consecutive unhealthy checks ` +
        `(~${Math.round((FAIL_NOTIFY_AT * 45) / 60)}h).\n` +
        `Last issue: ${detail}\n\n` +
        `Either the department genuinely has no live tenders right now, or the ` +
        `portal changed and the scraper needs a fix. ` +
        `SSH in and run: pm2 logs tender-alerts --lines 50 --nostream`
    );
  }
}

function tenderKey(t, searchId) {
  // Prefer the portal's tender ID; fall back to a title hash so we
  // still dedup even if the ID column wasn't parsed.
  return `${searchId}::${t.tenderId || t.title}`;
}

let cycleRunning = false;

async function runOnce() {
  // Overlap guard: if a cycle is still going when the next tick fires
  // (slow portal + several searches), skip rather than run two Chromium
  // sessions at once — fatal on a 1 GB server.
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
  // ONE browser + ONE portal session for the whole cycle (fast).
  let results;
  try {
    results = await scrapeAllSearches(SEARCHES);
  } catch (e) {
    console.error(`cycle failed before any search could run: ${e.message}`);
    for (const search of SEARCHES) {
      await trackHealth(search, false, `cycle error: ${e.message}`.slice(0, 300));
    }
    return;
  }

  for (const { search, tenders, error } of results) {
    const firstRun = isFirstRunFor(search.id);
    if (firstRun) {
      console.log(
        `[${search.id}] first check for this search — recording current ` +
          'tenders WITHOUT alerting. New tenders alert from the next run.'
      );
    }
    if (error) {
      await trackHealth(search, false, `scrape error: ${error}`.slice(0, 300));
      continue; // one department's failure never blocks the others
    }
    await trackHealth(
      search,
      tenders.length > 0,
      'scrape succeeded but extracted 0 tenders'
    );

    if (!tenders.length) {
      console.warn(
        `[${search.id}] 0 tenders returned. Either there are genuinely no ` +
          'live tenders for this department right now, or the selectors ' +
          'need tuning — run `npm run debug` to check screenshots.'
      );
      continue;
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
        const reReleased = isReReleased(key);
        const resp = await sendTelegram(formatTenderMessage(t, search.label, reReleased));
        markSent(key, resp?.result?.message_id ?? null);
        newCount++;
        await pause(3500); // stay under Telegram's group rate limit
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
