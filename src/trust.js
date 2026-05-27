const { db } = require('./db');

// ─── TRUST SCORE CALCULATOR ───
// Max 100 points — graduated criteria untuk GA4 demographic injection

function calculateTrustScore(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) return 0;

  let score = 0;

  // 1. Account age factor (max 30 pts)
  score += Math.min(account.warm_day * 1.5, 30);

  // 2. Activity diversity (max 20 pts)
  const activities = db.prepare(`
    SELECT DISTINCT activity FROM warm_logs WHERE account_id = ? AND status = 'success'
  `).all(accountId);
  score += Math.min(activities.length * 3, 20);

  // 3. YouTube engagement (max 20 pts)
  const ytHistory = db.prepare(
    'SELECT COUNT(*) as c FROM youtube_history WHERE account_id = ?'
  ).get(accountId).c;
  score += Math.min(ytHistory * 1.5, 20);

  // 4. Search click-through (max 15 pts)
  const searchClicks = db.prepare(`
    SELECT COUNT(*) as c FROM search_history
    WHERE account_id = ? AND clicked_url IS NOT NULL
  `).get(accountId).c;
  score += Math.min(searchClicks, 15);

  // 5. Site visit diversity (max 10 pts)
  const uniqueSites = db.prepare(`
    SELECT COUNT(DISTINCT url) as c FROM site_visits WHERE account_id = ?
  `).get(accountId).c;
  score += Math.min(uniqueSites * 0.5, 10);

  // 6. Consistency bonus (max 5 pts)
  // Has activity across multiple days
  const activeDays = db.prepare(`
    SELECT COUNT(DISTINCT DATE(created_at)) as c
    FROM warm_logs WHERE account_id = ? AND status = 'success'
  `).get(accountId).c;
  score += Math.min(activeDays * 0.3, 5);

  return Math.min(Math.round(score), 100);
}

function getTrustLabel(score) {
  if (score < 40) return { label: 'Building', color: 'red', emoji: '🔴' };
  if (score < 75) return { label: 'Warming', color: 'amber', emoji: '🟡' };
  return { label: 'Ready', color: 'green', emoji: '🟢' };
}

function isReadyForDemographic(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account || account.status !== 'ready') return false;

  const score = calculateTrustScore(accountId);
  if (score < 75) return false;

  const ytCount = db.prepare(
    'SELECT COUNT(*) as c FROM youtube_history WHERE account_id = ?'
  ).get(accountId).c;
  if (ytCount < 15) return false;

  const searchClicks = db.prepare(`
    SELECT COUNT(*) as c FROM search_history
    WHERE account_id = ? AND clicked_url IS NOT NULL
  `).get(accountId).c;
  if (searchClicks < 10) return false;

  // No suspension in last 7 days
  const recentBad = db.prepare(`
    SELECT COUNT(*) as c FROM warm_logs
    WHERE account_id = ? AND status = 'failed'
    AND created_at > datetime('now', '-7 days')
  `).get(accountId).c;
  if (recentBad > 5) return false;

  return true;
}

function updateTrustScore(accountId) {
  const score = calculateTrustScore(accountId);
  db.prepare('UPDATE accounts SET trust_score = ? WHERE id = ?').run(score, accountId);

  // Auto-graduate to ready if criteria met
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (account.warm_day >= 21 && score >= 75 && account.status === 'warming') {
    db.prepare("UPDATE accounts SET status = 'ready' WHERE id = ?").run(accountId);
    console.log(`  🎓 Account #${accountId} graduated to READY (score: ${score})`);
  }

  return score;
}

module.exports = { calculateTrustScore, getTrustLabel, isReadyForDemographic, updateTrustScore };
