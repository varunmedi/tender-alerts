import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

/**
 * Dedup store v2.
 *
 * Structure (data/seen.json):
 * {
 *   "version": 2,
 *   "tenders": { "<searchId>::<tenderId>": { "lastSeen": iso, "missing": 0 } },
 *   "retired": { "<searchId>::<tenderId>": iso-when-retired }
 * }
 *
 * Lifecycle:
 *  - New tender        → alert → recorded in `tenders`
 *  - Present each run  → missing counter stays 0
 *  - Absent from a SUCCESSFUL scrape → missing++ ; at 3 consecutive
 *    absences the entry moves to `retired` (tender withdrawn/closed)
 *  - Reappears while retired → treated as NEW again → alert fires with a
 *    "re-released" label, entry returns to `tenders`
 *  - Retired entries are pruned after 365 days to keep the file small
 *
 * v1 files (plain array of keys) are migrated automatically.
 */

const MISSING_LIMIT = 3;      // consecutive successful scrapes without the tender
const RETIRED_KEEP_DAYS = 365;

function searchIdsFromKeys(tenders) {
  const ids = new Set();
  for (const key of Object.keys(tenders)) {
    const i = key.indexOf('::');
    if (i > 0) ids.add(key.slice(0, i));
  }
  return [...ids];
}

function migrate(raw) {
  if (Array.isArray(raw)) {
    const tenders = {};
    const now = new Date().toISOString();
    for (const key of raw) tenders[key] = { lastSeen: now, missing: 0 };
    return { version: 2, tenders, retired: {}, searches: searchIdsFromKeys(tenders) };
  }
  if (raw && raw.version === 2) {
    raw.tenders = raw.tenders || {};
    raw.retired = raw.retired || {};
    // derive the known-searches list for stores written before this field existed
    raw.searches = raw.searches || searchIdsFromKeys(raw.tenders);
    return raw;
  }
  return { version: 2, tenders: {}, retired: {}, searches: [] };
}

function load() {
  try {
    return migrate(JSON.parse(fs.readFileSync(CONFIG.seenStorePath, 'utf8')));
  } catch {
    return migrate(null); // fresh store with all fields initialized
  }
}

function save() {
  // Atomic write: write to a temp file, then rename. A crash or power
  // loss mid-write can then never leave a half-written seen.json.
  fs.mkdirSync(path.dirname(CONFIG.seenStorePath), { recursive: true });
  const tmp = CONFIG.seenStorePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG.seenStorePath);
}

const store = load();

/** True if this tender should trigger an alert (never seen, or retired). */
export function isNewTender(key) {
  return !(key in store.tenders);
}

/** True if this "new" tender is actually a re-release of a retired one. */
export function isReReleased(key) {
  return key in store.retired;
}

/**
 * Record a tender as alerted (or silently recorded on first run).
 * msgId is the Telegram message_id of the alert, kept so the alert can be
 * deleted from the group if the tender is later withdrawn from the portal.
 */
export function markSent(key, msgId = null) {
  delete store.retired[key];
  store.tenders[key] = {
    lastSeen: new Date().toISOString(),
    missing: 0,
    ...(msgId ? { msgId } : {}),
  };
  save();
}

/**
 * Call ONCE per search after a scrape, with the set of keys currently on
 * the portal. Only acts when the scrape succeeded (scrapeOk) — a failed
 * or empty scrape must never age-out entries, or one bad run would cause
 * a re-alert flood later.
 */
export function sweepMissing(searchId, currentKeys, scrapeOk) {
  const retiredNow = []; // [{ key, msgId }] — returned so alerts can be deleted
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
        retiredNow.push({ key, msgId: meta.msgId || null });
        delete store.tenders[key];
        store.retired[key] = now;
        console.log(
          `[store] retired ${key} (absent from ${MISSING_LIMIT} consecutive scrapes) — ` +
            'a future reappearance with this ID WILL alert again.'
        );
      }
    }
  }

  // prune ancient retired entries
  const cutoff = Date.now() - RETIRED_KEEP_DAYS * 24 * 3600 * 1000;
  for (const [key, when] of Object.entries(store.retired)) {
    if (new Date(when).getTime() < cutoff) {
      delete store.retired[key];
      changed = true;
    }
  }

  if (changed) save();
  return retiredNow;
}

/**
 * Per-search first run: true until a search has completed one successful
 * scrape. New searches added to config record their existing tenders
 * SILENTLY on their first check — no alert flood — even when other
 * searches have been running for months.
 */
export function isFirstRunFor(searchId) {
  return !store.searches.includes(searchId);
}

/** Call after a search's first successful scrape has been processed. */
export function markSearchKnown(searchId) {
  if (!store.searches.includes(searchId)) {
    store.searches.push(searchId);
    save();
  }
}
