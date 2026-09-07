/* Dayfall — Supabase config.
   Filled in = sync available (magic-link sign-in, cross-device). Blank = device-local only.
   This is the PUBLISHABLE key — safe to ship in a browser by design; Row Level Security
   (see supabase/schema.sql) is what protects the data. Never put a secret/service key here. */
window.UNSTUCK_CONFIG = {
  supabaseUrl: "https://naacdjiposemwggashen.supabase.co",
  supabaseAnonKey: "sb_publishable_QOZCHZ-3eTEKjksYUYLOoA_qXu06Rm-"
};
