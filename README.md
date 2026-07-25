# AP Tender Alerts → Telegram — Varun's Ops Guide (v5)

Self-hosted bot that checks the AP eProcurement portal on an adaptive IST
schedule and pings the **"Tenders"** Telegram group when tenders are published,
**amended**, or withdrawn. Withdrawn tenders' alerts are deleted (or edited into
❌ tombstones when too old to delete) so the group tracks live tenders. Runs
24/7 on an Oracle Cloud Always Free VM (Hyderabad). Cost: ₹0/month.

**Current production state (verified 25 Jul 2026):** Node.js 24.18.0 LTS ·
Playwright 1.61 · kernel 6.17.0-1018-oracle · full 4-search cycle ≈ **15–17s** ·
pagination verified reading all pages · crash (PM2) and reboot (systemd)
recovery both proven by live tests.

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js 24 LTS (ES Modules) | Current LTS; single runtime |
| Browser automation | Playwright 1.61 (headless Chromium) | Portal is JS-rendered with session-flow + client-side crypto; a real browser is mandatory |
| Scheduler | Adaptive `setTimeout` loop, **IST via Intl** | OS-timezone-independent office-hours cadence |
| Pipeline | Async-generator streaming | Alerts send while the next search runs |
| Notifications | Telegram Bot API (native `fetch`, 15s timeouts, retries incl. 429 retry_after) | Send + edit + delete; a stalled call can never block the pipeline |
| State/dedup | JSON file (`data/seen.json` v3), atomic writes, corruption backup | Per-tender persistence = crash-safe alerts |
| Concurrency | In-process overlap guard + **PID lockfile** | Manual `--once` can't collide with the PM2 instance |
| Process manager | PM2 + systemd (`pm2-ubuntu`) + pm2-logrotate | Auto-restart, resurrect on reboot, bounded logs |
| Hosting | Oracle Always Free — VM.Standard.E2.1.Micro, Ubuntu 24.04, 2 GB swap, Hyderabad | ₹0 forever; **Indian IP required** (geo-restricted portal) |

> **Stack verdict (agreed by two external reviews):** Node + Playwright + JSON is
> optimal. Rejected with rationale: language rewrites (99% of cycle is portal
> latency + rendering), web frameworks (no HTTP served), raw-HTTP scraping
> (anti-tamper `temp()`/CSRF fragility), batched state writes (breaks crash
> safety), hashed tender keys (parser guarantees numeric IDs; would break
> per-search sweeps).

## Watched searches (src/config.js)

| id | Department | Sub-department |
|---|---|---|
| `gvmc-electrical` | Greater Visakhapatnam Municipal Corporation | E.E.- Electrical |
| `gvmc-it` | Greater Visakhapatnam Municipal Corporation | IT Department, GVMC |
| `vmrda` | Visakhapatnam Metropolitan Region Development Authority | Executive Engineer -VIII (Electrical), VMRDA |
| `aptransco-telecom` | APTRANSCO PRODUCTS | Superintending Engineer Telecommunication Circle, Visakhapatnam |

Whitespace-insensitive matching (exact > prefix > contains). **Sub-department
selection failure is a HARD search failure** — never a silent department-wide
search. Known IDs: GVMC=49 (Electrical=74, IT=5889), VMRDA=14 (EE-VIII=5520),
APTRANSCO=1766 (SE Telecom=1781).

## My values (quick reference)

| Item | Value |
|---|---|
| Telegram bot | `@ap_tender_alerts_bot` (group admin with Delete messages) |
| Bot token | `8550919760:AAEgdJFNaDL25Jl4_1jojxAmN4fS2c4ZVO8` — ⚠️ exposed in repo history; rotate via @BotFather |
| Telegram group | "Tenders", chat ID `-5341406269` |
| Server public IP | `140.245.246.22` (ephemeral) |
| SSH | `ssh -i C:\Users\varun\Downloads\tenders\files\ap-tender-alerts-v2\ap-tender-alerts\keys\private\ssh-key-2026-07-13.key ubuntu@140.245.246.22` |
| Project path (server) | `/home/ubuntu/ap-tender-alerts` |

