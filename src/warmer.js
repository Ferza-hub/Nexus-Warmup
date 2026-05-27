const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');
const { updateTrustScore } = require('./trust');
const PERSONAS = require('../config/personas');

const SESSION_DIR = path.join(__dirname, '../data/sessions');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── PHASE SYSTEM ───
function getPhase(day) {
  if (day <= 3)  return 'login_only';
  if (day <= 7)  return 'light';
  if (day <= 14) return 'medium';
  if (day <= 21) return 'deep';
  return 'ready';
}

// ─── ACTIVE HOURS CHECK ───
function isActiveHour(persona) {
  const now = new Date();
  const hour = now.getHours();
  const isWeekend = now.getDay() === 0 || now.getDay() === 6;
  const schedule = isWeekend ? persona.active_hours.weekend : persona.active_hours.weekday;
  return schedule.some(([start, end]) => hour >= start && hour < end);
}

// ─── SHOULD SKIP TODAY ───
function shouldSkipToday(accountId) {
  // 20% chance skip on weekday, 30% on weekend
  const isWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;
  const skipChance = isWeekend ? 0.3 : 0.2;
  if (Math.random() < skipChance) return true;

  // Never skip 3 days in a row
  const recentLogs = db.prepare(`
    SELECT DISTINCT DATE(created_at) as day
    FROM warm_logs WHERE account_id = ?
    ORDER BY day DESC LIMIT 3
  `).all(accountId);
  
  if (recentLogs.length >= 2) {
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const twoDaysAgo = new Date(Date.now() - 172800000).toISOString().split('T')[0];
    const days = recentLogs.map(r => r.day);
    if (!days.includes(yesterday) && !days.includes(twoDaysAgo)) return false; // already skipped 2 days
  }

  return false;
}

// ─── BROWSER LAUNCH ───
async function launchBrowser(account) {
  const proxy = account.proxy_id
    ? db.prepare('SELECT * FROM proxies WHERE id = ?').get(account.proxy_id)
    : null;

  const sessionPath = path.join(SESSION_DIR, `${account.id}.json`);
  const hasSession = fs.existsSync(sessionPath);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox','--disable-setuid-sandbox',
      '--disable-dev-shm-usage','--disable-blink-features=AutomationControlled',
      '--no-first-run','--disable-gpu',
      '--disable-infobars','--disable-extensions',
    ],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: rand(1280, 1920), height: rand(768, 1080) },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    ...(proxy && {
      proxy: {
        server: `http://${proxy.host}:${proxy.port}`,
        ...(proxy.username && { username: proxy.username, password: proxy.password }),
      }
    }),
    ...(hasSession && { storageState: sessionPath }),
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  return { browser, context, page, sessionPath };
}

async function saveSession(context, sessionPath) {
  try { await context.storageState({ path: sessionPath }); } catch {}
}

