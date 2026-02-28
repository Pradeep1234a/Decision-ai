/* ═══════════════════════════════════════════════════════════
   DecisionAI — app.js
   Includes embedded Supabase schema + auto-migration engine.
   On first run the database is created automatically.
   ═══════════════════════════════════════════════════════════ */
'use strict';

// ─── STATE ────────────────────────────────────────────────
let SB        = null;
let USER      = null;
let PROFILE   = null;
let DECISIONS = [];
let CHARTS    = {};
let CUR_PAGE  = 'dashboard';
let PREV_PAGE = null;
let OPT_IDX   = 0;

const LS = {
  get: k => { try { return JSON.parse(localStorage.getItem('dai_' + k)) } catch { return null } },
  set: (k, v) => localStorage.setItem('dai_' + k, JSON.stringify(v)),
};

const CAT_ICONS = {
  career:'💼', finance:'💰', relationships:'❤️', health:'🏃',
  education:'🎓', lifestyle:'🌟', business:'🚀', travel:'✈️',
};

// ═══════════════════════════════════════════════════════════
// EMBEDDED DATABASE SCHEMA
// Split into individual statements — each run independently
// ═══════════════════════════════════════════════════════════

const SCHEMA_STEPS = [
  {
    label: 'Enable UUID extension',
    sql: `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`,
  },
  {
    label: 'Create profiles table',
    sql: `
      CREATE TABLE IF NOT EXISTS public.profiles (
        id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        email            TEXT NOT NULL,
        full_name        TEXT,
        risk_personality TEXT DEFAULT 'balanced'
                         CHECK (risk_personality IN ('conservative','balanced','aggressive')),
        is_admin         BOOLEAN DEFAULT FALSE,
        is_premium       BOOLEAN DEFAULT FALSE,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );`,
  },
  {
    label: 'Create decisions table',
    sql: `
      CREATE TABLE IF NOT EXISTS public.decisions (
        id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        title                   TEXT NOT NULL,
        description             TEXT,
        category                TEXT,
        status                  TEXT DEFAULT 'pending'
                                CHECK (status IN ('pending','analyzed','decided','completed','cancelled')),
        confidence_score        FLOAT DEFAULT 0,
        risk_level              TEXT DEFAULT 'medium'
                                CHECK (risk_level IN ('low','medium','high','critical')),
        risk_personality        TEXT DEFAULT 'balanced',
        chosen_option_id        UUID,
        ai_summary              TEXT,
        ai_long_term_prediction TEXT,
        ai_emotional_impact     TEXT,
        tags                    TEXT[],
        is_public               BOOLEAN DEFAULT FALSE,
        outcome_rating          INTEGER CHECK (outcome_rating BETWEEN 1 AND 5),
        outcome_notes           TEXT,
        created_at              TIMESTAMPTZ DEFAULT NOW(),
        updated_at              TIMESTAMPTZ DEFAULT NOW()
      );`,
  },
  {
    label: 'Create options table',
    sql: `
      CREATE TABLE IF NOT EXISTS public.options (
        id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        decision_id      UUID NOT NULL REFERENCES public.decisions(id) ON DELETE CASCADE,
        label            TEXT NOT NULL,
        description      TEXT,
        cost             FLOAT DEFAULT 0,
        time_required    FLOAT DEFAULT 0,
        risk_level       FLOAT DEFAULT 5 CHECK (risk_level BETWEEN 0 AND 10),
        priority         FLOAT DEFAULT 5 CHECK (priority BETWEEN 0 AND 10),
        reward_potential FLOAT DEFAULT 5 CHECK (reward_potential BETWEEN 0 AND 10),
        feasibility      FLOAT DEFAULT 5 CHECK (feasibility BETWEEN 0 AND 10),
        weighted_score   FLOAT DEFAULT 0,
        pros             TEXT[],
        cons             TEXT[],
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );`,
  },
  {
    label: 'Create results table',
    sql: `
      CREATE TABLE IF NOT EXISTS public.results (
        id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        decision_id           UUID NOT NULL REFERENCES public.decisions(id) ON DELETE CASCADE,
        best_option_id        UUID,
        analysis_data         JSONB DEFAULT '{}',
        score_breakdown       JSONB DEFAULT '{}',
        confidence_percentage FLOAT DEFAULT 0,
        risk_assessment       TEXT,
        recommendation        TEXT,
        alternative_suggestion TEXT,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(decision_id)
      );`,
  },
  {
    label: 'Create indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_decisions_user    ON public.decisions(user_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_status  ON public.decisions(status);
      CREATE INDEX IF NOT EXISTS idx_decisions_created ON public.decisions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_options_decision  ON public.options(decision_id);
      CREATE INDEX IF NOT EXISTS idx_results_decision  ON public.results(decision_id);`,
  },
  {
    label: 'Enable Row Level Security',
    sql: `
      ALTER TABLE public.profiles  ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.options   ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.results   ENABLE ROW LEVEL SECURITY;`,
  },
  {
    label: 'Create RLS policies — profiles',
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='profile_own_select') THEN
          CREATE POLICY profile_own_select ON public.profiles FOR SELECT USING (auth.uid() = id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='profile_own_insert') THEN
          CREATE POLICY profile_own_insert ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='profile_own_update') THEN
          CREATE POLICY profile_own_update ON public.profiles FOR UPDATE USING (auth.uid() = id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='profiles' AND policyname='admin_view_all_profiles') THEN
          CREATE POLICY admin_view_all_profiles ON public.profiles FOR SELECT
            USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_admin = TRUE));
        END IF;
      END $$;`,
  },
  {
    label: 'Create RLS policies — decisions',
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='decisions' AND policyname='decision_select') THEN
          CREATE POLICY decision_select ON public.decisions FOR SELECT USING (auth.uid() = user_id OR is_public = TRUE);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='decisions' AND policyname='decision_insert') THEN
          CREATE POLICY decision_insert ON public.decisions FOR INSERT WITH CHECK (auth.uid() = user_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='decisions' AND policyname='decision_update') THEN
          CREATE POLICY decision_update ON public.decisions FOR UPDATE USING (auth.uid() = user_id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='decisions' AND policyname='decision_delete') THEN
          CREATE POLICY decision_delete ON public.decisions FOR DELETE USING (auth.uid() = user_id);
        END IF;
      END $$;`,
  },
  {
    label: 'Create RLS policies — options & results',
    sql: `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='options' AND policyname='option_select') THEN
          CREATE POLICY option_select ON public.options FOR SELECT
            USING (EXISTS (SELECT 1 FROM public.decisions d WHERE d.id = decision_id AND (d.user_id = auth.uid() OR d.is_public)));
          CREATE POLICY option_insert ON public.options FOR INSERT
            WITH CHECK (EXISTS (SELECT 1 FROM public.decisions d WHERE d.id = decision_id AND d.user_id = auth.uid()));
          CREATE POLICY option_update ON public.options FOR UPDATE
            USING (EXISTS (SELECT 1 FROM public.decisions d WHERE d.id = decision_id AND d.user_id = auth.uid()));
          CREATE POLICY option_delete ON public.options FOR DELETE
            USING (EXISTS (SELECT 1 FROM public.decisions d WHERE d.id = decision_id AND d.user_id = auth.uid()));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='results' AND policyname='result_select') THEN
          CREATE POLICY result_select ON public.results FOR SELECT
            USING (EXISTS (SELECT 1 FROM public.decisions d WHERE d.id = decision_id AND (d.user_id = auth.uid() OR d.is_public)));
          CREATE POLICY result_insert ON public.results FOR INSERT
            WITH CHECK (EXISTS (SELECT 1 FROM public.decisions d WHERE d.id = decision_id AND d.user_id = auth.uid()));
          CREATE POLICY result_update ON public.results FOR UPDATE
            USING (EXISTS (SELECT 1 FROM public.decisions d WHERE d.id = decision_id AND d.user_id = auth.uid()));
        END IF;
      END $$;`,
  },
  {
    label: 'Create auto-profile trigger',
    sql: `
      CREATE OR REPLACE FUNCTION public.handle_new_user()
      RETURNS TRIGGER AS $$
      BEGIN
        INSERT INTO public.profiles (id, email, full_name)
        VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name')
        ON CONFLICT (id) DO NOTHING;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;

      DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
      CREATE TRIGGER on_auth_user_created
        AFTER INSERT ON auth.users
        FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();`,
  },
  {
    label: 'Grant permissions',
    sql: `
      GRANT USAGE ON SCHEMA public TO anon, authenticated;
      GRANT ALL ON ALL TABLES    IN SCHEMA public TO authenticated;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;`,
  },
];

// ═══════════════════════════════════════════════════════════
// MIGRATION ENGINE
// Uses Supabase pg-meta SQL endpoint with service role key
// ═══════════════════════════════════════════════════════════

function migLog(text, type = 'run') {
  const icons = { ok:'✓', run:'…', skip:'–', err:'✕' };
  const el = document.createElement('div');
  el.className = `mig-line ${type}`;
  el.innerHTML = `<span class="mig-icon">${icons[type]||'·'}</span><span>${text}</span>`;
  document.getElementById('mig-log').appendChild(el);
  el.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function migStatus(msg) {
  document.getElementById('mig-status').textContent = msg;
}

async function runSQL(sql) {
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/rpc/run_sql`;

  // Primary method: pg-meta query endpoint (Supabase Management API subset)
  const pgMetaUrl = CONFIG.SUPABASE_URL.replace('.supabase.co', '') +
    (CONFIG.SUPABASE_URL.includes('localhost') ? '' : '') +
    `${CONFIG.SUPABASE_URL}/pg-meta/v1/query`;

  // Use the correct Supabase pg-meta endpoint
  const endpoint = `${CONFIG.SUPABASE_URL}/pg-meta/v1/query`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.SUPABASE_SERVICE_KEY}`,
      'apikey': CONFIG.SUPABASE_SERVICE_KEY,
    },
    body: JSON.stringify({ query: sql.trim() }),
  });

  if (!res.ok) {
    const body = await res.text();
    // IF it's "already exists" type error treat as success
    if (body.includes('already exists') || body.includes('duplicate') || res.status === 409) {
      return { skipped: true };
    }
    throw new Error(`HTTP ${res.status}: ${body.substring(0, 200)}`);
  }

  return await res.json();
}

async function checkTablesExist() {
  // Quick check: try to select from profiles with anon key
  const { error } = await SB.from('profiles').select('id').limit(1);
  // If no error or error is "no rows" => tables exist
  if (!error) return true;
  // PGRST116 = no rows found = table exists
  if (error.code === 'PGRST116') return true;
  // Table doesn't exist
  return false;
}

async function runMigration() {
  showScreen('migration');
  document.getElementById('mig-log').innerHTML = '';
  document.getElementById('mig-error').classList.add('hidden');
  document.getElementById('mig-retry-btn').classList.add('hidden');
  document.getElementById('mig-spinner').style.display = 'flex';

  migStatus('Checking database…');

  // Validate service key
  if (!CONFIG.SUPABASE_SERVICE_KEY || CONFIG.SUPABASE_SERVICE_KEY.includes('YOUR_SUPABASE')) {
    document.getElementById('mig-spinner').style.display = 'none';
    document.getElementById('mig-error').textContent =
      'SUPABASE_SERVICE_KEY is not set in config.js\n\n' +
      'Add your Service Role key (found in Supabase → Settings → API → service_role key)';
    document.getElementById('mig-error').classList.remove('hidden');
    document.getElementById('mig-retry-btn').classList.remove('hidden');
    return;
  }

  // Check if already migrated
  migLog('Checking existing schema…', 'run');
  const alreadyExists = await checkTablesExist();

  if (alreadyExists) {
    migLog('Schema already exists — no changes needed', 'skip');
    migStatus('Done ✓');
    setTimeout(() => proceedToApp(), 1200);
    return;
  }

  migLog('Schema not found — running migration…', 'run');

  // Run each step
  for (const step of SCHEMA_STEPS) {
    migStatus(step.label + '…');
    migLog(step.label, 'run');
    try {
      const result = await runSQL(step.sql);
      // Update last log line to ok
      const lines = document.querySelectorAll('.mig-line');
      const last  = lines[lines.length - 1];
      if (last) {
        last.className = 'mig-line ' + (result?.skipped ? 'skip' : 'ok');
        last.querySelector('.mig-icon').textContent = result?.skipped ? '–' : '✓';
      }
    } catch (e) {
      const lines = document.querySelectorAll('.mig-line');
      const last  = lines[lines.length - 1];
      if (last) { last.className = 'mig-line err'; last.querySelector('.mig-icon').textContent = '✕'; }

      // Non-fatal: already exists errors
      const msg = e.message.toLowerCase();
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        migLog(`  └ Already exists — skipped`, 'skip');
        continue;
      }

      // Fatal error
      document.getElementById('mig-spinner').style.display = 'none';
      document.getElementById('mig-error').textContent = `Step failed: "${step.label}"\n\n${e.message}`;
      document.getElementById('mig-error').classList.remove('hidden');
      document.getElementById('mig-retry-btn').classList.remove('hidden');
      return;
    }
  }

  // Mark as migrated in localStorage
  LS.set('schema_done', true);

  migLog('✓ All done! Database ready.', 'ok');
  migStatus('Migration complete ✓');

  setTimeout(() => proceedToApp(), 1500);
}

async function proceedToApp() {
  const { data: { session } } = await SB.auth.getSession();
  if (session) await onSignedIn(session);
  else showScreen('auth');
}

// ═══════════════════════════════════════════════════════════
// GRID BACKGROUND
// ═══════════════════════════════════════════════════════════

function drawGrid() {
  const canvas = document.getElementById('grid-canvas');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const W    = canvas.width  = window.innerWidth;
  const H    = canvas.height = window.innerHeight;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(0,229,200,0.04)';
  ctx.lineWidth   = 1;
  for (let x = 0; x <= W; x += 48) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 48) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
}
window.addEventListener('resize', drawGrid);

// ═══════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════

async function initApp() {
  drawGrid();

  // Validate CONFIG
  if (!window.CONFIG?.SUPABASE_URL || !window.CONFIG?.SUPABASE_ANON_KEY ||
      CONFIG.SUPABASE_URL.includes('YOUR_PROJECT') ||
      CONFIG.SUPABASE_ANON_KEY.includes('YOUR_SUPABASE')) {
    showScreen('config-error');
    return;
  }

  try {
    SB = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  } catch (e) {
    showScreen('config-error');
    return;
  }

  // Check if schema was already applied this browser
  const schemaDone = LS.get('schema_done');

  if (schemaDone) {
    // Quick verify it still exists (in case DB was reset)
    const ok = await checkTablesExist();
    if (!ok) LS.set('schema_done', false);

    if (ok) {
      await proceedToApp();
      return;
    }
  }

  // Run migration
  await runMigration();

  // Auth state changes after migration
  SB.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN'  && session) await onSignedIn(session);
    if (event === 'SIGNED_OUT')            { USER = null; PROFILE = null; DECISIONS = []; showScreen('auth'); }
  });
}

async function onSignedIn(session) {
  USER = session.user;
  await fetchProfile();
  showScreen('app');
  gotoPage('dashboard');
}

// ═══════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
    document.getElementById(`form-${btn.dataset.tab}`).classList.remove('hidden');
    document.getElementById('auth-msg').classList.add('hidden');
  });
});

document.getElementById('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('btn-login');
  btn.innerHTML = '<span class="loading"></span>'; btn.disabled = true;
  const { error } = await SB.auth.signInWithPassword({
    email:    document.getElementById('login-email').value,
    password: document.getElementById('login-password').value,
  });
  btn.textContent = 'Sign In →'; btn.disabled = false;
  if (error) showAuthMsg(error.message, 'err');
});

document.getElementById('form-signup').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('btn-signup');
  btn.innerHTML = '<span class="loading"></span>'; btn.disabled = true;
  const { error } = await SB.auth.signUp({
    email:    document.getElementById('signup-email').value,
    password: document.getElementById('signup-password').value,
    options:  { data: { full_name: document.getElementById('signup-name').value } },
  });
  btn.textContent = 'Create Account ⬡'; btn.disabled = false;
  if (error) showAuthMsg(error.message, 'err');
  else       showAuthMsg('Check your email to confirm, then sign in.', 'ok');
});

document.getElementById('btn-logout').addEventListener('click', () => SB.auth.signOut());

function showAuthMsg(msg, type) {
  const el = document.getElementById('auth-msg');
  el.textContent = msg; el.className = `auth-msg ${type}`; el.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════

async function fetchProfile() {
  const { data } = await SB.from('profiles').select('*').eq('id', USER.id).single();
  PROFILE = data;
  const name = PROFILE?.full_name || USER?.email?.split('@')[0] || '?';
  document.getElementById('sb-avatar').textContent = name[0].toUpperCase();
  document.getElementById('sb-uname').textContent  = name;
  if (PROFILE?.is_admin) document.getElementById('nav-admin').style.display = 'flex';
}

// ═══════════════════════════════════════════════════════════
// SCREEN / PAGE NAVIGATION
// ═══════════════════════════════════════════════════════════

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(`screen-${id}`)?.classList.remove('hidden');
}

function gotoPage(page) {
  PREV_PAGE = CUR_PAGE; CUR_PAGE = page;
  document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.replace('hidden', 'active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  const titles = { dashboard:'Dashboard', new:'New Decision', history:'History', profile:'Profile', admin:'Admin Panel', detail:'Decision Detail' };
  document.getElementById('page-heading').textContent = titles[page] || page;
  if (page === 'dashboard') loadDashboard();
  if (page === 'history')   loadHistory();
  if (page === 'profile')   loadProfilePage();
  if (page === 'admin')     loadAdminPage();
  if (page === 'new')       initWizard();
  document.getElementById('sidebar').classList.remove('open');
}

function goBack() { gotoPage(PREV_PAGE || 'history'); }

document.querySelectorAll('.nav-link').forEach(el => el.addEventListener('click', () => gotoPage(el.dataset.page)));
document.getElementById('mobile-menu-btn').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
document.addEventListener('click', e => {
  const sb = document.getElementById('sidebar');
  if (sb.classList.contains('open') && !sb.contains(e.target) && !e.target.closest('#mobile-menu-btn'))
    sb.classList.remove('open');
});

// ═══════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════

async function loadDashboard() {
  const { data, count } = await SB.from('decisions').select('*', { count:'exact' }).eq('user_id', USER.id).order('created_at', { ascending:false });
  DECISIONS = data || [];
  const analyzed = DECISIONS.filter(d => d.confidence_score > 0);
  const avgConf  = analyzed.length ? (analyzed.reduce((a,d) => a + d.confidence_score, 0) / analyzed.length).toFixed(1) : '—';
  document.getElementById('kpi-total').textContent    = count || 0;
  document.getElementById('kpi-analyzed').textContent = analyzed.length;
  document.getElementById('kpi-conf').textContent     = avgConf !== '—' ? avgConf + '%' : '—';
  document.getElementById('kpi-ai').textContent       = DECISIONS.filter(d => d.ai_summary).length;
  renderTimelineChart(DECISIONS);
  renderCatChart(DECISIONS);
  renderDecList(DECISIONS.slice(0, 6), 'list-recent');
}

// ═══════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════

async function loadHistory() {
  if (!DECISIONS.length) {
    const { data } = await SB.from('decisions').select('*').eq('user_id', USER.id).order('created_at', { ascending:false });
    DECISIONS = data || [];
  }
  renderHistory();
}

function renderHistory() {
  const q = (document.getElementById('hist-search')?.value || '').toLowerCase();
  const c = document.getElementById('hist-cat')?.value || '';
  const s = document.getElementById('hist-status')?.value || '';
  renderDecList(DECISIONS.filter(d =>
    (!q || d.title.toLowerCase().includes(q)) &&
    (!c || d.category === c) &&
    (!s || d.status === s)
  ), 'list-history');
}

// ═══════════════════════════════════════════════════════════
// DECISION LIST
// ═══════════════════════════════════════════════════════════

function renderDecList(items, containerId) {
  const el = document.getElementById(containerId);
  if (!items?.length) { el.innerHTML = `<div class="empty-state"><span class="empty-icon">◈</span>No decisions found.</div>`; return; }
  el.innerHTML = items.map(d => {
    const conf = d.confidence_score || 0;
    const cls  = conf >= 75 ? 'conf-high' : conf >= 50 ? 'conf-med' : 'conf-low';
    const date = new Date(d.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    return `<div class="dec-card" onclick="viewDecision('${d.id}')">
      <div class="dec-cat-icon">${CAT_ICONS[d.category] || '📋'}</div>
      <div class="dec-body">
        <div class="dec-title">${esc(d.title)}</div>
        <div class="dec-meta">${date} · ${d.category || 'Uncategorized'}</div>
      </div>
      <div class="dec-right">
        ${conf > 0 ? `<span class="conf-badge ${cls}">${conf.toFixed(1)}%</span>` : ''}
        <span class="status-tag st-${d.status}">${d.status}</span>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════
