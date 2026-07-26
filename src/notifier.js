import { CONFIG, assertConfig } from './config.js';

/**
 * Telegram notifier v3.
 *  - 15s timeout + retries (network / 5xx / 429 with retry_after)
 *  - Structured TelegramError (error_code, description, parameters)
 *  - isAlreadyCompleted(): treats "message to delete not found" and
 *    "message is not modified" as idempotent SUCCESS during cleanup
 *  - All outgoing text is clamped under Telegram's 4096-char limit
 */

const API_BASE = () => `https://api.telegram.org/bot${CONFIG.telegramBotToken}`;
const SAFE_LIMIT = 3900; // headroom under Telegram's 4096 post-parse limit

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramError extends Error {
  constructor(method, response, status) {
    super(response?.description || `${method} failed (HTTP ${status})`);
    this.name = 'TelegramError';
    this.method = method;
    this.status = status;
    this.errorCode = response?.error_code;
    this.description = response?.description || '';
    this.parameters = response?.parameters;
  }
}

/** Outcome already exists on Telegram's side — count cleanup as done. */
export function isAlreadyCompleted(error) {
  const d = (error?.description || error?.message || '').toLowerCase();
  return (
    d.includes('message to delete not found') ||
    d.includes('message is not modified') ||
    d.includes("message can't be found")
  );
}

async function tgCall(method, payload, { retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE()}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (body?.ok) return body;

      const err = new TelegramError(method, body, res.status);
      if (res.status === 429 && attempt < retries) {
        await pause((body?.parameters?.retry_after ?? 3) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await pause(1500 * (attempt + 1));
        continue;
      }
      throw err; // 4xx (non-429): permanent
    } catch (e) {
      lastError = e;
      if (e instanceof TelegramError) throw e;
      const transient =
        e.name === 'TimeoutError' || e.name === 'AbortError' ||
        e.code === 'ECONNRESET' || e.message?.includes('fetch failed');
      if (transient && attempt < retries) {
        await pause(1500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// ---------------- formatting ----------------

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function truncate(value, max = 500) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function clampMessage(text) {
  if (text.length <= SAFE_LIMIT) return text;
  // Emergency fallback only (formatters already truncate fields, so this is
  // near-unreachable). Arbitrary slicing could cut through <b>…</b> or an
  // &entity; and make Telegram reject the send — so strip ALL tags first,
  // slice the plain text, and re-escape. Ugly but always deliverable.
  const plain = text.replace(/<[^>]*>/g, '');
  return esc(plain.slice(0, SAFE_LIMIT - 30)) + '\n\n…message truncated';
}

export function formatTenderMessage(t, searchLabel, reReleased = false, updatedNote = null) {
  const heading = reReleased
    ? `🔁 <b>Re-released Tender — ${esc(searchLabel)}</b>`
    : `🔔 <b>New Tender — ${esc(searchLabel)}</b>`;
  const lines = [heading, '', `<b>${esc(truncate(t.title, 600))}</b>`];
  if (t.tenderId) lines.push(`🆔 Tender ID: <code>${esc(t.tenderId)}</code>`);
  if (t.noticeNumber) lines.push(`📄 Notice No: ${esc(truncate(t.noticeNumber, 200))}`);
  if (t.category) lines.push(`🏷 Category: ${esc(truncate(t.category, 100))}`);
  if (t.department) lines.push(`🏛 Dept: ${esc(truncate(t.department, 200))}`);
  if (t.publishedDate) lines.push(`📅 Published: ${esc(t.publishedDate)}`);
  if (t.closingDate) lines.push(`⏰ Closing: <b>${esc(t.closingDate)}</b>`);
  if (t.value) lines.push(`💰 Value: ${esc(truncate(t.value, 100))}`);
  if (t.emd) lines.push(`🏦 EMD: ${esc(truncate(t.emd, 100))}`);
  if (updatedNote) lines.push('', `✏️ <i>${esc(updatedNote)}</i>`);
  lines.push('', `🔗 https://tender.apeprocurement.gov.in/TenderDetailsHome.html`);
  return clampMessage(lines.join('\n'));
}

export function formatUpdateMessage(t, searchLabel, changes) {
  const lines = [
    `📝 <b>Tender Updated — ${esc(searchLabel)}</b>`,
    '',
    `<b>${esc(truncate(t.title, 400))}</b>`,
    `🆔 Tender ID: <code>${esc(t.tenderId)}</code>`,
  ];
  const shown = changes.slice(0, 6); // bounded: worst case stays under the limit
  for (const c of shown) {
    lines.push(
      `• ${esc(c.field)}: <s>${esc(truncate(c.from ?? '—', 200))}</s> → ` +
        `<b>${esc(truncate(c.to ?? '—', 200))}</b>`
    );
  }
  if (changes.length > shown.length) {
    lines.push(`• …and ${changes.length - shown.length} more change(s)`);
  }
  lines.push('', `🔗 https://tender.apeprocurement.gov.in/TenderDetailsHome.html`);
  return clampMessage(lines.join('\n'));
}

export function formatWithdrawnTombstone(tenderId, searchLabel, title = null) {
  const lines = [
    `❌ <b>Withdrawn / Closed Tender — ${esc(searchLabel)}</b>`,
    '',
  ];
  if (title) lines.push(`<b>${esc(truncate(title, 400))}</b>`);
  lines.push(
    `🆔 Tender ID: <code>${esc(tenderId)}</code>`,
    `This tender is no longer listed by the department.`
  );
  return clampMessage(lines.join('\n'));
}

// ---------------- API operations ----------------

export async function sendTelegram(text) {
  return tgCall('sendMessage', {
    chat_id: CONFIG.telegramChatId,
    text: clampMessage(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

export async function deleteTelegramMessage(messageId) {
  return tgCall('deleteMessage', {
    chat_id: CONFIG.telegramChatId,
    message_id: messageId,
  }, { retries: 1 });
}

export async function editTelegramMessage(messageId, text) {
  return tgCall('editMessageText', {
    chat_id: CONFIG.telegramChatId,
    message_id: messageId,
    text: clampMessage(text),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }, { retries: 1 });
}

if (process.argv.includes('--test-telegram-send')) {
  assertConfig();
  sendTelegram('✅ <b>AP Tender Alerts</b> is connected to this group. Test successful!')
    .then(() => console.log('Test message sent. Check your group!'))
    .catch((e) => {
      console.error('Failed:', e.message);
      process.exitCode = 1;
    });
}
if (process.argv.includes('--test')) {
  // legacy alias used by npm run test-telegram
  assertConfig();
  sendTelegram('✅ <b>AP Tender Alerts</b> is connected to this group. Test successful!')
    .then(() => console.log('Test message sent. Check your group!'))
    .catch((e) => {
      console.error('Failed:', e.message);
      process.exitCode = 1;
    });
}
