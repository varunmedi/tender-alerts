# AP Tender Alerts → Telegram — Varun's Ops Guide (v3)

Self-hosted bot that checks the AP eProcurement portal on an adaptive schedule and
pings the **"Tenders"** Telegram group when new tenders appear. Withdrawn tenders'
alerts are auto-deleted so the group only shows live tenders. Runs 24/7 on an
Oracle Cloud Always Free VM (Hyderabad). Cost: ₹0/month.

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js 20 LTS (ES Modules) | Single runtime for scraping + notifications |
| Browser automation | Playwright (headless Chromium) | Portal is JS-rendered with session-flow + client-side crypto; a real browser is mandatory |
| Scheduler | Adaptive in-process `setTimeout` loop | Office-hours vs quiet-hours cadence; no external cron |
| Notifications | Telegram Bot API (plain HTTPS `fetch`, no SDK) | Free, unlimited group messages; supports send + delete |
| State/dedup | JSON file (`data/seen.json`), atomic writes | Tiny data volume; no database needed |
| Config/secrets | dotenv (`.env`) | Token/chat-id/tuning kept out of code |
| Process manager | PM2 + systemd (`pm2-ubuntu`) + pm2-logrotate | Auto-restart, resurrect on reboot, bounded logs |
| Hosting | Oracle Cloud Always Free — VM.Standard.E2.1.Micro, Ubuntu 24.04, 2 GB swap, Hyderabad | ₹0 forever; **Indian IP required** (portal is geo-restricted) |

> **Why not Go/Rust/Bun/Quarkus/Express/Fastify?** ~99% of each cycle is spent
> waiting on the portal's network responses and Chromium rendering — costs that are
> identical in every language. Web-server frameworks (Express/Fastify/Gin/Fiber/
> Actix/Axum/Quarkus) solve HTTP-serving, which this bot doesn't do. The only true
> speed lever would be replacing the browser with raw HTTP calls — rejected as a
> fragility trap because the portal's `temp()` client-side encryption + CSRF tokens
> would have to be re-implemented and kept in sync. Node + Playwright is optimal here.

## Watched searches (src/config.js)

| id | Department | Sub-department |
|---|---|---|
| `gvmc-electrical` | Greater Visakhapatnam Municipal Corporation | E.E.- Electrical |
| `gvmc-it` | Greater Visakhapatnam Municipal Corporation | IT Department, GVMC |
| `vmrda` | Visakhapatnam Metropolitan Region Development Authority | Executive Engineer -VIII (Electrical), VMRDA |
| `aptransco-telecom` | APTRANSCO PRODUCTS | Superintending Engineer Telecommunication Circle, Visakhapatnam |

Dropdown matching is whitespace-insensitive; exact match preferred, then prefix,
then contains (prevents "…Smart City Corporation" false matches).

## My values (quick reference)

| Item | Value |
|---|---|
| Telegram bot | `@ap_tender_alerts_bot` |
| Bot token | `8550919760:AAEgdJFNaDL25Jl4_1jojxAmN4fS2c4ZVO8` |
| Telegram group | "Tenders", chat ID: `-5341406269` |
| Server public IP | `140.245.246.22` (ephemeral — may change on stop/start) |
| SSH | `ssh -i C:\Users\varun\Downloads\tenders\files\ap-tender-alerts-v2\ap-tender-alerts\keys\private\ssh-key-2026-07-13.key ubuntu@140.245.246.22` |
| Project path (server) | `/home/ubuntu/ap-tender-alerts` |

> ⚠️ The bot token is a secret (rotate via @BotFather `/revoke` if exposed, then
> update `.env` and `pm2 restart tender-alerts`). The SSH private key is
> unrecoverable — keep a backup.

## How it works (final architecture)

```
adaptive schedule (overlap-guarded; PM2 keeps alive; systemd survives reboots)
  └─ ONE browser + ONE portal session for the WHOLE cycle:
       Playwright opens login.html (session cookie minted; images/fonts blocked)
         └─ executes the portal's own "More..." handler directly:
              loginForm.hdnType="current"; temp(tempName,'loginForm');
              POST → TenderDetailsHome.html         (session-flow REQUIRED)
       then for EACH of the 4 searches (reusing that one session):
         └─ Advancedsearch() → dropdowns appear
              └─ select Department → getCircles() AJAX loads sub-depts → select
                   └─ advsearchBtn() DIRECTLY (Apply & Search share duplicate
                      id="searchTender"!) → full page reload → results
                        └─ parse #pagetable13 (DataTables) + pagination
                             └─ lifecycle store (data/seen.json)
                                  └─ new/re-released → Telegram; withdrawn → delete
```

