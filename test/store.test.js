import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Isolated store per test run
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-store-'));
process.env.SEEN_STORE_PATH = path.join(tmp, 'seen.json');
process.env.TELEGRAM_BOT_TOKEN = 'x';
process.env.TELEGRAM_CHAT_ID = '-1';

const storePath = process.env.SEEN_STORE_PATH;
let store;

before(async () => {
  store = await import('../src/store.js');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('new tender lifecycle: new → known → retire(pending) → re-release', () => {
  assert.equal(store.isNewTender('s::1'), true);
  store.markSent('s::1', 42, 'fp1', { title: 'Road work' });
  assert.equal(store.isNewTender('s::1'), false);
  assert.equal(store.getFingerprint('s::1'), 'fp1');
  assert.equal(store.getMsgId('s::1'), 42);

  // grace: two healthy absences don't retire
  assert.equal(store.sweepMissing('s', new Set(), true).length, 0);
  assert.equal(store.sweepMissing('s', new Set(), true).length, 0);
  const retired = store.sweepMissing('s', new Set(), true);
  assert.equal(retired.length, 1);
  assert.equal(retired[0].msgId, 42);
  assert.equal(retired[0].notify, 'pending');
  assert.equal(retired[0].snapshot.title, 'Road work');
  assert.equal(store.isReReleased('s::1'), true);

  // re-release clears retired entry
  store.markSent('s::1', 99, 'fp2');
  assert.equal(store.isReReleased('s::1'), false);
});

test('unhealthy scrapes never age entries', () => {
  store.markSent('u::7', 1, 'fp');
  for (let i = 0; i < 5; i++) assert.equal(store.sweepMissing('u', new Set(), false).length, 0);
  assert.equal(store.isNewTender('u::7'), false); // still live
});

test('pending cleanup retries then gives up as failed', () => {
  store.markSent('p::9', 5, 'fp');
  for (let i = 0; i < 3; i++) store.sweepMissing('p', new Set(), true);
  assert.equal(store.getPendingRetirements('p').length, 1);
  let outcome;
  for (let i = 0; i < 4; i++) {
    outcome = store.markRetirementNotified('p::9', false);
    assert.equal(outcome, 'pending');
  }
  outcome = store.markRetirementNotified('p::9', false); // 5th attempt
  assert.equal(outcome, 'gave-up');
  assert.equal(store.getPendingRetirements('p').length, 0); // no longer pending
  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(raw.retired['p::9'].notify, 'failed'); // visible, not silent
});

test('per-search sweep isolation: search A never retires search B keys', () => {
  store.markSent('a::1', 1, 'f');
  store.markSent('b::1', 2, 'f');
  for (let i = 0; i < 3; i++) store.sweepMissing('a', new Set(), true);
  assert.equal(store.isNewTender('a::1'), true); // retired
  assert.equal(store.isNewTender('b::1'), false); // untouched
});

test('baselines: first run flips only after markSearchKnown', () => {
  assert.equal(store.isFirstRunFor('brand-new'), true);
  store.markSearchKnown('brand-new');
  assert.equal(store.isFirstRunFor('brand-new'), false);
});
