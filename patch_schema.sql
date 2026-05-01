
create table if not exists telegram_sessions (
  id serial primary key,
  telegram_user_id bigint unique,
  state text,
  data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists telegram_sessions_state_idx on telegram_sessions(state);

create table if not exists hermes_patches (
  id bigserial primary key,
  task_id bigint references hermes_tasks(id) on delete cascade,
  file_path text not null,
  diff_text text not null,
  status text not null default 'pending', -- pending|approved|applied|rejected
  created_at timestamptz default now(),
  approved_at timestamptz,
  applied_at timestamptz
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

alter table hermes_memories add column if not exists memory_type text default 'project_context';
alter table hermes_memories add column if not exists importance int default 3;
alter table hermes_memories add column if not exists confidence numeric default 0.7;
alter table hermes_memories add column if not exists last_used_at timestamptz;

alter table hermes_tasks add column if not exists retry_count integer default 0;
alter table hermes_tasks add column if not exists max_retries integer default 3;
alter table hermes_tasks add column if not exists locked_by text;
alter table hermes_tasks add column if not exists locked_at timestamptz;
alter table hermes_tasks add column if not exists heartbeat_at timestamptz;
alter table hermes_tasks add column if not exists idempotency_key text;
alter table hermes_tasks add column if not exists timeout_at timestamptz;

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
