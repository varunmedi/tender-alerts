# AP Tender Alerts → Telegram — Varun's Ops Guide (v2)

Self-hosted bot that checks the AP eProcurement portal every 45 minutes and pings
the **"Tenders"** Telegram group when new tenders appear. Runs 24/7 on an Oracle
Cloud Always Free VM (Hyderabad). Cost: ₹0/month.

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js 20 LTS (ES Modules) | Single runtime for scraping + notifications |
| Browser automation | Playwright (headless Chromium) | Portal is JS-rendered with session-flow protection; a real browser is required |
| Scheduler | node-cron (in-process, 45-min cycle) | Simple, no external cron dependency |
| Notifications | Telegram Bot API (plain HTTPS `fetch`, no SDK) | Free, unlimited group messages, official API |
| State/dedup | JSON file (`data/seen.json`), atomic writes | Tiny data volume; no database needed |
| Config/secrets | dotenv (`.env`) | Token/chat-id kept out of code |
| Process manager | PM2 + systemd (`pm2-ubuntu`) + pm2-logrotate | Auto-restart on crash, resurrect on reboot, bounded logs |
| Hosting | Oracle Cloud Always Free — VM.Standard.E2.1.Micro, Ubuntu 24.04, 2 GB swap, Hyderabad region | ₹0 forever; **Indian IP required** (portal is geo-restricted) |
| Dev/debug tooling | Built-in: POST-body capture, step screenshots, HTML dumps, headed debug mode | Portal changes become a diff, not a mystery |

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
| getUpdates URL | `https://api.telegram.org/bot<TOKEN>/getUpdates` |
| Server public IP | `140.245.246.22` (ephemeral — may change on stop/start) |
| SSH | `ssh -i C:\Users\varun\Downloads\tenders\files\ap-tender-alerts-v2\ap-tender-alerts\keys\private\ssh-key-2026-07-13.key ubuntu@140.245.246.22` |
| Project path (server) | `/home/ubuntu/ap-tender-alerts` |
| Poll interval | 45 min (`POLL_INTERVAL_MINUTES` in `.env`) |

> ⚠️ The bot token is a secret (rotate via @BotFather `/revoke` if exposed; then
> update `.env` on the server and `pm2 restart tender-alerts`). The SSH private
> key is unrecoverable — keep a backup copy.

## How it works (final architecture)

```
every 45 min (overlap-guarded; PM2 keeps it alive; systemd survives reboots)
  └─ Playwright opens login.html (session cookie minted here)
       └─ executes the portal's own "More..." handler directly:
            loginForm.hdnType="current"; temp(tempName,'loginForm');
            POST → TenderDetailsHome.html          (session-flow REQUIRED)
              └─ clicks "Advanced Search" → dropdowns appear
                   └─ Department (exact-match first) → getCircles() AJAX
                      loads sub-departments → select sub-department
                        └─ invokes advsearchBtn() DIRECTLY (Apply & Search
                           share duplicate id="searchTender"!) → form POST
                             └─ parses #pagetable13 (DataTables) + pagination
                                  └─ lifecycle store (data/seen.json)
                                       └─ new/re-released → Telegram group
```

### Tender lifecycle (v2 store — re-release handling)
- **New tender** → 🔔 alert → recorded in `tenders`
- **Absent from 3 consecutive successful scrapes** (~2¼ h grace) → moved to
  `retired` (withdrawn/closed); logged as `[store] retired …`
- **Reappears while retired** → alerts again as **🔁 Re-released Tender**
- Retired entries pruned after 365 days
- Failed/empty scrapes NEVER age entries (no false re-alerts from hiccups)
- Tune: `MISSING_LIMIT` in `src/store.js` (3 checks ≈ 2¼ h; 6 ≈ 4½ h)

### Per-search silent baseline
Each search's FIRST successful check records existing tenders silently.
Adding a new department to config never floods the group.

### Self-monitoring (health alerts to the group itself)
- 6 consecutive unhealthy checks for a search (error OR 0 tenders ≈ 4½ h)
  → one ⚠️ warning message with the error detail
- Next healthy check → ✅ recovery message
- Counters reset on restart (restart triggers an immediate check anyway)

