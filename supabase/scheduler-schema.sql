-- SCHEDULER (replaces the old kmpanel.onrender.com service)
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
-- Additive only: creates two NEW tables (sched_orders, sched_legs). It does not touch any existing table.

create table if not exists sched_orders (
  id uuid primary key,
  name text not null,
  link text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'completed')),
  base_url text,
  key_hint text,                                  -- masked API key (e.g. "ab12••••"), never the real key
  total_legs integer not null default 0,
  done_legs integer not null default 0,
  failed_legs integer not null default 0,
  total_quantity bigint not null default 0,
  by_category jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists sched_legs (
  id uuid primary key,
  order_id uuid not null references sched_orders(id) on delete cascade,
  service_id text not null,
  link text not null,
  quantity integer not null,
  category text not null default 'other',
  service_label text,
  base_url text not null,
  api_key_enc text not null,                      -- panel API key, AES-256-GCM encrypted with PROVIDER_ENCRYPTION_KEY
  comments text,
  fire_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed', 'paused')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  done_at timestamptz,
  provider_order_id text,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists sched_legs_due_idx on sched_legs (status, fire_at);
create index if not exists sched_legs_order_idx on sched_legs (order_id, status);
create index if not exists sched_legs_done_idx on sched_legs (status, done_at);
create index if not exists sched_orders_created_idx on sched_orders (created_at desc);

-- Row Level Security ON with no policies = nobody can read these tables with the public (anon) key.
-- The server uses the service-role key, which bypasses RLS.
alter table sched_orders enable row level security;
alter table sched_legs enable row level security;
