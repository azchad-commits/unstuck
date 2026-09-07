/* Unstuck — Supabase config.
   Leave both empty and the app runs device-local only (no sign-in UI, nothing leaves the phone).
   Fill them in from Supabase → Project Settings → API. The anon key is safe to ship in a browser
   because Row Level Security (see supabase/schema.sql) is what protects the data. */
window.UNSTUCK_CONFIG = {
  supabaseUrl: "",      // e.g. "https://abcdefghijklmnop.supabase.co"
  supabaseAnonKey: ""   // e.g. "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
};
