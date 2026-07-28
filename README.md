# AP Tender Alerts → Telegram — Varun's Ops Guide (v11)

Self-hosted bot watching the AP eProcurement portal on an adaptive IST schedule.
Alerts the **"Tenders"** Telegram group on new (🔔), re-released (🔁), and amended
(📝) tenders; withdrawn tenders' alerts are deleted or edited into ❌ tombstones.
Oracle Cloud Always Free (Hyderabad). ₹0/month.

**Production state (verified 28 Jul 2026):** Node 24.18.0 LTS · Playwright 1.61 ·
per-search isolated sessions · full 4-search cycle ≈ **34s** · POST-verified
filters · **22-test suite (incl. real child-process integration tests) + CI** · crash/reboot recovery live-verified.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 24 LTS (ES Modules), engines-pinned `>=24 <25` |
| Automation | Playwright 1.61 headless Chromium — **one fresh, isolated browser context per search** (clean cookies/session/tokens each time) |
| Scheduler | Adaptive `setTimeout` loop, IST via `Intl` (OS-timezone independent) |
| Pipeline | Async generator — each search's result fully processed before the next search starts |
| Notifications | Telegram Bot API: send/edit/delete; 15s timeouts; retries incl. 429 `retry_after`; structured `TelegramError`; 4096-char clamping |
| State | JSON v4 (`data/seen.json`): atomic writes, schema validation, corrupt-file backup + group warning, I/O errors fail loud |
| Concurrency | Overlap guard + atomic lock directory (mkdir + owner token) |
| Process mgmt | PM2 + systemd + pm2-logrotate |
| Tests | `npm test` → node:test, 22 tests |

Stack verdict (8 external reviews concur): Node+Playwright+JSON optimal.

## Watched searches (src/config.js — now with verified portal IDs)

| id | Department (deptId) | Sub-department (subDeptId) |
|---|---|---|
| `gvmc-electrical` | GVMC (49) | E.E.- Electrical (**74**) |
| `gvmc-it` | GVMC (49) | IT Department, GVMC (**5889**) |
| `vmrda` | VMRDA (14) | EE-VIII Electrical (**5520**) |
| `aptransco-telecom` | APTRANSCO PRODUCTS (1766) | SE Telecom Circle Vskp (**1781**) |

The IDs are not just documentation — **every Apply's captured POST body is
asserted against them**, and since v7 config validation REQUIRES them (a
search without numeric `deptId`/`subDeptId` refuses to start, so the guard
can never be silently unarmed). When adding a search: temporarily set the IDs
after one `--debug` run by reading the `POST (auto):` log line.

## Filter integrity (three layers)

1. **Isolation (prevention):** each search runs in a brand-new browser context —
   no cookies, form state, or `#subDeptId` options can leak from a previous
   search. This structurally eliminates the stale-dropdown class of bug.
2. **Selection verification (belt, read-only):** after choosing the
   sub-department, the dropdown's actual selected value is read back and must
   match; mismatch = transient failure + fresh-context retry.
3. **POST ground-truth guard (braces, read-only):** the captured Apply POST —
   what the portal *actually filtered on* — must carry the config's
   `deptId`/`subDeptId`. Mismatch = the search FAILS; wrong-sub-department
   results can never be ingested or alerted.

**Hard-won rule:** only drive the portal the way its own UI does (natural
change events, its own `advsearchBtn()`); synthetic DOM surgery or calling its
AJAX helpers with wrong/absent args (`getCircles()`) makes the anti-tamper
backend invalidate the session server-side → every Apply bounces to
SessionTimeOut.jsp.

## My values

| Item | Value |
|---|---|
| Bot | `@ap_tender_alerts_bot` (group admin, Delete messages) |
| Token | `8550919760:AAEgdJFNaDL25Jl4_1jojxAmN4fS2c4ZVO8` — ⚠️ exposed in repo history; rotate via @BotFather |
| Group | "Tenders", chat `-5341406269` |
| Server | `140.245.246.22` (ephemeral IP) · `~/ap-tender-alerts` |
| SSH | `ssh -i keys\private\ssh-key-2026-07-13.key ubuntu@140.245.246.22` (from project dir) |

## Alert types

🔔 new · 🔁 re-released · 📝 updated (original alert also edited in place) ·
❌ withdrawn tombstone (>47h) · *(deleted)* withdrawn (<47h) · ⚠️/✅ health.

