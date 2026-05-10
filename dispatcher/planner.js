const { query } = require('../db');

const KEYWORDS = ['fix', 'build', 'implement', 'refactor'];
const DEFAULT_STEPS = ['analyze', 'locate', 'patch', 'test', 'pr'];

function taskType(text = '') {
  const t = text.toLowerCase();
  return KEYWORDS.find((k) => t.includes(k)) || null;
}

async function createPlanForTask(task) {
  const tType = taskType(task.input_text);
  const planKey = `${task.id}:plan`;
  const existing = await query(`select * from hermes_plans where plan_key=$1 limit 1`, [planKey]);
  if (existing.rows[0]) {
    console.log('PLAN_EXISTS', { taskId: task.id, planId: existing.rows[0].id });
    return existing.rows[0];
  }

  const stepTypes = (tType ? DEFAULT_STEPS : ['analyze']).slice(0, 5);
  const planRes = await query(
    `insert into hermes_plans (task_id,plan_key,status) values ($1,$2,'pending') returning *`,
    [task.id, planKey]
  );
  const plan = planRes.rows[0];

  for (let i = 0; i < stepTypes.length; i++) {
    await query(
      `insert into hermes_plan_steps (plan_id, step_id, type, status, result, updated_at)
       values ($1, $2, $3, 'pending', '{}'::jsonb, now())`,
      [plan.id, i + 1, stepTypes[i]]
    );
  }
  if (task.skill_context) {
    await query(
      `insert into hermes_task_events (task_id, event_type, message, payload)
       values ($1, 'skill_context_attached', $2, $3)`,
      [task.id, 'Skill Context available to planner', { truncated: task.skill_context.includes('[Skill Context truncated]') }]
    );
  }
  console.log('PLAN_CREATED', { taskId: task.id, planId: plan.id });
  return plan;
}

module.exports = { createPlanForTask, taskType };
