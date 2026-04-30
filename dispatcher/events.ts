import { Queryable } from "./types";

const IDEMPOTENT_EVENTS = new Set([
  "plan_created",
  "memory_loaded",
  "approval_required",
  "approved",
  "rejected",
]);

export async function logEvent(
  db: Queryable,
  taskId: number,
  eventType: string,
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (IDEMPOTENT_EVENTS.has(eventType)) {
    const dup = await db.query(
      `SELECT id FROM hermes_task_events WHERE task_id = $1 AND event_type = $2 LIMIT 1`,
      [taskId, eventType],
    );
    if ((dup.rowCount ?? 0) > 0) {
      return;
    }
  }

  await db.query(
    `INSERT INTO hermes_task_events (task_id, event_type, message, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [taskId, eventType, message, JSON.stringify(metadata)],
  );
}