// DECISION DETAIL
// ═══════════════════════════════════════════════════════════

async function viewDecision(id) {
  gotoPage('detail');
  const content = document.getElementById('detail-content');
  content.innerHTML = '<div class="empty-state"><span class="loading" style="width:36px;height:36px;border-width:3px"></span></div>';

  const [{ data:d }, { data:opts }, { data:res }] = await Promise.all([
    SB.from('decisions').select('*').eq('id', id).single(),
    SB.from('options').select('*').eq('decision_id', id).order('weighted_score', { ascending:false }),
    SB.from('results').select('*').eq('decision_id', id).single(),
  ]);

  if (!d) { content.innerHTML = '<div class="empty-state">Decision not found.</div>'; return; }

  const conf    = d.confidence_score || 0;
  const confCls = conf >= 75 ? 'conf-high' : conf >= 50 ? 'conf-med' : 'conf-low';
  const scores  = res?.score_breakdown?.breakdown || [];
  const bestRow = scores.find(s => s.rank === 1);

  content.innerHTML = `
    <div class="detail-meta-row">
      <span style="font-size:1.5rem">${CAT_ICONS[d.category] || '📋'}</span>
      <span class="status-tag st-${d.status}">${d.status}</span>
      <span class="risk-tag risk-${d.risk_level || 'medium'}">⚠ ${d.risk_level || 'medium'} risk</span>
    </div>
    <h1 class="detail-title">${esc(d.title)}</h1>
    ${d.description ? `<p style="color:var(--text-2);font-size:.875rem;line-height:1.7;margin-bottom:1.25rem">${esc(d.description)}</p>` : ''}
    <div class="detail-actions">
      <button class="btn btn-prime btn-sm" onclick="openDecideForMe('${d.id}')">⬡ Decide For Me</button>
      <button class="btn btn-outline btn-sm" onclick="openAIModal('${d.id}')">◈ AI Analysis</button>
      <button class="btn btn-danger btn-sm" onclick="deleteDecision('${d.id}')">✕ Delete</button>
    </div>
    ${conf > 0 ? `
    <div class="detail-grid-2">
      <div class="card conf-display">
        <div class="conf-label">Confidence Score</div>
        <div class="conf-big ${confCls}">${conf.toFixed(1)}%</div>
        <div class="conf-badge ${confCls}" style="margin-top:.5rem">
          ${conf>=75?'● HIGH CONFIDENCE':conf>=50?'● MODERATE':'● LOW — gather more data'}
        </div>
        ${bestRow ? `<p style="font-size:.82rem;color:var(--text-2);margin-top:.75rem">Best: <strong style="color:var(--cyan)">${esc(bestRow.label)}</strong></p>` : ''}
      </div>
      <div class="card">
        <div class="chart-title">Score Breakdown</div>
        ${scores.map(s => `<div class="score-row">
          <span class="score-lbl" style="${s.rank===1?'color:var(--cyan)':''}">${esc(s.label)}</span>
          <div class="score-track"><div class="score-fill" style="width:${s.weighted_total}%"></div></div>
          <span class="score-num">${s.weighted_total.toFixed(1)}</span>
        </div>`).join('')}
      </div>
    </div>` : ''}
    ${res?.recommendation ? `
    <div class="card" style="margin-bottom:1rem;border-left:2px solid var(--cyan)">
      <div class="chart-title">🎯 Recommendation</div>
      <p style="font-size:.875rem;color:var(--text-2);line-height:1.75">${esc(res.recommendation)}</p>
      ${res.risk_assessment ? `<p style="margin-top:.5rem;font-size:.82rem;color:var(--amber)">⚠ ${esc(res.risk_assessment)}</p>` : ''}
      ${res.alternative_suggestion ? `<p style="margin-top:.3rem;font-size:.82rem;color:var(--text-2)">💡 ${esc(res.alternative_suggestion)}</p>` : ''}
    </div>` : ''}
    ${d.ai_summary             ? `<div class="ai-block"><h4>◈ AI Summary</h4><p>${esc(d.ai_summary)}</p></div>` : ''}
    ${d.ai_long_term_prediction? `<div class="ai-block"><h4>◷ Long-Term Prediction</h4><p>${esc(d.ai_long_term_prediction)}</p></div>` : ''}
    ${d.ai_emotional_impact    ? `<div class="ai-block" style="margin-bottom:1.5rem"><h4>◉ Emotional Impact</h4><p>${esc(d.ai_emotional_impact)}</p></div>` : ''}
    ${scores.length ? `
    <div class="detail-grid-2" style="margin-bottom:1.5rem">
      <div class="card"><div class="chart-title">Bar Comparison</div><canvas id="d-bar" height="200"></canvas></div>
      <div class="card"><div class="chart-title">Radar Analysis</div><canvas id="d-radar" height="200"></canvas></div>
    </div>` : ''}
    <div class="card">
      <div class="chart-title">All Options</div>
      ${(opts||[]).map(o => `
        <div class="option-row ${bestRow?.option_id===o.id?'best':''}">
          <div>
            <div class="option-row-name">${esc(o.label)}
              ${bestRow?.option_id===o.id?'<span class="conf-badge conf-high" style="font-size:.65rem;margin-left:.4rem">BEST</span>':''}
            </div>
            ${o.description?`<div style="font-size:.78rem;color:var(--text-3)">${esc(o.description)}</div>`:''}
          </div>
          <div class="option-row-stats">
            <span>💰 $${o.cost}</span><span>⏰ ${o.time_required}h</span>
            <span>⚠ ${o.risk_level}/10</span><span>🎯 ${o.priority}/10</span><span>🏆 ${o.reward_potential}/10</span>
            ${o.weighted_score?`<span style="color:var(--cyan);font-weight:700">${o.weighted_score.toFixed(1)} pts</span>`:''}
          </div>
        </div>`).join('')}
    </div>`;

  setTimeout(() => {
    if (scores.length) { renderBarChart('d-bar', scores); renderRadarChart('d-radar', opts||[], scores); }
  }, 80);
}

