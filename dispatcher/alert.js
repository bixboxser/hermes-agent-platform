const axios = require('axios');
const { query } = require('../db');

const lastAlertAt = new Map();
const ALERT_INTERVAL_MS = 5 * 60 * 1000;

function sanitize(payload = {}) {
  const out = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (/token|key|secret|password/i.test(k)) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  }
  return out;
}

async function triggerAlert(type, payload = {}) {
  const now = Date.now();
  const last = lastAlertAt.get(type) || 0;
  if (now - last < ALERT_INTERVAL_MS) return { skipped: true, reason: 'rate_limited' };
  lastAlertAt.set(type, now);

  const safePayload = sanitize(payload);
  await query(
    `insert into hermes_action_logs (task_id, action_name, input, output, status)
     values ($1,$2,$3,$4,$5)`,
    [safePayload.task_id || null, 'alert', { type }, safePayload, 'alerted'],
  );

  if (process.env.TELEGRAM_TOKEN && process.env.OWNER_CHAT_ID) {
    const text = `⚠️ Hermes Alert: ${type}\n${JSON.stringify(safePayload).slice(0, 1200)}`;
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: process.env.OWNER_CHAT_ID,
      text,
    });
  }

  return { sent: true };
}

module.exports = { triggerAlert };
