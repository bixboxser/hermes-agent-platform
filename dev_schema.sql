create table if not exists hermes_approvals (
  id bigserial primary key,
  task_id bigint references hermes_tasks(id) on delete cascade,
  action_name text not null,
  command text,
  status text not null default 'pending',
  requested_at timestamptz default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  executed_at timestamptz
);
