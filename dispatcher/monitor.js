const { query } = require('../db');
const { triggerAlert } = require('./alert');

async function detectAndHandleStuckTasks() {
  const stuck = await query(
    `select id,retry_count,max_retries from hermes_tasks
     where status='running' and heartbeat_at < now() - interval '10 minutes'`,
  );

  for (const t of stuck.rows) {
    if (Number(t.retry_count) < Number(t.max_retries)) {
      await query(`update hermes_tasks set status='pending', retry_count=retry_count+1, locked_by=null, locked_at=null, updated_at=now() where id=$1`, [t.id]);
    } else {
      await query(`update hermes_tasks set status='failed', locked_by=null, locked_at=null, updated_at=now(), error_text=coalesce(error_text,'stuck task exceeded retries') where id=$1`, [t.id]);
    }
    await triggerAlert('TASK_STUCK', { task_id: t.id, retry_count: t.retry_count, max_retries: t.max_retries });
  }

  return { stuck: stuck.rowCount || 0 };
}

async function checkHighFailureRate(options = {}) {
  const queryFn = options.queryFn || query;
  const alertFn = options.alertFn || triggerAlert;
  const res = await queryFn(
    `with recent_failed as (
       select t.id,t.error_text
       from hermes_tasks t
       where t.status='failed'
         and t.updated_at > now() - interval '10 minutes'
     ), classified as (
       select rf.id,
              (
                rf.error_text = 'Expired by operator stale-task cleanup'
                or exists (
                  select 1
                  from hermes_task_events e
                  where e.task_id = rf.id
                    and e.event_type = 'stale_task_expired'
                    and e.created_at > now() - interval '10 minutes'
                )
              ) as is_cleanup_expiration
       from recent_failed rf
     )
     select
       coalesce(sum(case when not is_cleanup_expiration then 1 else 0 end),0)::int as failed_last_10m,
       coalesce(sum(case when is_cleanup_expiration then 1 else 0 end),0)::int as cleanup_expired_last_10m
     from classified`,
  );
  const failedLast10m = res.rows[0]?.failed_last_10m || 0;
  const cleanupExpiredLast10m = res.rows[0]?.cleanup_expired_last_10m || 0;
  if (failedLast10m > 5) await alertFn('HIGH_FAILURE_RATE', { failed_last_10m: failedLast10m, cleanup_expired_last_10m: cleanupExpiredLast10m });
  return { failedLast10m, cleanupExpiredLast10m };
}

async function checkStuckApprovals() {
  const res = await query(
    `select count(*)::int as c from hermes_approvals where status='pending' and created_at < now() - interval '15 minutes'`,
  );
  const count = res.rows[0]?.c || 0;
  if (count > 0) await triggerAlert('APPROVAL_STUCK', { pending_approvals: count });
  return { pendingApprovals: count };
}

module.exports = { detectAndHandleStuckTasks, checkHighFailureRate, checkStuckApprovals };
