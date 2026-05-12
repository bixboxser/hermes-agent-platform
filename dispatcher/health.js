const { query } = require('../db');
const envConfig = require('../config/env');

async function safeQuery(sql, params = [], queryFn = query) {
  try {
    const result = await queryFn(sql, params);
    return { ok: true, rows: result.rows || [] };
  } catch (error) {
    return { ok: false, rows: [], error: error.message };
  }
}

async function getSystemHealth(options = {}) {
  const queryFn = options.queryFn || query;
  const warnings = [];

  const dbPing = await safeQuery('select 1', [], queryFn);
  const dbOk = dbPing.ok;
  if (!dbOk) warnings.push(`DB ping failed: ${dbPing.error}`);

  const worker = dbOk
    ? await safeQuery(
        `select worker_id,last_heartbeat_at,status
         from hermes_worker_status
         order by last_heartbeat_at desc
         limit 1`,
        [],
        queryFn,
      )
    : { ok: false, rows: [], error: dbPing.error };
  if (!worker.ok) warnings.push(`Worker status unavailable: ${worker.error}`);
  const latestWorker = worker.rows[0] || null;

  const queue = dbOk
    ? await safeQuery(
        `select
          coalesce(sum(case when status='pending' then 1 else 0 end), 0)::int as pending,
          coalesce(sum(case when status='planned' then 1 else 0 end), 0)::int as planned,
          coalesce(sum(case when status='pending_approval' then 1 else 0 end), 0)::int as pending_approval,
          coalesce(sum(case when status='approved' then 1 else 0 end), 0)::int as approved,
          coalesce(sum(case when status='running' then 1 else 0 end), 0)::int as running,
          coalesce(sum(case when status='completed' and updated_at >= now() - interval '24 hours' then 1 else 0 end), 0)::int as completed_24h,
          coalesce(sum(case when status='failed' and updated_at >= now() - interval '24 hours' then 1 else 0 end), 0)::int as failed_24h,
          coalesce(sum(case when status='failed' then 1 else 0 end), 0)::int as failed_total
         from hermes_tasks`,
        [],
        queryFn,
      )
    : { ok: false, rows: [], error: dbPing.error };
  if (!queue.ok) warnings.push(`Queue counts unavailable: ${queue.error}`);

  const oldest = dbOk
    ? await safeQuery(
        `select
          coalesce(extract(epoch from (now() - min(case when status='pending' then created_at end)))::int, 0) as oldest_pending_seconds,
          coalesce(extract(epoch from (now() - min(case when status='pending_approval' then created_at end)))::int, 0) as oldest_pending_approval_seconds
         from hermes_tasks
         where status in ('pending','pending_approval')`,
        [],
        queryFn,
      )
    : { ok: false, rows: [], error: dbPing.error };
  if (!oldest.ok) warnings.push(`Queue age unavailable: ${oldest.error}`);

  const stuck = dbOk
    ? await safeQuery(
        `select count(*)::int as c
         from hermes_tasks
         where status='running'
           and heartbeat_at < now() - interval '10 minutes'`,
        [],
        queryFn,
      )
    : { ok: false, rows: [], error: dbPing.error };
  if (!stuck.ok) warnings.push(`Stuck running count unavailable: ${stuck.error}`);

  const latestTask = dbOk
    ? await safeQuery(
        `select id,status,intent,input_text,created_at,updated_at
         from hermes_tasks
         order by id desc
         limit 1`,
        [],
        queryFn,
      )
    : { ok: false, rows: [], error: dbPing.error };
  if (!latestTask.ok) warnings.push(`Latest task unavailable: ${latestTask.error}`);

  const memory = dbOk
    ? await safeQuery(`select count(*)::int as total from hermes_memories`, [], queryFn)
    : { ok: false, rows: [], error: dbPing.error };
  if (!memory.ok) warnings.push(`Memory count unavailable: ${memory.error}`);

  const q = queue.rows[0] || {};
  const running = q.running || 0;
  const status = !dbOk ? 'down' : running > 50 || warnings.length ? 'degraded' : 'ok';

  return {
    status,
    app: { ok: true },
    app_env: process.env.APP_ENV || 'development',
    env: envConfig.HERMES_ENV,
    projectRoot: process.env.PROJECT_ROOT || process.cwd(),
    db: { ok: dbOk, error: dbOk ? null : dbPing.error },
    worker: {
      alive: Boolean(latestWorker && latestWorker.last_heartbeat_at),
      worker_id: latestWorker?.worker_id || null,
      last_heartbeat_at: latestWorker?.last_heartbeat_at || null,
      status: latestWorker?.status || null,
    },
    queue: {
      pending: q.pending || 0,
      planned: q.planned || 0,
      pending_approval: q.pending_approval || 0,
      waiting_approval: q.pending_approval || 0,
      approved: q.approved || 0,
      running,
      completed_24h: q.completed_24h || 0,
      failed_24h: q.failed_24h || 0,
      failed: q.failed_total || 0,
      oldest_pending_seconds: oldest.rows[0]?.oldest_pending_seconds || 0,
      oldest_pending_approval_seconds: oldest.rows[0]?.oldest_pending_approval_seconds || 0,
      stuck_running: stuck.rows[0]?.c || 0,
    },
    latest_task: latestTask.rows[0] || null,
    memory: { total: memory.rows[0]?.total || 0 },
    warnings,
  };
}

module.exports = { getSystemHealth };
