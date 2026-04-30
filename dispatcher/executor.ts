import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeError } from "./errors";
import { logEvent } from "./events";
import { validateTransition } from "./fsm";
import { Queryable, Task } from "./types";

const execFileAsync = promisify(execFile);

const ALLOWED_EXACT = new Set(["git status", "git diff", "npm run build", "npm run test", "npm run lint", "npm run typecheck"]);

export class ExecutionBlockedError extends Error {}

function isAllowed(command: string): boolean {
  const trimmed = command.trim();
  return ALLOWED_EXACT.has(trimmed) || trimmed.startsWith("node scripts/safe-");
}

function withResultSafety(output: string): { storedResult: string; fullOutput?: string } {
  if (Buffer.byteLength(output, "utf8") <= 10 * 1024) {
    return { storedResult: output };
  }
  const truncated = output.slice(0, 10 * 1024);
  return { storedResult: truncated, fullOutput: output };
}

async function runCommandWithTimeout(command: string, timeoutMs = 60_000): Promise<string> {
  const { stdout, stderr } = await execFileAsync("bash", ["-lc", command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  return `${stdout ?? ""}${stderr ?? ""}`.trim();
}

export async function executeTask(db: Queryable, task: Task): Promise<string> {
  if (task.retry_count >= 1) {
    throw new Error(`Retry limit reached for task ${task.id}`);
  }

  const command = task.input_text.trim();
  if (!isAllowed(command)) {
    throw new ExecutionBlockedError(`Blocked command: ${command}`);
  }

  await db.query("BEGIN");
  try {
    validateTransition(task.status, "running");
    const updated = await db.query(`UPDATE hermes_tasks SET status='running', running_since = NOW() WHERE id=$1 AND status=$2`, [task.id, task.status]);
    if ((updated.rowCount ?? 0) === 0) throw new Error("Race condition entering running state");
    await logEvent(db, task.id, "execution_started", `Executing command: ${command}`, {});
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }

  try {
    const output = await runCommandWithTimeout(command, 60_000);
    const safe = withResultSafety(output);
    await db.query("BEGIN");
    try {
      validateTransition("running", "done");
      await db.query(`UPDATE hermes_tasks SET status='done', result=$1, result_text=$1 WHERE id=$2 AND status='running'`, [safe.storedResult, task.id]);
      await logEvent(db, task.id, "execution_finished", "Execution completed", safe.fullOutput ? { full_output: safe.fullOutput } : {});
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
    return output;
  } catch (error) {
    const normalized = normalizeError(error);
    const timeout = normalized.message.toLowerCase().includes("timed out");
    await db.query("BEGIN");
    try {
      validateTransition("running", "failed");
      await db.query(`UPDATE hermes_tasks SET status='failed', retry_count = retry_count + 1, error_text=$1 WHERE id=$2 AND status='running'`, [normalized.message, task.id]);
      await logEvent(db, task.id, "execution_failed", timeout ? "timeout" : "Execution failed", {
        reason: timeout ? "timeout" : normalized.message,
        error: normalized,
      });
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
    throw error;
  }
}
