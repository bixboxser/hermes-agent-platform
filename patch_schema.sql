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
