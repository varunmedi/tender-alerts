import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

/**
 * Dedup + lifecycle store v3.
 *
 * {
 *   "version": 3,
 *   "tenders": { "<searchId>::<tenderId>": {
 *       lastSeen, missing, msgId, sentAt, fp   // fp = amendment fingerprint
 *   }},
 *   "retired": { "<key>": {
 *       retiredAt, msgId, sentAt,
 *       notify: "pending" | "done",            // withdrawn-alert cleanup state
 *       attempts: 0
 *   }},
 *   "searches": ["gvmc-electrical", ...]       // searches already baselined
 * }
 *
 * Corruption handling: a missing file (ENOENT) starts fresh silently; any
 * OTHER load failure backs the bad file up as seen.json.corrupt-<ts>, starts
 * fresh, and exposes `storeLoadWarning` so the orchestrator can notify the
 * group ONCE (silent resets can suppress genuine alerts).
 */

const MISSING_LIMIT = 3;
const RETIRED_KEEP_DAYS = 365;
const NOTIFY_MAX_ATTEMPTS = 5;

export let storeLoadWarning = null;

function searchIdsFromKeys(tenders) {
  const ids = new Set();
  for (const key of Object.keys(tenders)) {
    const i = key.indexOf('::');
    if (i > 0) ids.add(key.slice(0, i));
  }
  return [...ids];
}

function migrate(raw) {
  if (raw == null) return { version: 3, tenders: {}, retired: {}, searches: [] };

  // v1: flat array of keys
  if (Array.isArray(raw)) {
    const tenders = {};
    const now = new Date().toISOString();
    for (const key of raw) tenders[key] = { lastSeen: now, missing: 0 };
    return { version: 3, tenders, retired: {}, searches: searchIdsFromKeys(tenders) };
  }

  const out = {
    version: 3,
    tenders: raw.tenders || {},
    retired: {},
    searches: raw.searches || searchIdsFromKeys(raw.tenders || {}),
  };
  // v2 retired entries were plain ISO strings; v3 are objects
  for (const [key, val] of Object.entries(raw.retired || {})) {
    out.retired[key] =
      typeof val === 'string'
        ? { retiredAt: val, msgId: null, sentAt: null, notify: 'done', attempts: 0 }
        : { attempts: 0, notify: 'done', ...val };
  }
  return out;
}

function load() {
  try {
    return migrate(JSON.parse(fs.readFileSync(CONFIG.seenStorePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return migrate(null);
    // Corrupt or unreadable: preserve evidence, start fresh, surface warning.
    try {
      const backup = `${CONFIG.seenStorePath}.corrupt-${Date.now()}`;
      fs.copyFileSync(CONFIG.seenStorePath, backup);
      storeLoadWarning =
        `State file was corrupt/unreadable (${error.message}). ` +
        `Backed up to ${path.basename(backup)} and started fresh — all searches ` +
        `will silently re-baseline this cycle (a few alerts may be missed once).`;
    } catch {
      storeLoadWarning = `State file unreadable (${error.message}); started fresh.`;
    }
    console.error(`[store] ${storeLoadWarning}`);
    return migrate(null);
  }
}

function save() {
  fs.mkdirSync(path.dirname(CONFIG.seenStorePath), { recursive: true });
  const tmp = CONFIG.seenStorePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG.seenStorePath);
}

const store = load();

// ---------------- alert dedup ----------------

export function isNewTender(key) {
  return !(key in store.tenders);
}

export function isReReleased(key) {
  return key in store.retired;
}

export function markSent(key, msgId = null, fp = null) {
  delete store.retired[key];
  store.tenders[key] = {
    lastSeen: new Date().toISOString(),
    missing: 0,
    ...(msgId ? { msgId, sentAt: new Date().toISOString() } : {}),
    ...(fp ? { fp } : {}),
  };
  save();
}

// ---------------- amendment detection ----------------

/** Returns previous fingerprint for a KNOWN tender, or undefined. */
export function getFingerprint(key) {
  return store.tenders[key]?.fp;
}

/** Update a known tender's fingerprint (call after alerting the update). */
export function setFingerprint(key, fp) {
  const meta = store.tenders[key];
  if (!meta) return;
  meta.fp = fp;
  save();
}

// ---------------- retirement / withdrawal ----------------

/**
 * Call once per search after a HEALTHY scrape ('ok' or explicit 'empty')
 * with the set of keys currently on the portal. Never call for timeouts or
 * errors — those must not age anything.
 * Returns the entries retired THIS run.
 */
export function sweepMissing(searchId, currentKeys, scrapeOk) {
  const retiredNow = [];
  if (!scrapeOk) return retiredNow;
  const now = new Date().toISOString();
  const prefix = `${searchId}::`;
  let changed = false;

  for (const [key, meta] of Object.entries(store.tenders)) {
    if (!key.startsWith(prefix)) continue;
    if (currentKeys.has(key)) {
      if (meta.missing !== 0) changed = true;
      meta.missing = 0;
      meta.lastSeen = now;
    } else {
      meta.missing = (meta.missing || 0) + 1;
      changed = true;
      if (meta.missing >= MISSING_LIMIT) {
        const entry = {
          retiredAt: now,
          msgId: meta.msgId || null,
          sentAt: meta.sentAt || null,
          notify: meta.msgId ? 'pending' : 'done',
          attempts: 0,
        };
        delete store.tenders[key];
        store.retired[key] = entry;
        retiredNow.push({ key, ...entry });
        console.log(
          `[store] retired ${key} (absent from ${MISSING_LIMIT} consecutive scrapes) — ` +
            'a future reappearance with this ID WILL alert again.'
        );
      }
    }
  }

  const cutoff = Date.now() - RETIRED_KEEP_DAYS * 24 * 3600 * 1000;
  for (const [key, entry] of Object.entries(store.retired)) {
    if (new Date(entry.retiredAt).getTime() < cutoff) {
      delete store.retired[key];
      changed = true;
    }
  }

  if (changed) save();
  return retiredNow;
}

/** Withdrawn alerts whose group cleanup (delete/edit) hasn't succeeded yet. */
export function getPendingRetirements(searchId) {
  const prefix = `${searchId}::`;
  return Object.entries(store.retired)
    .filter(([key, e]) => key.startsWith(prefix) && e.notify === 'pending' && e.msgId)
    .map(([key, e]) => ({ key, ...e }));
}

/** Record a cleanup attempt outcome; gives up after NOTIFY_MAX_ATTEMPTS. */
export function markRetirementNotified(key, success) {
  const entry = store.retired[key];
  if (!entry) return;
  if (success) {
    entry.notify = 'done';
  } else {
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts >= NOTIFY_MAX_ATTEMPTS) {
      entry.notify = 'done';
      console.warn(
        `[store] giving up on group cleanup for ${key} after ${NOTIFY_MAX_ATTEMPTS} attempts.`
      );
    }
  }
  save();
}

// ---------------- per-search baselines ----------------

export function isFirstRunFor(searchId) {
  return !store.searches.includes(searchId);
}

export function markSearchKnown(searchId) {
  if (!store.searches.includes(searchId)) {
    store.searches.push(searchId);
    save();
  }
}
