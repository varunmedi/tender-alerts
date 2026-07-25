# AP Tender Alerts → Telegram — Varun's Ops Guide (v6.1)

Self-hosted bot watching the AP eProcurement portal on an adaptive IST schedule.
Alerts the **"Tenders"** Telegram group on new (🔔), re-released (🔁), and amended
(📝) tenders; withdrawn tenders' alerts are deleted or edited into ❌ tombstones.
Oracle Cloud Always Free (Hyderabad). ₹0/month.

**Production state (verified 25 Jul 2026):** Node 24.18.0 LTS · Playwright 1.61 ·
per-search isolated sessions · full 4-search cycle ≈ **34s** · POST-verified
filters · 9-test suite passing · crash/reboot recovery live-verified.

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
| Tests | `npm test` → node:test, 9 tests |

Stack verdict (3 external reviews concur): Node+Playwright+JSON optimal.

## Watched searches (src/config.js — now with verified portal IDs)

| id | Department (deptId) | Sub-department (subDeptId) |
|---|---|---|
| `gvmc-electrical` | GVMC (49) | E.E.- Electrical (**74**) |
| `gvmc-it` | GVMC (49) | IT Department, GVMC (**5889**) |
| `vmrda` | VMRDA (14) | EE-VIII Electrical (**5520**) |
| `aptransco-telecom` | APTRANSCO PRODUCTS (1766) | SE Telecom Circle Vskp (**1781**) |

The IDs are not just documentation — **every Apply's captured POST body is
asserted against them** (see Filter integrity below). When adding a search,
run it once, read the IDs from the `POST (auto):` log line, and add them to
config to arm the guard.

## Filter integrity (v6.1 — three layers)

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

## Result states

| Status | Meaning | Healthy | Baseline | Sweep |
|---|---|---|---|---|
| `ok` | Rows parsed; pagination count-verified; **POST filter-verified** | yes | yes | yes |
| `empty` | Portal explicitly: "No matching records" (POST verified) | yes | yes | yes |
| `error` | Anything else — incl. timeouts, POST mismatch, pagination integrity | no | no | no |

## Safety guarantees (v6 + v6.1)

- Fail-closed pagination with DataTables count verification — sweeps never run
  on partial data
- **POST filter verification** — alerts never come from the wrong sub-department
- Live-tender race guard; per-result processing isolation; transient retry
  (one, in a fresh context); idempotent cleanup with `notify:"failed"` +
  give-up warnings; header-mapped columns; ambiguity hard-fail; strict env
  parsing; 4096-char clamping; ENOENT/corrupt/IO distinction; `--once` exit
  code 1 on failures with `N ok, M failed, K alerts` summary

## Operations (bash on server; PowerShell only for ssh/scp)

```bash
pm2 status | pm2 logs tender-alerts [--lines 50 --nostream] | pm2 restart tender-alerts
npm test
pm2 stop tender-alerts && npm run once && pm2 start tender-alerts   # manual cycle
npm run debug     # artifacts, headless (server-safe) · npm run headed = laptop only
pm2 flush tender-alerts   # clear historical log noise after deploys
```

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
- **"pagination integrity failure"** → transient (auto-retried); recurring =
  DataTables markup changed.
- **"Another instance holds bot.lock"** → stop PM2 for manual runs.
- State corruption → auto-backup `seen.json.corrupt-<ts>` + ⚠️ to group; I/O
  errors intentionally crash. Old error-log noise → `pm2 flush`.

## File map

```
src/config.js     searches WITH portal IDs; schedule; strict envInt; validation
src/scraper.js    per-search isolated contexts; POST guard; verified pagination;
                  header-mapped parse; ambiguity detection; marker navigation
src/store.js      v4 store; snapshots; corrupt-backup; IO fail-loud
src/notifier.js   TelegramError; idempotency; truncation; 🔔🔁📝❌
src/index.js      atomic lock; 4-state whitelist; isolation; race guard;
                  edit-on-amend; IST Intl; exit codes
test/*.test.js    node:test suite (9)
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
