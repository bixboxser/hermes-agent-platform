const { query } = require('../db');

async function logEvent(taskId, eventType, message, payload = {}) {
  await query(
    `insert into hermes_task_events (task_id, event_type, message, payload) values ($1,$2,$3,$4)`,
    [taskId, eventType, message, payload],
  );
}



const ALLOWED = {
  pending: new Set(['planned']),
  planned: new Set(['pending_approval']),
  pending_approval: new Set(['approved','failed']),
  approved: new Set(['running']),
  running: new Set(['completed','failed','planned']),
  completed: new Set(),
  failed: new Set(),
};

async function transitionTask(taskId, workerId, nextStatus, patch = {}) {
  const cur = await query('select status from hermes_tasks where id=$1', [taskId]);
  const currentStatus = cur.rows[0]?.status;
  if (!currentStatus) throw new Error('task_not_found');
  if (!ALLOWED[currentStatus] || !ALLOWED[currentStatus].has(nextStatus)) {
    throw new Error(`invalid_transition:${currentStatus}->${nextStatus}`);
  }
  const sets = ['status=$3', 'updated_at=now()'];
  const params = [taskId, workerId, nextStatus];
  let i = 4;
  for (const [k, v] of Object.entries(patch || {})) {
    sets.push(`${k}=$${i}`);
    params.push(v);
    i += 1;
  }
  const lockWhere = workerId ? ' and locked_by=$2' : '';
  const res = await query(`update hermes_tasks set ${sets.join(', ')} where id=$1${lockWhere}`, params);
  if ((res.rowCount||0)!==1) throw new Error('transition_update_failed');
}

async function claimNextTask(workerId) {
  const res = await query(
    `with next_task as (
      select id from hermes_tasks
      where status='approved'
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
  await transitionTask(taskId, workerId, status, {
    result_text: result,
    locked_by: null,
    locked_at: null,
    timeout_at: null,
    heartbeat_at: new Date().toISOString(),
  });
  await logEvent(taskId, status, `Task moved to ${status}`, { workerId });
}

async function failTask(taskId, workerId, errorText, retryable = true) {
  const taskRes = await query('select retry_count,max_retries from hermes_tasks where id=$1', [taskId]);
  const task = taskRes.rows[0];
  if (!task) return;
  const canRetry = retryable && Number(task.retry_count) < Number(task.max_retries);
  if (canRetry) {
    await transitionTask(taskId, workerId, 'planned', {
      error_text: String(errorText || ''),
      locked_by: null,
      locked_at: null,
      timeout_at: null,
      retry_count: Number(task.retry_count) + 1,
    });
    await logEvent(taskId, 'retry_scheduled', 'Task scheduled for retry', { workerId });
    return;
  }
  await transitionTask(taskId, workerId, 'failed', {
    error_text: String(errorText || ''),
    locked_by: null,
    locked_at: null,
    timeout_at: null,
  });
  await logEvent(taskId, 'failed', 'Task failed permanently', { workerId });
}

async function markWaitingApproval(taskId, workerId, approvalId) {
  await transitionTask(taskId, workerId, 'pending_approval', {
    locked_by: null,
    locked_at: null,
    timeout_at: null,
  });
  await logEvent(taskId, 'pending_approval', 'Task waiting approval', { workerId, approvalId });
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
