const { query } = require('../db');

async function getOrCreateSession(taskId) {
  const existing = await query('select * from hermes_sessions where task_id=$1', [taskId]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await query(
    `insert into hermes_sessions (task_id, status) values ($1, 'running') returning *`,
    [taskId],
  );
  return created.rows[0];
}

async function updateSession(taskId, patch = {}) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k}=$${i + 2}`);
  const values = keys.map((k) => patch[k]);
  await query(`update hermes_sessions set ${sets.join(', ')} where task_id=$1`, [taskId, ...values]);
}

async function logSessionAction(sessionId, actionType, status, payload = {}) {
  await query(
    `insert into hermes_session_actions (session_id, action_type, status, payload) values ($1,$2,$3,$4)`,
    [sessionId, actionType, status, payload],
  );
}

module.exports = { getOrCreateSession, updateSession, logSessionAction };
