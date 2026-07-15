import 'dotenv/config';
import { fileURLToPath } from 'url';

/**
 * The two searches you asked for. Each entry is one Advanced Search
 * run on the AP eProcurement portal.
 *
 * `department` / `subDepartment` must match the visible text in the
 * portal's dropdowns EXACTLY (copy-paste from the site if a search
 * returns nothing). `subDepartment: null` means "leave it as All".
 */
export const SEARCHES = [
  {
    id: 'gvmc-electrical',
    label: 'GVMC — E.E. Electrical',
    department: 'Greater Visakhapatnam Municipal Corporation',
    subDepartment: 'E.E.- Electrical',
  },
  {
    id: 'gvmc-it',
    label: 'GVMC — IT Department',
    department: 'Greater Visakhapatnam Municipal Corporation',
    subDepartment: 'IT Department, GVMC',
  },
  {
    // Kept id 'vmrda' so already-alerted EE-VIII tenders are not re-announced.
    // Tenders from OTHER VMRDA sub-departments will retire naturally via the
    // missing-sweep since they no longer appear in this filtered search.
    id: 'vmrda',
    label: 'VMRDA — EE-VIII (Electrical)',
    department: 'Visakhapatnam Metropolitan Region Development Authority',
    subDepartment: 'Executive Engineer -VIII (Electrical),VMRDA, Visakhapatnam',
  },
  {
    id: 'aptransco-telecom',
    label: 'APTRANSCO — SE Telecom Circle Visakhapatnam',
    department: 'APTRANSCO PRODUCTS',
    subDepartment: 'Superintending Engineer Telecommunication Circle, APTRANSCO Visakhapatnam-P',
  },
];

export const PORTAL_URL =
  'https://tender.apeprocurement.gov.in/TenderDetailsHome.html';

/** Landing page visited FIRST to establish a session — the portal
 *  redirects deep links to SessionTimeOut.jsp without this. */
export const HOME_URL = 'https://tender.apeprocurement.gov.in/login.html';

export const CONFIG = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  // ---- adaptive scheduling ----
  // Office hours (Mon–Sat, IST — server timezone is Asia/Kolkata): check
  // every ACTIVE_INTERVAL_MINUTES. Nights & Sundays: QUIET_INTERVAL_MINUTES.
  // Departments publish tenders during working hours, so this gives 3×
  // faster detection when it matters while REDUCING total portal load.
  activeStartHour: parseInt(process.env.ACTIVE_START_HOUR || '9', 10),
  activeEndHour: parseInt(process.env.ACTIVE_END_HOUR || '19', 10),
  activeIntervalMin: parseInt(process.env.ACTIVE_INTERVAL_MINUTES || '15', 10),
  quietIntervalMin: parseInt(process.env.QUIET_INTERVAL_MINUTES || '60', 10),
  // Legacy fallback (used if ADAPTIVE_SCHEDULE=0 in .env)
  adaptiveSchedule: process.env.ADAPTIVE_SCHEDULE !== '0',
  pollIntervalMinutes: parseInt(process.env.POLL_INTERVAL_MINUTES || '45', 10),
  // --debug flag works on Windows/Mac/Linux; env var kept for compatibility
  debug: process.env.DEBUG_SCRAPER === '1' || process.argv.includes('--debug'),
  // When a tender is withdrawn from the portal (retired after 3 missed
  // checks), delete its alert message from the Telegram group so the group
  // only shows live tenders. Set DELETE_WITHDRAWN_ALERTS=0 in .env to keep
  // old alerts instead. NOTE: deleting messages older than 48h requires the
  // bot to be a GROUP ADMIN with the "Delete messages" permission.
  deleteWithdrawnAlerts: process.env.DELETE_WITHDRAWN_ALERTS !== '0',
  seenStorePath: fileURLToPath(new URL('../data/seen.json', import.meta.url)),
  debugDir: fileURLToPath(new URL('../debug/', import.meta.url)),
  // Playwright timeouts (ms). The portal can be slow — be generous.
  navTimeout: 60_000,
  actionTimeout: 20_000,
};

export function assertConfig() {
  const missing = [];
  if (!CONFIG.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!CONFIG.telegramChatId) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) {
    console.error(
      `Missing required env vars: ${missing.join(', ')}.\n` +
        'Copy .env.example to .env and fill them in.'
    );
    process.exit(1);
  }
}
