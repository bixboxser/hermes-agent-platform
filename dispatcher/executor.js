const { query } = require('../db');

async function updatePlanStatus(planId, status) {
  await query(`update hermes_plans set status=$2 where id=$1`, [planId, status]);
}

async function executeStep(step) {
  const stepType = step.type;
  if (!stepType) {
    throw new Error('unknown_step_type');
  }
  return { stepType };
}

async function executePlan(planId) {
  console.log('PLAN_EXECUTE_START', { planId });
  const planRes = await query(`select * from hermes_plans where id=$1 limit 1`, [planId]);
  const plan = planRes.rows[0];
  if (!plan) throw new Error('plan_not_found');

  const steps = await query(`select * from hermes_plan_steps where plan_id=$1 order by step_order asc`, [planId]);

  await updatePlanStatus(planId, 'running');

  for (const step of steps.rows) {
    const requiresApproval = step.requires_approval === true;
    if (requiresApproval) {
      await updatePlanStatus(planId, 'waiting_approval');
      console.log('PLAN_WAITING_APPROVAL', { planId, stepOrder: step.step_order ?? step.step_id });
      return { status: 'waiting_approval' };
    }

    await query(
      `update hermes_plan_steps set status='running', updated_at=now() where plan_id=$1 and step_id=$2`,
      [planId, step.step_id]
    );

    try {
      await executeStep(step);
      await query(
        `update hermes_plan_steps set status='done', updated_at=now() where plan_id=$1 and step_id=$2`,
        [planId, step.step_id]
      );
      console.log('PLAN_STEP_DONE', { planId, stepOrder: step.step_order ?? step.step_id, stepType: step.step_type ?? step.type });
    } catch (err) {
      await query(
        `update hermes_plan_steps set status='failed', result=$3, updated_at=now() where plan_id=$1 and step_id=$2`,
        [planId, step.step_id, { error: err.message }]
      );
      await updatePlanStatus(planId, 'failed');
      console.log('PLAN_FAILED', { planId, stepOrder: step.step_order ?? step.step_id, error: err.message });
      throw err;
    }
  }

  await updatePlanStatus(planId, 'done');
  return { status: 'done' };
}

module.exports = { executePlan };
