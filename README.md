# AP Tender Alerts → Telegram — Varun's Ops Guide (v4)

Self-hosted bot that checks the AP eProcurement portal on an adaptive schedule and
pings the **"Tenders"** Telegram group when new tenders appear. Withdrawn tenders'
alerts are auto-deleted so the group only shows live tenders. Runs 24/7 on an
Oracle Cloud Always Free VM (Hyderabad). Cost: ₹0/month.

**Current production state (verified 25 Jul 2026):** Node.js 24.18.0 LTS ·
Playwright 1.61 · kernel 6.17.0-1018-oracle · full 4-search cycle ≈ **15 seconds**
· crash recovery (PM2) and reboot recovery (systemd) both proven by live tests.

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js 24 LTS (ES Modules) | Current LTS; single runtime for scraping + notifications |
| Browser automation | Playwright 1.61 (headless Chromium) | Portal is JS-rendered with session-flow + client-side crypto; a real browser is mandatory |
| Scheduler | Adaptive in-process `setTimeout` loop | Office-hours vs quiet-hours cadence; no external cron |
| Pipeline | Async-generator streaming | Each search's alerts send while the next search runs |
| Notifications | Telegram Bot API (native `fetch`) | Free, unlimited; supports send + delete |
| State/dedup | JSON file (`data/seen.json`), atomic writes | Tiny data volume; per-tender persistence = crash-safe alerts |
| Config/secrets | dotenv (`.env`) | Token/chat-id/tuning kept out of code |
| Process manager | PM2 + systemd (`pm2-ubuntu`) + pm2-logrotate | Auto-restart, resurrect on reboot, bounded logs |
| Hosting | Oracle Cloud Always Free — VM.Standard.E2.1.Micro, Ubuntu 24.04, 2 GB swap, Hyderabad | ₹0 forever; **Indian IP required** (portal is geo-restricted) |

> **Why not Go/Rust/Bun/Quarkus/Express/Fastify?** ~99% of each cycle is portal
> network latency + Chromium rendering — identical in every language. Web-server
> frameworks solve HTTP-serving, which this bot doesn't do. A raw-HTTP scraper was
> evaluated twice (including a browser-cookie `context.request` hybrid) and
> rejected: the portal's `temp()` anti-tamper encryption + per-page CSRF chaining
> would need re-implementing and maintaining. Node + Playwright is optimal here.

## Watched searches (src/config.js)

| id | Department | Sub-department |
|---|---|---|
| `gvmc-electrical` | Greater Visakhapatnam Municipal Corporation | E.E.- Electrical |
| `gvmc-it` | Greater Visakhapatnam Municipal Corporation | IT Department, GVMC |
| `vmrda` | Visakhapatnam Metropolitan Region Development Authority | Executive Engineer -VIII (Electrical), VMRDA |
| `aptransco-telecom` | APTRANSCO PRODUCTS | Superintending Engineer Telecommunication Circle, Visakhapatnam |

Dropdown matching is whitespace-insensitive; exact match preferred, then prefix,
then contains (handles the portal's "APTRANSCO   PRODUCTS" triple-space and
prevents "…Smart City Corporation" false matches). Known dept/sub-dept IDs:
GVMC=49 (E.E.- Electrical=74, IT=5889), VMRDA=14 (EE-VIII=5520),
APTRANSCO=1766 (SE Telecom=1781).

## My values (quick reference)

| Item | Value |
|---|---|
| Telegram bot | `@ap_tender_alerts_bot` |
| Bot token | `8550919760:AAEgdJFNaDL25Jl4_1jojxAmN4fS2c4ZVO8` |
| Telegram group | "Tenders", chat ID: `-5341406269` — **bot is group admin** (needed for alert deletion) |
| Server public IP | `140.245.246.22` (ephemeral — may change on stop/start) |
| SSH | `ssh -i C:\Users\varun\Downloads\tenders\files\ap-tender-alerts-v2\ap-tender-alerts\keys\private\ssh-key-2026-07-13.key ubuntu@140.245.246.22` |
| Project path (server) | `/home/ubuntu/ap-tender-alerts` |

> ⚠️ The bot token is a secret (rotate via @BotFather `/revoke` if exposed, then
> update `.env` and `pm2 restart tender-alerts`). The SSH private key is
> unrecoverable — keep a backup. Never commit `.env` or `keys/` to any repository.

## How it works (final architecture)

