import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

/**
 * Lifecycle + dedup store (schema v4).
 *
 * {
 *   version: 4,
 *   tenders: { "<searchId>::<tenderId>": {
 *       lastSeen, missing, msgId, sentAt, fp, snapshot
 *   }},
 *   retired: { "<key>": {
 *       retiredAt, msgId, sentAt, snapshot, notify, attempts
 *   }},
 *   searches: ["gvmc-electrical", ...]   // baselined searches
 * }
 *
 * Load discipline (each case distinct — none silently swallowed):
 *  - ENOENT              -> fresh store
 *  - version > supported -> UnsupportedStoreVersionError, NEVER recovered
 *                           (an older deploy must not rewrite a newer file)
 *  - malformed / invalid -> backup + warn; then recover or halt per
 *                           CONFIG.stateCorruptionPolicy
 *  - permission / I/O    -> throw (starting fresh would fail on first save)
 *
 * markSent/updateKnownTender persist per tender (not batched) so a crash can
 * never re-send an alert Telegram already accepted.
 */

const STORE_VERSION = 4;
const MISSING_LIMIT = 3;
const RETIRED_KEEP_DAYS = 365;
const NOTIFY_MAX_ATTEMPTS = 5;

export let storeLoadWarning = null;

/** Future-version refusal must BYPASS corruption recovery: an older deploy
 *  must terminate, not quietly re-baseline over a newer state file. */
export class UnsupportedStoreVersionError extends Error {
  constructor(found, supported) {
    super(`state version ${found} is newer than supported ${supported} — refusing to run`);
    this.name = 'UnsupportedStoreVersionError';
  }
}

function searchIdsFromKeys(tenders) {
  const ids = new Set();
  for (const key of Object.keys(tenders)) {
    const i = key.indexOf('::');
    if (i > 0) ids.add(key.slice(0, i));
  }
  return [...ids];
}

function migrate(raw) {
  if (raw == null) return { version: STORE_VERSION, tenders: {}, retired: {}, searches: [] };
  // Refuse FUTURE versions: an older deployment must never rewrite a newer
  // state file and silently drop fields it doesn't understand.
  if (Number.isInteger(raw.version) && raw.version > STORE_VERSION) {
    throw new UnsupportedStoreVersionError(raw.version, STORE_VERSION);
  }

  // v1: flat array of keys
  if (Array.isArray(raw)) {
    const tenders = {};
    const now = new Date().toISOString();
    for (const key of raw) tenders[key] = { lastSeen: now, missing: 0 };
    return { version: STORE_VERSION, tenders, retired: {}, searches: searchIdsFromKeys(tenders) };
  }

  const out = {
    version: STORE_VERSION,
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

function validateStore(st) {
  const bad = [];
  if (typeof st.tenders !== 'object' || Array.isArray(st.tenders)) bad.push('tenders');
  if (typeof st.retired !== 'object' || Array.isArray(st.retired)) bad.push('retired');
  if (!Array.isArray(st.searches) || st.searches.some((x) => typeof x !== 'string')) bad.push('searches');
  const isIso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
  for (const [k, m] of Object.entries(st.tenders || {})) {
    if (!m || typeof m !== 'object') { bad.push(`tenders[${k}] not an object`); continue; }
    if (!Number.isInteger(m.missing) || m.missing < 0) bad.push('tenders.missing');
    if (!isIso(m.lastSeen)) bad.push('tenders.lastSeen');
    if (m.msgId != null && !Number.isInteger(m.msgId)) bad.push('tenders.msgId');
  }
  for (const [k, r] of Object.entries(st.retired || {})) {
    if (!r || typeof r !== 'object') { bad.push(`retired[${k}] not an object`); continue; }
    if (!['pending', 'done', 'failed'].includes(r.notify)) bad.push('retired.notify');
    if (!isIso(r.retiredAt)) bad.push('retired.retiredAt');
    if (!Number.isInteger(r.attempts) || r.attempts < 0) bad.push('retired.attempts');
  }
  if (bad.length) throw new Error(`schema invalid: ${[...new Set(bad)].join(', ')}`);
  return st;
}

function load() {
  let text;
  try {
    text = fs.readFileSync(CONFIG.seenStorePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return migrate(null);
    // Permission / disk / IO errors are NOT recoverable by starting fresh —
    // the first save would fail anyway. Fail loudly.
    throw new Error(`Cannot read state file ${CONFIG.seenStorePath}: ${error.code || error.message}`);
  }
  try {
    return validateStore(migrate(JSON.parse(text)));
  } catch (error) {
    if (error instanceof UnsupportedStoreVersionError) throw error; // no recovery
    // Malformed JSON / invalid schema: preserve evidence, start fresh, warn.
    try {
      const backup = `${CONFIG.seenStorePath}.corrupt-${Date.now()}`;
      fs.writeFileSync(backup, text);
      storeLoadWarning =
        `State file was corrupt (${error.message}). Backed up to ` +
        `${path.basename(backup)} and started fresh — all searches will ` +
        `silently re-baseline this cycle (a few alerts may be missed once).`;
    } catch {
      storeLoadWarning = `State file corrupt (${error.message}); started fresh.`;
    }
    console.error(`[store] ${storeLoadWarning}`);
    if (CONFIG.stateCorruptionPolicy === 'halt') {
      throw new Error(
        `${storeLoadWarning} STATE_CORRUPTION_POLICY=halt — refusing to start. ` +
          `Inspect the backup, then restart (optionally with STATE_CORRUPTION_POLICY=recover).`
      );
    }
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

export function markSent(key, msgId = null, fp = null, snapshot = null) {
  delete store.retired[key];
  store.tenders[key] = {
    lastSeen: new Date().toISOString(),
    missing: 0,
    ...(msgId ? { msgId, sentAt: new Date().toISOString() } : {}),
    ...(fp ? { fp } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
  save();
}

/** Snapshot (e.g. title) of a known tender, for tombstones/edits. */
export function getSnapshot(key) {
  return store.tenders[key]?.snapshot ?? store.retired[key]?.snapshot ?? null;
}

/** msgId of a known live tender (for editing its original alert). */
export function getMsgId(key) {
  return store.tenders[key]?.msgId ?? null;
}

// ---------------- amendment detection ----------------

/** Returns previous fingerprint for a KNOWN tender, or undefined. */
export function getFingerprint(key) {
  return store.tenders[key]?.fp;
}

/** Update a known tender's fingerprint (call after alerting the update). */
export function updateKnownTender(key, { fp, snapshot }) {
  const meta = store.tenders[key];
  // Silently ignoring an impossible state hides lifecycle bugs; per-result
  // isolation in app.js contains the blast radius to this one search.
  if (!meta) throw new Error(`cannot update unknown tender ${key}`);
  if (fp !== undefined) meta.fp = fp;
  if (snapshot !== undefined) meta.snapshot = snapshot; // stays current for tombstones
  meta.lastSeen = new Date().toISOString();
  save();
}

export function setFingerprint(key, fp) {
  updateKnownTender(key, { fp });
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
          snapshot: meta.snapshot || null,
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
/** Returns 'done' | 'pending' | 'gave-up' so the caller can warn ops. */
export function markRetirementNotified(key, success) {
  const entry = store.retired[key];
  if (!entry) return 'done';
  let outcome;
  if (success) {
    entry.notify = 'done';
    outcome = 'done';
  } else {
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts >= NOTIFY_MAX_ATTEMPTS) {
      entry.notify = 'failed'; // visible in the state file, not silently dropped
      outcome = 'gave-up';
    } else {
      outcome = 'pending';
    }
  }
  save();
  return outcome;
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
