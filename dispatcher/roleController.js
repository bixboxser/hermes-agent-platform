const { createPlan, taskType } = require('./planner');
const { executePlan } = require('./planExecutor');
const { reviewTask } = require('./reviewer');
const { query } = require('../db');
const { startIdempotentAction, completeIdempotentAction } = require('./idempotency');
const { updateSession } = require('./session');

function short(text) { return String(text || '').slice(0, 120); }

async function storeReviewMemory(task, review) {
  if (review.approved) {
    await query(`insert into hermes_memories (memory_key,memory_text,memory_type,importance,confidence,last_used_at)
      values ($1,$2,'decision_log',3,0.8,now())`, [`review:${task.id}`, JSON.stringify({ pattern: 'successful flow', success: true })]);
  } else if (review.issues.length) {
    await query(`insert into hermes_memories (memory_key,memory_text,memory_type,importance,confidence,last_used_at)
      values ($1,$2,'coding_rule',3,0.6,now())`, [`review:${task.id}`, JSON.stringify({ issue_pattern: short(review.issues[0]), suggestion: 'Fix gate/plan/approval before complete' })]);
  }
}

async function runWithRoles(task, session, ctx) {
  const plan = createPlan(task);
  const resolvedPlan = await plan;
  let execResult;
  if (resolvedPlan) {
    execResult = await executePlan(resolvedPlan, task, session, ctx);
  } else {
    const output = await ctx.runAction(task);
    execResult = { status: 'completed', output, patch_applied: /patch/i.test(output || '') };
  }

  const reviewKey = `${task.id}:review`;
  const start = await startIdempotentAction(reviewKey, task.id, 'review', { status: execResult.status });
  if (start.state === 'completed') return start.existing.response;

  const refreshed = (await query(`select * from hermes_sessions where task_id=$1`, [task.id])).rows[0] || session;
  const review = await reviewTask(task, refreshed, execResult);
  await updateSession(task.id, { review_status: review.approved ? 'approved' : 'rejected', review_confidence: review.confidence, last_error: review.approved ? null : short(review.issues.join('; ')) });
  await storeReviewMemory(task, review);

  const final = {
    status: review.approved ? 'completed' : 'failed',
    review_status: review.approved ? 'approved' : 'rejected',
    review_confidence: review.confidence,
    issues: review.issues,
    output: execResult.output || null,
  };
  await completeIdempotentAction(reviewKey, final);
  return final;
}

module.exports = { runWithRoles };
