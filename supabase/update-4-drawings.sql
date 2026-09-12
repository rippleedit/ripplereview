-- RippleReview update: drawings on the frame.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run twice.

alter table public.comments add column if not exists drawing jsonb;