```
adaptive schedule (overlap-guarded; PM2 keeps alive; systemd survives reboots)
  └─ ONE browser + ONE portal session for the WHOLE cycle:
       Playwright opens login.html (session minted; images/media/fonts blocked)
         └─ executes the portal's own "More..." handler directly:
              loginForm.hdnType="current"; temp(tempName,'loginForm');
              POST → TenderDetailsHome.html         (session-flow REQUIRED)
       then for EACH of the 4 searches (reusing that one session):
         └─ Advancedsearch() → select Department → getCircles() AJAX → sub-dept
              (sub-dept failure = HARD search failure — never dept-wide fallback)
                └─ advsearchBtn() DIRECTLY (Apply & Search share duplicate
                   id="searchTender"!) → full page reload → results
                     └─ wait for rows OR explicit "No matching records"
                        (empty depts resolve in ~1s, not a 20s timeout)
                          └─ parse #pagetable13 + pagination
                               └─ YIELD result → alerts send immediately
                                    while the next search already runs
                                      └─ lifecycle store → Telegram
                                         (new 🔔 / re-released 🔁 / withdrawn → delete)
```

### Adaptive scheduling
- **Mon–Sat, 09:00–19:00 IST:** every **15 min** · **nights & Sundays:** every **60 min**
- 10-minute politeness floor; fewer total requests/day than the old fixed 45-min polling
- Tune in `.env`: `ACTIVE_START_HOUR`, `ACTIVE_END_HOUR`, `ACTIVE_INTERVAL_MINUTES`,
  `QUIET_INTERVAL_MINUTES`, or `ADAPTIVE_SCHEDULE=0` → fixed `POLL_INTERVAL_MINUTES`

