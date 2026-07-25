import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CONFIG, SEARCHES, assertConfig } from './config.js';
import { scrapeSearchesStream } from './scraper.js';
import {
  isNewTender, isReReleased, markSent, sweepMissing, isFirstRunFor, markSearchKnown,
  getFingerprint, setFingerprint, getPendingRetirements, markRetirementNotified,
  getSnapshot, getMsgId, storeLoadWarning,
} from './store.js';
import {
  sendTelegram, deleteTelegramMessage, editTelegramMessage, isAlreadyCompleted,
  formatTenderMessage, formatUpdateMessage, formatWithdrawnTombstone, pause,
} from './notifier.js';

/**
 * Orchestrator v6.
 *   node src/index.js --once     → single check (exit code 1 if any search failed)
 *   node src/index.js            → adaptive IST schedule (production)
 *   flags: --debug (artifacts, headless) · --headed (visible browser)
 */

// ---------------- atomic process lock (#8) ----------------
// Lock DIRECTORY (mkdir is atomic) + random owner token (immune to PID
// reuse). Stale locks are reclaimed via atomic rename, so two processes
// can never both "win" a stale lock.

const LOCK_DIR = path.join(path.dirname(CONFIG.seenStorePath), 'bot.lock');
const OWNER_FILE = path.join(LOCK_DIR, 'owner.json');
const myToken = crypto.randomUUID();