## Alert types the group can receive

| Emoji | Meaning |
|---|---|
| 🔔 New Tender | First appearance of a tender ID |
| 🔁 Re-released Tender | A withdrawn tender's ID reappeared |
| 📝 Tender Updated | Same ID, changed details (closing date, value, notice no, title) — shows old → new |
| ❌ Withdrawn (edited tombstone) | Alert too old to delete; edited in place |
| ⚠️ / ✅ | Health warning after 6 consecutive failed checks (real elapsed duration) / recovery |
| *(deleted message)* | Withdrawn tender whose alert was <48h old |

## Search result states (v5 core semantics)

| Status | Meaning | Health | Baseline | Sweep/retire |
|---|---|---|---|---|
| `ok` | Rows parsed | healthy | yes | yes |
| `empty` | Portal explicitly says "No matching records" | healthy | **yes** (first real tender will alert!) | **yes** (emptied dept retires its last tenders) |
| `timeout` | Neither rows nor empty marker in 20s | UNHEALTHY | no | no — session force-reset |
| `error` | Scrape threw | UNHEALTHY | no | no — session force-reset |

## Lifecycle & cleanup

- New → 🔔 (message_id + sentAt + fingerprint stored)
- Absent 3 consecutive healthy scrapes → retired (`notify: pending`)
- Cleanup each cycle: **<47h old → delete; older/refused → edit to ❌ tombstone**;
  failures retry next cycle, give up after 5 attempts
- Retired ID reappears → 🔁 · fingerprint changes on live tender → 📝
- Retired entries pruned after 365 days; unhealthy scrapes never age anything

## How it works

```
adaptive IST schedule (Intl-computed; overlap guard + PID lockfile)
  └─ ONE browser + session per cycle (images/media/fonts blocked)
       login.html → portal's own More... handler (temp/tempName POST)
       for EACH search (streamed):
         Advancedsearch() → dept → getCircles AJAX → sub-dept (hard-fail)
           → advsearchBtn() directly (duplicate id="searchTender"!)
             → rows | explicit-empty | timeout(throw)
               → paginate ALL pages (pre-click first-row capture + Set dedup)
                 → yield → alerts/updates/cleanup while next search runs
```

## Daily operations (server bash; PowerShell only for ssh/scp)

```bash
pm2 status
pm2 logs tender-alerts [--lines 50 --nostream]
pm2 restart tender-alerts        # = immediate check
pm2 flush tender-alerts          # clear old log files (cosmetic)
```

- **Manual run while PM2 is active is now BLOCKED by the lockfile** — stop first:
  `pm2 stop tender-alerts && node src/index.js --once && pm2 start tender-alerts`
- **Debug on the server (headless-safe):** `node src/index.js --once --debug`
  → saves screenshots/dumps/POSTs to `debug/`
- **Visible browser (laptop only):** `--headed`
- Test alert: delete one entry inside `"tenders": {…}` in `data/seen.json`,
  restart, watch a 🔁 arrive
- Add a department: append to `SEARCHES` (unique id, exact dropdown text) →
  restart; first check baselines silently — even if the department is empty
- Push code: `scp -i keys\private\ssh-key-2026-07-13.key .\src\<file>.js
  ubuntu@140.245.246.22:~/ap-tender-alerts/src/` then restart

### Runtime upgrade pattern (last done 25 Jul 2026)
NodeSource setup_XX.x → `apt install nodejs` → `npm i -g pm2 && pm2 update` →
`npm install && npx playwright install chromium && sudo npx playwright
install-deps` → **stop PM2, `node src/index.js --once` to verify, restart** →
if `pm2 restart` says "not found": `pm2 resurrect` FIRST, only then `pm2 save`
→ reboot and re-verify `pm2 status` + `systemctl status pm2-ubuntu`.

## Troubleshooting

