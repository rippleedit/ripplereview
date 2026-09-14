-- RippleReview update: emoji reactions on notes and replies.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run twice.
--
-- One reaction per person per note, like a chat app: picking another emoji
-- swaps it, picking the same one again takes it back. Whoever can see a note
-- can see and add reactions to it; nobody can react as someone else.

create table if not exists public.reactions (
  comment_id uuid not null references public.comments on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  emoji text not null check (emoji in ('heart', 'thumbs', 'fire', 'laugh', 'wow', 'pray')),
  file_id text not null,             -- copied from the note, so a video's reactions load in one go
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);
create index if not exists reactions_file_id on public.reactions (file_id);
alter table public.reactions enable row level security;

-- Who reacted, and on which video, come from the database, not the app.
-- Not security definer: a note the person can't see isn't found, so it refuses.
create or replace function public.stamp_reaction() returns trigger
language plpgsql set search_path = '' as $$
declare note_file text;
begin
  select file_id into note_file from public.comments where id = new.comment_id;
  if note_file is null then raise exception 'That note is gone'; end if;
  new.user_id := auth.uid();
  new.file_id := note_file;
  new.created_at := now();
  return new;
end $$;

drop trigger if exists reactions_stamp on public.reactions;
create trigger reactions_stamp
  before insert on public.reactions
  for each row execute function public.stamp_reaction();

-- Visible exactly where the note itself is visible.
drop policy if exists "read reactions on notes I can see" on public.reactions;
create policy "read reactions on notes I can see" on public.reactions
  for select to authenticated
  using (exists (select 1 from public.comments c where c.id = comment_id));

drop policy if exists "react to notes I can see" on public.reactions;
create policy "react to notes I can see" on public.reactions
  for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.comments c where c.id = comment_id));

drop policy if exists "take back my own reaction" on public.reactions;
create policy "take back my own reaction" on public.reactions
  for delete to authenticated using (user_id = auth.uid());

grant select, insert, delete on public.reactions to authenticated;
grant all on public.reactions to service_role;
revoke all on public.reactions from anon;
