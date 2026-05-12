process.env.DISABLE_TELEGRAM = 'true';
process.env.PROJECT_ROOT_PROD = process.env.PROJECT_ROOT_PROD || '/tmp/hermes-prod-root-for-tests';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSkillsCommandReply,
  buildTasksCommandReply,
  buildTasksStaleMessage,
  buildTasksSummaryMessage,
  expireStaleTasks,
  saveSkillLessonToMemory,
} = require('../index');

function skillQueryMock({ candidate = true } = {}) {
  return async (sql, params) => {
    if (/from hermes_tasks/.test(sql)) {
      return { rows: [{ id: params[0], status: 'failed', input_text: 'deploy failed with missing docker env' }], rowCount: 1 };
    }
    if (/from hermes_task_events/.test(sql)) {
      return {
        rows: [
          { event_type: 'skill_lesson_candidate', message: candidate ? 'Potential lesson to save: use docker preflight token=abc123 DATABASE_URL=postgres://user:pass@db/app https://user:pass@example.com sk-test_1234567890123456' : '', payload: candidate ? { lesson_candidate: 'Use docker preflight token=abc123 DATABASE_URL=postgres://user:pass@db/app https://user:pass@example.com sk-test_1234567890123456' } : {} },
          { event_type: 'skill_requirements_checked', payload: { missing_env: ['GOOGLE_APPLICATION_CREDENTIALS'], missing_tools: ['docker', 'psql'] } },
          { event_type: 'skills_matched', payload: { selected_skills: [{ name: 'docker-compose-v1-safety' }] } },
        ].filter((event) => candidate || event.event_type !== 'skill_lesson_candidate'),
        rowCount: candidate ? 3 : 2,
      };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
}

test('/skills learn <task_id> with existing skill_lesson_candidate returns review', async () => {
  const output = await buildSkillsCommandReply('/skills learn 29', { queryFn: skillQueryMock() });
  assert.match(output, /Skill lesson review for task #29/);
  assert.match(output, /Potential lesson to save: Use docker preflight/);
  assert.match(output, /Selected skills: docker-compose-v1-safety/);
  assert.match(output, /Missing env: GOOGLE_APPLICATION_CREDENTIALS/);
  assert.match(output, /Missing tools: docker, psql/);
  assert.match(output, /Next step: \/skills save-memory 29 or \/skills append-skill 29 <skill-name>/);
});

test('/skills learn <task_id> with no candidate returns clear message', async () => {
  const output = await buildSkillsCommandReply('/skills learn 30', { queryFn: skillQueryMock({ candidate: false }) });
  assert.match(output, /No skill_lesson_candidate found for task #30/);
});

test('/skills save-memory <task_id> writes hermes_memories using memory_text and memory_type, redacts secrets', async () => {
  const writes = [];
  const queryFn = async (sql, params) => {
    if (/from hermes_tasks/.test(sql)) return { rows: [{ id: params[0], status: 'failed', input_text: 'x' }], rowCount: 1 };
    if (/from hermes_task_events/.test(sql)) return { rows: [{ event_type: 'skill_lesson_candidate', message: 'x', payload: { lesson_candidate: 'Save token=abc123 DATABASE_URL=postgres://user:pass@db/app https://user:pass@example.com sk-test_1234567890123456' } }], rowCount: 1 };
    writes.push({ sql, params });
    if (/insert into hermes_memories/.test(sql)) {
      assert.match(sql, /memory_text/);
      assert.match(sql, /memory_type/);
      assert.doesNotMatch(sql, /\bcontent\b|\btype\b/);
      assert.equal(params[4], 'ops_sop');
      assert.doesNotMatch(params[1], /abc123|user:pass|sk-test_1234567890123456|DATABASE_URL=postgres/);
      return { rows: [{ id: 44, memory_key: params[0], memory_text: params[1], memory_type: params[4] }], rowCount: 1 };
    }
    if (/insert into hermes_task_events/.test(sql)) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected sql: ${sql}`);
  };
  const result = await saveSkillLessonToMemory(31, { queryFn });
  assert.equal(result.ok, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].params[1], 'skill_lesson_saved_to_memory');
});

const staleRows = [
  { id: 1, status: 'pending', input_text: 'old pending task', created_at: '2026-05-10T00:00:00.000Z', approval_expires_at: null, age_seconds: 172800 },
  { id: 2, status: 'pending_approval', input_text: 'expired approval task', created_at: '2026-05-10T00:00:00.000Z', approval_expires_at: '2026-05-10T00:15:00.000Z', age_seconds: 172800 },
  { id: 3, status: 'approved', input_text: 'old approved task', created_at: '2026-05-10T00:00:00.000Z', approval_expires_at: null, age_seconds: 172800 },
  { id: 4, status: 'running', input_text: 'old running task', created_at: '2026-05-11T23:00:00.000Z', approval_expires_at: null, age_seconds: 3600 },
];

test('/tasks stale lists stale tasks without mutation', async () => {
  const calls = [];
  const output = await buildTasksStaleMessage({ queryFn: async (sql, params) => { calls.push({ sql, params }); return { rows: staleRows, rowCount: staleRows.length }; } });
  assert.match(output, /Stale tasks \(read-only\):/);
  assert.match(output, /#1 pending/);
  assert.match(output, /#2 pending_approval/);
  assert.match(output, /#4 running/);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].sql, /update|delete/i);
});

test('/tasks expire-stale mutates only eligible stale pending_approval tasks and logs events', async () => {
  const writes = [];
  const result = await expireStaleTasks({
    operatorAuthorized: true,
    queryFn: async (sql, params) => {
      if (/select id,status,input_text/.test(sql)) return { rows: staleRows, rowCount: staleRows.length };
      writes.push({ sql, params });
      if (/update hermes_tasks/.test(sql)) {
        assert.equal(params[0], 2);
        assert.match(sql, /status='pending_approval'/);
        assert.equal(params[1], 'Expired by operator stale-task cleanup');
        return { rows: [{ id: 2, status: 'failed' }], rowCount: 1 };
      }
      if (/insert into hermes_task_events/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected sql: ${sql}`);
    },
  });
  assert.deepEqual(result.expired, [2]);
  assert.deepEqual(result.skipped.map((task) => task.id), [1, 3, 4]);
  assert.equal(writes.filter((write) => /update hermes_tasks/.test(write.sql)).length, 1);
  const eventWrites = writes.filter((write) => /insert into hermes_task_events/.test(write.sql));
  assert.deepEqual(eventWrites.map((write) => write.params[1]), ['stale_task_expired']);
  assert.equal(eventWrites.filter((write) => write.params[1] === 'stale_task_expired').length, 1);
  assert.equal(eventWrites.filter((write) => write.params[1] === 'status_transition').length, 0);
});

test('/tasks expire-stale relies on the DB trigger for one pending_approval -> failed status_transition', async () => {
  const writes = [];
  await expireStaleTasks({
    operatorAuthorized: true,
    queryFn: async (sql, params) => {
      if (/select id,status,input_text/.test(sql)) return { rows: [staleRows[1]], rowCount: 1 };
      writes.push({ sql, params });
      if (/update hermes_tasks/.test(sql)) return { rows: [{ id: 2, status: 'failed' }], rowCount: 1 };
      if (/insert into hermes_task_events/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected sql: ${sql}`);
    },
  });

  const manualStatusTransitionWrites = writes.filter((write) => /insert into hermes_task_events/.test(write.sql) && write.params[1] === 'status_transition');
  assert.equal(manualStatusTransitionWrites.length, 0);
});

test('/tasks summary returns queue and stale counts', async () => {
  const output = await buildTasksSummaryMessage({ queryFn: async () => ({ rows: [{ pending: 2, pending_approval: 3, approved: 4, running: 5, completed_24h: 6, failed_24h: 7, oldest_pending_age_seconds: 90000, stale_pending: 1, stale_pending_approval: 2, stale_approved: 3, stale_running: 4 }] }) });
  assert.match(output, /Tasks summary/);
  assert.match(output, /pending: 2/);
  assert.match(output, /completed_24h: 6/);
  assert.match(output, /stale pending_approval: 2/);
  assert.match(output, /stale running: 4/);
});

test('non-operator cannot expire stale tasks', async () => {
  let called = false;
  const output = await buildTasksCommandReply('/tasks expire-stale', { operatorAuthorized: false, queryFn: async () => { called = true; return { rows: [] }; } });
  assert.match(output, /Operator authorization required/);
  assert.equal(called, false);
});

test('completed and failed tasks are never modified by expire-stale', async () => {
  const writes = [];
  await expireStaleTasks({
    operatorAuthorized: true,
    queryFn: async (sql, params) => {
      if (/select id,status,input_text/.test(sql)) return { rows: [{ id: 8, status: 'completed', input_text: 'done', created_at: '2026-05-01T00:00:00Z' }, { id: 9, status: 'failed', input_text: 'failed', created_at: '2026-05-01T00:00:00Z' }], rowCount: 2 };
      writes.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  });
  assert.equal(writes.length, 0);
});

test('running tasks are not expired in v3', async () => {
  const writes = [];
  const result = await expireStaleTasks({
    operatorAuthorized: true,
    queryFn: async (sql, params) => {
      if (/select id,status,input_text/.test(sql)) return { rows: [staleRows[3]], rowCount: 1 };
      writes.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  });
  assert.deepEqual(result.expired, []);
  assert.equal(writes.length, 0);
});
