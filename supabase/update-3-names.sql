-- RippleReview update: never store an email address as a note's author name.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run twice.

create or replace function public.stamp_comment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  new.author_id := auth.uid();
  new.author_name := coalesce(nullif(p.name, ''), split_part(coalesce(p.email, ''), '@', 1), 'Someone');
  new.author_is_admin := coalesce(p.is_admin, false);
  new.client_folder := lower(new.client_folder);
  new.done := false;
  return new;
end $$;

create or replace function public.stamp_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  new.approved_by := auth.uid();
  new.approved_name := coalesce(nullif(p.name, ''), split_part(coalesce(p.email, ''), '@', 1), 'Someone');
  new.client_folder := lower(new.client_folder);
  new.approved_at := now();
  return new;
end $$;

-- Tidy up anything already written that way.
update public.comments set author_name = split_part(author_name, '@', 1) where author_name like '%@%';
update public.approvals set approved_name = split_part(approved_name, '@', 1) where approved_name like '%@%';
