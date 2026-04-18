'use strict';

/**
 * api.js — Tauri invoke wrapper
 *
 * Exposes window.api with exactly the same interface as the Electron preload,
 * so renderer/app.js does not need to change.
 *
 * Requires withGlobalTauri: true in tauri.conf.json, which makes
 * window.__TAURI__ available without any npm bundler.
 */

(function () {
  const { invoke, event } = window.__TAURI__;
  // In Tauri v2, invoke lives at window.__TAURI__.core.invoke
  // and event listeners at window.__TAURI__.event.listen
  const inv = (window.__TAURI__.core && window.__TAURI__.core.invoke)
    ? window.__TAURI__.core.invoke.bind(window.__TAURI__.core)
    : invoke;
  const listen = (window.__TAURI__.event && window.__TAURI__.event.listen)
    ? window.__TAURI__.event.listen.bind(window.__TAURI__.event)
    : (window.__TAURI__.listen || (async () => () => {}));

  window.api = {
    // ── Data queries ──────────────────────────────────────────────────────────
    getScreentime:    (from, to) => inv('get_screentime',    { from, to }),
    getDaily:         (from, to) => inv('get_daily',         { from, to }),
    getHourly:        (from, to) => inv('get_hourly',        { from, to }),
    getDevices:       ()         => inv('get_devices',       {}),
    getCollectionLog: (limit)    => inv('get_collection_log', { limit }),

    // ── Actions ───────────────────────────────────────────────────────────────
    triggerCollect:      () => inv('trigger_collect',      {}),
    checkFda:            () => inv('check_fda_cmd',        {}),
    openPrivacySettings: () => inv('open_privacy_settings', {}),
    exportDb:            () => inv('export_db',            {}),
    importDb:            () => inv('import_db',            {}),
    updateAppName:       (bundleId, name) => inv('update_app_name', { bundleId, name }),
    updateDeviceName:    (deviceId, name) => inv('update_device_name', { deviceId, name }),

    // ── Push events from backend → renderer ───────────────────────────────────
    onCollectProgress: (callback) => {
      let unlisten = null;
      listen('collect:progress', (tauriEvent) => {
        callback(tauriEvent.payload);
      }).then((fn) => { unlisten = fn; });
      // Return unsubscribe function
      return () => { if (unlisten) unlisten(); };
    },

    // ── Extended API ──────────────────────────────────────────────────────────
    getAppDaily:      (appId, from, to) => inv('get_app_daily', { appId, from, to }),
    showNotification: (title, body)     => inv('show_notification', { title, body }),
    getAutostart:     ()                => inv('get_autostart', {}),
    setAutostart:     (enabled)         => inv('set_autostart', { enabled }),
    saveCsv:          (filename, content) => inv('save_csv', { filename, content }),
    startDrag:        ()                  => inv('start_drag', {}),

    // ── Grafana / PostgreSQL push ──────────────────────────────────────────────
    testGrafanaPush: (host, port, database, user, password) =>
      inv('test_grafana_push', { host, port, database, user, password }),
    pushToGrafana:   (host, port, database, user, password) =>
      inv('push_to_grafana',   { host, port, database, user, password }),
  };
})();