async function deleteDecision(id) {
  if (!confirm('Delete this decision? This cannot be undone.')) return;
  await Promise.all([
    SB.from('options').delete().eq('decision_id', id),
    SB.from('results').delete().eq('decision_id', id),
  ]);
  await SB.from('decisions').delete().eq('id', id);
  DECISIONS = DECISIONS.filter(d => d.id !== id);
  toast('Decision deleted', 'info');
  gotoPage('history');
}

// ═══════════════════════════════════════════════════════════
// NEW DECISION WIZARD
// ═══════════════════════════════════════════════════════════

function initWizard() {
  OPT_IDX = 0;
  document.getElementById('new-title').value = '';
  document.getElementById('new-desc').value  = '';
  document.getElementById('options-list').innerHTML = '';
  wizSetStep(1);
  addOptionRow(); addOptionRow();
}

function wizSetStep(n) {
  [1,2,3].forEach(i => {
    document.getElementById(`wiz-${i}`).classList.toggle('hidden', i !== n);
    const p = document.getElementById(`wp-${i}`);
    const l = document.getElementById(`wl-${i-1}`);
    p.classList.toggle('active', i === n);
    p.classList.toggle('done',   i < n);
    if (l) l.classList.toggle('done', i <= n);
  });
}

function wizNext(step) {
  if (step === 2 && !document.getElementById('new-title').value.trim()) {
    toast('Please enter a decision title', 'err'); return;
  }
  if (step === 3) {
    const opts = collectOptions();
    if (opts.length < 2) { toast('Add at least 2 options', 'err'); return; }
    renderReview(opts);
  }
  wizSetStep(step);
}

