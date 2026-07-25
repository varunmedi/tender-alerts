# AP Tender Alerts → Telegram — Varun's Ops Guide (v6 "Production Safety")

Self-hosted bot watching the AP eProcurement portal on an adaptive IST schedule.
Alerts the **"Tenders"** Telegram group on new (🔔), re-released (🔁), and amended
(📝) tenders; withdrawn tenders' alerts are deleted or edited into ❌ tombstones.
Oracle Cloud Always Free (Hyderabad). ₹0/month.

**Production state:** Node 24.18.0 LTS · Playwright 1.61 · ~15s full cycle ·
9-test `node:test` suite passing · crash/reboot recovery live-verified.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24 LTS (ES Modules), engines-pinned `>=24 <25` |
| Automation | Playwright 1.61 headless Chromium (portal's session-flow + `temp()` crypto make a real browser mandatory) |
| Scheduler | Adaptive `setTimeout` loop, IST computed via `Intl` (OS-timezone independent) |
| Pipeline | Async generator — each search's result fully processed before the next search starts (reduces time-to-first-alert; not concurrent) |
| Notifications | Telegram Bot API: send/edit/delete; 15s timeouts; retries incl. 429 `retry_after`; structured `TelegramError`; 4096-char clamping |
| State | JSON v4 (`data/seen.json`): atomic writes, schema validation, corrupt-file backup + group warning, I/O errors fail loud |
| Concurrency | Overlap guard + **atomic lock directory** (mkdir + owner token; PID-reuse-safe; stale reclaim via atomic rename) |
| Process mgmt | PM2 + systemd + pm2-logrotate |
| Tests | `npm test` → node:test (store lifecycle, fingerprints, truncation, idempotency, header mapping) |

Stack verdict (3 external reviews concur): Node+Playwright+JSON optimal. Rejected
with rationale: language/framework rewrites, raw-HTTP scraping (anti-tamper
fragility), batched writes (breaks crash safety), hashed keys (breaks sweeps).

## Watched searches

| id | Department | Sub-department |
|---|---|---|
| `gvmc-electrical` | Greater Visakhapatnam Municipal Corporation | E.E.- Electrical |
| `gvmc-it` | GVMC | IT Department, GVMC |
| `vmrda` | Visakhapatnam Metropolitan Region Development Authority | EE-VIII (Electrical), VMRDA |
| `aptransco-telecom` | APTRANSCO PRODUCTS | SE Telecommunication Circle, Visakhapatnam |

Matching: whitespace-insensitive, exact > prefix > contains. **Ambiguous ties
fail loudly** (never silently pick option #1). **Sub-department failure = hard
search failure.** IDs: GVMC=49 (74/5889), VMRDA=14 (5520), APTRANSCO=1766 (1781).

## My values

| Item | Value |
|---|---|
| Bot | `@ap_tender_alerts_bot` (group admin, Delete messages) |
| Token | `8550919760:AAEgdJFNaDL25Jl4_1jojxAmN4fS2c4ZVO8` — ⚠️ exposed in repo history; rotate via @BotFather |
| Group | "Tenders", chat `-5341406269` |
| Server | `140.245.246.22` (ephemeral IP) · `~/ap-tender-alerts` |
| SSH | `ssh -i keys\private\ssh-key-2026-07-13.key ubuntu@140.245.246.22` (from project dir) |

## Alert types

| Emoji | Meaning |
|---|---|
| 🔔 | New tender |
| 🔁 | Withdrawn tender's ID reappeared |
| 📝 | Same ID, changed details (old → new); the ORIGINAL alert is also edited in place with an "Updated" note |
| ❌ | Withdrawn; alert too old to delete → edited to tombstone (includes title) |
| *(deleted)* | Withdrawn; alert <47h old |
| ⚠️/✅ | Health: 6 consecutive failures (real duration) / recovery. Also: state-corruption warnings, cleanup give-ups |

## Result states (core semantics)

| Status | Meaning | Healthy? | Baseline | Sweep |
|---|---|---|---|---|
| `ok` | Rows parsed, pagination VERIFIED complete | yes | yes | yes |
| `empty` | Portal explicitly: "No matching records" | yes | yes | yes |
| `error` (incl. timeouts) | Anything else | no | no | no |

Healthiness is an explicit **whitelist** (`ok`/`empty`) — unknown future states
can never accidentally baseline or sweep.

## v6 safety guarantees

- **Fail-closed pagination**: stuck page-advance or the 50-page cap → the whole
  search FAILS (transient). Collected count is verified against DataTables' own
  "Showing … of N entries" total. Sweeps can never run on partial data → no
  false retirements/deletions.
- **Header-mapped columns**: fields located by header text, not position; a
  changed/renamed required column fails loudly with the seen headers listed.
- **Live-tender race guard**: a re-released tender whose 🔁 send failed is never
  tombstoned/deleted by the same cycle's cleanup pass.
- **Per-result isolation**: a processing failure (state/Telegram) can't kill the
  generator, close Chromium, or abandon remaining searches.
- **Transient retry**: timeouts/navigation/pagination failures get ONE same-cycle
  retry with a fresh session; config errors (dept not found/ambiguous/headers)
  surface immediately.
- **Idempotent cleanup**: "message to delete not found" / "not modified" count as
  success; give-ups are marked `notify:"failed"` in state AND warned to the group.
- **Amendment fingerprints normalized** (NFKC + whitespace) — the portal's
  spacing quirks can't cause false 📝 alerts.
- **Strict env parsing** (`"15minutes"` rejected), schema-validated state,
  ENOENT vs corruption vs I/O errors handled distinctly.
- `--once` exits **1** if any search failed (machine-checkable), with a
  `N ok, M failed, K alerts` summary line.

## Operations (bash on server; PowerShell only for ssh/scp)

```bash
pm2 status | pm2 logs tender-alerts [--lines 50 --nostream] | pm2 restart tender-alerts
npm test                                   # 9 tests, no network needed
pm2 stop tender-alerts && npm run once && pm2 start tender-alerts   # manual cycle (lock enforces this)
npm run debug     # --once + artifacts, HEADLESS (server-safe)
npm run headed    # visible browser (laptop only)
```

- Test an alert: delete one entry inside `"tenders": {…}` in `data/seen.json`, restart → 🔁 arrives
- Add a department: append to `SEARCHES`, restart; first check baselines silently (even if empty)
- Deploy code: `scp -i keys\private\ssh-key-2026-07-13.key .\src\<file>.js ubuntu@140.245.246.22:~/ap-tender-alerts/src/` → restart
- **package-lock discipline:** after changing `package.json`, run `npm install`
  on the server (or locally and scp the lockfile) so `package-lock.json` stays
  in sync — a stale lock breaks `npm ci` on fresh clones.
- Runtime upgrade pattern + the `pm2 resurrect`-before-`save` lesson: see v4/v5
  changelog; unchanged.

## Troubleshooting

- **⚠️ health alert** → `pm2 logs … --nostream`; `debug/<id>-post-auto.txt`
  healthy flags: `hdnSearch=1|hdnSearch4=4|hdnadvsearch=1|hdnnoSearch=`.
- **"headers changed — required column(s) not found"** → portal redesign; the
  error lists what it saw; update `REQUIRED_HEADERS`/`OPTIONAL_HEADERS` aliases.
- **"matches N options equally"** → dropdown labels changed; make config text
  more specific (see `debug/<id>-selects.json`).
- **"pagination integrity failure"** → transient portal glitch (auto-retried);
  recurring = DataTables markup changed.
- **"Another instance holds bot.lock"** → stop PM2 for manual runs; stale locks
  (dead PID) reclaim automatically and atomically.
- **State corruption** → backed up as `seen.json.corrupt-<ts>`, fresh start,
  ⚠️ sent; **I/O errors** (permissions/disk) intentionally crash instead.
- `notify:"failed"` entries in state = cleanup give-ups (already warned in group).

## File map

```
src/config.js     searches, schedule, flags; strict envInt; hard validation
src/scraper.js    session generator; fail-closed verified pagination; header-
                  mapped parse; ambiguity detection; marker-based navigation;
                  transient retry; --debug/--headed
src/store.js      v4: tenders{fp,msgId,sentAt,snapshot} retired{notify,attempts,
                  snapshot}; schema validation; corrupt-backup; IO fail-loud
src/notifier.js   TelegramError; idempotency; truncation/clamping; 🔔🔁📝❌
src/index.js      atomic lock; 4-state whitelist; isolation; race guard;
                  edit-on-amend; give-up warnings; IST Intl; exit codes
test/*.test.js    node:test suite (9 tests)
```

## Changelog

- **v1–v1.1 (12–13 Jul)** Scraper + alerts; Oracle deploy; reboot survival.
- **v2 (14 Jul)** Lifecycle (retire/🔁), 4 searches, baselines, health,
  overlap guard, atomic writes, logrotate, withdrawn-alert deletion.
- **v3 (14 Jul)** Single session/cycle, condition waits, resource blocking,
  adaptive 15/60 schedule. ~4 min → 60–90s.
- **v4 (25 Jul)** Review 1: streaming, empty-detection, hard sub-dept fail,
  timestamped health. Node 24 + Playwright 1.61. ~15s cycles.
- **v5 (25 Jul)** Review 2: pagination first-row fix; ok/empty/timeout split
  (baseline+sweep on empty); delete-or-edit cleanup with retries; Telegram
  timeouts; 📝 amendments; IST-Intl; PID lock; corrupt-backup; validation.
- **v6 (25 Jul)** Review 3 "Production Safety": **fail-closed pagination with
  DataTables count verification**; **live-tender cleanup race guard**;
  **per-result processing isolation**; healthy-status whitelist; atomic lock
  directory (token-owned, rename-reclaimed); idempotent cleanup +
  `notify:"failed"` + give-up warnings; 4096-char clamping; ENOENT/corrupt/IO
  split + schema validation; strict env ints; ambiguity hard-fail;
  header-mapped columns; marker-based navigation (no deprecated
  waitForNavigation); browser-close under finally; awaited startup warnings;
  `--once` exit codes + summary; NFKC fingerprints; same-cycle transient retry;
  original-alert edit on amendment; **node:test suite (9 tests)**; engines
  pinned; README streaming-wording corrected (sequential, not concurrent).
  Deferred: full 22-case fixture suite + CI; git hygiene (untrack state/keys).
