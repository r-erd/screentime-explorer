'use strict';

/**
 * Background collection scheduler.
 *
 * Replaces the launchd plist. Collects every hour and also on wake from sleep,
 * so data stays fresh even after the Mac has been closed for a week.
 *
 * Guards:
 *  - Skips if a collection is already in-flight
 *  - Skips if Full Disk Access is not granted (avoids noisy error logs)
 */

const { powerMonitor, BrowserWindow } = require('electron');
const { collect } = require('./collect');
const { checkFDA } = require('./fda');

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let _running = false;
let _timer   = null;

function isRunning() {
  return _running;
}

function runCollect() {
  if (_running) return;

  const fda = checkFDA();
  if (!fda.granted) return; // FDA not granted — onboarding will handle it

  _running = true;
  let result;
  try {
    result = collect((progress) => {
      // Push live progress to every open renderer window
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('collect:progress', progress);
        }
      }
    });
  } catch (err) {
    result = { ok: false, fetched: 0, inserted: 0, error: err.message };
  } finally {
    _running = false;
  }
  return result;
}

function startScheduler() {
  // Collect immediately on startup (catches everything since last run)
  runCollect();

  // Then every hour while the app is running
  _timer = setInterval(runCollect, INTERVAL_MS);

  // Also collect whenever the Mac wakes from sleep —
  // this replaces the need for a launchd StartOnMount trigger
  powerMonitor.on('resume', runCollect);
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  powerMonitor.removeListener('resume', runCollect);
}

module.exports = { startScheduler, stopScheduler, runCollect, isRunning };