function addOptionRow() {
  OPT_IDX++;
  const n = OPT_IDX;
  const div = document.createElement('div');
  div.className = 'opt-entry'; div.id = `opt-${n}`;
  div.innerHTML = `
    <div class="opt-entry-head">
      <span class="opt-num mono">OPTION ${n}</span>
      ${n > 2 ? `<button class="btn-rm" onclick="document.getElementById('opt-${n}').remove();updateOptCount()">✕ Remove</button>` : ''}
    </div>
    <div class="field-row">
      <div class="field"><label>Label <span class="req">*</span></label><input type="text" id="ol-${n}" placeholder="e.g. Accept the offer"/></div>
      <div class="field"><label>Description</label><input type="text" id="od-${n}" placeholder="Brief context…"/></div>
    </div>
    <div class="opt-metrics">
      <div class="metric-fld"><label>💰 Cost ($)</label><input type="number" id="oc-${n}" value="0" min="0"/></div>
      <div class="metric-fld"><label>⏰ Time (hrs)</label><input type="number" id="ot-${n}" value="0" min="0"/></div>
      <div class="metric-fld">
        <label>⚠ Risk — <span id="rv-risk-${n}" class="metric-val">5</span>/10</label>
        <input type="range" id="or-${n}" min="0" max="10" value="5" step="0.5" oninput="document.getElementById('rv-risk-${n}').textContent=this.value"/>
      </div>
      <div class="metric-fld">
        <label>🎯 Priority — <span id="rv-pri-${n}" class="metric-val">5</span>/10</label>
        <input type="range" id="op-${n}" min="0" max="10" value="5" step="0.5" oninput="document.getElementById('rv-pri-${n}').textContent=this.value"/>
      </div>
      <div class="metric-fld">
        <label>🏆 Reward — <span id="rv-rew-${n}" class="metric-val">5</span>/10</label>
        <input type="range" id="ow-${n}" min="0" max="10" value="5" step="0.5" oninput="document.getElementById('rv-rew-${n}').textContent=this.value"/>
      </div>
      <div class="metric-fld">
        <label>✅ Feasibility — <span id="rv-fea-${n}" class="metric-val">5</span>/10</label>
        <input type="range" id="of-${n}" min="0" max="10" value="5" step="0.5" oninput="document.getElementById('rv-fea-${n}').textContent=this.value"/>
      </div>
    </div>`;
  document.getElementById('options-list').appendChild(div);
  updateOptCount();
}