### Adaptive scheduling
- **Mon–Sat, 09:00–19:00 IST:** check every **15 min** (departments publish then)
- **Nights & Sundays:** every **60 min**
- 10-minute politeness floor enforced in code
- Fewer total requests/day than fixed 45-min polling, yet 3× faster detection in hours
- Tune in `.env`: `ACTIVE_START_HOUR`, `ACTIVE_END_HOUR`, `ACTIVE_INTERVAL_MINUTES`,
  `QUIET_INTERVAL_MINUTES`, or `ADAPTIVE_SCHEDULE=0` to revert to `POLL_INTERVAL_MINUTES`

### Performance design (v3)
- **Single session per cycle** — the login→More→TenderDetails chain runs ONCE;
  all four searches reuse the page (a failed search re-establishes the session)
- **Condition-based waits** — waits for the actual element/AJAX/rows, not fixed
  timers (each search logs `search completed in X.Xs`)
- **Resource blocking** — images/media/fonts aborted at network layer (faster
  loads, less RAM on the 1 GB box)
- Typical full cycle: **~60–90s** (was ~4 min); detection latency 15 min in hours

### Tender lifecycle (retire / re-release)
- **New tender** → 🔔 alert → recorded in `tenders` (with its Telegram message_id)
- **Absent from 3 consecutive successful scrapes** (~45 min in office hours) →
  moved to `retired`; logged `[store] retired …`
- **Reappears while retired** → alerts again as **🔁 Re-released Tender**
- Retired entries pruned after 365 days
- Failed/empty scrapes NEVER age entries (no false re-alerts from hiccups)
- Tune: `MISSING_LIMIT` in `src/store.js` (3 = ~45 min in hours; 2 ≈ 30 min)

### Auto-delete withdrawn alerts
- When a tender is retired (taken down from the portal), its ORIGINAL alert is
  **deleted from the group** → group shows only live tenders; log:
  `deleted group alert for withdrawn …`
- **Requires the bot to be a group ADMIN** with "Delete messages" permission
  (Telegram forbids deleting others'/old >48h messages otherwise)
- Only alerts sent by the auto-delete-capable code have a stored message_id;
  older alerts are skipped (clear those once, manually)
- Disable with `DELETE_WITHDRAWN_ALERTS=0` in `.env` to keep a permanent history

### Per-search silent baseline
Each search's FIRST successful check records existing tenders silently — adding a
new department never floods the group.

### Self-monitoring (health alerts to the group)
- 6 consecutive unhealthy checks for a search (error OR 0 tenders) → one ⚠️ warning
- Next healthy check → ✅ recovery message
- Counters reset on restart (restart triggers an immediate check anyway)

### Reliability hardening
- **Overlap guard**: a long cycle makes the next tick skip (never two Chromiums at once)
- **Atomic seen.json writes** (temp file + rename; corruption-proof)
- **pm2-logrotate** installed: logs can't fill the disk

### Portal quirks (why the code is shaped this way)
- Deep links bounce to `SessionTimeOut.jsp`; entry must be via `login.html`
- Searches from a direct-GET page return 0 results — More... POST flow is mandatory
- Apply = `advsearchBtn()` = full page reload with server-rendered results
- Duplicate `id="searchTender"` on Search AND Apply buttons
- Table headers wrap ("Tender\nID") — parser normalizes whitespace
- Rows validated: Tender ID must be numeric (rejects filter-row junk)
- Portal is geo-restricted to Indian IPs

## Daily operations (server)

```bash
pm2 status
pm2 logs tender-alerts                          # live (Ctrl+C to exit)
pm2 logs tender-alerts --lines 50 --nostream    # recent history
pm2 restart tender-alerts                       # restart = immediate check
```

### Test an alert end-to-end
```bash
nano ~/ap-tender-alerts/data/seen.json
# delete ONE entry inside "tenders": { ... } — keep JSON valid
pm2 restart tender-alerts && pm2 logs tender-alerts
```
Expect `1 new alert(s) sent`; the ID re-records automatically.

### Add another department
`nano ~/ap-tender-alerts/src/config.js` → append to `SEARCHES` with a unique `id`
and the portal's exact dropdown texts → `pm2 restart tender-alerts`. Its first
check baselines silently.

### Push code changes from the laptop
```powershell
cd C:\Users\varun\Downloads\tenders\files\ap-tender-alerts-v2\ap-tender-alerts
scp -i keys\private\ssh-key-2026-07-13.key .\src\<file>.js ubuntu@140.245.246.22:~/ap-tender-alerts/src/
```
then `pm2 restart tender-alerts`.

## Troubleshooting

- **⚠️ health alert arrived** → `pm2 logs tender-alerts --lines 60 --nostream`.
  Check `debug/<search>-post-auto.txt`; healthy flags:
  `hdnSearch=1 | hdnSearch4=4 | hdnadvsearch=1 | hdnnoSearch=` with
  `nDepartmentID=49` (GVMC) / `14` (VMRDA), `subDeptId=74` (E.E.- Electrical).
  `hdnnoSearch=1` ⇒ wrong button fired.
- **`Department "..." not found`** → `cat debug/<search>-selects.json` lists every
  dropdown option; copy the exact text into config.js.
- **Withdrawn alerts not deleting** → `could not delete alert … (is the bot a
  group admin…)` means the bot needs admin + "Delete messages" permission; also,
  alerts sent before this feature have no message_id and are skipped.
- **Deep diagnosis** → `node src/index.js --once --debug` (headed browser, step
  screenshots, waits for a MANUAL Apply click to compare POSTs). Copy artifacts:
  `scp -i <key> ubuntu@140.245.246.22:~/ap-tender-alerts/debug/* .`
- **Telegram 403** = bot removed from group; **400 chat not found** = wrong chat id.
- **Server unreachable** → Oracle console: instance Running? IP changed after a
  stop/start? Act on any idle-reclamation email.
- **Memory** → `free -h` must show `Swap: 2.0Gi` (`sudo swapon /swapfile`).
- **seen.json corrupted/deleted** → fails safe: all searches silently re-baseline
  (a few hours of missed alerts at worst, no flood).

## Known limitations (accepted)

- **Corrigendums/amendments don't re-alert** (same ID, edited in place — e.g.
  extended closing date). Future enhancement: watch the corrigendum tab.
