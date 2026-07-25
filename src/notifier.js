import { CONFIG, assertConfig } from './config.js';

/**
 * Telegram notifier.
 * All API calls have a 15s timeout (AbortSignal.timeout) and up to 2 retries
 * for network failures, HTTP 5xx, and 429 (honouring retry_after) — a stalled
 * Telegram connection must never block the scraping pipeline.
 */

const API_BASE = () => `https://api.telegram.org/bot${CONFIG.telegramBotToken}`;

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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

      // 429: respect Telegram's requested wait, then retry
      if (res.status === 429 && attempt < retries) {
        const wait = (body?.parameters?.retry_after ?? 3) * 1000;
        await pause(wait);
        continue;
      }
      // 5xx: transient server error — brief backoff, retry
      if (res.status >= 500 && attempt < retries) {
        await pause(1500 * (attempt + 1));
        continue;
      }
      // 4xx (other than 429): permanent — do not retry
      throw new Error(`${method} failed: ${JSON.stringify(body ?? { status: res.status })}`);
    } catch (e) {
      lastError = e;
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

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------- message formats ----------------

export function formatTenderMessage(t, searchLabel, reReleased = false) {
  const heading = reReleased
    ? `🔁 <b>Re-released Tender — ${esc(searchLabel)}</b>`
    : `🔔 <b>New Tender — ${esc(searchLabel)}</b>`;
  const lines = [heading, '', `<b>${esc(t.title)}</b>`];
  if (t.tenderId) lines.push(`🆔 Tender ID: <code>${esc(t.tenderId)}</code>`);
  if (t.noticeNumber) lines.push(`📄 Notice No: ${esc(t.noticeNumber)}`);
  if (t.category) lines.push(`🏷 Category: ${esc(t.category)}`);
  if (t.department) lines.push(`🏛 Dept: ${esc(t.department)}`);
  if (t.publishedDate) lines.push(`📅 Published: ${esc(t.publishedDate)}`);
  if (t.closingDate) lines.push(`⏰ Closing: <b>${esc(t.closingDate)}</b>`);
  if (t.value) lines.push(`💰 Value: ${esc(t.value)}`);
  if (t.emd) lines.push(`🏦 EMD: ${esc(t.emd)}`);
  lines.push('', `🔗 https://tender.apeprocurement.gov.in/TenderDetailsHome.html`);
  return lines.join('\n');
}

/** Amendment notification (same tender ID, changed details). */
export function formatUpdateMessage(t, searchLabel, changes) {
  const lines = [
    `📝 <b>Tender Updated — ${esc(searchLabel)}</b>`,
    '',
    `<b>${esc(t.title)}</b>`,
    `🆔 Tender ID: <code>${esc(t.tenderId)}</code>`,
  ];
  for (const c of changes) {
    lines.push(`• ${esc(c.field)}: <s>${esc(c.from ?? '—')}</s> → <b>${esc(c.to ?? '—')}</b>`);
  }
  lines.push('', `🔗 https://tender.apeprocurement.gov.in/TenderDetailsHome.html`);
  return lines.join('\n');
}

/** Tombstone text for withdrawn alerts too old to delete. */
export function formatWithdrawnTombstone(tenderId, searchLabel) {
  return (
    `❌ <b>Withdrawn / Closed Tender — ${esc(searchLabel)}</b>\n\n` +
    `🆔 Tender ID: <code>${esc(tenderId)}</code>\n` +
    `This tender is no longer listed by the department.`
  );
}

// ---------------- API operations ----------------

export async function sendTelegram(text) {
  return tgCall('sendMessage', {
    chat_id: CONFIG.telegramChatId,
    text,
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
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }, { retries: 1 });
}

// ---- CLI test mode: `npm run test-telegram` ----
if (process.argv.includes('--test')) {
  assertConfig();
  sendTelegram('✅ <b>AP Tender Alerts</b> is connected to this group. Test successful!')
    .then(() => console.log('Test message sent successfully. Check your group!'))
    .catch((e) => {
      console.error('Failed:', e.message);
      process.exit(1);
    });
}
