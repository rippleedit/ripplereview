-- RippleReview update: the studio sees each client's picture beside their notes.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run twice.
--
-- The rule for reading profiles let a login see itself, the studio, and people
-- in its own folder. The studio has no folder, so it saw no client at all and
-- their notes fell back to initials. Now the studio sees everyone; a client
-- still sees only themselves, the studio and their own space.

drop policy if exists "read people in my space" on public.profiles;
create policy "read people in my space" on public.profiles
  for select to authenticated
  using (id = auth.uid() or is_admin or public.is_admin() or lower(client_folder) = public.my_folder());
