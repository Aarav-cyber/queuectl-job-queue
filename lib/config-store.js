'use strict';
/**
 * lib/config-store.js
 *
 * Persistent key/value config backed by the SQLite `config` table.
 */

const { getDb } = require('./db');

function getConfig(key) {
  const db  = getDb();
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setConfig(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function getAllConfig() {
  const db = getDb();
  return db.prepare('SELECT key, value FROM config ORDER BY key').all();
}

module.exports = { getConfig, setConfig, getAllConfig };
