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

async function checkHighFailureRate() {
  const res = await query(
    `select count(*)::int as c from hermes_tasks where status='failed' and updated_at > now() - interval '10 minutes'`,
  );
  const count = res.rows[0]?.c || 0;
  if (count > 5) await triggerAlert('HIGH_FAILURE_RATE', { failed_last_10m: count });
  return { failedLast10m: count };
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