// ─── GOOGLE SEARCH WITH CLICK-THROUGH ───
async function doGoogleSearch(page, query, shouldClick = false) {
  const start = Date.now();
  try {
    await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(rand(1000, 2500));

    const searchBox = await page.$('textarea[name="q"], input[name="q"]');
    if (!searchBox) return { success: false, reason: 'no search box' };

    await searchBox.click();
    await sleep(rand(300, 700));
    for (const char of query) {
      await page.keyboard.type(char);
      await sleep(rand(50, 150));
    }
    await sleep(rand(500, 1200));
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await sleep(rand(2000, 5000));

    // Scroll SERP naturally
    await page.mouse.wheel(0, rand(200, 500));
    await sleep(rand(1000, 3000));
    await page.mouse.wheel(0, rand(100, 300));
    await sleep(rand(500, 2000));

    let clickedUrl = null;
    let timeOnPage = 0;

    if (shouldClick) {
      try {
        // Click result #2 or #3 — not always #1 (too robotic)
        const results = await page.$$('h3');
        if (results.length > 1) {
          const idx = rand(1, Math.min(3, results.length - 1));
          const result = results[idx];
          const parentA = await result.$('xpath=ancestor::a');
          if (parentA) {
            clickedUrl = await parentA.getAttribute('href');
            await result.scrollIntoViewIfNeeded();
            await sleep(rand(500, 1500));
            await result.click();
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 });

            const readStart = Date.now();
            // Read naturally — scroll, pause
            for (let i = 0; i < rand(3, 7); i++) {
              await page.mouse.wheel(0, rand(100, 400));
              await sleep(rand(2000, 8000));
              if (Math.random() < 0.15) {
                await page.mouse.wheel(0, -rand(50, 150));
                await sleep(rand(500, 1500));
              }
            }
            timeOnPage = Date.now() - readStart;

            // Maybe click another link on the page
            if (Math.random() < 0.25) {
              try {
                const currentBase = new URL(page.url()).hostname;
                const internalLinks = await page.$$eval('a[href]', (els, host) =>
                  els.map(el => el.href).filter(h => { try { return new URL(h).hostname === host; } catch { return false; } }),
                  currentBase
                );
                if (internalLinks.length > 0) {
                  await page.goto(pick(internalLinks), { waitUntil: 'domcontentloaded', timeout: 12000 });
                  await sleep(rand(5000, 12000));
                  await page.mouse.wheel(0, rand(300, 800));
                  await sleep(rand(3000, 8000));
                }
              } catch {}
            }

            // Back to SERP
            await page.goBack().catch(() => {});
            await sleep(rand(1000, 3000));

            // Maybe click another result
            if (Math.random() < 0.35) {
              try {
                const results2 = await page.$$('h3');
                if (results2.length > idx + 1) {
                  await results2[idx + 1].scrollIntoViewIfNeeded();
                  await sleep(rand(500, 1000));
                  await results2[idx + 1].click();
                  await page.waitForLoadState('domcontentloaded', { timeout: 12000 });
                  await sleep(rand(5000, 15000));
                  await page.mouse.wheel(0, rand(300, 800));
                  await sleep(rand(3000, 8000));
                  await page.goBack().catch(() => {});
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    return { success: true, query, clickedUrl, timeOnPage, duration: Date.now() - start };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ─── YOUTUBE WATCH ENGINE ───
async function doYouTubeWatch(page, searchQuery, accountId) {
  try {
    await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(rand(2000, 4000));

    // Search
    const searchBtn = await page.$('input#search');
    if (!searchBtn) return { success: false, reason: 'no search box' };
    await searchBtn.click();
    await sleep(rand(500, 1000));
    for (const char of searchQuery) {
      await page.keyboard.type(char);
      await sleep(rand(50, 130));
    }
    await sleep(rand(500, 1000));
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    await sleep(rand(2000, 4000));

    // Scroll results
    await page.mouse.wheel(0, rand(200, 500));
    await sleep(rand(1000, 2000));

    let watched = 0;
    const videosToWatch = rand(2, 4);

    for (let v = 0; v < videosToWatch; v++) {
      try {
        const videos = await page.$$('ytd-video-renderer a#thumbnail, a#thumbnail[href*="/watch"]');
        if (!videos.length) break;

        const video = videos[rand(0, Math.min(4, videos.length - 1))];
        const href = await video.getAttribute('href');
        if (!href) continue;

        await video.scrollIntoViewIfNeeded();
        await sleep(rand(500, 1500));
        await video.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 });
        await sleep(rand(2000, 4000));

        // Get video duration estimate from title/metadata
        // Watch 45-85% of video — simulate by time
        const watchTimeMs = rand(20000, 90000); // 20-90 seconds
        const watchPct = rand(45, 85);

        // Scroll to comments occasionally
        if (Math.random() < 0.4) {
          await page.mouse.wheel(0, rand(500, 1200));
          await sleep(rand(2000, 5000));
        }

        await sleep(watchTimeMs);

        // Like video — 25% chance
        let liked = 0;
        if (Math.random() < 0.25) {
          try {
            const likeBtn = await page.$('[aria-label="like this video"]');
            if (likeBtn) {
              await likeBtn.click();
              liked = 1;
              await sleep(rand(500, 1500));
            }
          } catch {}
        }

        // Subscribe — 10% chance
        let subscribed = 0;
        if (Math.random() < 0.10) {
          try {
            const subBtn = await page.$('[aria-label*="Subscribe"]');
            if (subBtn) {
              await subBtn.click();
              subscribed = 1;
              await sleep(rand(500, 1000));
            }
          } catch {}
        }

        // Log to youtube_history
        db.prepare(`
          INSERT INTO youtube_history (account_id, query, video_url, watch_pct, liked, subscribed)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(accountId, searchQuery, page.url(), watchPct, liked, subscribed);

        watched++;

        // Go back to results
        await page.goBack().catch(() => {});
        await sleep(rand(1000, 3000));

      } catch { break; }
    }

    return { success: true, watched };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ─── SITE VISIT ───
async function doSiteVisit(page, url, accountId) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(rand(2000, 5000));

    let pagesVisited = 1;

    // Scroll naturally
    for (let i = 0; i < rand(3, 8); i++) {
      await page.mouse.wheel(0, rand(100, 400));
      await sleep(rand(800, 3000));
      if (Math.random() < 0.15) {
        await page.mouse.wheel(0, -rand(50, 200));
        await sleep(rand(500, 1500));
      }
    }

    // Click internal link
    if (Math.random() < 0.5) {
      try {
        const base = new URL(url);
        const links = await page.$$eval('a[href]', (els, host) =>
          els.map(el => el.href).filter(h => {
            try { return new URL(h).hostname === host && !h.includes('#') && !h.match(/\.(pdf|jpg|png|zip)$/i); }
            catch { return false; }
          }), base.hostname
        );
        if (links.length > 0) {
          await page.goto(pick(links), { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(rand(5000, 15000));
          await page.mouse.wheel(0, rand(300, 800));
          await sleep(rand(3000, 8000));
          pagesVisited++;
        }
      } catch {}
    }

    // Log site visit
    db.prepare('INSERT INTO site_visits (account_id, url, pages_visited) VALUES (?, ?, ?)')
      .run(accountId, url, pagesVisited);

    return { success: true, pagesVisited };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ─── NEWS READ ───
async function doNewsRead(page, topic) {
  try {
    const query = encodeURIComponent(topic + ' news today');
    await page.goto(`https://news.google.com/search?q=${query}&hl=en-US`, {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    await sleep(rand(2000, 5000));
    await page.mouse.wheel(0, rand(300, 800));
    await sleep(rand(3000, 8000));

    // Click article
    try {
      const articles = await page.$$('article a[href]');
      if (articles.length > 0) {
        const article = articles[rand(0, Math.min(4, articles.length - 1))];
        await article.click();
        await sleep(rand(5000, 20000));
        await page.mouse.wheel(0, rand(300, 800));
        await sleep(rand(3000, 8000));
      }
    } catch {}

    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ─── REDDIT BROWSE ───
async function doRedditBrowse(page, subreddit, accountId) {
  try {
    await page.goto(`https://www.reddit.com/${subreddit}`, {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    await sleep(rand(2000, 5000));
    await page.mouse.wheel(0, rand(300, 800));
    await sleep(rand(2000, 5000));

    // Upvote a few posts
    let upvotes = 0;
    if (Math.random() < 0.5) {
      try {
        const upvoteBtns = await page.$$('[aria-label*="upvote"]');
        const toUpvote = rand(2, 5);
        for (let i = 0; i < Math.min(toUpvote, upvoteBtns.length); i++) {
          await upvoteBtns[i].scrollIntoViewIfNeeded();
          await sleep(rand(500, 1500));
          await upvoteBtns[i].click();
          upvotes++;
          await sleep(rand(300, 800));
        }
      } catch {}
    }

    // Click a post and read
    if (Math.random() < 0.4) {
      try {
        const posts = await page.$$('a[data-click-id="body"]');
        if (posts.length > 0) {
          await posts[rand(0, Math.min(4, posts.length - 1))].click();
          await page.waitForLoadState('domcontentloaded', { timeout: 12000 });
          await sleep(rand(5000, 15000));
          await page.mouse.wheel(0, rand(300, 800));
          await sleep(rand(3000, 8000));
        }
      } catch {}
    }

    return { success: true, upvotes };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ─── DAILY WARMUP RUNNER ───
async function runDailyWarmup(accountId) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) return;
  if (account.status === 'disabled') return;

  const persona = PERSONAS[account.persona];
  if (!persona) return;

  // Skip check
  if (shouldSkipToday(accountId)) {
    console.log(`  ⏭ ${account.email} — skipping today (natural idle)`);
    return;
  }

  const day = account.warm_day + 1;
  const phase = account.skip_warmup ? 'ready' : getPhase(day);

  console.log(`\n🔥 [Day ${day}/${phase}] ${account.email} (${persona.name})`);

  const { browser, context, page, sessionPath } = await launchBrowser(account);

  const logActivity = (activity, status, detail = '', durationMs = 0) => {
    db.prepare(`
      INSERT INTO warm_logs (account_id, day, phase, activity, status, detail, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(accountId, day, phase, activity, status, detail, durationMs);
    console.log(`  ${status === 'success' ? '✓' : '✗'} ${activity}${detail ? ' — ' + detail.slice(0, 60) : ''}`);
  };

  try {
    const t = () => Date.now();

    if (phase === 'login_only') {
      // Day 1-3: Just browse news + one site visit
      const topic = pick(persona.news_topics);
      const s = Date.now();
      const r = await doNewsRead(page, topic);
      logActivity('news_read', r.success ? 'success' : 'failed', topic, Date.now() - s);
      await sleep(rand(5000, 15000));

      const site = pick(persona.visit_sites);
      const s2 = Date.now();
      const r2 = await doSiteVisit(page, site, accountId);
      logActivity('site_visit', r2.success ? 'success' : 'failed', site, Date.now() - s2);
    }

    else if (phase === 'light') {
      // Day 4-7: 2-3 searches + YouTube
      const queries = shuffle(persona.search_queries).slice(0, rand(2, 3));
      for (const query of queries) {
        const s = Date.now();
        const r = await doGoogleSearch(page, query, Math.random() < 0.3);
        logActivity('google_search', r.success ? 'success' : 'failed', query, Date.now() - s);
        if (r.success && r.clickedUrl) {
          db.prepare('INSERT INTO search_history (account_id, query, clicked_url, time_on_page_ms) VALUES (?, ?, ?, ?)')
            .run(accountId, query, r.clickedUrl, r.timeOnPage || 0);
        }
        await sleep(rand(3000, 8000));
      }

      if (Math.random() < 0.6) {
        const ytQuery = pick(persona.youtube_searches);
        const s = Date.now();
        const r = await doYouTubeWatch(page, ytQuery, accountId);
        logActivity('youtube_watch', r.success ? 'success' : 'failed', ytQuery, Date.now() - s);
      }
    }

    else if (phase === 'medium') {
      // Day 8-14: 3-5 searches + YouTube + site visits
      const queries = shuffle(persona.search_queries).slice(0, rand(3, 5));
      for (const query of queries) {
        const s = Date.now();
        const r = await doGoogleSearch(page, query, Math.random() < 0.5);
        logActivity('google_search', r.success ? 'success' : 'failed', query, Date.now() - s);
        if (r.success && r.clickedUrl) {
          db.prepare('INSERT INTO search_history (account_id, query, clicked_url, time_on_page_ms) VALUES (?, ?, ?, ?)')
            .run(accountId, query, r.clickedUrl, r.timeOnPage || 0);
        }
        await sleep(rand(5000, 12000));
      }

      const sites = shuffle(persona.visit_sites).slice(0, rand(1, 2));
      for (const site of sites) {
        const s = Date.now();
        const r = await doSiteVisit(page, site, accountId);
        logActivity('site_visit', r.success ? 'success' : 'failed', site, Date.now() - s);
        await sleep(rand(5000, 10000));
      }

      const ytQuery = pick(persona.youtube_searches);
      const s = Date.now();
      const r = await doYouTubeWatch(page, ytQuery, accountId);
      logActivity('youtube_watch', r.success ? 'success' : 'failed', ytQuery, Date.now() - s);
    }

    else {
      // Day 15+: Full simulation
      const queries = shuffle(persona.search_queries).slice(0, rand(4, 6));
      for (const query of queries) {
        const s = Date.now();
        const r = await doGoogleSearch(page, query, Math.random() < 0.7);
        logActivity('google_search', r.success ? 'success' : 'failed', query, Date.now() - s);
        if (r.success && r.clickedUrl) {
          db.prepare('INSERT INTO search_history (account_id, query, clicked_url, time_on_page_ms) VALUES (?, ?, ?, ?)')
            .run(accountId, query, r.clickedUrl, r.timeOnPage || 0);
        }
        await sleep(rand(5000, 15000));
      }

      // YouTube — multiple videos
      const ytQueries = shuffle(persona.youtube_searches).slice(0, rand(1, 2));
      for (const ytq of ytQueries) {
        const s = Date.now();
        const r = await doYouTubeWatch(page, ytq, accountId);
        logActivity('youtube_watch', r.success ? 'success' : 'failed', ytq, Date.now() - s);
        await sleep(rand(5000, 12000));
      }

      // Site visits
      const sites = shuffle(persona.visit_sites).slice(0, rand(2, 3));
      for (const site of sites) {
        const s = Date.now();
        const r = await doSiteVisit(page, site, accountId);
        logActivity('site_visit', r.success ? 'success' : 'failed', site, Date.now() - s);
        await sleep(rand(5000, 12000));
      }

      // Reddit browse
      if (persona.reddit_subs && Math.random() < 0.6) {
        const sub = pick(persona.reddit_subs);
        const s = Date.now();
        const r = await doRedditBrowse(page, sub, accountId);
        logActivity('reddit_browse', r.success ? 'success' : 'failed', sub, Date.now() - s);
        await sleep(rand(5000, 10000));
      }

      // News
      const topic = pick(persona.news_topics);
      const s = Date.now();
      const r = await doNewsRead(page, topic);
      logActivity('news_read', r.success ? 'success' : 'failed', topic, Date.now() - s);
    }

    // Save session
    await saveSession(context, sessionPath);

    // Update account
    const newStatus = account.skip_warmup ? 'ready' :
      (day >= 21 ? 'ready' : 'warming');

    db.prepare(`
      UPDATE accounts SET
        warm_day = ?,
        status = ?,
        session_path = ?,
        last_warm_at = CURRENT_TIMESTAMP,
        last_active_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(day, newStatus, sessionPath, accountId);

    // Update trust score
    const score = updateTrustScore(accountId);
    console.log(`  ✅ Day ${day} complete — Phase: ${phase} — Trust: ${score}/100`);

  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
    db.prepare(`INSERT INTO warm_logs (account_id, day, phase, activity, status, detail) VALUES (?, ?, ?, 'error', 'failed', ?)`)
      .run(accountId, day, phase, err.message);
  } finally {
    try { await context.close(); await browser.close(); } catch {}
  }
}

// ─── RUN ALL ───
async function runAllWarmups() {
  const accounts = db.prepare(`
    SELECT * FROM accounts
    WHERE status IN ('new', 'warming', 'ready')
    ORDER BY id ASC
  `).all();

  if (!accounts.length) {
    console.log('No accounts to warm up.');
    return;
  }

  console.log(`\n🔥 Starting warmup for ${accounts.length} accounts\n`);

  for (const account of accounts) {
    // Check already warmed today
    const today = new Date().toISOString().split('T')[0];
    const alreadyWarmed = db.prepare(`
      SELECT id FROM warm_logs
      WHERE account_id = ? AND DATE(created_at) = ?
      LIMIT 1
    `).get(account.id, today);

    if (alreadyWarmed) {
      console.log(`⏭ ${account.email} — already warmed today`);
      continue;
    }

    await runDailyWarmup(account.id);
    await sleep(rand(60000, 180000)); // 1-3 min between accounts — natural gap
  }

  console.log('\n✅ All warmups complete\n');
}

module.exports = { runDailyWarmup, runAllWarmups, getPhase };
