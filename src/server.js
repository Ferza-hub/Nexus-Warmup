require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { db, initDB } = require('./db');
const { runAllWarmups, runDailyWarmup, getPhase } = require('./warmer');
const { calculateTrustScore, getTrustLabel, isReadyForDemographic } = require('./trust');
const PERSONAS = require('../config/personas');

const app = express();
const PORT = process.env.PORT || 3005;
const TOKEN = process.env.PANEL_PASSWORD || 'changeme123';

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Login route must be before auth middleware
app.post('/api/auth/login', (req, res) => {
  if (req.body.password === TOKEN) res.json({ success: true, token: TOKEN });
  else res.status(401).json({ error: 'Wrong password' });
});

app.use('/api', (req, res, next) => {
  const t = req.headers['x-auth-token'] || req.query.token;
  if (t !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── ACCOUNTS ──
app.get('/api/accounts', (req, res) => {
  const accounts = db.prepare(`
    SELECT a.*, p.host as proxy_host, p.geo as proxy_geo
    FROM accounts a LEFT JOIN proxies p ON a.proxy_id = p.id
    ORDER BY a.id
  `).all().map(a => ({
    ...a,
    phase: getPhase(a.warm_day),
    trust_label: getTrustLabel(a.trust_score),
    is_ready_for_demographic: isReadyForDemographic(a.id),
  }));
  res.json(accounts);
});

app.post('/api/accounts', (req, res) => {
  const { email, password, persona, proxy_id, skip_warmup = 0 } = req.body;
  if (!email || !password || !persona)
    return res.status(400).json({ error: 'email, password, persona required' });
  if (!PERSONAS[persona])
    return res.status(400).json({ error: `Unknown persona: ${persona}` });

  db.prepare(`
    INSERT INTO accounts (email, password, persona, proxy_id, status, skip_warmup)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(email, password, persona, proxy_id || null,
    skip_warmup ? 'ready' : 'new', skip_warmup ? 1 : 0);

  res.json({ success: true });
});

app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM warm_logs WHERE account_id = ?').run(req.params.id);
  db.prepare('DELETE FROM search_history WHERE account_id = ?').run(req.params.id);
  db.prepare('DELETE FROM youtube_history WHERE account_id = ?').run(req.params.id);
  db.prepare('DELETE FROM site_visits WHERE account_id = ?').run(req.params.id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/accounts/:id/warm', async (req, res) => {
  res.json({ success: true, message: 'Warmup started' });
  runDailyWarmup(parseInt(req.params.id)).catch(console.error);
});

// ── PROXIES ──
app.get('/api/proxies', (req, res) => {
  res.json(db.prepare('SELECT * FROM proxies ORDER BY id').all());
});

app.post('/api/proxies/bulk', (req, res) => {
  const { proxies, geo = 'US' } = req.body;
  const insert = db.prepare('INSERT INTO proxies (host, port, username, password, geo) VALUES (?, ?, ?, ?, ?)');
  const insertAll = db.transaction(list => {
    for (const raw of list) {
      const parts = raw.trim().split(':');
      if (parts.length < 2) continue;
      const [host, port, username = null, password = null] = parts;
      insert.run(host, parseInt(port), username, password, geo);
    }
  });
  insertAll(proxies);
  res.json({ success: true });
});

app.delete('/api/proxies/:id', (req, res) => {
  db.prepare('DELETE FROM proxies WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── STATS ──
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM accounts').get().c;
  const warming = db.prepare("SELECT COUNT(*) as c FROM accounts WHERE status = 'warming'").get().c;
  const ready = db.prepare("SELECT COUNT(*) as c FROM accounts WHERE status = 'ready'").get().c;
  const readyForDemo = db.prepare("SELECT id FROM accounts WHERE status = 'ready'").all()
    .filter(a => isReadyForDemographic(a.id)).length;

  const phases = { login_only:0, light:0, medium:0, deep:0, ready:0 };
  db.prepare('SELECT warm_day FROM accounts').all()
    .forEach(a => { const p = getPhase(a.warm_day); phases[p] = (phases[p]||0)+1; });

  const recentLogs = db.prepare(`
    SELECT l.*, a.email, a.persona
    FROM warm_logs l LEFT JOIN accounts a ON l.account_id = a.id
    ORDER BY l.created_at DESC LIMIT 50
  `).all();

  const searchHistory = db.prepare(`
    SELECT s.*, a.email FROM search_history s
    LEFT JOIN accounts a ON s.account_id = a.id
    ORDER BY s.created_at DESC LIMIT 30
  `).all();

  const ytHistory = db.prepare(`
    SELECT y.*, a.email FROM youtube_history y
    LEFT JOIN accounts a ON y.account_id = a.id
    ORDER BY y.created_at DESC LIMIT 20
  `).all();

  res.json({ total, warming, ready, readyForDemo, phases, recentLogs, searchHistory, ytHistory });
});

// ── PERSONAS ──
app.get('/api/personas', (req, res) => {
  res.json(Object.entries(PERSONAS).map(([key, p]) => ({
    key, name: p.name, gender: p.gender,
    age_range: p.age_range, interests: p.interests,
  })));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

async function main() {
  initDB();
  cron.schedule(process.env.WARMUP_CRON || '0 10 * * *', () => {
    console.log('⏰ Daily warmup triggered');
    runAllWarmups().catch(console.error);
  });
  app.listen(PORT, () => {
    console.log(`\n🔥 NexusWarmup running on http://localhost:${PORT}`);
    console.log(`   Personas: ${Object.keys(PERSONAS).length}`);
    console.log(`   Cron: ${process.env.WARMUP_CRON || '0 10 * * *'}\n`);
  });
}

main();
