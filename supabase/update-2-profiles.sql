-- RippleReview update: profile pictures and names.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run twice.

alter table public.profiles add column if not exists avatar text;

drop policy if exists "read own profile, admin reads all" on public.profiles;
drop policy if exists "read people in my space" on public.profiles;
create policy "read people in my space" on public.profiles
  for select to authenticated
  using (id = auth.uid() or is_admin or lower(client_folder) = public.my_folder());

-- Names and pictures are shared inside a space; email addresses are not.
revoke select on public.profiles from authenticated;
grant select (id, name, avatar, is_admin, client_folder) on public.profiles to authenticated;
