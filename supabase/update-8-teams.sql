-- RippleReview update: client teams, a team leader and team members.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run twice.
--
-- A client space has its team leader (the client's own login, e.g. Sim) and can
-- have team members (e.g. sim-thumbnails). A member only ever sees approved
-- cuts: watch and download the master. No notes, no reactions, no approving.
-- The server function hides everything else in Dropbox; these rules keep the
-- database side shut. Logins are still made by the studio only.

alter table public.profiles add column if not exists team_role text not null default 'leader';
alter table public.profiles drop constraint if exists profiles_team_role_check;
alter table public.profiles add constraint profiles_team_role_check check (team_role in ('leader', 'member'));

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select team_role = 'member' and not is_admin from public.profiles where id = auth.uid()), false)
$$;

-- Reviewing (notes, approving, handing over) is for the studio and the team leader.
create or replace function public.can_review(folder text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_see(folder) and not public.is_member()
$$;

grant execute on function public.is_member(), public.can_review(text) to authenticated;

drop policy if exists "read notes in my space" on public.comments;
create policy "read notes in my space" on public.comments
  for select to authenticated using (public.can_review(client_folder));

drop policy if exists "write notes in my space" on public.comments;
create policy "write notes in my space" on public.comments
  for insert to authenticated with check (public.can_review(lower(client_folder)));

drop policy if exists "tick notes in my space" on public.comments;
create policy "tick notes in my space" on public.comments
  for update to authenticated using (public.can_review(client_folder)) with check (public.can_review(client_folder));

-- A member can see what is approved (that's their whole view), not change it.
drop policy if exists "approve in my space" on public.approvals;
create policy "approve in my space" on public.approvals
  for insert to authenticated with check (public.can_review(lower(client_folder)));

drop policy if exists "withdraw approval in my space" on public.approvals;
create policy "withdraw approval in my space" on public.approvals
  for delete to authenticated using (public.can_review(client_folder));

drop policy if exists "read submissions in my space" on public.submissions;
create policy "read submissions in my space" on public.submissions
  for select to authenticated using (public.can_review(client_folder));

-- Reactions follow the notes they sit on (update-7), so a member sees none.

-- The app reads the role with the rest of the profile; nobody can change their own.
grant select (id, name, avatar, is_admin, client_folder, last_seen, team_role) on public.profiles to authenticated;
