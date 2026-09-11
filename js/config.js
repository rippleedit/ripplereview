// Your Supabase project. Both values are public by design (they sit in every
// visitor's browser); the database's access rules are what keep data private.
// Find them in Supabase → Project Settings → API (or "Connect").
export const SUPABASE_URL = "https://btwfdctachysmcfhlacc.supabase.co";
export const SUPABASE_KEY = "sb_publishable_8owax7EQNZbSqqyc1oVrlg_Eg3c2uvJ"; // the "publishable" (or "anon") key, never the secret one

// Left empty, the app runs in demo mode with sample data. So does ?demo.
export const DEMO = !SUPABASE_URL || new URLSearchParams(location.search).has("demo");
