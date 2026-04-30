import * as crypto from 'crypto';
import { logEvent } from './events';
import { validateTransition } from './fsm';
import { Queryable, TaskStatus } from './types';

function hashPayload(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

async function updateStatusTx(db: Queryable, taskId: number, from: TaskStatus, to: TaskStatus): Promise<void> {
  validateTransition(from, to);
  const res = await db.query(`UPDATE hermes_tasks SET status = $1 WHERE id = $2 AND status = $3`, [to, taskId, from]);
  if ((res.rowCount ?? 0) === 0) throw new Error(`Race condition updating task ${taskId} ${from} -> ${to}`);
}

export async function createCommandApproval(db: Queryable, taskId: number, actionType: string, riskLevel: string, payload: unknown = {}): Promise<string> {
  const token = crypto.randomBytes(16).toString('hex');
  const payloadHash = hashPayload(payload);
  await db.query(
    `insert into hermes_approvals (task_id,status,action_type,risk_level,approval_token,expires_at,payload_hash)
     values ($1,'pending',$2,$3,$4, now() + interval '30 minutes',$5)`,
    [taskId, actionType, riskLevel, token, payloadHash],
  );
  await logEvent(db, taskId, 'approval_required', `Approval required for ${actionType}`, { riskLevel });
  return token;
}

export async function consumeApprovalToken(db: Queryable, taskId: number, token: string, payload: unknown = {}, executedBy = 'system', idempotencyKey: string | null = null): Promise<boolean> {
  const payloadHash = hashPayload(payload);
  const res = await db.query(
    `update hermes_approvals set status='executed', executed_at=now(), executed_by=$4, idempotency_key=coalesce($5,idempotency_key)
     where task_id=$1 and approval_token=$2 and status='approved' and expires_at > now()
       and executed_at is null and payload_hash=$3`,
    [taskId, token, payloadHash, executedBy, idempotencyKey],
  );
  if ((res.rowCount ?? 0) === 1) await logEvent(db, taskId, 'approval_executed', 'Approved action executed', { token });
  return (res.rowCount ?? 0) === 1;
}

export async function approveTask(db: Queryable, taskId: number): Promise<void> {
  await db.query('BEGIN');
  try {
    await updateStatusTx(db, taskId, 'pending_approval', 'approved');
    await db.query(`update hermes_approvals set status='approved' where task_id=$1 and status='pending'`, [taskId]);
    await logEvent(db, taskId, 'approved', 'Task approved', {});
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function rejectTask(db: Queryable, taskId: number): Promise<void> {
  await db.query('BEGIN');
  try {
    await updateStatusTx(db, taskId, 'pending_approval', 'failed');
    await db.query(`update hermes_approvals set status='rejected' where task_id=$1 and status='pending'`, [taskId]);
    await logEvent(db, taskId, 'rejected', 'Task rejected', {});
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function requireApprovalIfHighRisk(db: Queryable, taskId: number, riskLevel: string): Promise<boolean> {
  if (riskLevel !== 'high') return false;
  await db.query('BEGIN');
  try {
    await updateStatusTx(db, taskId, 'planned', 'pending_approval');
    await logEvent(db, taskId, 'approval_required', 'High-risk task requires approval', {});
    await db.query('COMMIT');
    return true;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
