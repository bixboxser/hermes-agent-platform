const { query } = require('../db');
const { executeAutomation, validateConfig } = require('./automation');
const { startIdempotentAction, completeIdempotentAction, failIdempotentAction } = require('./idempotency');

let lastSchedulerRunAt = 0;

async function createGoalTask(goal, execution) {
  const text = `[GOAL:${goal.id}] ${goal.name} - ${goal.config?.action || 'automation'}`;
  const r = await query(
    `insert into hermes_tasks (telegram_chat_id, telegram_user_id, input_text, status, intent, source, goal_id)
     values ($1,$2,$3,'pending','automation',$4,$5) returning *`,
    [Number(process.env.OWNER_CHAT_ID || 0), Number(process.env.OWNER_USER_ID || 0), text, 'goal', goal.id],
  );
  await query(`insert into hermes_task_events (task_id,event_type,message,payload) values ($1,'goal_task_created',$2,$3)`, [r.rows[0].id, 'Task created from goal execution', execution]);
  return r.rows[0];
}

async function executeGoal(goal) {
  const windowKey = `${goal.id}:${Math.floor(Date.now() / (5 * 60 * 1000))}`;
  const idem = await startIdempotentAction(windowKey, null, 'goal_run', { goal_id: goal.id });
  if (idem.state !== 'started') return { skipped: true, reason: idem.state };

  try {
    const cfg = goal.config || {};
    validateConfig(cfg);
    const result = await executeAutomation(cfg);
    const task = await createGoalTask(goal, result);

    await query(`update hermes_goals set last_run_at=now(), next_run_at=now() + make_interval(secs => schedule_interval_seconds), failure_count=0 where id=$1`, [goal.id]);
    await completeIdempotentAction(windowKey, { goal_id: goal.id, task_id: task.id, result });
    await query(`insert into hermes_memories (memory_key,memory_text,memory_type,importance,confidence,last_used_at) values ($1,$2,'business_rule',3,0.7,now())`, [`goal:${goal.id}:ok`, JSON.stringify({ goal_type: goal.type, action: cfg.action, success: true })]);
    return { success: true, task_id: task.id, result };
  } catch (e) {
    await failIdempotentAction(windowKey, e.message);
    const upd = await query(`update hermes_goals set failure_count=failure_count+1, next_run_at=now() + make_interval(secs => greatest(schedule_interval_seconds*2,30)) where id=$1 returning failure_count`, [goal.id]);
    const failureCount = Number(upd.rows[0]?.failure_count || 0);
    if (failureCount >= 3) await query(`update hermes_goals set status='failed' where id=$1`, [goal.id]);
    await query(`insert into hermes_memories (memory_key,memory_text,memory_type,importance,confidence,last_used_at) values ($1,$2,'ops_sop',3,0.6,now())`, [`goal:${goal.id}:fail`, JSON.stringify({ pattern: 'goal failure', action: 'manual check required' })]);
    return { success: false, error: e.message };
  }
}

async function runDueGoals() {
  try {
    if (Date.now() - lastSchedulerRunAt < 30000) return { skipped: true, reason: 'interval_guard' };
    lastSchedulerRunAt = Date.now();

    const active = await query(`select * from hermes_goals where status='active' and next_run_at <= now() order by next_run_at asc limit 10`);
    const results = [];
    for (const goal of active.rows) {
      const recent = await query(`select count(*)::int as c from hermes_idempotency_keys where action_type='goal_run' and created_at > now() - interval '1 hour' and response->>'goal_id' = $1`, [String(goal.id)]);
      if (Number(recent.rows[0]?.c || 0) >= 3) continue;
      results.push(await executeGoal(goal));
    }
    return { ran: results.length, results };
  } catch (e) {
    return { ran: 0, error: e.message };
  }
}

async function runGoalNow(goalId) {
  const g = await query(`select * from hermes_goals where id=$1`, [goalId]);
  if (!g.rows[0]) throw new Error('goal_not_found');
  return executeGoal(g.rows[0]);
}

module.exports = { runDueGoals, executeGoal, runGoalNow };
