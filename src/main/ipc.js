'use strict';

/**
 * IPC handler registration — all ipcMain.handle() calls live here.
 *
 * Security:
 *  - Every handler validates its arguments before touching the DB
 *  - Timestamps are validated: finite numbers, non-negative, in range, from <= to
 *  - Limit is clamped to [1, 500]
 *  - collect:run is guarded against concurrent invocations
 *  - shell:open-privacy-settings opens only the hardcoded System Settings URL
 */

const { ipcMain, shell, dialog, app } = require('electron');
const fs = require('fs');
const db = require('./db');
const { checkFDA } = require('./fda');
const { runCollect, isRunning } = require('./scheduler');

// Only this URL may be opened externally from the app
const PRIVACY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

function validateTimestamps(from, to) {
  const f = Number(from);
  const t = Number(to);
  if (
    !Number.isFinite(f) || !Number.isFinite(t) ||
    f < 0 || t < 0 ||
    f > t ||
    t > 9_999_999_999
  ) {
    throw Object.assign(new Error('Invalid timestamp range'), { code: 'INVALID_PARAMS' });
  }
  return [Math.floor(f), Math.floor(t)];
}

function registerIpcHandlers() {
  // ── Data queries ─────────────────────────────────────────────────────────

  ipcMain.handle('db:screentime', (_event, { from, to } = {}) => {
    const [f, t] = validateTimestamps(from, to);
    return db.getScreentime(f, t);
  });

  ipcMain.handle('db:daily', (_event, { from, to } = {}) => {
    const [f, t] = validateTimestamps(from, to);
    return db.getDaily(f, t);
  });

  ipcMain.handle('db:hourly', (_event, { from, to } = {}) => {
    const [f, t] = validateTimestamps(from, to);
    return db.getHourly(f, t);
  });

  ipcMain.handle('db:devices', () => db.getDevices());

  ipcMain.handle('db:collection-log', (_event, { limit } = {}) => {
    const safeLimit = Math.min(Math.max(1, Math.floor(Number(limit) || 50)), 500);
    return db.getCollectionLog(safeLimit);
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  ipcMain.handle('collect:run', () => {
    if (isRunning()) return { ok: false, error: 'Collection already in progress' };
    return runCollect() ?? { ok: true, fetched: 0, inserted: 0, error: null };
  });

  ipcMain.handle('fda:check', () => checkFDA());

  ipcMain.handle('shell:open-privacy-settings', () => {
    // Open only the hardcoded System Settings URL — no user-controlled URLs
    shell.openExternal(PRIVACY_SETTINGS_URL);
  });

  // ── Backup & Restore ─────────────────────────────────────────────────────

  ipcMain.handle('db:export', async (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Export Database Backup',
      defaultPath: `screenlog_backup_${new Date().toISOString().split('T')[0]}.db`,
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    });

    if (canceled || !filePath) return { ok: false };

    try {
      fs.copyFileSync(db.DB_PATH, filePath);
      return { ok: true, path: filePath };
    } catch (err) {
      console.error('Export failed:', err);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('db:import', async (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    const { filePaths, canceled } = await dialog.showOpenDialog(win, {
      title: 'Import Database Backup',
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
      properties: ['openFile'],
    });

    if (canceled || filePaths.length === 0) return { ok: false };

    const sourcePath = filePaths[0];

    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Overwrite Current Data'],
      defaultId: 0,
      title: 'Confirm Restore',
      message: 'Restore backup?',
      detail: 'This will completely replace your current history with the data from the backup file. This cannot be undone and the app will restart.',
    });

    if (response !== 1) return { ok: false };

    try {
      db.closeDb();
      fs.copyFileSync(sourcePath, db.DB_PATH);
      app.relaunch();
      app.exit(0);
      return { ok: true };
    } catch (err) {
      console.error('Import failed:', err);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('db:update-app-name', (_event, { bundleId, name }) => {
    return db.updateAppName(bundleId, name);
  });
}

module.exports = { registerIpcHandlers };