### Reliability hardening
- **Overlap guard**: a long-running cycle makes the next tick skip (prevents
  two Chromiums on the 1 GB server)
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
`nano ~/ap-tender-alerts/src/config.js` → append to `SEARCHES` with a unique
`id` and the portal's exact dropdown texts → `pm2 restart tender-alerts`.
Its first check baselines silently.

### Push code changes from the laptop
```powershell
cd C:\Users\varun\Downloads\tenders\files\ap-tender-alerts-v2\ap-tender-alerts
scp -i keys\private\ssh-key-2026-07-13.key .\src\<file>.js ubuntu@140.245.246.22:~/ap-tender-alerts/src/
```
then `pm2 restart tender-alerts` on the server.

## Troubleshooting

- **⚠️ health alert arrived** → `pm2 logs tender-alerts --lines 60 --nostream`.
  Check `debug/<search>-post-auto.txt`; healthy flags:
  `hdnSearch=1 | hdnSearch4=4 | hdnadvsearch=1 | hdnnoSearch=` with
  `nDepartmentID=49` (GVMC) / `14` (VMRDA), `subDeptId=74` (E.E.- Electrical).
  `hdnnoSearch=1` ⇒ wrong button fired.
- **`Department "..." not found`** → `cat debug/<search>-selects.json` lists
  every dropdown option; copy the exact text into config.js.
- **Deep diagnosis** → `node src/index.js --once --debug` (headed browser,
  step screenshots 00–06, waits for a MANUAL Apply click to compare POSTs).
  Copy artifacts: `scp -i <key> ubuntu@140.245.246.22:~/ap-tender-alerts/debug/* .`
- **Telegram 403** = bot removed from group; **400 chat not found** = wrong chat id.
- **Server unreachable** → Oracle console: instance Running? IP changed after a
  stop/start? Act on any idle-reclamation email from Oracle.
- **Memory** → `free -h` must show `Swap: 2.0Gi` (`sudo swapon /swapfile`).
- **seen.json corrupted/deleted** → fails safe: all searches silently re-baseline
  (a few hours of missed alerts at worst, no flood).

## Known limitations (accepted)

- **Corrigendums/amendments don't re-alert** (same ID, edited in place — e.g.
  extended closing date). Future enhancement: watch the corrigendum tab.
- **Alerts link to the portal home**, not the tender (portal forbids deep links).
- A genuinely empty department triggers ONE ⚠️ after ~4½ h (informative, not noise).

## File map (server: ~/ap-tender-alerts)

```
src/config.js     ← the four searches, URLs, env config
src/scraper.js    ← Playwright automation (session flow, advsearchBtn, #pagetable13)
src/store.js      ← lifecycle dedup: tenders / retired / searches (atomic writes)
src/notifier.js   ← Telegram sender (🔔 new / 🔁 re-released formatting)
src/index.js      ← orchestrator, 45-min scheduler, overlap guard, health alerts
.env              ← TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, POLL_INTERVAL_MINUTES
data/seen.json    ← v2 lifecycle store
debug/            ← POST captures, screenshots, HTML dumps (safe to delete)
```

## Changelog

- **v1 (12 Jul 2026)** — Initial build: Playwright scraper (GVMC E.E.-Electrical
  + all-VMRDA), Telegram alerts, flat-array dedup, first-run silent baseline.
  Debugging milestones: SessionTimeOut session flow, ad popup, More... handler
  replication (login_emudhra.js), duplicate id="searchTender" bug, DataTables
  #pagetable13 parsing, Windows path fixes.
- **v1.1 (13 Jul 2026)** — Deployed to Oracle Cloud Hyderabad (Indian IP
  required); PM2 + systemd reboot survival verified by live reboot test.
- **v2 (14 Jul 2026)** — Tender lifecycle store (retire after 3 missed checks;
  🔁 re-release alerts; 365-day pruning; automatic v1 migration). Four searches
  (added GVMC IT + APTRANSCO Telecom; VMRDA narrowed to EE-VIII Electrical).
  Per-search silent baselines. Self-monitoring ⚠️/✅ health alerts to the group.
  Overlap guard. Atomic seen.json writes. pm2-logrotate.