function updateOptCount() {
  document.getElementById('opt-count-badge').textContent = `(${document.querySelectorAll('.opt-entry').length})`;
}

function collectOptions() {
  return [...document.querySelectorAll('.opt-entry')].reduce((acc, e) => {
    const n = e.id.split('-')[1];
    const label = document.getElementById(`ol-${n}`)?.value?.trim();
    if (!label) return acc;
    acc.push({
      label, description: document.getElementById(`od-${n}`)?.value || '',
      cost:             parseFloat(document.getElementById(`oc-${n}`)?.value) || 0,
      time_required:    parseFloat(document.getElementById(`ot-${n}`)?.value) || 0,
      risk_level:       parseFloat(document.getElementById(`or-${n}`)?.value) || 5,
      priority:         parseFloat(document.getElementById(`op-${n}`)?.value) || 5,
      reward_potential: parseFloat(document.getElementById(`ow-${n}`)?.value) || 5,
      feasibility:      parseFloat(document.getElementById(`of-${n}`)?.value) || 5,
    });
    return acc;
  }, []);
}

function renderReview(opts) {
  const cat   = document.getElementById('new-cat');
  const prof  = document.getElementById('new-risk-profile').value;
  document.getElementById('review-box').innerHTML = `
    <div class="review-title">${esc(document.getElementById('new-title').value)}</div>
    <div class="review-cat mono">Category: ${cat?.selectedOptions[0]?.text || 'None'} · Profile: ${prof}</div>
    ${opts.map((o,i) => `
      <div class="review-option">
        <span><strong>Option ${i+1}:</strong> ${esc(o.label)}</span>
        <span class="review-opt-stats">💰$${o.cost} · ⏰${o.time_required}h · ⚠${o.risk_level}/10</span>
      </div>`).join('')}`;
}

async function submitDecision() {
  const title   = document.getElementById('new-title').value.trim();
  const desc    = document.getElementById('new-desc').value.trim();
  const cat     = document.getElementById('new-cat').value;
  const profile = document.getElementById('new-risk-profile').value;
  const opts    = collectOptions();
  if (!title || opts.length < 2) { toast('Missing required fields', 'err'); return; }

  const btn = document.getElementById('btn-analyze');
  btn.disabled = true; btn.innerHTML = '<span class="loading"></span> Analyzing…';

  try {
    const { data: dec, error: dErr } = await SB.from('decisions')
      .insert({ user_id:USER.id, title, description:desc, category:cat||null, status:'pending', risk_personality:profile })
      .select().single();
    if (dErr) throw dErr;

    const { data: savedOpts, error: oErr } = await SB.from('options')
      .insert(opts.map(o => ({ ...o, decision_id:dec.id }))).select();
    if (oErr) throw oErr;

    const weights = loadWeights();
    const { breakdown, bestId, confidence, riskLevel } = scoreOptions(savedOpts, weights, profile);

    await Promise.all(breakdown.map(b =>
      SB.from('options').update({ weighted_score:b.weighted_total }).eq('id', b.option_id)
    ));

    const riskTexts = {
      low:'Low risk — a safe and predictable path forward.',
      medium:'Moderate risk — consider mitigation strategies.',
      high:'High risk — ensure you have contingency plans.',
      critical:'Critical risk — consider lower-risk alternatives.',
    };

    await SB.from('results').upsert({
      decision_id: dec.id, best_option_id: bestId,
      analysis_data: { weights, risk_personality:profile },
      score_breakdown: { breakdown },
      confidence_percentage: confidence,
      risk_assessment: riskTexts[riskLevel] || '',
      recommendation: `Recommend **${breakdown[0].label}** with ${confidence.toFixed(1)}% confidence.`,
      alternative_suggestion: breakdown[1] ? `**${breakdown[1].label}** is a solid backup.` : null,
    }, { onConflict:'decision_id' });

    await SB.from('decisions').update({ status:'analyzed', confidence_score:confidence, risk_level:riskLevel }).eq('id', dec.id);

    DECISIONS = [];
    toast('Decision analyzed! ⬡', 'ok');
    gotoPage('detail');
    await viewDecision(dec.id);

    // Auto-run AI if key is present
    const aiKey = CONFIG.OPENAI_API_KEY || LS.get('openai_key') || '';
    if (aiKey) { try { await runAIForDecision(dec.id, savedOpts, aiKey, profile); } catch {} }

  } catch (e) {
    toast(`Error: ${e.message}`, 'err');
  } finally {
    btn.disabled = false; btn.innerHTML = '⬡ Run Analysis';
  }
}

// ═══════════════════════════════════════════════════════════
// SCORING ENGINE
// ═══════════════════════════════════════════════════════════

function loadWeights() {
  return LS.get('weights') || { cost:0.25, time:0.20, risk:0.25, priority:0.15, reward:0.15 };
}

