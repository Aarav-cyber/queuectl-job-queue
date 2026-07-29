'use strict';
/**
 * lib/db.js
 *
 * Opens (or creates) the SQLite database and initialises the schema.
 * Using better-sqlite3 (synchronous) so that transactions are simple
 * and we never have async gaps inside a critical section.
 */

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

// Resolve data directory relative to this file's location (project root/data/)
// QUEUECTL_DB env var allows tests to use isolated DB files per scenario
const DATA_DIR = process.env.QUEUECTL_DATA || path.join(__dirname, '..', 'data');
const DB_PATH  = process.env.QUEUECTL_DB   || path.join(DATA_DIR, 'queue.db');

let _db = null;

/**
 * Returns the singleton DB connection.
 * Creates the data directory and initialises schema on first call.
 */
function getDb() {
  if (_db) return _db;

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH);

  // Enable WAL mode: allows concurrent readers + one writer without blocking
  _db.pragma('journal_mode = WAL');
  // Enforce foreign keys
  _db.pragma('foreign_keys = ON');
  // Busy timeout: if another process holds a write lock, wait up to 5 s before throwing
  _db.pragma('busy_timeout = 5000');

  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id             TEXT PRIMARY KEY,
      command        TEXT NOT NULL,
      state          TEXT NOT NULL DEFAULT 'pending',
      attempts       INTEGER NOT NULL DEFAULT 0,
      max_retries    INTEGER NOT NULL DEFAULT 3,
      priority       INTEGER NOT NULL DEFAULT 0,
      timeout        INTEGER,            -- seconds; NULL = no timeout
      output         TEXT,               -- captured stdout+stderr
      next_run_at    TEXT NOT NULL,      -- ISO-8601; when job becomes eligible
      last_heartbeat TEXT,               -- ISO-8601; updated by worker every 5 s
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_state_next
      ON jobs (state, next_run_at);

    CREATE INDEX IF NOT EXISTS idx_jobs_state_priority
      ON jobs (state, priority, created_at);

    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Default configuration values (INSERT OR IGNORE so we never overwrite user settings)
    INSERT OR IGNORE INTO config (key, value) VALUES ('max-retries',  '3');
    INSERT OR IGNORE INTO config (key, value) VALUES ('backoff-base', '2');
    INSERT OR IGNORE INTO config (key, value) VALUES ('heartbeat-timeout', '30');
  `);
}

module.exports = { getDb, DB_PATH, DATA_DIR };
