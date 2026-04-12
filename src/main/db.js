'use strict';

/**
 * Database layer — all reads/writes to screentime.db go through here.
 *
 * Uses better-sqlite3 (synchronous). All public functions are called from
 * ipcMain.handle() which runs on the main process thread, so sync is fine.
 *
 * Security:
 *  - All queries use parameterized statements (no string interpolation)
 *  - knowledgeC.db is never opened here — that's collect.js's job, read-only
 *  - screentime.db lives in app.getPath('userData'), not next to the binary
 */

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

// Path is determined lazily in getDb() to ensure app.isReady()
let DB_PATH = null;

const DEVICE_TYPE = (alias = '') => {
  const pfx = alias ? `${alias}.` : '';
  return `
  CASE
    WHEN ${pfx}device_model IS NULL OR ${pfx}device_model = '' THEN 'mac'
    WHEN LOWER(${pfx}device_model) LIKE 'iphone%' THEN 'iphone'
    WHEN LOWER(${pfx}device_model) LIKE 'ipad%' THEN 'ipad'
    ELSE 'mac'
  END`;
};

let _db = null;

function getDb() {
  if (!DB_PATH) {
    DB_PATH = path.join(app.getPath('userData'), 'screentime.db');
  }
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('busy_timeout = 5000');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

function initSchema() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS screentime (
      app           TEXT    NOT NULL,
      usage_seconds REAL,
      start_time    INTEGER NOT NULL,
      end_time      INTEGER,
      tz_offset     INTEGER,
      device_id     TEXT    NOT NULL DEFAULT '',
      device_model  TEXT,
      PRIMARY KEY (app, start_time, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_start_time ON screentime(start_time);
    CREATE TABLE IF NOT EXISTS collection_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at           INTEGER NOT NULL,
      records_fetched  INTEGER NOT NULL,
      records_inserted INTEGER NOT NULL,
      error            TEXT
    );
    CREATE TABLE IF NOT EXISTS app_names (
      bundle_id    TEXT PRIMARY KEY,
      display_name TEXT NOT NULL
    );
  `);
}

function getScreentime(from, to) {
  const rows = getDb().prepare(`
    SELECT s.app, COALESCE(n.display_name, s.app) AS display_name, ${DEVICE_TYPE('s')} AS dtype, CAST(SUM(usage_seconds) AS INTEGER) AS total
    FROM screentime s
    LEFT JOIN app_names n ON s.app = n.bundle_id
    WHERE s.start_time >= ? AND s.start_time <= ?
      AND s.app IS NOT NULL AND s.usage_seconds > 0
    GROUP BY s.app, dtype
  `).all(from, to);

  const apps = {};
  for (const { app, display_name, dtype, total } of rows) {
    if (!apps[app]) apps[app] = { app, display_name, mac: 0, iphone: 0, ipad: 0 };
    apps[app][dtype] = total;
  }
  return {
    apps: Object.values(apps)
      .sort((a, b) => (b.mac + b.iphone + b.ipad) - (a.mac + a.iphone + a.ipad))
      .slice(0, 40),
  };
}

function getDaily(from, to) {
  const rows = getDb().prepare(`
    SELECT DATE(start_time, 'unixepoch', 'localtime') AS day,
           ${DEVICE_TYPE()} AS dtype,
           CAST(SUM(usage_seconds) AS INTEGER) AS total
    FROM screentime
    WHERE start_time >= ? AND start_time <= ?
      AND app IS NOT NULL AND usage_seconds > 0
    GROUP BY day, dtype
    ORDER BY day ASC
  `).all(from, to);

  // Fill the complete date range so the chart always has contiguous bars
  const days = {};
  const cursor = new Date(from * 1000);
  const end = new Date(Math.min(to * 1000, Date.now()));
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    days[iso] = { date: iso, mac: 0, iphone: 0, ipad: 0 };
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const { day, dtype, total } of rows) {
    if (days[day]) days[day][dtype] = total;
  }
  return { days: Object.values(days) };
}

function getHourly(from, to) {
  const numDays = Math.max(1, Math.round((to - from) / 86400));
  const rows = getDb().prepare(`
    SELECT CAST(strftime('%H', start_time, 'unixepoch', 'localtime') AS INTEGER) AS hour,
           ${DEVICE_TYPE()} AS dtype,
           CAST(SUM(usage_seconds) AS INTEGER) AS total
    FROM screentime
    WHERE start_time >= ? AND start_time <= ?
      AND app IS NOT NULL AND usage_seconds > 0
    GROUP BY hour, dtype
    ORDER BY hour ASC
  `).all(from, to);

  const hours = Object.fromEntries(
    Array.from({ length: 24 }, (_, h) => [h, { hour: h, mac: 0, iphone: 0, ipad: 0 }])
  );
  for (const { hour, dtype, total } of rows) {
    hours[hour][dtype] = total;
  }
  return { hours: Object.values(hours), num_days: numDays };
}

function getDevices() {
  const rows = getDb().prepare(`
    SELECT DISTINCT ${DEVICE_TYPE()} AS dtype
    FROM screentime
    WHERE usage_seconds > 0
  `).all();
  return { types: rows.map(r => r.dtype).sort() };
}

function getCollectionLog(limit) {
  const rows = getDb().prepare(`
    SELECT ran_at, records_fetched, records_inserted, error
    FROM collection_log
    ORDER BY ran_at DESC
    LIMIT ?
  `).all(limit);
  return {
    runs: rows.map(r => ({
      ran_at:   r.ran_at,
      fetched:  r.records_fetched,
      inserted: r.records_inserted,
      error:    r.error,
    })),
  };
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function updateAppName(bundleId, displayName) {
  if (!displayName || displayName.trim() === '') {
    // If empty, delete the custom name to revert to default
    getDb().prepare('DELETE FROM app_names WHERE bundle_id = ?').run(bundleId);
  } else {
    getDb().prepare(`
      INSERT INTO app_names (bundle_id, display_name) VALUES (?, ?)
      ON CONFLICT(bundle_id) DO UPDATE SET display_name = excluded.display_name
    `).run(bundleId, displayName.trim());
  }
}

module.exports = {
  initSchema,
  getDb,
  closeDb,
  getScreentime,
  getDaily,
  getHourly,
  getDevices,
  getCollectionLog,
  updateAppName,
  DB_PATH,
};
