create table if not exists telegram_users (
  id bigserial primary key,
  telegram_user_id bigint unique not null,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  is_allowed boolean default false
);

create table if not exists hermes_tasks (
  id bigserial primary key,
  telegram_chat_id bigint not null,
  telegram_user_id bigint not null,
  input_text text not null,
  intent text,
  status text not null default 'pending',
  result_text text,
  error_text text,
  issue_url text,
  issue_number bigint,
  codex_triggered_at timestamptz,
  codex_trigger_comment_url text,
  pull_request_url text,
  pull_request_number bigint,
  pull_request_detected_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists hermes_task_events (
  id bigserial primary key,
  task_id bigint references hermes_tasks(id) on delete cascade,
  event_type text not null,
  message text,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
alter table hermes_task_events add column if not exists metadata jsonb default '{}'::jsonb;
alter table hermes_task_events add column if not exists sequence_id bigserial;
create index if not exists idx_hermes_task_events_task_created on hermes_task_events(task_id, created_at);
create index if not exists idx_hermes_task_events_task_type_created on hermes_task_events(task_id, event_type, created_at);

create table if not exists hermes_memories (
  id bigserial primary key,
  memory_key text,
  memory_text text not null,
  source text default 'telegram',
  trust_score numeric default 0.5,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists hermes_action_logs (
  id bigserial primary key,
  task_id bigint references hermes_tasks(id) on delete set null,
  action_name text not null,
  input jsonb default '{}'::jsonb,
  output jsonb default '{}'::jsonb,
  status text not null,
  created_at timestamptz default now()
);

create table if not exists hermes_approvals (
  id bigserial primary key,
  task_id bigint references hermes_tasks(id) on delete cascade,
  status text not null default 'pending',
  action_type text not null,
  risk_level text not null,
  approval_token text unique not null,
  expires_at timestamptz not null,
  created_at timestamptz default now(),
  executed_at timestamptz
);

create table if not exists hermes_sessions (
  id bigserial primary key,
  task_id bigint unique references hermes_tasks(id) on delete cascade,
  status text,
  branch_name text,
  patch_id bigint,
  pr_url text,
  last_error text,
  last_gate_status text
);

create table if not exists hermes_session_actions (
  id bigserial primary key,
  session_id bigint references hermes_sessions(id) on delete cascade,
  action_type text not null,
  status text not null,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

alter table hermes_tasks add column if not exists retry_count integer default 0;
alter table hermes_tasks add column if not exists max_retries integer default 3;
alter table hermes_tasks add column if not exists locked_by text;
alter table hermes_tasks add column if not exists locked_at timestamptz;
alter table hermes_tasks add column if not exists heartbeat_at timestamptz;
alter table hermes_tasks add column if not exists idempotency_key text;
alter table hermes_tasks add column if not exists timeout_at timestamptz;
alter table hermes_tasks add column if not exists approved_by text;
alter table hermes_tasks add column if not exists approved_at timestamptz;
alter table hermes_tasks add column if not exists approval_snapshot_hash text;
alter table hermes_tasks add column if not exists approval_snapshot_payload jsonb default '{}'::jsonb;
alter table hermes_tasks add column if not exists approval_expires_at timestamptz;
alter table hermes_tasks add column if not exists result_summary jsonb default '{}'::jsonb;
alter table hermes_tasks add column if not exists execution_started_at timestamptz;
alter table hermes_tasks add column if not exists execution_completed_at timestamptz;
alter table hermes_tasks add column if not exists duration_ms integer;
alter table hermes_tasks add constraint hermes_tasks_status_check
  check (status in ('pending','planned','pending_approval','approved','running','completed','failed')) not valid;
alter table hermes_tasks add constraint hermes_tasks_idempotency_key_uq unique (idempotency_key);

alter table hermes_approvals add column if not exists payload_hash text;
alter table hermes_approvals add column if not exists executed_by text;
alter table hermes_approvals add column if not exists idempotency_key text;

create table if not exists hermes_idempotency_keys (
  id bigserial primary key,
  key text unique not null,
  task_id bigint references hermes_tasks(id) on delete set null,
  action_type text not null,
  status text not null default 'started',
  request_hash text,
  response jsonb default '{}'::jsonb,
  error_text text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists hermes_tasks_status_idx on hermes_tasks(status);
create index if not exists hermes_tasks_heartbeat_idx on hermes_tasks(heartbeat_at);
create index if not exists hermes_idempotency_task_idx on hermes_idempotency_keys(task_id);

create table if not exists hermes_worker_status (
  worker_id text primary key,
  last_heartbeat_at timestamptz,
  status text
);
create index if not exists hermes_worker_status_heartbeat_idx on hermes_worker_status(last_heartbeat_at);

alter table hermes_sessions add column if not exists debug_attempts integer default 0;
alter table hermes_sessions add column if not exists last_error_type text;

create table if not exists hermes_plans (
  id bigserial primary key,
  task_id bigint references hermes_tasks(id) on delete cascade,
  plan_key text unique,
  status text not null default 'pending',
  created_at timestamptz default now()
);

create table if not exists hermes_plan_steps (
  id bigserial primary key,
  plan_id bigint references hermes_plans(id) on delete cascade,
  step_id integer not null,
  type text not null,
  status text not null default 'pending',
  result jsonb default '{}'::jsonb,
  updated_at timestamptz default now(),
  unique(plan_id, step_id)
);

alter table hermes_sessions add column if not exists plan_id bigint;
alter table hermes_sessions add column if not exists current_step_id integer;
alter table hermes_sessions add column if not exists review_status text;
alter table hermes_sessions add column if not exists review_confidence numeric;

create table if not exists hermes_goals (
  id bigserial primary key,
  name text not null,
  type text not null,
  status text not null default 'active',
  schedule_interval_seconds integer not null,
  last_run_at timestamptz,
  next_run_at timestamptz not null default now(),
  failure_count integer not null default 0,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);
alter table hermes_tasks add column if not exists source text;
alter table hermes_tasks add column if not exists goal_id bigint references hermes_goals(id) on delete set null;
create index if not exists hermes_goals_status_next_run_idx on hermes_goals(status,next_run_at);

create or replace function hermes_validate_task_status_transition()
returns trigger as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if old.status = 'pending' and new.status <> 'planned' then
      raise exception 'invalid transition % -> %', old.status, new.status;
    elsif old.status = 'planned' and new.status <> 'pending_approval' then
      raise exception 'invalid transition % -> %', old.status, new.status;
    elsif old.status = 'pending_approval' and new.status not in ('approved','failed') then
      raise exception 'invalid transition % -> %', old.status, new.status;
    elsif old.status = 'pending_approval' and new.status = 'approved' and (new.approved_by is null or new.approved_at is null) then
      raise exception 'approved status requires approved_by and approved_at';
    elsif old.status = 'approved' and new.status <> 'running' then
      raise exception 'invalid transition % -> %', old.status, new.status;
    elsif old.status = 'running' and new.status not in ('completed','failed','planned') then
      raise exception 'invalid transition % -> %', old.status, new.status;
    elsif old.status in ('completed','failed') then
      raise exception 'terminal status cannot transition % -> %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists hermes_tasks_transition_guard on hermes_tasks;
create trigger hermes_tasks_transition_guard
before update on hermes_tasks
for each row
execute function hermes_validate_task_status_transition();

create or replace function hermes_log_task_status_change()
returns trigger as $$
begin
  if new.status is distinct from old.status then
    insert into hermes_task_events(task_id, event_type, message, payload)
    values (new.id, 'status_transition', old.status || ' -> ' || new.status, jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists hermes_tasks_transition_event on hermes_tasks;
create trigger hermes_tasks_transition_event
after update on hermes_tasks
for each row
execute function hermes_log_task_status_change();

revoke update(status, approved_by, approved_at, locked_by, locked_at, heartbeat_at, timeout_at) on hermes_tasks from public;
