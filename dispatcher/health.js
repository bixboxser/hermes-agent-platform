const { query } = require('../db');
const envConfig = require('../config/env');

async function getSystemHealth() {
  let dbOk = true;
  try { await query('select 1'); } catch { dbOk = false; }

  const worker = await query(`select worker_id,last_heartbeat_at,status from hermes_worker_status order by last_heartbeat_at desc limit 1`);
  const latestWorker = worker.rows[0] || null;

  const q = await query(
    `select
      count(*) filter (where status='pending')::int as pending,
      count(*) filter (where status='running')::int as running,
      count(*) filter (where status='failed')::int as failed,
      count(*) filter (where status='waiting_approval')::int as waiting_approval
     from hermes_tasks`,
  );

  const m = await query(`select count(*)::int as total from hermes_memories`);

  const running = q.rows[0]?.running || 0;
  const status = !dbOk ? 'down' : running > 50 ? 'degraded' : 'ok';

  return {
    status,
    env: envConfig.HERMES_ENV,
    db: { ok: dbOk },
    worker: {
      alive: Boolean(latestWorker && latestWorker.last_heartbeat_at),
      last_heartbeat_at: latestWorker?.last_heartbeat_at || null,
    },
    queue: {
      pending: q.rows[0]?.pending || 0,
      running: running,
      failed: q.rows[0]?.failed || 0,
      waiting_approval: q.rows[0]?.waiting_approval || 0,
    },
    memory: { total: m.rows[0]?.total || 0 },
  };
}

module.exports = { getSystemHealth };
