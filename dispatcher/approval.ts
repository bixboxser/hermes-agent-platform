import { logEvent } from "./events";
import { validateTransition } from "./fsm";
import { Queryable, TaskStatus } from "./types";

async function updateStatusTx(db: Queryable, taskId: number, from: TaskStatus, to: TaskStatus): Promise<void> {
  validateTransition(from, to);
  const res = await db.query(
    `UPDATE hermes_tasks SET status = $1 WHERE id = $2 AND status = $3`,
    [to, taskId, from],
  );
  if ((res.rowCount ?? 0) === 0) throw new Error(`Race condition updating task ${taskId} ${from} -> ${to}`);
}

export async function approveTask(db: Queryable, taskId: number): Promise<void> {
  await db.query("BEGIN");
  try {
    await updateStatusTx(db, taskId, "pending_approval", "approved");
    await logEvent(db, taskId, "approved", "Task approved", {});
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function rejectTask(db: Queryable, taskId: number): Promise<void> {
  await db.query("BEGIN");
  try {
    await updateStatusTx(db, taskId, "pending_approval", "failed");
    await logEvent(db, taskId, "rejected", "Task rejected", {});
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}

export async function requireApprovalIfHighRisk(db: Queryable, taskId: number, riskLevel: string): Promise<boolean> {
  if (riskLevel !== "high") return false;
  await db.query("BEGIN");
  try {
    await updateStatusTx(db, taskId, "planned", "pending_approval");
    await logEvent(db, taskId, "approval_required", "High-risk task requires approval", {});
    await db.query("COMMIT");
    return true;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