const PERSONALITY_MODS = {
  conservative: { cost:0.25, time:0.15, risk:0.40, priority:0.10, reward:0.10 },
  balanced:     { cost:0.25, time:0.20, risk:0.25, priority:0.15, reward:0.15 },
  aggressive:   { cost:0.20, time:0.20, risk:0.10, priority:0.20, reward:0.30 },
};

function scoreOptions(options, weights, personality = 'balanced') {
  const mod = PERSONALITY_MODS[personality] || PERSONALITY_MODS.balanced;
  const w = {};
  const keys = ['cost','time','risk','priority','reward'];
  keys.forEach(k => w[k] = (weights[k]||0)*0.6 + (mod[k]||0)*0.4);
  const t = Object.values(w).reduce((a,b)=>a+b,0);
  keys.forEach(k => w[k] /= t);

  const maxCost = Math.max(...options.map(o=>o.cost||0), 1);
  const maxTime = Math.max(...options.map(o=>o.time_required||0), 1);

  const scored = options.map(o => {
    const cs = Math.max(0, 100 - ((o.cost||0)/maxCost)*100);
    const ts = Math.max(0, 100 - ((o.time_required||0)/maxTime)*100);
    const rs = (10-(o.risk_level||5))*10;
    const ps = (o.priority||5)*10;
    const ws = (o.reward_potential||5)*10;
    const total = cs*w.cost + ts*w.time + rs*w.risk + ps*w.priority + ws*w.reward;
    return { option_id:o.id, label:o.label, cost_score:+cs.toFixed(2), time_score:+ts.toFixed(2),
      risk_score:+rs.toFixed(2), priority_score:+ps.toFixed(2), reward_score:+ws.toFixed(2),
      weighted_total:+total.toFixed(2), raw_risk:o.risk_level||5 };
  });

  scored.sort((a,b) => b.weighted_total - a.weighted_total);
  scored.forEach((s,i) => s.rank = i+1);

  const gap        = scored[0].weighted_total - (scored[1]?.weighted_total || 0);
  const confidence = +(Math.min(99, Math.max(50, 50+(gap/100)*49))).toFixed(1);
  const raw        = scored[0].raw_risk;
  const riskLevel  = raw<=2.5?'low':raw<=5?'medium':raw<=7.5?'high':'critical';

  return { breakdown:scored, bestId:scored[0].option_id, confidence, riskLevel };
}

// ═══════════════════════════════════════════════════════════
// DECIDE FOR ME
// ═══════════════════════════════════════════════════════════

async function openDecideForMe(decId) {
  const body = document.getElementById('modal-decide-body');
  body.innerHTML = '<div style="text-align:center;padding:3rem"><span class="loading" style="width:40px;height:40px;border-width:3px"></span><p style="margin-top:1rem;color:var(--text-2)">Computing optimal choice…</p></div>';
  openModal('modal-decide');

  const { data:opts } = await SB.from('options').select('*').eq('decision_id', decId);
  if (!opts || opts.length < 2) { body.innerHTML = '<p style="color:var(--red);text-align:center;padding:2rem">Need at least 2 options.</p>'; return; }

  const personality = PROFILE?.risk_personality || 'balanced';
  const { breakdown, bestId, confidence, riskLevel } = scoreOptions(opts, loadWeights(), personality);
  const bestOpt = opts.find(o => o.id === bestId);

  let aiSummary = '';
  const aiKey = CONFIG.OPENAI_API_KEY || LS.get('openai_key') || '';
  if (aiKey) { try { const { data:dec } = await SB.from('decisions').select('title,description').eq('id', decId).single(); const r = await callOpenAI(dec, opts, aiKey, personality); aiSummary = r.summary||''; } catch {} }

  await SB.from('decisions').update({ status:'decided', chosen_option_id:bestId, confidence_score:confidence, risk_level:riskLevel, ...(aiSummary?{ai_summary:aiSummary}:{}) }).eq('id', decId);
  DECISIONS = [];

  body.innerHTML = `
    <div class="decide-result">
      <div class="chart-title" style="margin-bottom:.5rem">THE DECISION IS</div>
      <div class="decide-winner">${esc(bestOpt.label)}</div>
      <div class="decide-conf">${confidence.toFixed(1)}% confidence &nbsp;·&nbsp; <span class="risk-tag risk-${riskLevel}">${riskLevel} risk</span></div>
      ${aiSummary?`<div class="ai-block" style="text-align:left;margin-bottom:1.25rem"><h4>◈ AI INSIGHT</h4><p>${esc(aiSummary)}</p></div>`:''}
      <div style="text-align:left;margin-bottom:1.25rem">
        ${breakdown.map((b,i)=>`<div class="score-row">
          <span class="score-lbl" style="${i===0?'color:var(--cyan)':''}">${esc(b.label)}</span>
          <div class="score-track"><div class="score-fill" style="width:${b.weighted_total}%"></div></div>
          <span class="score-num">${b.weighted_total.toFixed(1)}</span>
        </div>`).join('')}
      </div>
      <button class="btn btn-prime full" onclick="closeModal('modal-decide');viewDecision('${decId}')">View Full Detail →</button>
    </div>`;
}

// ═══════════════════════════════════════════════════════════
// AI ANALYSIS
// ═══════════════════════════════════════════════════════════

async function openAIModal(decId) {
  const apiKey = CONFIG.OPENAI_API_KEY || LS.get('openai_key') || '';
  if (!apiKey) { toast('Add your OpenAI API key in Profile to enable AI features.', 'err'); return; }
  const body = document.getElementById('modal-ai-body');
  body.innerHTML = '<div style="text-align:center;padding:3rem"><span class="loading" style="width:40px;height:40px;border-width:3px"></span><p style="margin-top:1rem;color:var(--text-2)">Running AI analysis…</p></div>';
  openModal('modal-ai');
  try {
    const [{ data:dec }, { data:opts }] = await Promise.all([
      SB.from('decisions').select('*').eq('id', decId).single(),
      SB.from('options').select('*').eq('decision_id', decId),
    ]);
    const result = await callOpenAI(dec, opts, apiKey, PROFILE?.risk_personality||'balanced');
    await SB.from('decisions').update({ ai_summary:result.summary, ai_long_term_prediction:result.long_term, ai_emotional_impact:result.emotional }).eq('id', decId);
    DECISIONS = [];
    body.innerHTML = `
      <h2 class="modal-title">◈ AI Analysis</h2>
      <div class="ai-block"><h4>Summary</h4><p>${esc(result.summary)}</p></div>
      ${result.long_term?`<div class="ai-block"><h4>◷ Long-Term Prediction</h4><p>${esc(result.long_term)}</p></div>`:''}
      ${result.emotional?`<div class="ai-block"><h4>◉ Emotional Impact</h4><p>${esc(result.emotional)}</p></div>`:''}
      ${result.insights?.length?`<div class="ai-block"><h4>Key Insights</h4>${result.insights.map(i=>`<div class="insight-line">${esc(i)}</div>`).join('')}</div>`:''}
      ${result.warnings?.length?`<div class="ai-block"><h4>⚠ Warning Flags</h4>${result.warnings.map(w=>`<div class="insight-line warn-line">${esc(w)}</div>`).join('')}</div>`:''}
      <button class="btn btn-prime full" onclick="closeModal('modal-ai');viewDecision('${decId}')">Done ✓</button>`;
    if (CUR_PAGE === 'detail') viewDecision(decId);
  } catch (e) {
    body.innerHTML = `<div style="text-align:center;padding:2rem;color:var(--red)">AI Error: ${esc(e.message)}<br><br><button class="btn btn-ghost" onclick="closeModal('modal-ai')">Close</button></div>`;
  }
}

