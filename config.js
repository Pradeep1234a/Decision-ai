/* ═══════════════════════════════════════════════════════════
   DecisionAI — Configuration
   ✏️  Fill in your values below, then push to GitHub.
   The app will auto-create all database tables on first run.
   ═══════════════════════════════════════════════════════════ */

const CONFIG = {

  // ── Supabase ─────────────────────────────────────────────
  // supabase.com → Your Project → Settings → API

  SUPABASE_URL:          'https://YOUR_PROJECT_ID.supabase.co',
  SUPABASE_ANON_KEY:     'YOUR_SUPABASE_ANON_KEY',

  // Service Role key — used ONLY to auto-run the schema on first launch
  // Keep this private (don't share your repo publicly if you put this here)
  // After first run you can remove it — the schema is already in the DB
  SUPABASE_SERVICE_KEY:  'YOUR_SUPABASE_SERVICE_ROLE_KEY',

  // ── OpenAI ────────────────────────────────────────────────
  // platform.openai.com/api-keys  (optional — enables AI features)
  OPENAI_API_KEY:        '',

  // ── App Settings ─────────────────────────────────────────
  DEFAULT_AI_MODEL:      'gpt-4o-mini',

};
