import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

test('store refuses FUTURE state versions (v7 #6)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tender-ver-'));
  process.env.SEEN_STORE_PATH = path.join(tmp, 'seen.json');
  process.env.TELEGRAM_BOT_TOKEN = 'x';
  process.env.TELEGRAM_CHAT_ID = '-1';
  fs.writeFileSync(process.env.SEEN_STORE_PATH,
    JSON.stringify({ version: 99, tenders: {}, retired: {}, searches: [] }));
  const store = await import('../src/store.js');
  // future version -> treated as unloadable: corrupt-backup path engages,
  // fresh store + loud warning (never silently rewritten/downgraded)
  assert.ok(store.storeLoadWarning, 'expected a load warning for future version');
  const backups = fs.readdirSync(tmp).filter((f) => f.includes('corrupt'));
  assert.equal(backups.length, 1, 'future-version file must be preserved as backup');
  fs.rmSync(tmp, { recursive: true, force: true });
});
