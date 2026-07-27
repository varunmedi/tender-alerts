import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

test('store REFUSES future state versions with a hard error (v8 #2)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ver-'));
  process.env.SEEN_STORE_PATH = path.join(tmp, 'seen.json');
  process.env.TELEGRAM_BOT_TOKEN = 'x';
  process.env.TELEGRAM_CHAT_ID = '-1';
  fs.writeFileSync(process.env.SEEN_STORE_PATH,
    JSON.stringify({ version: 99, tenders: {}, retired: {}, searches: [] }));
  // Import must THROW (module-load runs load()): future versions bypass
  // corruption recovery entirely — never silently re-baselined over.
  await assert.rejects(
    () => import('../src/store.js'),
    /newer than supported/
  );
  // and the file must be untouched (no corrupt-backup, no fresh rewrite)
  const raw = JSON.parse(fs.readFileSync(process.env.SEEN_STORE_PATH, 'utf8'));
  assert.equal(raw.version, 99);
  assert.equal(fs.readdirSync(tmp).filter((f) => f.includes('corrupt')).length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});