function tryAcquire() {
  try {
    fs.mkdirSync(LOCK_DIR); // atomic: fails with EEXIST if held
    fs.writeFileSync(OWNER_FILE, JSON.stringify({ pid: process.pid, token: myToken, at: new Date().toISOString() }));
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  if (tryAcquire()) return;

  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
  } catch {
    /* unreadable owner: treat as stale */
  }
  let alive = false;
  if (owner?.pid) {
    try {
      process.kill(owner.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  if (alive) {
    console.error(
      `Another instance (pid ${owner.pid}) holds ${LOCK_DIR}. ` +
        'If PM2 is running the bot, stop it before manual runs: pm2 stop tender-alerts'
    );
    process.exit(1);
  }
  // Stale: reclaim via ATOMIC rename — only one contender can win it.
  const graveyard = `${LOCK_DIR}.stale-${Date.now()}-${process.pid}`;
  try {
    fs.renameSync(LOCK_DIR, graveyard);
    fs.rmSync(graveyard, { recursive: true, force: true });
  } catch {
    /* another contender renamed it first — fall through to mkdir race */
  }
  if (!tryAcquire()) {
    console.error('Lost the lock race to another starting instance. Exiting.');
    process.exit(1);
  }
}

function releaseLock() {
  try {
    const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
    if (owner.token === myToken) fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ---------------- self-monitoring ----------------

const FAIL_NOTIFY_AT = 6;
const failState = {};

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
      await notifyHealth(`✅ <b>Tender bot recovered</b> — "${search.label}" is scraping normally again.`);
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
        `SSH in and run: pm2 logs tender-alerts --lines 50 --nostream`
    );
  }
}

// ---------------- amendment fingerprints (#21: normalized) ----------------

const FP_FIELDS = ['noticeNumber', 'title', 'value', 'publishedDate', 'closingDate'];
const FP_LABELS = {
  noticeNumber: 'Notice No', title: 'Name of Work', value: 'Value',
  publishedDate: 'Start Date', closingDate: 'Closing Date',
};

export function canonical(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function tenderFingerprint(t) {
  return JSON.stringify(FP_FIELDS.map((f) => canonical(t[f]) || null));
}

export function fingerprintChanges(oldFp, t) {
  let oldVals;
  try {
    oldVals = JSON.parse(oldFp);
  } catch {
    return [];
  }
  const changes = [];
  FP_FIELDS.forEach((f, i) => {
    const from = oldVals[i];
    const to = canonical(t[f]) || null;
    if (from !== to) changes.push({ field: FP_LABELS[f], from, to });
  });
  return changes;
}

function tenderKey(t, searchId) {
  return `${searchId}::${t.tenderId || t.title}`;
}

// ---------------- per-search processing ----------------

async function processSearchResult({ search, status, tenders, error }, summary) {
  const firstRun = isFirstRunFor(search.id);
  if (firstRun) {
    console.log(
      `[${search.id}] first check for this search — recording current ` +
        'tenders WITHOUT alerting. New tenders alert from the next run.'
    );
  }

  // Exhaustive whitelist (#7): anything not explicitly healthy is a failure —
  // a future status value can never accidentally baseline or sweep.
  const healthy = status === 'ok' || status === 'empty';
  if (!healthy) {
    summary.failed++;
    await trackHealth(search, false, `${status}: ${error || 'unknown scrape failure'}`.slice(0, 300));
    return;
  }
  summary.successful++;
  await trackHealth(search, true);
  if (status === 'empty') console.log(`[${search.id}] confirmed empty department this check.`);

  let newCount = 0;
  const currentKeys = new Set(tenders.map((t) => tenderKey(t, search.id)));

  for (const t of tenders) {
    const key = tenderKey(t, search.id);
    const fp = tenderFingerprint(t);

    if (!isNewTender(key)) {
      const oldFp = getFingerprint(key);
      if (oldFp && oldFp !== fp && !firstRun) {
        const changes = fingerprintChanges(oldFp, t);
        if (changes.length) {
          try {
            if (newCount > 0) await pause(3500);
            // Best UX (#20): refresh the ORIGINAL alert in place, then send
            // a compact 📝 note showing exactly what changed.
            const origMsgId = getMsgId(key);
            if (origMsgId) {
              try {
                await editTelegramMessage(
                  origMsgId,
                  formatTenderMessage(t, search.label, false, `Updated ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}`)
                );
              } catch (e) {
                if (!isAlreadyCompleted(e)) dbgWarn(search.id, `original-alert edit failed: ${e.message}`);
              }
            }
            await sendTelegram(formatUpdateMessage(t, search.label, changes));
            newCount++;
            summary.alertsSent++;
            console.log(`[${search.id}] update alert sent for amended ${key}`);
          } catch (e) {
            console.error(`[${search.id}] update alert failed: ${e.message}`);
            continue; // keep old fp → retried next cycle
          }
        }
      }
      if (oldFp !== fp) setFingerprint(key, fp);
      continue;
    }

    if (firstRun) {
      markSent(key, null, fp, { title: t.title });
      continue;
    }

    try {
      if (newCount > 0) await pause(3500);
      const reReleased = isReReleased(key);
      const resp = await sendTelegram(formatTenderMessage(t, search.label, reReleased));
      markSent(key, resp?.result?.message_id ?? null, fp, { title: t.title });
      newCount++;
      summary.alertsSent++;
    } catch (e) {
      console.error(`[${search.id}] Telegram send failed: ${e.message}`);
    }
  }

  sweepMissing(search.id, currentKeys, true);
  markSearchKnown(search.id);

  // Withdrawn-alert cleanup: delete (<47h) or edit to ❌ tombstone; retried
  // across cycles; idempotent against "not found"/"not modified" (#9).
  if (CONFIG.deleteWithdrawnAlerts) {
    for (const r of getPendingRetirements(search.id)) {
      // RACE GUARD (#5): a re-released tender whose 🔁 send failed is still
      // in `retired` — but it's LIVE on the portal. Never clean up its alert.
      if (currentKeys.has(r.key)) {
        console.log(`[${search.id}] skipping withdrawn cleanup for live tender ${r.key}`);
        continue;
      }
      const tenderId = r.key.split('::')[1] || r.key;
      const title = r.snapshot?.title || getSnapshot(r.key)?.title || null;
      const ageMs = r.sentAt ? Date.now() - new Date(r.sentAt).getTime() : Infinity;
      let success = false;
      try {
        if (ageMs < 47 * 3600 * 1000) {
          try {
            await deleteTelegramMessage(r.msgId);
            console.log(`[${search.id}] deleted group alert for withdrawn ${r.key}`);
          } catch (e) {
            if (isAlreadyCompleted(e)) throw e; // handled below as success
            await editTelegramMessage(r.msgId, formatWithdrawnTombstone(tenderId, search.label, title));
            console.log(`[${search.id}] edited withdrawn alert to tombstone: ${r.key}`);
          }
        } else {
          await editTelegramMessage(r.msgId, formatWithdrawnTombstone(tenderId, search.label, title));
          console.log(`[${search.id}] edited withdrawn alert to tombstone: ${r.key}`);
        }
        success = true;
      } catch (e) {
        if (isAlreadyCompleted(e)) {
          console.log(`[${search.id}] cleanup already effective for ${r.key} (${e.description || e.message})`);
          success = true;
        } else {
          console.warn(`[${search.id}] group cleanup failed for ${r.key}: ${e.message} — will retry.`);
        }
      }
      const outcome = markRetirementNotified(r.key, success);
      if (outcome === 'gave-up') {
        await notifyHealth(
          `⚠️ <b>Tender bot</b>: could not clean up the group alert for withdrawn ` +
            `tender <code>${tenderId}</code> after repeated attempts (marked notify:"failed" in state).`
        );
      }
      await pause(1200);
    }
  }

  console.log(`[${search.id}] done. ${tenders.length} tenders found, ${newCount} alert(s) sent.`);
}

function dbgWarn(id, msg) {
  console.warn(`[${id}] ${msg}`);
}

// ---------------- cycle ----------------

let cycleRunning = false;

async function runOnce() {
  const summary = { successful: 0, failed: 0, alertsSent: 0 };
  if (cycleRunning) {
    console.warn('previous check still running — skipping this tick.');
    return summary;
  }
  cycleRunning = true;
  try {
    await runSearches(summary);
  } finally {
    cycleRunning = false;
  }
  return summary;
}

async function runSearches(summary) {
  const processed = new Set();
  try {
    for await (const result of scrapeSearchesStream(SEARCHES)) {
      // Per-result isolation (#6): a processing failure (state write,
      // Telegram, lifecycle) must not kill the generator, close Chromium,
      // and abandon the remaining searches.
      try {
        await processSearchResult(result, summary);
      } catch (e) {
        console.error(`[${result.search.id}] result processing failed: ${e.message}`);
        summary.failed++;
        await trackHealth(result.search, false, `processing error: ${e.message}`.slice(0, 300));
      }
      processed.add(result.search.id);
    }
  } catch (e) {
    console.error(`cycle failed: ${e.message}`);
    for (const search of SEARCHES) {
      if (!processed.has(search.id)) {
        summary.failed++;
        await trackHealth(search, false, `cycle error: ${e.message}`.slice(0, 300));
      }
    }
  }
}

// ---------------- IST-explicit scheduling ----------------

function istNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  const weekday = parts.find((p) => p.type === 'weekday').value;
  return { hour, isSunday: weekday === 'Sun' };
}

function nextDelayMinutes() {
  if (!CONFIG.adaptiveSchedule) return Math.max(10, CONFIG.pollIntervalMinutes);
  const { hour, isSunday } = istNow();
  const officeHours = !isSunday && hour >= CONFIG.activeStartHour && hour < CONFIG.activeEndHour;
  return Math.max(10, officeHours ? CONFIG.activeIntervalMin : CONFIG.quietIntervalMin);
}

// ---------------- entrypoint (#17, #18) ----------------

async function main() {
  assertConfig();
  acquireLock();
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      releaseLock();
      process.exit(0);
    });
  }

  if (storeLoadWarning) {
    // AWAITED: --once must not exit before this warning is delivered.
    await notifyHealth(`⚠️ <b>Tender bot state warning</b>\n${storeLoadWarning}`);
  }

  if (process.argv.includes('--once')) {
    const summary = await runOnce();
    console.log(
      `Single run complete: ${summary.successful} ok, ${summary.failed} failed, ` +
        `${summary.alertsSent} alert(s) sent.`
    );
    if (summary.failed > 0) process.exitCode = 1; // machine-checkable outcome
    return;
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
        `(Mon–Sat ${CONFIG.activeStartHour}:00–${CONFIG.activeEndHour}:00 IST via Intl), ` +
        `every ${CONFIG.quietIntervalMin} min otherwise.`
      : `Scheduler started — every ${Math.max(10, CONFIG.pollIntervalMinutes)} minutes.`
  );
  loop();
}

// Only run when executed directly — imports (tests) get pure functions only.
import { pathToFileURL } from 'url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
