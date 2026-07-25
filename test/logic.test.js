import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TELEGRAM_BOT_TOKEN = 'x';
process.env.TELEGRAM_CHAT_ID = '-1';

const { canonical, tenderFingerprint, fingerprintChanges } = await import('../src/index.js');
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
