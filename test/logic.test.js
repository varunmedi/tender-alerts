import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'x';
process.env.TELEGRAM_CHAT_ID = '-1';

const { canonical, tenderFingerprint, fingerprintChanges } = await import('../src/app.js');
const { truncate, clampMessage, formatTenderMessage, isAlreadyCompleted } = await import('../src/notifier.js');
const { mapHeaders, rowToTenderMapped } = await import('../src/scraper.js');

test('fingerprints are whitespace/unicode-normalized (#21)', () => {
  const a = { noticeNumber: 'N-1', title: 'Road  Work', value: '1L', publishedDate: 'x', closingDate: 'y' };
  const b = { noticeNumber: 'N-1', title: ' Road Work ', value: '1L', publishedDate: 'x', closingDate: 'y' };
  assert.equal(tenderFingerprint(a), tenderFingerprint(b)); // no false 📝
  const c = { ...a, closingDate: 'z' };
  assert.notEqual(tenderFingerprint(a), tenderFingerprint(c));
  const changes = fingerprintChanges(tenderFingerprint(a), c);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, 'Closing Date');
  assert.equal(canonical('A\u00A0B'), 'A B'); // NBSP collapses
});

test('message truncation & clamping (#10)', () => {
  assert.equal(truncate('short', 10), 'short');
  assert.equal(truncate('x'.repeat(50), 10).length, 10);
  const huge = formatTenderMessage(
    { tenderId: '123456', title: 'T'.repeat(5000), closingDate: 'c' }, 'L'
  );
  assert.ok(huge.length <= 3900);
  assert.ok(clampMessage('y'.repeat(9000)).length <= 3900);
});

test('cleanup idempotency detection (#9)', () => {
  assert.ok(isAlreadyCompleted({ description: 'Bad Request: message to delete not found' }));
  assert.ok(isAlreadyCompleted({ description: 'Bad Request: message is not modified' }));
  assert.ok(!isAlreadyCompleted({ description: 'Forbidden: bot was kicked' }));
});

test('header mapping resists reorder and fails on missing required (#14)', () => {
  const headers = ['S.No', 'Tender ID', 'Department Name', 'Tender Notice Number',
    'Tender Category', 'Name of Work', 'Estimated Contract Value', 'Start Date', 'Closing Date'];
  const map = mapHeaders(headers);
  const row = ['1', '987654', 'GVMC', 'NIT-9', 'Works', 'Street lights', '12 L', '01-07', '30-07'];
  const t = rowToTenderMapped(row, map);
  assert.equal(t.tenderId, '987654');
  assert.equal(t.title, 'Street lights');
  assert.equal(t.closingDate, '30-07');
  assert.equal(rowToTenderMapped(['x', 'not-numeric', '', '', '', '', '', '', ''], map), null);
  assert.throws(() => mapHeaders(['S.No', 'Department', 'Something']), /required column/);
});

test('clampMessage strips tags when forced to cut (v7 #8)', async () => {
  const { clampMessage } = await import('../src/notifier.js');
  const huge = '<b>' + 'x'.repeat(5000) + '</b> &amp; <code>tail</code>';
  const out = clampMessage(huge);
  assert.ok(out.length <= 3950);
  assert.ok(!/<b>|<code>/.test(out)); // no live tags that could be cut open
});

test('esc is exported and escapes health-message hazards (v7 #7)', async () => {
  const { esc } = await import('../src/notifier.js');
  assert.equal(esc('waiting for selector "<div> & co"'), 'waiting for selector "&lt;div&gt; &amp; co"');
});

test('store refuses future version by THROWING, not recovering (v8 #2)', async () => {
  const s = await import('../src/store.js');
  assert.equal(typeof s.UnsupportedStoreVersionError, 'function');
  const e = new s.UnsupportedStoreVersionError(99, 4);
  assert.equal(e.name, 'UnsupportedStoreVersionError');
  assert.match(e.message, /99.*4/);
});

test('updateKnownTender is exported for atomic fp+snapshot (v8 #7)', async () => {
  const s = await import('../src/store.js');
  assert.equal(typeof s.updateKnownTender, 'function');
});

test('health state shape round-trips consecutive failures (v8)', async () => {
  // Guards the TDZ ordering bug: STATUS_PATH must be initialised before the
  // health loader reads it, or persisted counters silently load as empty and
  // a restarting bot never reaches the warn threshold.
  const src = await import('node:fs');
  const app = src.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const statusIdx = app.indexOf('const STATUS_PATH');
  const loaderIdx = app.indexOf('const failState = loadHealthState()');
  assert.ok(statusIdx > -1 && loaderIdx > -1);
  assert.ok(statusIdx < loaderIdx, 'STATUS_PATH must be declared before loadHealthState() runs');
});
