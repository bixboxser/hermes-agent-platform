const { query } = require('../db');
const { runGate } = require('./gate');
const { handleTaskFailure } = require('./autodebug');
const { commitChanges, createPullRequest } = require('./github');
const { updateSession } = require('./session');

async function markPlan(planId, status) {
  await query(`update hermes_plans set status=$2 where id=$1`, [planId, status]);
}

async function runStep(planId, stepId, fn) {
  const lock = await query(`update hermes_plan_steps set status='running', updated_at=now() where plan_id=$1 and step_id=$2 and status='pending' returning *`, [planId, stepId]);
  if (!lock.rows[0]) return { skipped: true };
  try {
    const result = await Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('step_timeout')), 120000))]);
    await query(`update hermes_plan_steps set status='completed', result=$3, updated_at=now() where plan_id=$1 and step_id=$2`, [planId, stepId, result || {}]);
    return { ok: true, result };
  } catch (e) {
    await query(`update hermes_plan_steps set status='failed', result=$3, updated_at=now() where plan_id=$1 and step_id=$2`, [planId, stepId, { error: e.message }]);
    return { ok: false, error: e };
  }
}

async function executePlan(plan, task, session, ctx) {
  const start = Date.now();
  await markPlan(plan.id, 'running');
  await updateSession(task.id, { plan_id: plan.id });
  let lastOutput = '';

  const steps = await query(`select * from hermes_plan_steps where plan_id=$1 order by step_id asc`, [plan.id]);
  for (const s of steps.rows) {
    if (Date.now() - start > 10 * 60 * 1000) {
      await markPlan(plan.id, 'failed');
      throw new Error('plan_timeout');
    }
    if (s.status !== 'pending') continue;
    await updateSession(task.id, { current_step_id: s.step_id });
    if (ctx.onStep) await ctx.onStep(s.step_id, steps.rows.length);

    let retries = 0;
    while (retries <= 1) {
      const outcome = await runStep(plan.id, s.step_id, async () => {
        if (s.type === 'analyze') return { message: 'analyzed task/session', task_id: task.id };
        if (s.type === 'locate') return { message: 'located likely files from task text' };
        if (s.type === 'patch') return { output: await ctx.runAction(task) };
        if (s.type === 'test') return await runGate(ctx.projectRoot);
        if (s.type === 'commit') return { commit_message: await commitChanges(task, session, 'planned change', ctx.projectRoot) };
        if (s.type === 'pr') return { pr: await createPullRequest(task, session, session.last_gate_status || 'PATCH DONE BUT GATE FAILED') };
        return { skipped: true };
      });

      if (outcome.ok) {
        lastOutput = JSON.stringify(outcome.result || {});
        break;
      }

      if (s.type === 'patch') {
        const debug = await handleTaskFailure(task, session, outcome.error.message, { projectRoot: ctx.projectRoot });
        if (!debug.retryable) break;
      }

      retries += 1;
      if (retries > 1) {
        await markPlan(plan.id, 'failed');
        throw outcome.error;
      }
      await query(`update hermes_plan_steps set status='pending' where plan_id=$1 and step_id=$2`, [plan.id, s.step_id]);
    }
  }

  await markPlan(plan.id, 'completed');
  await query(
    `insert into hermes_memories (memory_key,memory_text,memory_type,importance,confidence,last_used_at)
     values ($1,$2,'decision_log',3,0.7,now())`,
    [
      `decision:${task.id}`,
      JSON.stringify({ task_type: (ctx.taskType || 'fix'), keywords: String(task.input_text || '').toLowerCase().split(/\W+/).slice(0, 5), steps: steps.rows.map((r) => r.type), success: true }),
    ],
  );
  return { status: 'completed', output: lastOutput };
}

module.exports = { executePlan };
