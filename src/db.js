const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(path.join(DATA_DIR, 'sessions'))) fs.mkdirSync(path.join(DATA_DIR, 'sessions'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'warmup.db'));

function initDB() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      persona TEXT NOT NULL,
      proxy_id INTEGER,
      status TEXT DEFAULT 'new',
      warm_day INTEGER DEFAULT 0,
      trust_score INTEGER DEFAULT 0,
      session_path TEXT,
      skip_warmup INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_warm_at DATETIME,
      last_active_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT,
      password TEXT,
      geo TEXT DEFAULT 'US',
      status TEXT DEFAULT 'active',
      assigned_account_id INTEGER UNIQUE
    );

    CREATE TABLE IF NOT EXISTS warm_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      day INTEGER NOT NULL,
      phase TEXT NOT NULL,
      activity TEXT NOT NULL,
      status TEXT DEFAULT 'success',
      detail TEXT,
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      clicked_url TEXT,
      time_on_page_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS site_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      duration_ms INTEGER,
      pages_visited INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS youtube_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      query TEXT NOT NULL,
      video_url TEXT,
      watch_pct INTEGER,
      liked INTEGER DEFAULT 0,
      subscribed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('✅ Warmup DB initialized');
}

module.exports = { db, initDB };
