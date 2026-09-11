-- RippleReview database.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Once.
--
-- What lives here: logins (profiles), notes (comments) and approvals.
-- What does not: videos. Those stay in Dropbox and are streamed from there.
--
-- Access rule, enforced by the database itself (row level security):
-- a client only ever sees rows for their own folder; the admin sees all.

-- One row per login. The very first login you create becomes the admin.
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null default '',
  name text not null default '',
  client_folder text,                -- the client's Dropbox folder; null for the admin
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  file_id text not null,             -- Dropbox file id: survives renames and moves
  client_folder text not null,       -- lower-case folder name, used for access
  parent_id uuid references public.comments on delete cascade,
  author_id uuid references auth.users on delete set null,
  author_name text not null default '',
  author_is_admin boolean not null default false,
  body text not null check (char_length(body) between 1 and 5000),
  time_sec double precision,         -- null for replies and general notes
  pin_x real check (pin_x between 0 and 1),
  pin_y real check (pin_y between 0 and 1),
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index comments_file_id on public.comments (file_id);

create table public.approvals (
  file_id text primary key,
  client_folder text not null,
  approved_by uuid references auth.users on delete set null,
  approved_name text not null default '',
  approved_at timestamptz not null default now()
);

-- Helpers the access rules use. security definer so they can read profiles.
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

create function public.my_folder() returns text
language sql stable security definer set search_path = '' as $$
  select lower(client_folder) from public.profiles where id = auth.uid()
$$;

create function public.can_see(folder text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin() or (folder is not null and folder = public.my_folder())
$$;

-- A profile is created with every new login; the first one is the admin.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, name, is_admin)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    not exists (select 1 from public.profiles)
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Logins created before this file was run get their profile now;
-- the oldest of them becomes the admin.
insert into public.profiles (id, email, name, is_admin)
select id, coalesce(email, ''), coalesce(raw_user_meta_data ->> 'name', ''),
       row_number() over (order by created_at) = 1
from auth.users
on conflict (id) do nothing;

-- Author fields are filled in by the database, so nobody can post as someone else.
create function public.stamp_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  new.author_id := auth.uid();
  new.author_name := coalesce(nullif(p.name, ''), p.email, '');
  new.author_is_admin := coalesce(p.is_admin, false);
  new.client_folder := lower(new.client_folder);
  new.done := false;
  return new;
end $$;

create trigger comments_stamp
  before insert on public.comments
  for each row execute function public.stamp_comment();

-- Anyone in the space may tick a note done; only its author may reword it.
create function public.guard_comment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.body is distinct from old.body and old.author_id is distinct from auth.uid() then
    raise exception 'You can only edit your own notes';
  end if;
  return new;
end $$;

create trigger comments_guard
  before update on public.comments
  for each row execute function public.guard_comment();

create function public.stamp_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  new.approved_by := auth.uid();
  new.approved_name := coalesce(nullif(p.name, ''), p.email, '');
  new.client_folder := lower(new.client_folder);
  new.approved_at := now();
  return new;
end $$;

create trigger approvals_stamp
  before insert on public.approvals
  for each row execute function public.stamp_approval();

-- Row level security ------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.comments enable row level security;
alter table public.approvals enable row level security;

-- Profiles are read-only from the app. Logins are managed by the admin page,
-- which goes through the server function with full rights.
create policy "read own profile, admin reads all" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());

create policy "read notes in my space" on public.comments
  for select to authenticated using (public.can_see(client_folder));
create policy "write notes in my space" on public.comments
  for insert to authenticated with check (public.can_see(lower(client_folder)));
create policy "tick notes in my space" on public.comments
  for update to authenticated using (public.can_see(client_folder)) with check (public.can_see(client_folder));
create policy "delete own notes, admin deletes any" on public.comments
  for delete to authenticated using (author_id = auth.uid() or public.is_admin());

-- Only these two columns can ever change after a note is posted.
revoke update on public.comments from authenticated, anon;
grant update (body, done) on public.comments to authenticated;

create policy "read approvals in my space" on public.approvals
  for select to authenticated using (public.can_see(client_folder));
create policy "approve in my space" on public.approvals
  for insert to authenticated with check (public.can_see(lower(client_folder)));
create policy "withdraw approval in my space" on public.approvals
  for delete to authenticated using (public.can_see(client_folder));

-- Explicit table rights, so this works whether or not the project exposes new
-- tables automatically. Row level security above still decides which rows.
grant select on public.profiles to authenticated;
grant select, insert, delete on public.comments to authenticated;
grant select, insert, delete on public.approvals to authenticated;
grant all on public.profiles, public.comments, public.approvals to service_role;
grant execute on function public.is_admin(), public.my_folder(), public.can_see(text) to authenticated;

-- Nothing is open to logged-out visitors.
revoke all on public.profiles, public.comments, public.approvals from anon;

-- Keep-awake ping (see .github/workflows/keep-awake.yml). Returns 1, reads nothing.
create or replace function public.ping() returns int language sql as 'select 1';
grant execute on function public.ping() to anon;