### Performance design
- Single session per cycle; condition-based waits (no fixed sleeps); resource
  blocking; one-round-trip table parse; streamed results (alerts for search #1
  send while search #2 runs); instant empty-table detection
- **Measured: full 4-search cycle ≈ 15s** (8.3 + 2.1 + 2.6 + 1.8s on 25 Jul 2026)
- Per-search timing logged: `search completed in X.Xs`

### Tender lifecycle (retire / re-release)
- **New tender** → 🔔 alert → recorded in `tenders` (with Telegram message_id)
- **Absent from 3 consecutive successful scrapes** (~45 min office hours) →
  `retired`; logged `[store] retired …`
- **Reappears while retired** → **🔁 Re-released Tender** alert
- Retired entries pruned after 365 days; failed/empty scrapes NEVER age entries
- Tune: `MISSING_LIMIT` in `src/store.js`

### Auto-delete withdrawn alerts (proven live)
- Retired tender → its alert is **deleted from the group**; log:
  `deleted group alert for withdrawn …` (verified: 5 deletions in one pass, 25 Jul)
- Requires bot = group ADMIN with "Delete messages" (done)
- Disable with `DELETE_WITHDRAWN_ALERTS=0` for a permanent history

### Correctness guarantees
- **Sub-department selection failure = hard search failure** — never a silent
  department-wide search that would alert unrelated tenders
- Per-tender state writes = crash-safe (a mid-batch crash never re-sends alerts)
- Per-search silent baselines — adding a department never floods the group
- Overlap guard — never two Chromium sessions at once
- Atomic seen.json writes (temp + rename)

### Self-monitoring
- 6 consecutive unhealthy checks (error OR 0 tenders) → one ⚠️ with the error
  detail and **real elapsed duration** (timestamp-based) · recovery → ✅
- Note: an actually-empty department (e.g. APTRANSCO Telecom some weeks) triggers
  one informative ⚠️; it self-resolves with ✅ when a tender appears

### Portal quirks (why the code is shaped this way)
- Deep links bounce to `SessionTimeOut.jsp`; entry must be via `login.html`
- Searches from a direct-GET page return 0 results — More... POST flow mandatory
- Apply = `advsearchBtn()` = full page reload with server-rendered results
- Duplicate `id="searchTender"` on Search AND Apply buttons
- Table headers wrap ("Tender\nID"); rows validated by numeric Tender ID
- Geo-restricted to Indian IPs

## Daily operations (server)

```bash
pm2 status
pm2 logs tender-alerts                          # live (Ctrl+C to exit)
pm2 logs tender-alerts --lines 50 --nostream    # recent history
pm2 restart tender-alerts                       # restart = immediate check
```

### Test an alert end-to-end
```bash
nano ~/ap-tender-alerts/data/seen.json   # delete ONE entry inside "tenders": {...}
pm2 restart tender-alerts && pm2 logs tender-alerts
```

### Add another department
Append to `SEARCHES` in `src/config.js` (unique `id`, exact dropdown texts) →
`pm2 restart tender-alerts`. First check baselines silently.

### Push code changes from the laptop
```powershell
cd C:\Users\varun\Downloads\tenders\files\ap-tender-alerts-v2\ap-tender-alerts
scp -i keys\private\ssh-key-2026-07-13.key .\src\<file>.js ubuntu@140.245.246.22:~/ap-tender-alerts/src/
```
then `pm2 restart tender-alerts`.

### Runtime upgrades (done 25 Jul 2026 — repeat pattern for future majors)
```bash
curl -fsSL https://deb.nodesource.com/setup_XX.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2 && pm2 update
cd ~/ap-tender-alerts && npm install && npx playwright install chromium && sudo npx playwright install-deps
node src/index.js --once          # verify all searches healthy
pm2 resurrect && pm2 status && pm2 save   # resurrect BEFORE save if daemon respawned empty!
sudo reboot                        # then verify: pm2 status / systemctl status pm2-ubuntu
```
**Lesson learned:** after `pm2 update`/Node upgrades the daemon can respawn empty —
if `pm2 restart` says "not found", run `pm2 resurrect` FIRST; only `pm2 save` once
the process list is correct (saving an empty list overwrites the good dump).

## Troubleshooting

- **⚠️ health alert** → `pm2 logs tender-alerts --lines 60 --nostream`; check
  `debug/<search>-post-auto.txt`. Healthy flags:
  `hdnSearch=1 | hdnSearch4=4 | hdnadvsearch=1 | hdnnoSearch=` (`hdnnoSearch=1` ⇒
  wrong button fired). Dept/sub-dept IDs listed above.
- **`Department/Sub-department "..." not found`** → `cat debug/<search>-selects.json`
  lists real dropdown options; copy exact text into config.js.
- **Withdrawn alerts not deleting** → bot must be group admin with "Delete
  messages"; alerts sent before msgId tracking are skipped.
- **Deep diagnosis** → `node src/index.js --once --debug` (headed browser, step
  screenshots, manual-Apply POST comparison).
- **Telegram 403** = bot removed from group; **400** = wrong chat id.
- **Server unreachable** → Oracle console (instance Running? IP changed?); act on
  any idle-reclamation email.
- **Memory** → `free -h` must show `Swap: 2.0Gi`.
- **seen.json corrupted/deleted** → fails safe: silent re-baseline, no flood.

## Known limitations (accepted)

- Corrigendums/amendments (same-ID in-place edits) don't re-alert — future
  enhancement: watch the corrigendum tab
- Alerts link to the portal home (portal forbids deep links)
- Auto-delete has ~45-min confirmation delay (3-check grace) by design

## File map (server: ~/ap-tender-alerts)

```
src/config.js     ← searches, schedule settings, feature flags, env
src/scraper.js    ← Playwright: single-session async generator, condition waits,
                    resource blocking, empty-detection, hard sub-dept fail
src/store.js      ← lifecycle dedup: tenders/retired/searches, message_ids, atomic writes
src/notifier.js   ← Telegram send (🔔/🔁) + deleteMessage
src/index.js      ← streaming orchestrator, adaptive scheduler, overlap guard,
                    timestamp-based health alerts, auto-delete
.env              ← token, chat id, schedule + feature tuning
data/seen.json    ← v2 lifecycle store
debug/            ← POST captures, screenshots, HTML dumps (safe to delete)
```

## Changelog

- **v1 (12 Jul 2026)** — Initial build: Playwright scraper (GVMC E.E.-Electrical +
  all-VMRDA), Telegram alerts, flat-array dedup. Debugging milestones:
  SessionTimeOut session flow, ad popup, More... handler replication
  (login_emudhra.js), duplicate id="searchTender" bug, DataTables #pagetable13
  parsing, Windows path fixes.
- **v1.1 (13 Jul 2026)** — Deployed to Oracle Cloud Hyderabad (Indian IP required);
  PM2 + systemd reboot survival verified by live reboot test.
- **v2 (14 Jul 2026)** — Lifecycle store (retire / 🔁 re-release / 365-day pruning /
  auto v1 migration). Four searches. Per-search silent baselines. Health ⚠️/✅
  alerts. Overlap guard. Atomic writes. pm2-logrotate. Auto-delete of withdrawn
  tenders' alerts.
- **v3 (14 Jul 2026)** — Performance rewrite: single browser+session per cycle,
  condition-based waits, resource blocking, one-round table parse. Adaptive
  scheduling (15/60 min). node-cron removed. Cycle ~4 min → ~60–90s.
- **v4 (25 Jul 2026)** — External-review improvements: streamed async-generator
  pipeline (alerts send while next search runs), instant empty-table detection,
  hard-fail on sub-department selection, dead JSON-listener removed,
  timestamp-based health durations, Telegram pause only between messages.
  Runtime upgraded: Node 20 → **24.18.0 LTS**, Playwright 1.45 → **1.61**, kernel
  updated; PM2 migrated; reboot recovery re-verified live. Measured cycle: **~15s**.
  Rejected on review (documented rationale): batched state writes (breaks crash-
  safety), hashed keys (breaks per-search sweep; parser guarantees numeric IDs),
  HTTP fast path (anti-tamper fragility).
