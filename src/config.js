import 'dotenv/config';

// Strict integer env parsing (#12): parseInt('15minutes') === 15 would
// silently pass — require the WHOLE value to be digits.
const envErrors = [];
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw.trim())) {
    envErrors.push(`${name}="${raw}" is not a valid integer`);
    return NaN;
  }
  return parseInt(raw.trim(), 10);
}
export function getEnvErrors() {
  return envErrors;
}
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
    deptId: '49',
    subDeptId: '74',
  },
  {
    id: 'gvmc-it',
    label: 'GVMC — IT Department',
    department: 'Greater Visakhapatnam Municipal Corporation',
    subDepartment: 'IT Department, GVMC',
    deptId: '49',
    subDeptId: '5889',
  },
  {
    // Kept id 'vmrda' so already-alerted EE-VIII tenders are not re-announced.
    // Tenders from OTHER VMRDA sub-departments will retire naturally via the
    // missing-sweep since they no longer appear in this filtered search.
    id: 'vmrda',
    label: 'VMRDA — EE-VIII (Electrical)',
    department: 'Visakhapatnam Metropolitan Region Development Authority',
    subDepartment: 'Executive Engineer -VIII (Electrical),VMRDA, Visakhapatnam',
    deptId: '14',
    subDeptId: '5520',
  },
  {
    id: 'aptransco-telecom',
    label: 'APTRANSCO — SE Telecom Circle Visakhapatnam',
    department: 'APTRANSCO PRODUCTS',
    subDepartment: 'Superintending Engineer Telecommunication Circle, APTRANSCO Visakhapatnam-P',
    deptId: '1766',
    subDeptId: '1781',
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
  activeStartHour: envInt('ACTIVE_START_HOUR', 9),
  activeEndHour: envInt('ACTIVE_END_HOUR', 19),
  activeIntervalMin: envInt('ACTIVE_INTERVAL_MINUTES', 15),
  quietIntervalMin: envInt('QUIET_INTERVAL_MINUTES', 60),
  // Legacy fallback (used if ADAPTIVE_SCHEDULE=0 in .env)
  adaptiveSchedule: process.env.ADAPTIVE_SCHEDULE !== '0',
  pollIntervalMinutes: envInt('POLL_INTERVAL_MINUTES', 45),
  // --debug flag works on Windows/Mac/Linux; env var kept for compatibility
  // --debug: extra artifacts (screenshots/dumps), still headless — server-safe.
  // --headed: visible browser window — laptop/desktop only.
  debug: process.env.DEBUG_SCRAPER === '1' || process.argv.includes('--debug') || process.argv.includes('--headed'),
  headed: process.argv.includes('--headed'),
  // When a tender is withdrawn from the portal (retired after 3 missed
  // checks), delete its alert message from the Telegram group so the group
  // only shows live tenders. Set DELETE_WITHDRAWN_ALERTS=0 in .env to keep
  // old alerts instead. NOTE: deleting messages older than 48h requires the
  // bot to be a GROUP ADMIN with the "Delete messages" permission.
  deleteWithdrawnAlerts: process.env.DELETE_WITHDRAWN_ALERTS !== '0',
  seenStorePath:
    process.env.SEEN_STORE_PATH ||
    fileURLToPath(new URL('../data/seen.json', import.meta.url)),
  debugDir: fileURLToPath(new URL('../debug/', import.meta.url)),
  // Playwright timeouts (ms). The portal can be slow — be generous.
  navTimeout: 60_000,
  actionTimeout: 20_000,
};

export function assertConfig() {
  const errors = [...envErrors];
  if (!CONFIG.telegramBotToken) errors.push('TELEGRAM_BOT_TOKEN is missing');
  if (!CONFIG.telegramChatId) errors.push('TELEGRAM_CHAT_ID is missing');
  else if (!/^-?\d+$/.test(String(CONFIG.telegramChatId))) {
    errors.push(`TELEGRAM_CHAT_ID "${CONFIG.telegramChatId}" is not a numeric chat id`);
  }

  // Numeric env values: a typo producing NaN would make setTimeout(NaN)
  // fire immediately → rapid polling loop. Validate hard.
  const nums = {
    activeStartHour: [CONFIG.activeStartHour, 0, 23],
    activeEndHour: [CONFIG.activeEndHour, 1, 24],
    activeIntervalMin: [CONFIG.activeIntervalMin, 10, 1440],
    quietIntervalMin: [CONFIG.quietIntervalMin, 10, 1440],
    pollIntervalMinutes: [CONFIG.pollIntervalMinutes, 10, 1440],
  };
  for (const [name, [val, min, max]] of Object.entries(nums)) {
    if (!Number.isInteger(val) || val < min || val > max) {
      errors.push(`${name}=${val} is invalid (expected integer ${min}–${max})`);
    }
  }
  if (Number.isInteger(CONFIG.activeStartHour) && Number.isInteger(CONFIG.activeEndHour) &&
      CONFIG.activeStartHour >= CONFIG.activeEndHour) {
    errors.push('ACTIVE_START_HOUR must be earlier than ACTIVE_END_HOUR');
  }

  // Searches: unique ids, required fields
  const ids = new Set();
  for (const s of SEARCHES) {
    if (!s.id || !s.label || !s.department) {
      errors.push(`search entry ${JSON.stringify(s.id)} is missing id/label/department`);
    }
    if (ids.has(s.id)) errors.push(`duplicate search id "${s.id}"`);
    ids.add(s.id);
  }

  if (errors.length) {
    console.error('Configuration errors:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
}
