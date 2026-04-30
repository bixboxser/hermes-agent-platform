import { pool } from "../db";
import { requireApprovalIfHighRisk } from "./approval";
import { normalizeError } from "./errors";
import { executeTask } from "./executor";
import { logEvent } from "./events";
import { validateTransition } from "./fsm";
import { syncGithubComment } from "./github";
import { recallMemories } from "./memory";
import { planTask } from "./planner";
import { Task } from "./types";

export async function findActiveDuplicateTaskId(inputText: string): Promise<number | null> {
  const dup = await pool.query(
    `SELECT id FROM hermes_tasks WHERE input_text = $1 AND status IN ('pending','planned','running') LIMIT 1`,
    [inputText],
  );
  return (dup.rowCount ?? 0) > 0 ? (dup.rows[0].id as number) : null;
}


export async function createTaskOrReuse(taskPayload: { input_text: string; telegram_chat_id: number; telegram_user_id: number }): Promise<number> {
  await pool.query("BEGIN");
  try {
    const existingId = await findActiveDuplicateTaskId(taskPayload.input_text);
    if (existingId) {
      await pool.query("COMMIT");
      return existingId;
    }
    const created = await pool.query(
      `INSERT INTO hermes_tasks (input_text, telegram_chat_id, telegram_user_id, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [taskPayload.input_text, taskPayload.telegram_chat_id, taskPayload.telegram_user_id],
    );
    await pool.query("COMMIT");
    return created.rows[0].id as number;
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
async function recoverHungTasks(): Promise<void> {
  const hung = await pool.query(`SELECT id FROM hermes_tasks WHERE status = 'running' AND running_since < NOW() - INTERVAL '10 minutes'`);
  for (const row of hung.rows) {
    await pool.query("BEGIN");
    try {
      validateTransition("running", "failed");
      await pool.query(`UPDATE hermes_tasks SET status='failed' WHERE id=$1 AND status='running'`, [row.id]);
      await logEvent(pool, row.id, "execution_failed", "hung task recovered", { reason: "hung task recovered" });
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      const normalized = normalizeError(error);
      await logEvent(pool, row.id, "orchestrator_error", "Hung task recovery failed", { error: normalized });
      throw error;
    }
  }
}

async function loadTaskForUpdate(taskId: number): Promise<Task | null> {
  const rs = await pool.query(`SELECT * FROM hermes_tasks WHERE id = $1 FOR UPDATE SKIP LOCKED`, [taskId]);
  if ((rs.rowCount ?? 0) === 0) return null;
  return rs.rows[0] as Task;
}

function memoriesToContext(memories: Record<string, unknown>[]): string {
  return memories.map((m, i) => `${i + 1}. ${JSON.stringify(m)}`).join("\n");
}

export async function orchestrateTask(taskId: number): Promise<void> {
  try {
    await recoverHungTasks();

    await pool.query("BEGIN");
    let task = await loadTaskForUpdate(taskId);
    if (!task) {
      await pool.query("ROLLBACK");
      return;
    }
    await pool.query("COMMIT");

    if (task.status === "pending") {
      const memories = await recallMemories(pool, task.id, task.input_text);
      const plan = await planTask(pool, task, memoriesToContext(memories));
      if (await requireApprovalIfHighRisk(pool, task.id, plan.risk_level)) return;

      const refreshed = await pool.query(`SELECT * FROM hermes_tasks WHERE id = $1`, [task.id]);
      task = refreshed.rows[0] as Task;
      await executeTask(pool, task);
      return;
    }

    if (task.status === "approved") {
      await executeTask(pool, task);
      return;
    }

    if (task.status === "pending_approval") {
      return;
    }

    if (task.status === "done") {
      await syncGithubComment(task);
    }
  } catch (error) {
    const normalized = normalizeError(error);
    await logEvent(pool, taskId, "orchestrator_error", "Orchestration failed", { error: normalized });
    throw error;
  }
}
