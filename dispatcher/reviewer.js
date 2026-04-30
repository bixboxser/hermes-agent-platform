const { query } = require('../db');

async function reviewTask(task, session, result) {
  const issues = [];

  if ((session.last_gate_status || '').toLowerCase() !== 'patch done and gate passed' && (session.last_gate_status || '').toLowerCase() !== 'passed') {
    issues.push('Gate status is not passed');
  }

  if (session.plan_id) {
    const steps = await query(`select status from hermes_plan_steps where plan_id=$1`, [session.plan_id]);
    if (steps.rows.some((s) => s.status !== 'completed')) issues.push('Plan has incomplete/failed steps');
  }

  if (result && result.error) issues.push('Execution returned error');

  const pendingApprovals = await query(`select count(*)::int as c from hermes_approvals where task_id=$1 and status in ('pending','approved')`, [task.id]);
  if ((pendingApprovals.rows[0]?.c || 0) > 0) issues.push('Approval required but not executed');

  const codeTask = /(fix|build|implement|refactor)/i.test(task.input_text || '');
  if (codeTask && result?.patch_applied && !session.pr_url && !result?.pr_skipped_reason) issues.push('PR missing without skip reason');

  const approved = issues.length === 0;
  const confidence = approved ? 0.85 : 0.6;
  return { approved, issues, confidence };
}

module.exports = { reviewTask };