- **⚠️ health alert** → `pm2 logs … --nostream`; check `debug/<id>-post-auto.txt`
  (healthy: `hdnSearch=1|hdnSearch4=4|hdnadvsearch=1|hdnnoSearch=`;
  `hdnnoSearch=1` ⇒ wrong button). Dept IDs table above.
- **`Department/Sub-department not found`** → `cat debug/<id>-selects.json`,
  copy exact text into config.js. Sub-dept failures now fail the search (by design).
- **Old error-log noise after deploys** → historic lines; `pm2 flush tender-alerts`.
- **"Another instance holds bot.lock"** → PM2 is running; stop it for manual runs.
  Stale locks (dead PID) are reclaimed automatically.
- **State corruption** → auto-backed-up as `seen.json.corrupt-<ts>`, fresh start,
  one-time ⚠️ sent to the group (silent re-baseline; a few alerts may be missed once).
- **Config typos** (NaN intervals, bad hours, bad chat id, duplicate search ids)
  → refuses to start with named errors.
- Telegram 403 = bot removed from group; 400 = wrong chat id. Memory: `free -h`
  must show `Swap: 2.0Gi`. Server unreachable → Oracle console (IP is ephemeral).

## Known limitations (accepted)

- 📝 detection covers list-view fields (closing date, value, notice no, title);
  document-level corrigendum contents are not read
- Alerts link to the portal home (deep links forbidden by the portal)
- Withdrawal cleanup has the 3-check (~45 min) confirmation grace by design
- No automated test suite yet (`node:test` fixtures — planned follow-up)

## File map

```
src/config.js    searches, schedule, flags, HARD validation (NaN/hours/dupes)
src/scraper.js   single-session async generator; fixed pagination; rows/empty/
                 timeout states; --debug headless vs --headed; resource blocking
src/store.js     v3 store: tenders{fp,msgId,sentAt} / retired{notify,attempts} /
                 searches; atomic writes; corruption backup + warning
src/notifier.js  fetch timeouts+retries(429/5xx); send/edit/delete; 🔔🔁📝❌ formats
src/index.js     streaming orchestrator; 4-state handling; amendments; delete-or-
                 edit retry; IST-Intl scheduler; PID lockfile; health alerts
```

## Changelog

- **v1 (12 Jul)** Initial scraper + alerts. Milestones: SessionTimeOut flow, ad
  popup, More... handler replication, duplicate id="searchTender", #pagetable13.
- **v1.1 (13 Jul)** Oracle Hyderabad deploy; PM2+systemd reboot survival verified.
- **v2 (14 Jul)** Lifecycle store (retire/🔁), 4 searches, per-search baselines,
  health ⚠️/✅, overlap guard, atomic writes, logrotate, withdrawn-alert deletion.
- **v3 (14 Jul)** Performance: single session/cycle, condition waits, resource
  blocking, adaptive 15/60-min schedule. ~4 min → ~60–90s.
- **v4 (25 Jul)** Review round 1: streamed pipeline, empty-detection, hard
  sub-dept fail, dead-code removal, timestamped health, pause-between-only.
  Node 24 + Playwright 1.61 + kernel upgrade; ~15s cycles.
- **v5 (25 Jul)** Review round 2 — correctness release:
  **pagination bug fixed** (pre-click first-row capture; was silently reading
  only page 1 and false-retiring page-2+ tenders); **rows/empty/timeout
  separated** (empty = healthy: baselines AND sweeps — fixes silent first-tender
  swallow on empty new searches and never-retiring emptied departments);
  `waitForFunction` arg-order fixed; **delete-or-edit withdrawal cleanup**
  (48h-safe, ❌ tombstones) with **pending-state retries**; Telegram timeouts +
  retries; **📝 amendment detection** via fingerprints; IST-explicit scheduling;
  PID process lock; corrupt-state backup + group warning; hard config
  validation; `--debug`(headless)/`--headed` split. Verified live: 15 tenders
  from paginated GVMC (was 10), APTRANSCO "confirmed empty" healthy path.
