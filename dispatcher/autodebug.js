const { query } = require('../db');
const { classifyError } = require('./errorClassifier');
const { runGate } = require('./gate');
const { startIdempotentAction, completeIdempotentAction, failIdempotentAction } = require('./idempotency');
const { updateSession } = require('./session');

function shortError(text) {
  return String(text || '').split('\n').slice(0, 2).join(' ').slice(0, 180);
}

async function recallBugHistory(errorText) {
  const pattern = `%${shortError(errorText).split(' ')[0] || 'error'}%`;
  const res = await query(
    `select memory_text from hermes_memories where memory_type='bug_history'
     and memory_text ilike $1 order by updated_at desc limit 3`,
    [pattern],
  );
  return res.rows.map((r) => r.memory_text);
}

async function storeBugMemory(taskId, errorText, fixSummary) {
  await query(
    `insert into hermes_memories (memory_key,memory_text,memory_type,importance,confidence,last_used_at)
     values ($1,$2,'bug_history',4,0.7,now())`,
    [`bug:${taskId}`, JSON.stringify({ error_pattern: shortError(errorText), fix_summary: fixSummary })],
  );
}

async function handleTaskFailure(task, session, error, context = {}) {
  const errorText = String(error || 'unknown');
  const classified = classifyError(errorText);
  await updateSession(task.id, { last_error_type: classified.type, last_error: shortError(errorText) });

  if (classified.type === 'TRANSIENT') {
    return { handled: false, retryable: true, error_type: classified.type, auto_fix: false };
  }
  if (classified.type === 'ENV') {
    return { handled: true, retryable: false, error_type: classified.type, auto_fix: false };
  }

  let attempts = Number(session?.debug_attempts || 0);
  if (classified.type === 'UNKNOWN' && attempts >= 1) {
    return { handled: true, retryable: false, error_type: classified.type, auto_fix: false };
  }
  if (classified.type === 'CODE' && attempts >= 2) {
    return { handled: true, retryable: false, error_type: classified.type, auto_fix: false };
  }

  attempts += 1;
  await updateSession(task.id, { debug_attempts: attempts });
  const idemKey = `${task.id}:debug:${attempts}`;
  const start = await startIdempotentAction(idemKey, task.id, 'autodebug', { error: shortError(errorText), attempt: attempts });
  if (start.state !== 'started') {
    return { handled: true, retryable: false, error_type: classified.type, auto_fix: false, debug_attempts: attempts };
  }

  const memoryHints = await recallBugHistory(errorText);
  try {
    if (context.onFirstDebugAttempt && attempts === 1) {
      await context.onFirstDebugAttempt(`🛠️ Hermes auto-debug attempt #1 for task #${task.id}`);
    }

    // Reuse existing gate flow; no dangerous command execution.
    const gateResult = await Promise.race([
      runGate(context.projectRoot),
      new Promise((_, reject) => setTimeout(() => reject(new Error('autodebug_timeout')), 90000)),
    ]);

    const passed = gateResult.status === 'PATCH DONE AND GATE PASSED';
    await completeIdempotentAction(idemKey, { gate: gateResult.status, memoryHints: memoryHints.slice(0, 2) });
    await storeBugMemory(task.id, errorText, passed ? 'gate passed after safe retry' : 'gate still failing');

    return {
      handled: true,
      retryable: !passed && attempts < (classified.type === 'CODE' ? 2 : 1),
      error_type: classified.type,
      debug_attempts: attempts,
      auto_fix: passed,
      gate_status: gateResult.status,
      memory_hints_used: memoryHints.slice(0, 2),
    };
  } catch (e) {
    await failIdempotentAction(idemKey, e.message);
    return { handled: true, retryable: attempts < 2, error_type: classified.type, debug_attempts: attempts, auto_fix: false };
  }
}

module.exports = { handleTaskFailure };
