import fs from 'fs';
import path from 'path';
import { CONFIG, SEARCHES, assertConfig } from './config.js';
import { scrapeSearchesStream } from './scraper.js';
import {
  isNewTender, isReReleased, markSent, sweepMissing, isFirstRunFor, markSearchKnown,
  getFingerprint, setFingerprint, getPendingRetirements, markRetirementNotified,
  storeLoadWarning,
} from './store.js';
import {
  sendTelegram, deleteTelegramMessage, editTelegramMessage,
  formatTenderMessage, formatUpdateMessage, formatWithdrawnTombstone, pause,
} from './notifier.js';

/**
 * Orchestrator:
 *   node src/index.js --once     → single check
 *   node src/index.js            → adaptive schedule (production)
 *   flags: --debug (extra artifacts, headless) · --headed (visible browser)
 *
 * Search results have four states with distinct handling:
 *   ok      → healthy; alert/baseline/sweep
 *   empty   → healthy (portal explicitly says no records); baseline + sweep
 *   timeout → UNHEALTHY (thrown by scraper); no baseline, no sweep, session reset
 *   error   → UNHEALTHY; same
 */

// ---------------- process lock ----------------
// The in-memory overlap guard only covers one process. This lockfile stops a
// manual `--once` run colliding with the PM2 instance (two Chromiums = OOM,
// plus competing .tmp state writes). Stale locks (dead PID) are reclaimed.

const LOCK_PATH = path.join(path.dirname(CONFIG.seenStorePath), 'bot.lock');

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const otherPid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10);
    let alive = false;
    try {
      process.kill(otherPid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) {
      console.error(
        `Another instance (pid ${otherPid}) holds ${LOCK_PATH}. ` +
          'If PM2 is running the bot, stop it before manual runs: pm2 stop tender-alerts'
      );
      process.exit(1);
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid)); // reclaim stale lock
  }
  const release = () => {
    try {
      if (parseInt(fs.readFileSync(LOCK_PATH, 'utf8'), 10) === process.pid) {
        fs.unlinkSync(LOCK_PATH);
      }
    } catch {
      /* best effort */
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}

// ---------------- self-monitoring ----------------

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
        `✅ <b>Tender bot recovered</b> — "${search.label}" is scraping normally again.`
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
        `"${search.label}" has had ${FAIL_NOTIFY_AT} consecutive failed checks ` +
        `over ~${humanDuration(Date.now() - st.firstAt)}.\n` +
        `Last issue: ${detail}\n\n` +
        `The portal may have changed. SSH in and run: ` +
        `pm2 logs tender-alerts --lines 50 --nostream`
    );
  }
}

// ---------------- amendment detection ----------------

const FP_FIELDS = ['noticeNumber', 'title', 'value', 'publishedDate', 'closingDate'];
const FP_LABELS = {
  noticeNumber: 'Notice No', title: 'Name of Work', value: 'Value',
  publishedDate: 'Start Date', closingDate: 'Closing Date',
};

function tenderFingerprint(t) {
  return JSON.stringify(FP_FIELDS.map((f) => t[f] ?? null));
}

function fingerprintChanges(oldFp, t) {
  let oldVals;
  try {
    oldVals = JSON.parse(oldFp);
  } catch {
    return [];
  }
  const changes = [];
  FP_FIELDS.forEach((f, i) => {
    const from = oldVals[i];
    const to = t[f] ?? null;
    if (from !== to) changes.push({ field: FP_LABELS[f], from, to });
  });
  return changes;
}

function tenderKey(t, searchId) {
  return `${searchId}::${t.tenderId || t.title}`;
}

// ---------------- per-search processing ----------------

