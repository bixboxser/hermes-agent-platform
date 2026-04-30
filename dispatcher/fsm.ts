import { TaskStatus } from "./types";

const ALLOWED_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  pending: new Set(["planned"]),
  planned: new Set(["running", "pending_approval"]),
  pending_approval: new Set(["approved", "failed"]),
  approved: new Set(["running"]),
  running: new Set(["done", "failed"]),
  done: new Set(),
  failed: new Set(),
};

export function validateTransition(currentStatus: TaskStatus, nextStatus: TaskStatus): void {
  if (!ALLOWED_TRANSITIONS[currentStatus]?.has(nextStatus)) {
    throw new Error(`Invalid status transition: ${currentStatus} -> ${nextStatus}`);
  }
}
