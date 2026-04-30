const { query } = require('../db');

const KEYWORDS = ['fix', 'build', 'implement', 'refactor'];
const DEFAULT_STEPS = ['analyze', 'locate', 'patch', 'test', 'pr'];

function taskType(text = '') {
  const t = text.toLowerCase();
  return KEYWORDS.find((k) => t.includes(k)) || null;
}

async function findReusableSteps(task) {
  const tType = taskType(task.input_text);
  if (!tType) return null;
  const words = String(task.input_text || '').toLowerCase().split(/\W+/).filter(Boolean).slice(0, 10);
  const rows = await query(`select memory_text from hermes_memories where memory_type='decision_log' order by updated_at desc limit 20`);
  for (const r of rows.rows) {
    try {
      const m = JSON.parse(r.memory_text);
      if (m.task_type !== tType || !Array.isArray(m.keywords)) continue;
      if (words.some((w) => m.keywords.includes(w)) && Array.isArray(m.steps) && m.steps.length) return m.steps.slice(0, 5);
    } catch {}
  }
  return null;
}

async function createPlan(task) {
  const tType = taskType(task.input_text);
  if (!tType) return null;
  const planKey = `${task.id}:plan`;
  const existing = await query(`select * from hermes_plans where plan_key=$1 limit 1`, [planKey]);
  if (existing.rows[0]) {
    const steps = await query(`select step_id,type,status from hermes_plan_steps where plan_id=$1 order by step_id asc`, [existing.rows[0].id]);
    return { ...existing.rows[0], plan_key: planKey, steps: steps.rows };
  }

  const reused = await findReusableSteps(task);
  const stepTypes = (reused || DEFAULT_STEPS).slice(0, 5);
  const planRes = await query(`insert into hermes_plans (task_id,plan_key,status) values ($1,$2,'pending') returning *`, [task.id, planKey]);
  const plan = planRes.rows[0];
  for (let i = 0; i < stepTypes.length; i++) {
    await query(`insert into hermes_plan_steps (plan_id,step_id,type,status,result,updated_at) values ($1,$2,$3,'pending','{}',now())`, [plan.id, i + 1, stepTypes[i]]);
  }
  const steps = await query(`select step_id,type,status from hermes_plan_steps where plan_id=$1 order by step_id asc`, [plan.id]);
  return { ...plan, plan_key: planKey, steps: steps.rows };
}

module.exports = { createPlan, taskType };
