import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

/**
 * Health / heartbeat store (status.json) — separated from app.js so it can be
 * unit-tested and so corruption is handled with the same discipline as the
 * lifecycle store: ENOENT → fresh, malformed JSON → backup + warning, I/O
 * error → throw. Silently resetting durable failure counters (v8 behaviour)
 * would defeat the very monitoring the heartbeat exists to provide.
 *
 * Health-notification lifecycle per search (fixes lost/duplicate warnings):
 *   none → warning-pending → warned → (recovery-pending) → none
 * A warning is only marked delivered AFTER Telegram accepts it, so a failed
 * send is retried next cycle instead of being lost forever.
 */

const STATUS_PATH =
  process.env.STATUS_STORE_PATH ||
  path.join(path.dirname(CONFIG.seenStorePath), 'status.json');

export const NOTIFY = Object.freeze({
  NONE: 'none',
  WARNING_PENDING: 'warning-pending',
  WARNED: 'warned',
  RECOVERY_PENDING: 'recovery-pending',
});

export let healthLoadWarning = null;

function isIso(v) {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

function validate(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('status root is not an object');
  }
  const ps = status.perSearch;
  if (ps != null && (typeof ps !== 'object' || Array.isArray(ps))) {
    throw new Error('perSearch is not an object');
  }
  for (const [id, h] of Object.entries(ps || {})) {
    if (!h || typeof h !== 'object') throw new Error(`perSearch[${id}] not an object`);
    if (!Number.isInteger(h.consecutiveFailures) || h.consecutiveFailures < 0) {
      throw new Error(`perSearch[${id}].consecutiveFailures invalid`);
    }
    if (h.firstFailureAt != null && !isIso(h.firstFailureAt)) {
      throw new Error(`perSearch[${id}].firstFailureAt invalid`);
    }
    if (h.notification != null && !Object.values(NOTIFY).includes(h.notification)) {
      throw new Error(`perSearch[${id}].notification invalid`);
    }
  }
  if (status.lastSuccessfulCycleAt != null && !isIso(status.lastSuccessfulCycleAt)) {
    throw new Error('lastSuccessfulCycleAt invalid');
  }
  return status;
}

/** Load full status. ENOENT → {} ; corrupt → backup + warning + {} ; IO → throw. */
export function loadStatus() {
  let text;
  try {
    text = fs.readFileSync(STATUS_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`Cannot read status file ${STATUS_PATH}: ${e.code || e.message}`);
  }
  try {
    return validate(JSON.parse(text));
  } catch (e) {
    try {
      const backup = `${STATUS_PATH}.corrupt-${Date.now()}`;
      fs.writeFileSync(backup, text);
      healthLoadWarning =
        `status.json was corrupt (${e.message}); backed up to ${path.basename(backup)} ` +
        `and reset — failure counters restart from zero this run.`;
    } catch {
      healthLoadWarning = `status.json corrupt (${e.message}); reset.`;
    }
    console.error(`[health] ${healthLoadWarning}`);
    return {};
  }
}

/** In-memory failState hydrated from the on-disk perSearch block. */
export function hydrateFailState(status) {
  const out = {};
  for (const [id, h] of Object.entries(status.perSearch || {})) {
    out[id] = {
      count: Number.isInteger(h.consecutiveFailures) ? h.consecutiveFailures : 0,
      firstAt: h.firstFailureAt ? Date.parse(h.firstFailureAt) || null : null,
      notification: Object.values(NOTIFY).includes(h.notification) ? h.notification : NOTIFY.NONE,
      lastSuccessAt: h.lastSuccessAt || null,
      lastError: h.lastError || null,
      lastTenderCount: h.lastTenderCount ?? null,
    };
  }
  return out;
}

let current = {};

/** Merge a patch into status.json atomically, preserving prior fields. */
export function writeHeartbeat(patch) {
  try {
    current = { ...current, ...patch };
    fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
    const tmp = STATUS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2));
    fs.renameSync(tmp, STATUS_PATH);
  } catch (e) {
    console.warn(`heartbeat write failed: ${e.message}`);
  }
}

/** Seed the in-memory mirror so writeHeartbeat patches don't drop fields. */
export function seedHeartbeat(status) {
  current = { ...status };
}

export function serializeFailState(failState) {
  const perSearch = {};
  for (const [id, st] of Object.entries(failState)) {
    perSearch[id] = {
      consecutiveFailures: st.count,
      firstFailureAt: st.firstAt ? new Date(st.firstAt).toISOString() : null,
      notification: st.notification || NOTIFY.NONE,
      lastSuccessAt: st.lastSuccessAt || null,
      lastError: st.lastError || null,
      lastTenderCount: st.lastTenderCount ?? null,
    };
  }
  return perSearch;
}

export { STATUS_PATH };