async function runAIForDecision(decId, opts, apiKey, personality) {
  const { data:dec } = await SB.from('decisions').select('*').eq('id', decId).single();
  const result = await callOpenAI(dec, opts, apiKey, personality);
  await SB.from('decisions').update({ ai_summary:result.summary, ai_long_term_prediction:result.long_term, ai_emotional_impact:result.emotional }).eq('id', decId);
}

async function callOpenAI(dec, opts, apiKey, personality) {
  const model    = CONFIG.DEFAULT_AI_MODEL || 'gpt-4o-mini';
  const optsText = opts.map(o => `  - ${o.label}: cost=$${o.cost}, time=${o.time_required}h, risk=${o.risk_level}/10, priority=${o.priority}/10, reward=${o.reward_potential}/10`).join('\n');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:'POST',
    headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature:0.7, max_tokens:900,
      messages:[
        { role:'system', content:'You are DecisionAI. Respond only with valid JSON, no markdown.' },
        { role:'user', content:`Analyze this decision for a ${personality} risk user.\nDECISION: ${dec.title}\nDESCRIPTION: ${dec.description||'N/A'}\nOPTIONS:\n${optsText}\n\nReturn JSON: {"summary":"...","long_term":"...","emotional":"...","insights":["..."],"warnings":["..."]}` },
      ],
    }),
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `OpenAI HTTP ${res.status}`); }
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content.replace(/```json|```/g,'').trim());
}

// ═══════════════════════════════════════════════════════════
// PROFILE PAGE
// ═══════════════════════════════════════════════════════════

async function loadProfilePage() {
  if (!PROFILE) await fetchProfile();
  const name = PROFILE?.full_name || USER?.email?.split('@')[0] || '?';
  document.getElementById('prof-avatar-big').textContent = name[0].toUpperCase();
  document.getElementById('prof-name-big').textContent   = name;
  document.getElementById('prof-email-big').textContent  = USER?.email || '';
  document.getElementById('prof-name-input').value       = PROFILE?.full_name || '';
  document.getElementById('prof-badges').innerHTML = [
    PROFILE?.is_premium ? '<span class="badge badge-gold">⭐ PREMIUM</span>' : '',
    PROFILE?.is_admin   ? '<span class="badge badge-cyan">◬ ADMIN</span>'   : '',
  ].join('');
  const riskSel = document.getElementById('prof-risk');
  if (PROFILE?.risk_personality) riskSel.value = PROFILE.risk_personality;
  document.getElementById('prof-openai').value = CONFIG.OPENAI_API_KEY || LS.get('openai_key') || '';

  if (!DECISIONS.length) {
    const { data } = await SB.from('decisions').select('*').eq('user_id', USER.id).order('created_at', { ascending:false });
    DECISIONS = data || [];
  }
  renderProfileCatChart(DECISIONS);
  renderConfChart(DECISIONS);
}

async function saveProfile() {
  const risk   = document.getElementById('prof-risk').value;
  const name   = document.getElementById('prof-name-input').value.trim();
  const openai = document.getElementById('prof-openai').value.trim();
  await SB.from('profiles').update({ risk_personality:risk, ...(name?{full_name:name}:{}) }).eq('id', USER.id);
  PROFILE = { ...PROFILE, risk_personality:risk, ...(name?{full_name:name}:{}) };
  if (openai) LS.set('openai_key', openai);
  const n = PROFILE?.full_name || USER?.email?.split('@')[0] || '?';
  document.getElementById('sb-avatar').textContent = n[0].toUpperCase();
  document.getElementById('sb-uname').textContent  = n;
  toast('Profile saved ✓', 'ok');
}

// ═══════════════════════════════════════════════════════════
// ADMIN PAGE
// ═══════════════════════════════════════════════════════════

async function loadAdminPage() {
  const [{ count:uc }, { data:allDecs }] = await Promise.all([
    SB.from('profiles').select('*', { count:'exact', head:true }),
    SB.from('decisions').select('id,status,confidence_score'),
  ]);
  document.getElementById('ak-users').textContent    = uc || 0;
  document.getElementById('ak-decs').textContent     = allDecs?.length || 0;
  document.getElementById('ak-analyzed').textContent = (allDecs||[]).filter(d=>d.confidence_score>0).length;

  const sm = {};
  (allDecs||[]).forEach(d => { sm[d.status]=(sm[d.status]||0)+1; });
  renderAdminStatusChart(sm);

  const w = loadWeights();
  document.getElementById('weights-sliders').innerHTML = [
    ['cost','💰 Cost'],['time','⏰ Time'],['risk','⚠ Risk'],['priority','🎯 Priority'],['reward','🏆 Reward'],
  ].map(([k,lbl]) => `
    <div class="w-slider-row">
      <label>${lbl}</label>
      <input type="range" id="ws-${k}" min="0" max="100" value="${Math.round((w[k]||0)*100)}" oninput="updateWeightTotal()"/>
      <span id="wsv-${k}">${Math.round((w[k]||0)*100)}%</span>
    </div>`).join('');
  updateWeightTotal();
  loadAdminUsers();
}

function updateWeightTotal() {
  const keys = ['cost','time','risk','priority','reward'];
  let total  = 0;
  keys.forEach(k => { const v=parseInt(document.getElementById(`ws-${k}`)?.value||0); document.getElementById(`wsv-${k}`).textContent=v+'%'; total+=v; });
  const el = document.getElementById('w-total');
  el.textContent = total+'%'; el.style.color = total===100?'var(--green)':'var(--red)';
}

function saveWeights() {
  const keys=['cost','time','risk','priority','reward'];
  let total=0; const w={};
  keys.forEach(k => { const v=parseInt(document.getElementById(`ws-${k}`)?.value||0); w[k]=v/100; total+=v; });
  if (total!==100) { toast(`Weights must total 100% (currently ${total}%)`, 'err'); return; }
  LS.set('weights', w);
  toast('Scoring weights saved ✓', 'ok');
}

async function loadAdminUsers() {
  const q = document.getElementById('admin-user-search')?.value?.toLowerCase()||'';
  const { data:users } = await SB.from('profiles').select('*').order('created_at', { ascending:false });
  const rows = (users||[]).filter(u => !q || u.email?.toLowerCase().includes(q));
  const wrap = document.getElementById('admin-users-table');
  if (!rows.length) { wrap.innerHTML='<div class="empty-state">No users found.</div>'; return; }
  wrap.innerHTML = `<table class="admin-table">
    <thead><tr><th>Email</th><th>Name</th><th>Premium</th><th>Admin</th><th>Actions</th></tr></thead>
    <tbody>${rows.map(u=>`<tr>
      <td class="mono" style="font-size:.78rem">${esc(u.email)}</td>
      <td>${esc(u.full_name||'—')}</td>
      <td>${u.is_premium?'<span style="color:var(--amber)">⭐</span>':'—'}</td>
      <td>${u.is_admin?'<span style="color:var(--cyan)">◬</span>':'—'}</td>
      <td><button class="btn btn-sm btn-outline" onclick="togglePremium('${u.id}',${!u.is_premium})">
        ${u.is_premium?'Revoke':'Grant'} Premium
      </button></td>
    </tr>`).join('')}</tbody></table>`;
}

