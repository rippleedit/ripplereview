-- RippleReview update: finished projects, "done reviewing" notices, presence.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run twice.

-- 1. Project status. Only the studio decides what is finished.
create table if not exists public.project_status (
  client_folder text not null,
  project text not null,
  finished boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (client_folder, project)
);
alter table public.project_status enable row level security;

drop policy if exists "read status in my space" on public.project_status;
create policy "read status in my space" on public.project_status
  for select to authenticated using (public.can_see(client_folder));

drop policy if exists "studio sets status" on public.project_status;
create policy "studio sets status" on public.project_status
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select, insert, update, delete on public.project_status to authenticated;
grant all on public.project_status to service_role;

-- 2. "I'm done reviewing": one row per time a client hands their notes over.
create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  file_id text not null,
  client_folder text not null,
  by_name text not null default '',
  note_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists submissions_file_id on public.submissions (file_id);
alter table public.submissions enable row level security;

drop policy if exists "read submissions in my space" on public.submissions;
create policy "read submissions in my space" on public.submissions
  for select to authenticated using (public.can_see(client_folder));

grant select on public.submissions to authenticated;
grant all on public.submissions to service_role;

-- 3. Presence: each login touches its own timestamp, nothing else.
alter table public.profiles add column if not exists last_seen timestamptz;

drop policy if exists "touch my own last seen" on public.profiles;
create policy "touch my own last seen" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

revoke update on public.profiles from authenticated;
grant update (last_seen) on public.profiles to authenticated;
grant select (id, name, avatar, is_admin, client_folder, last_seen) on public.profiles to authenticated;