## Scrape status (what the scraper returns per search)

| Status | Meaning | Healthy | Baseline | Sweep |
|---|---|---|---|---|
| `ok` | Rows parsed; pagination count-verified; **POST filter-verified** | yes | yes | yes |
| `empty` | Portal explicitly: "No matching records" (POST verified) | yes | yes | yes |
| `error` | Anything else — incl. timeouts, POST mismatch, pagination integrity | no | no | no |

## Safety guarantees

- Pagination pages until the Next control disables, deduping by tender ID;
  when the portal exposes a DataTables total it is cross-checked (mismatch =
  fail), and when that count element is absent (this portal often omits it,
  even for multi-page results) the scraper warns and falls back to the proven
  page-until-disabled behaviour rather than dropping tenders — so sweeps never
  run on truncated data, but valid results are never blocked either
- **POST filter verification** — alerts never come from the wrong sub-department
- Live-tender race guard; per-result processing isolation; transient retry
  (one, in a fresh context); idempotent cleanup with `notify:"failed"` +
  give-up warnings; header-mapped columns; ambiguity hard-fail; strict env
  parsing; 4096-char clamping; ENOENT/corrupt/IO distinction; `--once` exit
  code 1 on failures with `N ok, M failed, K alerts` summary

## Schedule (adaptive, IST via Intl — OS-timezone independent)

- **Mon–Sat, 09:00–19:00 IST** → check every **15 min** (office hours, when
  departments actually publish)
- **Nights, and all of Sunday** → every **60 min**
- 10-minute politeness floor; the schedule is recomputed every cycle from IST
  regardless of the server clock, and flips automatically at 09:00 Mon — no
  restart needed. Sundays run a full set of checks, just hourly; a Sunday
  publication is caught within the hour rather than 15 min.
- Tune in `.env`: `ACTIVE_START_HOUR`, `ACTIVE_END_HOUR`,
  `ACTIVE_INTERVAL_MINUTES`, `QUIET_INTERVAL_MINUTES`, or `ADAPTIVE_SCHEDULE=0`
  for a fixed `POLL_INTERVAL_MINUTES`.

## Delivery guarantee (read this before trusting counts)

This bot is **at-least-once**, not exactly-once. There is an irreducible window
where Telegram accepts a message and the process dies before `markSent()`
persists it — that tender re-alerts next cycle. Per-tender (non-batched) state
writes keep the window as small as possible, and graceful shutdown avoids
creating it deliberately, but it cannot be eliminated. Duplicates are rare and
harmless; missing alerts would not be, so the design errs this way on purpose.

Search outcomes are reported in three **summary buckets** (distinct from the
per-scrape status table above: that one describes what the scraper returned,
this one describes how the orchestrator counted it):

| Bucket | Meaning |
|---|---|
| **ok** | Scraped and fully processed; completeness verified (or portal-confirmed empty) |
| **degraded** | Scraped fine, but completeness UNVERIFIED — new tenders still alerted; withdrawal sweep, first-run baseline, and alert cleanup all suppressed. Mutually exclusive with `ok` |
| **failed** | Scrape or processing error; nothing aged, nothing baselined |

Three consecutive `degraded` cycles for a search send a ⚠️ (with a ✅ when
completeness returns) — otherwise a portal change could silently disable
withdrawal tracking while new-tender alerts kept flowing, looking healthy.

## Operations (bash on server; PowerShell only for ssh/scp)

```bash
pm2 status | pm2 logs tender-alerts [--lines 50 --nostream] | pm2 restart tender-alerts
npm test
pm2 stop tender-alerts && npm run once && pm2 start tender-alerts   # manual cycle
npm run debug     # artifacts, headless (server-safe) · npm run headed = laptop only
pm2 flush tender-alerts   # clear historical log noise after deploys
```

- **Completeness model:** each scrape reports `verified` (portal's own count
  matched what we collected, or the portal explicitly said "no records") or
  `best-effort` (paged until Next disabled, count unavailable). New tenders are
  ALWAYS alerted; **withdrawal sweeps run only on `verified` results**, so
  tenders on an unread page can never be mistaken for withdrawn. Repeated
  `best-effort` cycles raise a warning.
- **`STATE_CORRUPTION_POLICY`** (`.env`): `recover` (default — back up
  `seen.json`, start fresh, warn the group; keeps an unattended bot alerting)
  or `halt` (refuse to start; safest against missed alerts but means zero
  alerts until you intervene).