async function togglePremium(userId, enable) {
  await SB.from('profiles').update({ is_premium:enable }).eq('id', userId);
  toast(`Premium ${enable?'granted':'revoked'}`, 'ok');
  loadAdminUsers();
}

// ═══════════════════════════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════════════════════════

const CC = {
  grid:'rgba(0,229,200,0.05)', tick:'rgba(200,223,245,0.4)', label:'rgba(200,223,245,0.55)',
  font:{ family:'JetBrains Mono', size:10 },
  COLORS:['#00e5c8','#4f8dff','#f5a623','#00d68f','#a78bfa','#ff4560','#ff6d00'],
};
const baseScales = () => ({
  x:{ grid:{color:CC.grid}, ticks:{color:CC.tick, font:CC.font} },
  y:{ grid:{color:CC.grid}, ticks:{color:CC.tick, font:CC.font} },
});
function dc(id) { if(CHARTS[id]){CHARTS[id].destroy();delete CHARTS[id];} }

function renderTimelineChart(d) {
  dc('timeline'); const ctx=document.getElementById('chart-timeline')?.getContext('2d'); if(!ctx)return;
  const map={}; d.forEach(x=>{ const m=new Date(x.created_at).toLocaleDateString('en-US',{month:'short',year:'2-digit'}); map[m]=(map[m]||0)+1; });
  const labels=Object.keys(map).slice(-12);
  CHARTS.timeline=new Chart(ctx,{type:'line',data:{labels,datasets:[{label:'Decisions',data:labels.map(l=>map[l]),borderColor:'#00e5c8',backgroundColor:'rgba(0,229,200,.06)',fill:true,tension:.4,pointRadius:3,pointBackgroundColor:'#00e5c8'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:baseScales()}});
}
function renderCatChart(d) {
  dc('cats'); const ctx=document.getElementById('chart-cats')?.getContext('2d'); if(!ctx)return;
  const map={}; d.forEach(x=>{const k=x.category||'Other';map[k]=(map[k]||0)+1;});
  const labels=Object.keys(map);
  CHARTS.cats=new Chart(ctx,{type:'doughnut',data:{labels,datasets:[{data:labels.map(l=>map[l]),backgroundColor:CC.COLORS.map(c=>c+'bb'),borderWidth:0,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'60%',plugins:{legend:{position:'bottom',labels:{color:CC.label,font:CC.font,padding:8}}}}});
}
function renderBarChart(id, scores) {
  dc(id); const ctx=document.getElementById(id)?.getContext('2d'); if(!ctx)return;
  CHARTS[id]=new Chart(ctx,{type:'bar',data:{labels:scores.map(s=>s.label),datasets:[{label:'Score',data:scores.map(s=>s.weighted_total),backgroundColor:CC.COLORS.map(c=>c+'cc'),borderWidth:0,borderRadius:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{...baseScales(),y:{...baseScales().y,min:0,max:100}}}});
}
function renderRadarChart(id, options, scores) {
  dc(id); const ctx=document.getElementById(id)?.getContext('2d'); if(!ctx)return;
  const M=['cost_score','time_score','risk_score','priority_score','reward_score'];
  CHARTS[id]=new Chart(ctx,{type:'radar',data:{labels:['Cost','Time','Risk','Priority','Reward'],datasets:scores.map((s,i)=>({label:s.label,data:M.map(m=>s[m]),borderColor:CC.COLORS[i%CC.COLORS.length],backgroundColor:CC.COLORS[i%CC.COLORS.length]+'18',borderWidth:2,pointRadius:3}))},options:{responsive:true,maintainAspectRatio:false,scales:{r:{min:0,max:100,grid:{color:CC.grid},angleLines:{color:CC.grid},pointLabels:{color:CC.label,font:{family:'Rajdhani',size:11}},ticks:{display:false}}},plugins:{legend:{labels:{color:CC.label,font:{family:'Rajdhani',size:10}}}}}});
}
function renderProfileCatChart(d) {
  dc('prof-cats'); const ctx=document.getElementById('chart-profile-cats')?.getContext('2d'); if(!ctx)return;
  const map={}; d.forEach(x=>{const k=x.category||'Other';map[k]=(map[k]||0)+1;});
  const labels=Object.keys(map);
  CHARTS['prof-cats']=new Chart(ctx,{type:'polarArea',data:{labels:labels.length?labels:['No data'],datasets:[{data:labels.length?labels.map(l=>map[l]):[1],backgroundColor:CC.COLORS.map(c=>c+'99'),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,scales:{r:{grid:{color:CC.grid},ticks:{display:false}}},plugins:{legend:{labels:{color:CC.label,font:CC.font,padding:8}}}}});
}
function renderConfChart(d) {
  dc('prof-conf'); const ctx=document.getElementById('chart-profile-conf')?.getContext('2d'); if(!ctx)return;
  const b={'0–50':0,'50–75':0,'75–90':0,'90–100':0};
  d.forEach(x=>{const c=x.confidence_score||0; if(c<50)b['0–50']++; else if(c<75)b['50–75']++; else if(c<90)b['75–90']++; else b['90–100']++;});
  CHARTS['prof-conf']=new Chart(ctx,{type:'bar',data:{labels:Object.keys(b),datasets:[{label:'Decisions',data:Object.values(b),backgroundColor:['rgba(255,69,96,.7)','rgba(245,166,35,.7)','rgba(0,229,200,.7)','rgba(0,214,143,.7)'],borderWidth:0,borderRadius:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:baseScales()}});
}
function renderAdminStatusChart(sm) {
  dc('admin-status'); const ctx=document.getElementById('chart-admin-status')?.getContext('2d'); if(!ctx)return;
  const labels=Object.keys(sm);
  const SC={pending:'#f5a623',analyzed:'#00e5c8',decided:'#a78bfa',completed:'#00d68f',cancelled:'#555'};
  CHARTS['admin-status']=new Chart(ctx,{type:'bar',data:{labels,datasets:[{label:'Count',data:labels.map(l=>sm[l]),backgroundColor:labels.map(l=>(SC[l]||'#4f8dff')+'cc'),borderWidth:0,borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:baseScales()}});
}

// ═══════════════════════════════════════════════════════════
// MODALS / TOAST / UTILS
// ═══════════════════════════════════════════════════════════

function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

document.querySelectorAll('.modal-overlay').forEach(el => {
  el.addEventListener('click', e => { if(e.target===el) el.classList.add('hidden'); });
});
document.addEventListener('keydown', e => {
  if (e.key==='Escape') document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m=>m.classList.add('hidden'));
});

function toast(msg, type='info', ms=4500) {
  const el=document.createElement('div');
  el.className=`toast ${type}`; el.textContent=msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(()=>{ el.style.cssText+='opacity:0;transform:translateX(20px);transition:.3s'; setTimeout(()=>el.remove(),300); }, ms);
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── INIT ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initApp);
