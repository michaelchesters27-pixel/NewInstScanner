create extension if not exists pgcrypto;

create table if not exists scanner_state (
  pair text primary key,
  state text not null,
  direction text,
  bias text,
  session text,
  entry numeric,
  stop numeric,
  target numeric,
  rr numeric,
  progress_percent integer,
  summary text,
  key_levels jsonb,
  checklist jsonb,
  last_scan_time timestamptz,
  raw_payload jsonb,
  updated_at timestamptz default now()
);

create table if not exists trade_ideas (
  id uuid primary key default gen_random_uuid(),
  pair text not null,
  state text not null,
  direction text,
  bias text,
  session text,
  entry numeric,
  stop numeric,
  target numeric,
  rr numeric,
  progress_percent integer,
  key_level text,
  summary text,
  checklist jsonb,
  status text not null,
  fingerprint text unique,
  outcome_price numeric,
  scan_time timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists scanner_runs (
  id uuid primary key default gen_random_uuid(),
  pair text not null,
  state text not null,
  progress_percent integer,
  summary text,
  scan_time timestamptz not null,
  created_at timestamptz default now()
);

create index if not exists trade_ideas_scan_time_idx on trade_ideas (scan_time desc);
create index if not exists trade_ideas_status_idx on trade_ideas (status);
create index if not exists scanner_runs_scan_time_idx on scanner_runs (scan_time desc);

alter table scanner_state enable row level security;
alter table trade_ideas enable row level security;
alter table scanner_runs enable row level security;

-- Public read only so the dashboard can load if you later switch to direct anon-key reads.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'scanner_state' and policyname = 'Public read scanner_state'
  ) then
    create policy "Public read scanner_state" on scanner_state for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'trade_ideas' and policyname = 'Public read trade_ideas'
  ) then
    create policy "Public read trade_ideas" on trade_ideas for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'scanner_runs' and policyname = 'Public read scanner_runs'
  ) then
    create policy "Public read scanner_runs" on scanner_runs for select using (true);
  end if;
end $$;
