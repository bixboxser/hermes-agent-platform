const nodeCrypto = require('node:crypto');
const { query } = require('../db');

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function hashPayload(payload) {
  return nodeCrypto.createHash('sha256').update(stableStringify(payload || {})).digest('hex');
}

async function getExistingIdempotentAction(key) {
  const res = await query('select * from hermes_idempotency_keys where key=$1', [key]);
  return res.rows[0] || null;
}

async function startIdempotentAction(key, taskId, actionType, requestPayload = {}) {
  const requestHash = hashPayload(requestPayload);
  const existing = await getExistingIdempotentAction(key);
  if (existing) {
    if (existing.request_hash !== requestHash) return { state: 'conflict', existing };
    if (existing.status === 'completed') return { state: 'completed', existing };
    if (existing.status === 'started') return { state: 'already_running', existing };
    return { state: 'failed', existing };
  }

  const inserted = await query(
    `insert into hermes_idempotency_keys (key, task_id, action_type, status, request_hash)
     values ($1,$2,$3,'started',$4) returning *`,
    [key, taskId, actionType, requestHash],
  );
  return { state: 'started', record: inserted.rows[0] };
}

async function completeIdempotentAction(key, response = {}) {
  await query(
    `update hermes_idempotency_keys
     set status='completed', response=$2, updated_at=now()
     where key=$1`,
    [key, response],
  );
}

async function failIdempotentAction(key, error) {
  await query(
    `update hermes_idempotency_keys
     set status='failed', error_text=$2, updated_at=now()
     where key=$1`,
    [key, String(error || '')],
  );
}

module.exports = {
  hashPayload,
  getExistingIdempotentAction,
  startIdempotentAction,
  completeIdempotentAction,
  failIdempotentAction,
};