async function processSearchResult({ search, status, tenders, error }) {
  const firstRun = isFirstRunFor(search.id);
  if (firstRun) {
    console.log(
      `[${search.id}] first check for this search — recording current ` +
        'tenders WITHOUT alerting. New tenders alert from the next run.'
    );
  }

  if (status === 'error') {
    await trackHealth(search, false, `scrape error: ${error}`.slice(0, 300));
    return;
  }

  // 'ok' and 'empty' are both HEALTHY scrapes.
  await trackHealth(search, true);

  if (status === 'empty') {
    console.log(`[${search.id}] confirmed empty department this check.`);
  }

  let newCount = 0;
  const currentKeys = new Set(tenders.map((t) => tenderKey(t, search.id)));

  for (const t of tenders) {
    const key = tenderKey(t, search.id);
    const fp = tenderFingerprint(t);

    if (!isNewTender(key)) {
      // KNOWN tender — detect in-place amendments (corrigendum-style edits).
      const oldFp = getFingerprint(key);
      if (oldFp && oldFp !== fp && !firstRun) {
        const changes = fingerprintChanges(oldFp, t);
        if (changes.length) {
          try {
            if (newCount > 0) await pause(3500);
            await sendTelegram(formatUpdateMessage(t, search.label, changes));
            newCount++;
            console.log(`[${search.id}] update alert sent for amended ${key}`);
          } catch (e) {
            console.error(`[${search.id}] update alert failed: ${e.message}`);
            continue; // keep old fp → retry next cycle
          }
        }
      }
      if (oldFp !== fp) setFingerprint(key, fp);
      continue;
    }

    if (firstRun) {
      markSent(key, null, fp); // record silently, with fingerprint
      continue;
    }

    try {
      if (newCount > 0) await pause(3500); // rate-limit BETWEEN messages only
      const reReleased = isReReleased(key);
      const resp = await sendTelegram(formatTenderMessage(t, search.label, reReleased));
      markSent(key, resp?.result?.message_id ?? null, fp);
      newCount++;
    } catch (e) {
      console.error(`[${search.id}] Telegram send failed: ${e.message}`);
      // don't markSent — retried next cycle
    }
  }

  // HEALTHY scrapes ('ok' AND explicit 'empty') baseline and sweep — an
  // emptied department must still retire its last tenders, and a new search
  // that starts empty must still exit first-run mode so its first real
  // tender ALERTS instead of being silently baselined.
  sweepMissing(search.id, currentKeys, true);
  markSearchKnown(search.id);

  // Withdrawn-alert group cleanup, with retry across cycles:
  //  - younger than 48h → delete the alert
  //  - older (or delete refused) → EDIT it into a ❌ Withdrawn tombstone
  //    (Telegram's 48h delete limit doesn't apply to editing own messages)
  if (CONFIG.deleteWithdrawnAlerts) {
    for (const r of getPendingRetirements(search.id)) {
      const tenderId = r.key.split('::')[1] || r.key;
      const ageMs = r.sentAt ? Date.now() - new Date(r.sentAt).getTime() : Infinity;
      const youngEnoughToDelete = ageMs < 47 * 3600 * 1000; // safety margin
      try {
        if (youngEnoughToDelete) {
          try {
            await deleteTelegramMessage(r.msgId);
            console.log(`[${search.id}] deleted group alert for withdrawn ${r.key}`);
          } catch {
            await editTelegramMessage(r.msgId, formatWithdrawnTombstone(tenderId, search.label));
            console.log(`[${search.id}] edited withdrawn alert to tombstone: ${r.key}`);
          }
        } else {
          await editTelegramMessage(r.msgId, formatWithdrawnTombstone(tenderId, search.label));
          console.log(`[${search.id}] edited withdrawn alert to tombstone: ${r.key}`);
        }
        markRetirementNotified(r.key, true);
        await pause(1200);
      } catch (e) {
        console.warn(
          `[${search.id}] group cleanup failed for ${r.key}: ${e.message} — will retry next cycle.`
        );
        markRetirementNotified(r.key, false);
      }
    }
  }

  console.log(
    `[${search.id}] done. ${tenders.length} tenders found, ${newCount} alert(s) sent.`
  );
}

// ---------------- cycle ----------------

let cycleRunning = false;

async function runOnce() {
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
    for await (const result of scrapeSearchesStream(SEARCHES)) {
      processed.add(result.search.id);
      await processSearchResult(result);
    }
  } catch (e) {
    console.error(`cycle failed: ${e.message}`);
    for (const search of SEARCHES) {
      if (!processed.has(search.id)) {
        await trackHealth(search, false, `cycle error: ${e.message}`.slice(0, 300));
      }
    }
  }
}

// ---------------- IST-explicit scheduling ----------------
// Never depend on the OS timezone: compute IST via Intl regardless of the
// host's configuration (a rebuilt VM in UTC must not shift the window).

function istNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  const weekday = parts.find((p) => p.type === 'weekday').value; // Mon..Sun
  return { hour, isSunday: weekday === 'Sun' };
}

function nextDelayMinutes() {
  if (!CONFIG.adaptiveSchedule) return Math.max(10, CONFIG.pollIntervalMinutes);
  const { hour, isSunday } = istNow();
  const officeHours =
    !isSunday && hour >= CONFIG.activeStartHour && hour < CONFIG.activeEndHour;
  return Math.max(10, officeHours ? CONFIG.activeIntervalMin : CONFIG.quietIntervalMin);
}

// ---------------- entrypoint ----------------

assertConfig();
acquireLock();

if (storeLoadWarning) {
  notifyHealth(`⚠️ <b>Tender bot state warning</b>\n${storeLoadWarning}`);
}

if (process.argv.includes('--once')) {
  runOnce().then(() => {
    console.log('Single run complete.');
    process.exit(0);
  });
} else {
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
        `(Mon–Sat ${CONFIG.activeStartHour}:00–${CONFIG.activeEndHour}:00 IST, ` +
        `computed via Intl — OS timezone independent), ` +
        `every ${CONFIG.quietIntervalMin} min otherwise.`
      : `Scheduler started — every ${Math.max(10, CONFIG.pollIntervalMinutes)} minutes.`
  );
  loop();
}