- **`HOME_URL` / `PORTAL_URL` / `NAV_TIMEOUT_MS`** (`.env`, optional): override
  the portal endpoints and per-navigation timeout. Production leaves these
  UNSET (real portal, 60s). They exist so the test suite can force a fast,
  deterministic scrape failure against an unreachable host — independent of
  whether the real portal is reachable from wherever the tests run.
- **Health heartbeat:** `cat data/status.json` — last cycle times, duration,
  per-search `consecutiveFailures` / `lastSuccessAt` / `lastError` /
  `lastTenderCount`. Counters are DURABLE across restarts, so a repeatedly
  restarting bot still reaches the 6-failure ⚠️ threshold.
- **Optional PM2 config:** `ecosystem.config.cjs` documents the verified fork
  mode plus `max_memory_restart: 750M` and `restart_delay: 5000` (a crash-loop
  can't spin at ~1s). Adopt with `pm2 delete tender-alerts && pm2 start
  ecosystem.config.cjs && pm2 save`.
- Deploy code: `scp -i keys\private\ssh-key-2026-07-13.key .\src\<file>.js ubuntu@140.245.246.22:~/ap-tender-alerts/src/` → restart
- After changing `package.json`: `rm -rf node_modules package-lock.json && npm install`
  **and then `npx playwright install chromium`** — wiping node_modules orphans
  the browser binary (bit us on 25 Jul; the summary line caught it)
- Reset one search's baseline (e.g. after bad data): delete its `<id>::…` keys
  from `tenders`/`retired` in `data/seen.json` AND remove its id from
  `searches` → next run re-baselines silently
- Expected timings: ~8–10s per search (isolated sessions), ~34s full cycle

## Troubleshooting

- **"POST sub-department mismatch … Refusing results"** → the guard caught a
  stale/incorrect filter before any wrong alert was sent; auto-retried in a
  fresh context. Recurring = compare `debug/<id>-post-auto.txt` with config IDs.
- **"Apply POST bounced to SessionTimeOut.jsp"** → something is driving the
  portal unnaturally (see the hard-won rule above) or the portal changed its
  session flow; `npm run debug` and diff the POST captures.
- **"headers changed — required column(s) not found"** → portal redesign;
  update the header aliases in scraper.js.
- **"matches N options equally"** → dropdown labels changed; make config text
  more specific (see `debug/<id>-selects.json`).
- **"pagination integrity failure"** → collected count disagreed with the
  portal's reported total (transient, auto-retried); recurring = markup change.
- **"paging until Next disables (count cross-check skipped)"** → informational,
  NOT an error: this portal often omits its count element even when paginated
  (GVMC-Electrical logs this every cycle) — all tenders are still collected.
- **"Another instance holds bot.lock"** → stop PM2 for manual runs.
- State corruption → auto-backup `seen.json.corrupt-<ts>` + ⚠️ to group; I/O
  errors intentionally crash. Old error-log noise → `pm2 flush`.

## File map

```
src/index.js      executable wrapper ONLY (PM2 entrypoint) — no guard needed
src/app.js        all logic + test exports: atomic lock, IST scheduler,
                  lifecycle, health/integrity state machines, exit codes
src/health-store.js  validated status.json I/O (ENOENT/corrupt/IO distinct)
src/config.js     searches WITH portal IDs; schedule; strict envInt; validation
src/scraper.js    per-search isolated contexts; POST guard; verified pagination;
                  header-mapped parse; ambiguity detection; marker navigation
src/store.js      v4 store; snapshots; corrupt-backup; IO fail-loud
src/notifier.js   TelegramError; idempotency; truncation; 🔔🔁📝❌
test/*.test.js    node:test suite (22) — logic + child-process integration
```

## Changelog

- **v1–v1.1 (12–13 Jul)** Scraper + alerts; Oracle deploy; reboot survival.
- **v2 (14 Jul)** Lifecycle (retire/🔁), 4 searches, baselines, health alerts,
  overlap guard, atomic writes, withdrawn-alert deletion.
- **v3 (14 Jul)** Single session/cycle, condition waits, resource blocking,
  adaptive 15/60 schedule.
- **v4 (25 Jul)** Review 1: streaming, empty-detection, hard sub-dept fail.
  Node 24 + Playwright 1.61.
- **v5 (25 Jul)** Review 2: pagination first-row fix; ok/empty/timeout split;
  delete-or-edit cleanup; Telegram timeouts; 📝 amendments; IST-Intl; locks.
- **v6 (25 Jul)** Review 3 "Production Safety": fail-closed count-verified
  pagination; live-tender race guard; per-result isolation; healthy whitelist;
  atomic lock dir; idempotent cleanup; clamping; strict env; header-mapped
  columns; ambiguity hard-fail; marker navigation; exit codes; NFKC
  fingerprints; transient retry; edit-on-amend; node:test suite.
- **v6.1 (25 Jul) — the live-fire fix.** Field logs caught a data bug no
  static review found: with a shared session, GVMC-IT's Apply POSTed the
  PREVIOUS search's `subDeptId=74` (Electrical) instead of 5889 — the dropdown
  *displayed* IT but a late `getCircles()` callback reset the form value; 15
  Electrical tenders were alerted as IT. Fix attempt 1 (forced re-navigation)
  and the DOM-surgery workaround (blank options + manual arg-less
  `getCircles()`) both made the portal invalidate its session → every Apply
  bounced to SessionTimeOut. Final architecture: **fresh isolated context per
  search** (prevention) + read-only selection verification (belt) + **POST-body
  assertion against config's deptId/subDeptId** (braces), with the filter flow
  restored to the portal's own natural event path. Store cleanup procedure
  documented (reset baseline). Cycle cost: ~15s → ~34s, accepted for
  correctness. Verified live: gvmc-it POSTs 5889, extracts its real 3 tenders;
  all four searches `4 ok, 0 failed`.
  Deferred: full fixture suite + CI; git hygiene; credential rotation.
- **v7 (26 Jul) — Correctness & Testability (review 4).** Silent-loop
  post-mortem hardening + reviewer items: **PM2 entry-guard fixed via
  NODE_TEST_CONTEXT** (the argv-based guard no-oped under PM2's fork wrapper →
  22,000+ silent restarts; reviewer's `import.meta.main` suggestion REJECTED —
  it would be false under the same PM2 wrapper and reintroduce the loop).
  Transient classification completed (SessionTimeOut bounce, portal
  navigation, login-readiness now retried in a fresh context); Chromium
  auto-relaunch if the browser process dies mid-cycle; pagination advance now
  tracked via the DataTables info text (no hardcoded columns, immune to
  equal-first-ID pages); DataTables reported-total cross-checked when present
  and ADVISORY with page-until-disabled fallback when absent (a v7 hotfix: an
  initial "required" version false-failed the 3 single-page searches and then
  GVMC-Electrical, whose paginated table has no count element on this portal —
  the guard now warns and falls back instead of dropping tenders);
  conflicting duplicate Tender IDs fail closed; POST capture restricted to
  main-frame navigation requests; pre-submit dropdown-value assertion against
  config; **numeric portal IDs required by validation**; success/healthy
  tallied only after lifecycle persistence (no more double-counted searches or
  premature ✅); health messages HTML-escaped (error text with < > & no longer
  kills the notification); clamping strips tags instead of cutting through
  markup; store version 4 with future-version refusal (preserved as backup +
  warning, never silently downgraded); PID-reuse-proof lock via /proc start
  time; last deprecated waitForNavigation removed; dead code removed
  (positional parser, polling waiter). Added: `.nvmrc`, `packageManager`,
  GitHub Actions CI (`ci.yml` → `.github/workflows/`), 3 new tests (12 total).
  Repo action still yours: commit the server-regenerated package-lock.json.
- **v7.1 (26 Jul) — live-fix + docs.** Count-verification made advisory with a
  page-until-disabled fallback and a hardened multi-selector total parser
  (fixed three over-strict v7 failures caught in field runs: single-page
  searches, then GVMC-Electrical's count-less paginated table). Verified live:
  all four searches `4 ok, 0 failed`, GVMC-Electrical extracts 15 via the
  fallback, PM2 stable at restarts 0. README: explicit Sunday/adaptive-schedule
  section; count-check wording corrected to match shipped behaviour.
- **v8 (27 Jul) — Integrity & Observability (review 5).** Review caught three
  places where v7's summary overclaimed. Fixed: **future store versions now
  truly refuse** (a dedicated `UnsupportedStoreVersionError` bypasses the
  corruption-recovery path that was silently backing up and re-baselining —
  defeating the very check it was meant to enforce); **Chromium relaunches
  BEFORE the retry** (the retry previously reused a dead browser) with
  target/connection-closed messages classified transient; **amendment writes
  `fp` + `snapshot` atomically** (a title change no longer leaves a stale
  tombstone); deeper per-entry store validation (null entries, ISO dates,
  msgId/attempts) so a malformed entry can't TypeError into a full reset;
  positional Tender-ID fallback removed in favour of position-agnostic row
  detection; duplicate-required-header ambiguity fails closed; evaluation
  failures in pagination no longer read as "not paginated" (fail-open path
  closed). **Count source upgraded:** DataTables `page.info()` API preferred,
  then tolerant text patterns (this portal's info element exists — advance
  detection depends on it — but doesn't always use the stock "of N entries"
  wording, which is why v7 saw null); still ADVISORY with page-until-disabled
  fallback, because three field regressions proved fail-hard assumptions about
  this portal break real scrapes. **Entry-point guessing eliminated:** logic
  split into `app.js`, `src/index.js` is a bare executable wrapper — no
  `import.meta.main`, no `NODE_TEST_CONTEXT`; verified running under both PM2
  fork-wrapper and direct node. **Persistent health:** `data/status.json`
  heartbeat with durable per-search failure counters (in-memory counters reset
  on restart, so a restart-looping bot could never reach the warn threshold —
  the blind spot that hid the 22k loop); edge-triggered warn/recovery. Added
  `ecosystem.config.cjs`; 15 tests (incl. a guard against the TDZ ordering bug
  found while building the persistence). REJECTED: replacing the Chrome-126
  user agent (cosmetic, and perturbing a working anti-tamper interaction is
  pure downside). DEFERRED with rationale: Playwright fixture tests — Chromium
  is unavailable in the authoring sandbox, and shipping unrunnable test code
  is worse than none; they remain the largest real gap.
  Repo actions still yours: commit the regenerated `package-lock.json`, add
  `.github/workflows/ci.yml`, push the current README, rotate credentials.
- **v9 (27 Jul) — Delivery Integrity (review 6).** **Health warnings can no
  longer be lost:** v8 set `warned=true` *before* the Telegram send and
  swallowed failures, so one outage meant the alert never arrived — delivery
  is now a persisted state machine (`warning-pending` → `warned`,
  `recovery-pending` → cleared only on confirmed delivery) that retries every
  cycle. **Graceful shutdown:** SIGTERM/SIGINT now stop scheduling and await
  the active cycle (bounded) instead of `process.exit(0)` mid-send — which
  could kill after Telegram accepted a message but before `markSent` persisted
  it, duplicating alerts; PM2's `kill_timeout` is now meaningful.
  **`verified` vs `best-effort` integrity:** the advisory-count compromise
  left unverified results feeding `sweepMissing` exactly like verified ones —
  an early-stopping pagination could retire unread-page tenders. New tenders
  are still always alerted (never block real data), but withdrawal sweeps are
  suppressed unless completeness is proven; `status: 'empty'` counts as
  verified so emptied departments still retire correctly. Transient
  classification completed: dropdown evaluation failures no longer masquerade
  as "Department not found", slow/failed `getCircles()` AJAX is retryable
  while a genuinely-populated-but-missing label stays permanent, and
  Playwright `TimeoutError` is retryable. `lastSuccessfulCycleAt` survives a
  restart+failure; corrupt `status.json` backs up and warns instead of
  silently zeroing monitoring; `updateKnownTender` throws on an unknown key
  instead of no-oping. New `STATE_CORRUPTION_POLICY` (default `recover`,
  deliberately: for an unattended bot, halting means zero alerts until
  noticed — and with warning delivery now reliable, the operator is told).
  **Tests made real:** v8's future-version and health-persistence tests only
  constructed an error object and checked declaration order; they are replaced
  with child-process integration tests that actually run the bot and assert
  exit codes, file preservation, counter accumulation across restarts, and
  both corruption policies (17 tests). CI now installs Chromium so browser
  fixture tests can be added. Stale v3-era file headers corrected.
  Repo actions still yours: regenerate/commit `package-lock.json`, push
  `.github/workflows/ci.yml` and this README, rotate credentials.
- **v9.1 (27 Jul) — test determinism.** Two v9 integration tests assumed the
  portal would be UNREACHABLE (true in the CI/authoring sandbox, false on the
  server) and so failed when run on the live host — the bot was correct, the
  tests' expectations were environment-dependent. Fixed by pointing
  `HOME_URL`/`PORTAL_URL` at an unroutable address to force a deterministic,
  fast failure everywhere; `HOME_URL`/`PORTAL_URL`/`NAV_TIMEOUT_MS` are now
  env-overridable (production defaults unchanged). Also isolates every test's
  store path so runs never touch real `seen.json`. Full suite: 17 pass in
  ~29s (was 143s — the old tests were scraping the live portal). No bot
  behaviour changed; this is a test-and-config-plumbing release.
- **v10 (27 Jul) — Lifecycle Integrity (review 7).** Four real bugs fixed.
  **`notifyHealth()` was undefined** — the cleanup-gave-up path threw a
  ReferenceError instead of warning (contained by per-result isolation, so it
  surfaced as a failed search); now calls `tryNotifyHealth()` and logs loudly
  if that delivery also fails. **False recovery messages:** `WARNING_PENDING`
  (a warning that never reached Telegram) counted as "was warned", so the next
  success sent a ✅ for a ⚠️ users never saw — pending warnings are now
  cancelled silently instead. **Best-effort first runs no longer baseline:**
  `markSearchKnown()` ran unconditionally, so an incomplete first scrape marked
  the search known and later announced pre-existing tenders (from unread pages)
  as newly published. **Retirement cleanup now gated on completeness:** it ran
  on best-effort results, so a re-released tender sitting on an unread page
  could be tombstoned while live — one `complete` flag now gates sweep,
  baseline, AND cleanup together. Also: integrity degradation is PERSISTED with
  its own ⚠️/✅ cycle after 3 consecutive best-effort scrapes (previously an
  in-memory counter that only logged); `writeHeartbeat()` throws instead of
  reporting success after a failed write; graceful shutdown finishes the
  CURRENT search then stops (was: whole cycle) with an 80s deadline under PM2's
  raised 90s `kill_timeout`, and no forced `process.exit()` on clean shutdown;
  `STATE_CORRUPTION_POLICY` typos now fail startup instead of silently becoming
  `recover`; lock liveness falls back to `process.kill(pid, 0)` where `/proc`
  is absent (Windows/macOS dev). Summary line gains a `degraded` count. Tests:
  19, including regression guards for the undefined-identifier bug and the
  policy-typo coercion. Documented the at-least-once delivery guarantee.
- **v11 (27 Jul) — State & Shutdown Integrity (review 8).** **Degraded searches
  were double-counted:** v10 incremented `degraded` AND `successful` for the
  same search (4 searches could report "4 ok, 1 degraded"), and counted
  success BEFORE `trackHealth()` so a persistence throw counted it as
  successful and failed. Classification is now mutually exclusive and happens
  only after every persistence step. **Shutdown could release the lock while
  scraping continued:** if the 80s deadline won the race, the lock was freed
  with the browser still open — PM2 or a manual run could then start a second
  bot writing state and sending alerts concurrently. The deadline is now
  cancellable (an uncancelled `pause()` timer also kept the event loop alive
  for the full 80s) and on timeout the lock is HELD while we await PM2
  termination. **Integrity warnings got the same reliable state machine as
  scrape health** (none → warning-pending → warned → recovery-pending): v10
  cleared `warned` before sending, so a failed ✅ was lost forever; integrity
  persistence failures are no longer swallowed. **Primitive JSON state roots
  rejected** — `42`, `"text"`, `true` parse as valid JSON and would silently
  produce a fresh store (wiping baselines, suppressing alerts); non-integer
  `version` likewise. `status.json`'s integrity section is now validated
  instead of silently normalised away. **Composite pagination marker** —
  advancement now checks the DataTables API page index first, then info text,
  then a first-rows signature, so a successful advance is no longer mistaken
  for failure when the optional info element is absent or unrepainted.
  Strict boolean env parsing (`ADAPTIVE_SCHEDULE=false` previously stayed
  ENABLED because only the literal "0" disabled it; typos now fail startup).
  22 tests, adding guards for primitive roots and boolean coercion.
  DEFERRED again, with the same rationale: Playwright fixture tests — CI can
  install Chromium, but I cannot execute them in the authoring sandbox, and
  shipping unverifiable test code is worse than shipping none.
  Repo actions still yours: regenerate/commit `package-lock.json`, push CI
  workflow + README, rotate credentials.