- **Alerts link to the portal home**, not the tender (portal forbids deep links).
- A genuinely empty department triggers ONE ⚠️ after 6 checks (informative, not noise).
- Auto-delete has a ~45-min confirmation delay (the 3-check grace period) by design.

## File map (server: ~/ap-tender-alerts)

```
src/config.js     ← the four searches, schedule settings, feature flags, env
src/scraper.js    ← Playwright: single-session, condition waits, resource blocking, #pagetable13
src/store.js      ← lifecycle dedup: tenders/retired/searches, message_ids, atomic writes
src/notifier.js   ← Telegram send (🔔/🔁) + deleteMessage
src/index.js      ← orchestrator, adaptive scheduler, overlap guard, health alerts, auto-delete
.env              ← token, chat id, schedule + feature tuning
data/seen.json    ← v2 lifecycle store
debug/            ← POST captures, screenshots, HTML dumps (safe to delete)
```

## Changelog

- **v1 (12 Jul 2026)** — Initial build: Playwright scraper (GVMC E.E.-Electrical +
  all-VMRDA), Telegram alerts, flat-array dedup, first-run silent baseline.
  Debugging milestones: SessionTimeOut session flow, ad popup, More... handler
  replication (login_emudhra.js), duplicate id="searchTender" bug, DataTables
  #pagetable13 parsing, Windows path fixes.
- **v1.1 (13 Jul 2026)** — Deployed to Oracle Cloud Hyderabad (Indian IP required);
  PM2 + systemd reboot survival verified by live reboot test.
- **v2 (14 Jul 2026)** — Tender lifecycle store (retire after 3 missed checks; 🔁
  re-release alerts; 365-day pruning; auto v1 migration). Four searches (added GVMC
  IT + APTRANSCO Telecom; VMRDA narrowed to EE-VIII Electrical). Per-search silent
  baselines. Self-monitoring ⚠️/✅ health alerts. Overlap guard. Atomic writes.
  pm2-logrotate. Auto-delete of withdrawn tenders' alerts (bot admin required).
- **v3 (14 Jul 2026)** — Performance rewrite: single browser+session per cycle,
  condition-based waits (no fixed sleeps), image/media/font blocking, single-round
  table parse. Adaptive scheduling (15 min office hours / 60 min otherwise).
  node-cron dependency removed. Cycle ~4 min → ~60–90s; detection 45 → 15 min.
