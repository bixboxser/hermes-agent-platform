const { query } = require('../db');

async function logEvent(taskId, eventType, message, payload = {}) {
  await query(
    `insert into hermes_task_events (task_id, event_type, message, payload) values ($1,$2,$3,$4)`,
    [taskId, eventType, message, payload],
  );
}

async function claimNextTask(workerId) {
  const res = await query(
    `with next_task as (
      select id from hermes_tasks
      where status='pending'
      order by id asc
      limit 1
      for update skip locked
    )
    update hermes_tasks t
    set status='running', locked_by=$1, locked_at=now(), heartbeat_at=now(), timeout_at=now()+interval '10 minutes', updated_at=now()
    from next_task
    where t.id = next_task.id
    returning t.*`,
    [workerId],
  );
  const task = res.rows[0] || null;
  if (task) await logEvent(task.id, 'claimed', 'Task claimed by worker', { workerId });
  return task;
}

async function heartbeatTask(taskId, workerId) {
  const res = await query(
    `update hermes_tasks set heartbeat_at=now(), timeout_at=now()+interval '10 minutes', updated_at=now()
     where id=$1 and locked_by=$2 and status='running' returning id`,
    [taskId, workerId],
  );
  return (res.rowCount || 0) === 1;
}

async function releaseTask(taskId, workerId, status = 'completed', result = null) {
  await query(
    `update hermes_tasks
     set status=$3, result_text=coalesce($4, result_text), locked_by=null, locked_at=null, timeout_at=null, heartbeat_at=now(), updated_at=now()
     where id=$1 and locked_by=$2`,
    [taskId, workerId, status, result],
  );
  await logEvent(taskId, status, `Task moved to ${status}`, { workerId });
}

async function failTask(taskId, workerId, errorText, retryable = true) {
  const taskRes = await query('select retry_count,max_retries from hermes_tasks where id=$1', [taskId]);
  const task = taskRes.rows[0];
  if (!task) return;
  const canRetry = retryable && Number(task.retry_count) < Number(task.max_retries);
  if (canRetry) {
    await query(
      `update hermes_tasks
       set status='pending', retry_count=retry_count+1, error_text=$3, locked_by=null, locked_at=null, timeout_at=null, updated_at=now()
       where id=$1 and locked_by=$2`,
      [taskId, workerId, String(errorText || '')],
    );
    await logEvent(taskId, 'retry_scheduled', 'Task scheduled for retry', { workerId });
    return;
  }
  await query(
    `update hermes_tasks
     set status='failed', error_text=$3, locked_by=null, locked_at=null, timeout_at=null, updated_at=now()
     where id=$1 and locked_by=$2`,
    [taskId, workerId, String(errorText || '')],
  );
  await logEvent(taskId, 'failed', 'Task failed permanently', { workerId });
}

async function markWaitingApproval(taskId, workerId, approvalId) {
  await query(
    `update hermes_tasks
     set status='waiting_approval', locked_by=null, locked_at=null, timeout_at=null, updated_at=now()
     where id=$1 and locked_by=$2`,
    [taskId, workerId],
  );
  await logEvent(taskId, 'waiting_approval', 'Task waiting approval', { workerId, approvalId });
}

async function recoverStaleTasks() {
  const recovered = await query(
    `update hermes_tasks
     set status='pending', retry_count=retry_count+1, locked_by=null, locked_at=null, updated_at=now()
     where status='running'
       and heartbeat_at < now() - interval '10 minutes'
       and retry_count < max_retries
     returning id`,
  );
  for (const row of recovered.rows) await logEvent(row.id, 'stale_recovered', 'Recovered stale running task', {});

  const failed = await query(
    `update hermes_tasks
     set status='failed', locked_by=null, locked_at=null, updated_at=now(), error_text=coalesce(error_text,'stale timeout exceeded')
     where status='running'
       and heartbeat_at < now() - interval '10 minutes'
       and retry_count >= max_retries
     returning id`,
  );
  for (const row of failed.rows) await logEvent(row.id, 'stale_failed', 'Stale task failed after retries', {});

  return { recovered: recovered.rowCount || 0, failed: failed.rowCount || 0 };
}

module.exports = { claimNextTask, heartbeatTask, releaseTask, failTask, markWaitingApproval, recoverStaleTasks };
