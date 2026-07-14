import { CONFIG, assertConfig } from './config.js';

/**
 * Sends messages to your Telegram group via the official Bot API.
 * Free, unlimited for this use case, no library needed — plain HTTPS.
 */

const API = () =>
  `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;

/** Escape the characters Telegram's HTML parse mode cares about. */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatTenderMessage(t, searchLabel, reReleased = false) {
  const heading = reReleased
    ? `🔁 <b>Re-released Tender — ${esc(searchLabel)}</b>`
    : `🔔 <b>New Tender — ${esc(searchLabel)}</b>`;
  const lines = [
    heading,
    '',
    `<b>${esc(t.title)}</b>`,
  ];
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

export async function sendTelegram(text) {
  const res = await fetch(API(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CONFIG.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const body = await res.json();
  if (!body.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(body)}`);
  }
  return body;
}

/** Small delay helper so we respect Telegram's ~20 msg/min group limit. */
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CLI test mode: `npm run test-telegram` ----
if (process.argv.includes('--test')) {
  assertConfig();
  sendTelegram(
    '✅ <b>AP Tender Alerts</b> is connected to this group. Test successful!'
  )
    .then(() => {
      console.log('Test message sent successfully. Check your group!');
    })
    .catch((e) => {
      console.error('Failed:', e.message);
      process.exit(1);
    });
}
