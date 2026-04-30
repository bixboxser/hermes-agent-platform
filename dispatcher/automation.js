const axios = require('axios');
const { query } = require('../db');

const ALLOWED = new Set(['notify_if_failed_tasks', 'notify_if_stuck_tasks', 'run_daily_report', 'simple_webhook_call']);

function validateConfig(config = {}) {
  if (!ALLOWED.has(config.action)) throw new Error('invalid_action');
  if (config.action === 'simple_webhook_call' && !config.webhook_url) throw new Error('missing_webhook_url');
}

async function executeAutomation(config = {}) {
  validateConfig(config);
  const dryRun = config.dry_run === true;
  let sideEffectCount = 0;

  const runner = async () => {
    if (config.action === 'notify_if_failed_tasks') {
      const r = await query(`select count(*)::int as c from hermes_tasks where status='failed' and updated_at > now() - interval '1 hour'`);
      if (!dryRun && Number(r.rows[0]?.c || 0) > 0 && process.env.TELEGRAM_TOKEN && process.env.OWNER_CHAT_ID && sideEffectCount < 1) {
        sideEffectCount += 1;
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, { chat_id: process.env.OWNER_CHAT_ID, text: `Hermes: failed tasks last hour=${r.rows[0].c}` });
      }
      return { action: config.action, failed_count: Number(r.rows[0]?.c || 0), dry_run: dryRun };
    }

    if (config.action === 'notify_if_stuck_tasks') {
      const r = await query(`select count(*)::int as c from hermes_tasks where status='running' and heartbeat_at < now() - interval '10 minutes'`);
      return { action: config.action, stuck_count: Number(r.rows[0]?.c || 0), dry_run: dryRun };
    }

    if (config.action === 'run_daily_report') {
      const r = await query(`select count(*)::int as c from hermes_tasks where created_at > now() - interval '1 day'`);
      return { action: config.action, daily_tasks: Number(r.rows[0]?.c || 0), dry_run: dryRun };
    }

    if (config.action === 'simple_webhook_call') {
      if (!dryRun && sideEffectCount < 1) {
        sideEffectCount += 1;
        await axios.post(config.webhook_url, config.payload || {});
      }
      return { action: config.action, webhook_called: !dryRun, dry_run: dryRun };
    }

    throw new Error('unsupported_action');
  };

  return Promise.race([runner(), new Promise((_, reject) => setTimeout(() => reject(new Error('automation_timeout')), 15000))]);
}

module.exports = { executeAutomation, validateConfig };
