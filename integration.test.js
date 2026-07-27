import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// REAL behavioural tests via child processes (no module-cache interference,
// no Chromium needed). These replace v8's proxy tests, which only constructed
// an error object / checked declaration order and so proved nothing.

const ROOT = new URL('..', import.meta.url).pathname;

// Force a DETERMINISTIC scrape failure by pointing the portal at an
// unreachable host. This makes the "failure" tests independent of whether
// the real AP portal is reachable from wherever the suite runs (sandbox: no
// Chromium → fails; server: portal works → would succeed). Either way, an
// unroutable URL fails fast and identically.
const UNREACHABLE = 'http://127.0.0.1:9/never';
const run = (env, args = ['--once']) =>
  spawnSync(process.execPath, ['src/index.js', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: 'test',
      TELEGRAM_CHAT_ID: '-1',
      HOME_URL: UNREACHABLE,
      PORTAL_URL: UNREACHABLE,
      NAV_TIMEOUT_MS: '4000', // fail quickly per search
      ...env,
    },
  });

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('startup REFUSES a future store version (real process, nonzero exit)', () => {
  const dir = tmpDir('tender-future-');
  const statePath = path.join(dir, 'seen.json');
  fs.writeFileSync(statePath, JSON.stringify({ version: 99, tenders: {}, retired: {}, searches: [] }));

  const r = run({ SEEN_STORE_PATH: statePath });
  const out = (r.stdout || '') + (r.stderr || '');

  assert.notEqual(r.status, 0, 'must exit nonzero on unsupported future version');
  assert.match(out, /newer than supported/i);
  // Must NOT have quietly replaced the file with a fresh store
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(after.version, 99, 'future-version file must be left intact');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('failure counters PERSIST across separate processes (real runs)', () => {
  const dir = tmpDir('tender-health-');
  const statePath = path.join(dir, 'seen.json');
  const statusPath = path.join(dir, 'status.json');

  // Two independent runs against an unreachable portal → every search fails
  // both times, so each counter must reach exactly 2 (proves persistence
  // across separate processes rather than resetting to 0 on restart).
  const r1 = run({ SEEN_STORE_PATH: statePath });
  assert.equal(r1.status, 1, 'run 1 should report failures');
  run({ SEEN_STORE_PATH: statePath });

  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  const counts = Object.values(status.perSearch).map((h) => h.consecutiveFailures);
  assert.ok(counts.length >= 1, 'perSearch health must be written');
  assert.ok(
    counts.every((c) => c === 2),
    `counters must accumulate across restarts, saw ${JSON.stringify(counts)}`
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('corrupt state: default recovers with a backup; halt policy refuses', () => {
  const dir = tmpDir('tender-corrupt-');
  const statePath = path.join(dir, 'seen.json');

  // --- default policy: recover ---
  fs.writeFileSync(statePath, '{ not valid json');
  const recovered = run({ SEEN_STORE_PATH: statePath });
  const recoveredOut = (recovered.stdout || '') + (recovered.stderr || '');
  assert.match(recoveredOut, /corrupt/i);
  assert.equal(
    fs.readdirSync(dir).some((f) => f.includes('corrupt-')),
    true,
    'corrupt state must be backed up'
  );

  // --- halt policy: refuse to start ---
  fs.writeFileSync(statePath, '{ still not valid');
  const halted = run({ SEEN_STORE_PATH: statePath, STATE_CORRUPTION_POLICY: 'halt' });
  const haltedOut = (halted.stdout || '') + (halted.stderr || '');
  assert.notEqual(halted.status, 0, 'halt policy must exit nonzero');
  assert.match(haltedOut, /refusing to start/i);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('--once exits nonzero when searches fail (deterministic unreachable portal)', () => {
  const dir = tmpDir('tender-exit-');
  const r = run({ SEEN_STORE_PATH: path.join(dir, 'seen.json') });
  assert.equal(r.status, 1, '--once must report failures via exit code');
  assert.match(r.stdout, /Single run complete: \d+ ok, \d+ degraded, \d+ failed/);
  assert.match(r.stdout, /\d+ failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no undefined identifiers on the cleanup-gave-up path (v10 #1)', async () => {
  // v9 called notifyHealth() which did not exist -> ReferenceError instead of
  // the intended ops warning. Assert every notify call resolves to a real
  // declaration in app.js.
  const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const called = [...app.matchAll(/\bawait (\w*[Nn]otify\w*)\(/g)].map((m) => m[1]);
  assert.ok(called.length > 0, 'expected notify calls to exist');
  for (const name of new Set(called)) {
    const declared = new RegExp(`(async function|function|const)\\s+${name}\\b`).test(app);
    assert.ok(declared, `${name}() is called but never declared in app.js`);
  }
});

test('invalid STATE_CORRUPTION_POLICY fails startup, not silent coercion (v10 #10)', () => {
  const dir = tmpDir('tender-policy-');
  const r = run({
    SEEN_STORE_PATH: path.join(dir, 'seen.json'),
    STATE_CORRUPTION_POLICY: 'halts', // typo
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.notEqual(r.status, 0, 'a typo must not silently become "recover"');
  assert.match(out, /must be one of: recover, halt/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('primitive JSON state root is REJECTED, not silently re-baselined (v11 #6)', () => {
  const dir = tmpDir('tender-primitive-');
  const statePath = path.join(dir, 'seen.json');
  // Valid JSON, but not a store. v10 would read raw.tenders === undefined and
  // quietly build a fresh store — wiping baselines and suppressing alerts.
  fs.writeFileSync(statePath, '42');

  const r = run({ SEEN_STORE_PATH: statePath, STATE_CORRUPTION_POLICY: 'halt' });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.notEqual(r.status, 0, 'primitive root must not be accepted silently');
  assert.match(out, /state root must be an object|corrupt/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('boolean env typo fails startup instead of flipping behaviour (v11 #10)', () => {
  const dir = tmpDir('tender-bool-');
  // Previously only the literal "0" disabled these, so "false" silently
  // left adaptive scheduling ENABLED.
  const r = run({
    SEEN_STORE_PATH: path.join(dir, 'seen.json'),
    ADAPTIVE_SCHEDULE: 'maybe',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  assert.notEqual(r.status, 0);
  assert.match(out, /must be true\/false or 1\/0/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ADAPTIVE_SCHEDULE=false is honoured (not coerced to enabled)', () => {
  const dir = tmpDir('tender-bool2-');
  const r = run({
    SEEN_STORE_PATH: path.join(dir, 'seen.json'),
    ADAPTIVE_SCHEDULE: 'false',
    POLL_INTERVAL_MINUTES: '30',
  });
  // --once doesn't print the scheduler banner, so just assert it started and
  // ran (exit 1 from failed scrapes) rather than rejecting the config.
  const out = (r.stdout || '') + (r.stderr || '');
  assert.doesNotMatch(out, /must be true\/false/);
  assert.match(out, /Single run complete/);
  fs.rmSync(dir, { recursive: true, force: true });
});
