'use strict';

/**
 * Preload script — the ONLY bridge between the sandboxed renderer and the
 * main process. Nothing from Node.js or Electron leaks into the renderer
 * beyond what is explicitly listed here.
 *
 * Security properties:
 *  - contextIsolation: true  → renderer's `window` is a separate JS context
 *  - sandbox: true           → preload itself has no `require` for Node modules
 *                              (ipcRenderer is injected by Electron specifically)
 *  - Only named, typed methods are exposed — no raw IPC channel strings
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Data queries ───────────────────────────────────────────────────────────
  getScreentime:    (from, to) => ipcRenderer.invoke('db:screentime', { from, to }),
  getDaily:         (from, to) => ipcRenderer.invoke('db:daily',      { from, to }),
  getHourly:        (from, to) => ipcRenderer.invoke('db:hourly',     { from, to }),
  getDevices:       ()         => ipcRenderer.invoke('db:devices'),
  getCollectionLog: (limit)    => ipcRenderer.invoke('db:collection-log', { limit }),

  // ── Actions ────────────────────────────────────────────────────────────────
  triggerCollect:      () => ipcRenderer.invoke('collect:run'),
  checkFda:            () => ipcRenderer.invoke('fda:check'),
  openPrivacySettings: () => ipcRenderer.invoke('shell:open-privacy-settings'),
  exportDb:            () => ipcRenderer.invoke('db:export'),
  importDb:            () => ipcRenderer.invoke('db:import'),
  updateAppName:       (bundleId, name) => ipcRenderer.invoke('db:update-app-name', { bundleId, name }),

  // ── Push events from main → renderer ──────────────────────────────────────
  // Returns an unsubscribe function so callers can clean up.
  onCollectProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('collect:progress', handler);
    return () => ipcRenderer.removeListener('collect:progress', handler);
  },
});
