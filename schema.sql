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
