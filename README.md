# ⬡ DecisionAI — Smart Life Decision Engine

> Fully static app for GitHub Pages. The **database schema is built-in** — it auto-creates all tables on first launch. No SQL editor, no manual setup.

---

## 🚀 Deploy in 3 Steps

### Step 1 — Fork & open `config.js`

Fill in your Supabase credentials:

```js
SUPABASE_URL:          'https://xxxx.supabase.co',
SUPABASE_ANON_KEY:     'eyJhbGci...',    // "anon / public" key
SUPABASE_SERVICE_KEY:  'eyJhbGci...',    // "service_role" key
OPENAI_API_KEY:        '',               // optional — enables AI features
```

Get all from: **supabase.com → Your Project → Settings → API**

---

### Step 2 — Enable GitHub Pages

Repo → **Settings → Pages → Source: GitHub Actions**

Push to `main` → GitHub Actions auto-deploys via `.github/workflows/deploy.yml`.

Your live URL: `https://YOUR_USERNAME.github.io/DecisionAI-Web/`

---

### Step 3 — Open the app

On first visit, the app shows a **DATABASE SETUP** screen and automatically:

1. Runs all SQL migrations against your Supabase project  
2. Creates tables: `profiles`, `decisions`, `options`, `results`  
3. Sets up Row Level Security policies  
4. Installs the auto-profile trigger  
5. Grants permissions  

Once done it redirects straight to Sign In. **Never needs to run again** (flag stored in localStorage).

---

## 🔑 Grant Admin Access

After creating your account, run this once in **Supabase → SQL Editor**:

```sql
UPDATE public.profiles SET is_admin = TRUE WHERE email = 'you@example.com';
```

Sign out and back in — the **Admin** panel appears in the sidebar.

---

## 🔒 Security Note

The `SUPABASE_SERVICE_KEY` in `config.js` is only needed for the one-time migration. After setup you can remove it from the file if your repo is public. Row Level Security enforces all data access.

---

## 📁 File Structure

```
DecisionAI-Web/
├── config.js                     ← YOUR ONLY EDIT — put credentials here
├── index.html                    ← Full SPA
├── css/style.css                 ← Terminal-noir dark theme
├── js/app.js                     ← All logic + embedded schema migration
├── .github/workflows/deploy.yml  ← Auto GitHub Pages CI/CD
└── README.md
```

## ✨ Features
- Auto database migration on first run
- Supabase email/password auth
- 3-step decision wizard (2–10 options)
- In-browser weighted scoring engine
- Risk personality adaptation (Conservative / Balanced / Aggressive)
- ⬡ Decide For Me — instant one-click decision
- OpenAI GPT-4o-mini AI analysis (optional)
- Dashboard with 5 Chart.js chart types
- Decision history with search & filters
- Admin panel: scoring weights, user management, platform stats
- 100% static — no server, no build step
