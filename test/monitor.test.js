process.env.DISABLE_TELEGRAM = 'true';
process.env.PROJECT_ROOT_PROD = process.env.PROJECT_ROOT_PROD || '/tmp/hermes-prod-root-for-tests';
process.env.APP_ENV = process.env.APP_ENV || 'production';

const assert = require('node:assert/strict');
const test = require('node:test');

const { checkHighFailureRate } = require('../dispatcher/monitor');
const { getSystemHealth } = require('../dispatcher/health');

test('HIGH_FAILURE_RATE excludes stale cleanup expirations', async () => {
  const alerts = [];
  const result = await checkHighFailureRate({
    queryFn: async (sql) => {
      assert.match(sql, /Expired by operator stale-task cleanup/);
      assert.match(sql, /stale_task_expired/);
      assert.match(sql, /cleanup_expired_last_10m/);
      return { rows: [{ failed_last_10m: 0, cleanup_expired_last_10m: 7 }], rowCount: 1 };
    },
    alertFn: async (...args) => alerts.push(args),
  });

  assert.deepEqual(result, { failedLast10m: 0, cleanupExpiredLast10m: 7 });
  assert.equal(alerts.length, 0);
});

test('HIGH_FAILURE_RATE still triggers for real failures', async () => {
  const alerts = [];
  const result = await checkHighFailureRate({
    queryFn: async () => ({ rows: [{ failed_last_10m: 6, cleanup_expired_last_10m: 7 }], rowCount: 1 }),
    alertFn: async (...args) => alerts.push(args),
  });

  assert.deepEqual(result, { failedLast10m: 6, cleanupExpiredLast10m: 7 });
  assert.deepEqual(alerts, [['HIGH_FAILURE_RATE', { failed_last_10m: 6, cleanup_expired_last_10m: 7 }]]);
});

test('/health remains OK while failed_24h stays factual', async () => {
  const result = await getSystemHealth({
    queryFn: async (sql) => {
      if (/select 1/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (/from hermes_worker_status/.test(sql)) return { rows: [{ worker_id: 'worker-1', last_heartbeat_at: '2026-05-12T00:00:00.000Z', status: 'alive' }], rowCount: 1 };
      if (/from hermes_tasks/.test(sql) && /failed_24h/.test(sql)) return { rows: [{ pending: 0, planned: 0, pending_approval: 0, approved: 0, running: 0, completed_24h: 0, failed_24h: 7, failed_total: 7 }], rowCount: 1 };
      if (/oldest_pending_seconds/.test(sql)) return { rows: [{ oldest_pending_seconds: 0, oldest_pending_approval_seconds: 0 }], rowCount: 1 };
      if (/stuck running count/i.test(sql) || /heartbeat_at < now\(\) - interval '10 minutes'/.test(sql)) return { rows: [{ c: 0 }], rowCount: 1 };
      if (/order by id desc/.test(sql)) return { rows: [{ id: 22, status: 'failed', intent: 'maintenance', input_text: 'expired', created_at: '2026-05-12T00:00:00.000Z', updated_at: '2026-05-12T00:01:00.000Z' }], rowCount: 1 };
      if (/from hermes_memories/.test(sql)) return { rows: [{ total: 0 }], rowCount: 1 };
      throw new Error(`unexpected sql: ${sql}`);
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.db.ok, true);
  assert.equal(result.worker.alive, true);
  assert.equal(result.queue.failed_24h, 7);
});
