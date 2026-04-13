'use strict';

/**
 * Electron main process entry point.
 *
 * Security hardening:
 *  - nodeIntegration: false   — renderer has zero Node.js access
 *  - contextIsolation: true   — renderer's `window` is isolated from the preload
 *  - sandbox: true            — Chromium renderer sandbox enforced
 *  - webSecurity: true        — never disabled
 *  - will-navigate locked     — only file:// URLs allowed
 *  - setWindowOpenHandler     — all new-window requests denied
 *  - Single-instance lock     — prevents two copies running simultaneously
 *  - LSUIElement: true        — no Dock icon (set in package.json extendInfo)
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  session,
} = require('electron');
const path = require('path');
const fs   = require('fs');

// Prevent a second instance from launching
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const { initSchema }          = require('./db');
const { registerIpcHandlers } = require('./ipc');
const { startScheduler }      = require('./scheduler');
const { checkFDA }            = require('./fda');

let tray = null;
let win  = null;

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width:     960,
    height:    680,
    minWidth:  760,
    minHeight: 500,
    show:      false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f5f7',
    webPreferences: {
      nodeIntegration:             false, // renderer never gets Node.js
      contextIsolation:            true,  // preload and renderer are separate worlds
      sandbox:                     true,  // Chromium renderer sandbox
      preload:                     path.join(__dirname, '../preload/preload.js'),
      webSecurity:                 true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop:          false,
    },
  });

  // Content Security Policy — applied to all responses including file://
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'none'",
            "script-src 'self'",          // only local scripts, no eval, no inline
            "style-src 'self' 'unsafe-inline'", // inline styles ok (no XSS risk here)
            "img-src 'self' data:",
            "connect-src 'none'",         // no fetch/XHR to any URL
            "font-src 'self'",
            "object-src 'none'",
            "frame-src 'none'",
            "base-uri 'self'",
          ].join('; '),
        ],
      },
    });
  });

  // Block navigation away from the app's own files
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  // Block all popup / new-window requests (e.g. target="_blank")
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(__dirname, '../../renderer/index.html'));

  // Hide instead of closing — we live in the menu bar
  win.on('close', (event) => {
    event.preventDefault();
    win.hide();
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

// Fallback 16x16 + 32x32 bar-chart PNGs (black on transparent, template-style)
const FALLBACK_ICON_1X =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAH0lEQVR42mNgGAWkgv9IeCQYgE3xIDcAXXIIGjAwAAA2XjjIFAlGlwAAAABJRU5ErkJggg==';
const FALLBACK_ICON_2X =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANUlEQVR42u3OsQ0AMAgEMfZfOkyASENB4pMoeTlCkuY6xQEAAOwH3A4DAOwFdI8AAO8D9FcJhxPjHQC3hewAAAAASUVORK5CYII=';

// Resolve an asset path that works both in development and in a packaged .app.
// In a packaged app, asarUnpack assets live in app.asar.unpacked/ on the real
// filesystem — nativeImage and other native APIs can only read real paths.
function assetPath(...parts) {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '../..');
  return path.join(base, ...parts);
}

function buildTrayIcon() {
  const path1x = assetPath('assets', 'iconTemplate.png');
  const path2x = assetPath('assets', 'iconTemplate@2x.png');

  // Load from the real filesystem (not through ASAR virtual layer)
  let buf1x = null, buf2x = null;
  try { buf1x = fs.readFileSync(path1x); } catch { /* use fallback */ }
  try { buf2x = fs.readFileSync(path2x); } catch { /* use fallback */ }

  const icon = buf2x
    ? nativeImage.createFromBuffer(buf2x, { scaleFactor: 2.0 })
    : buf1x
      ? nativeImage.createFromBuffer(buf1x, { scaleFactor: 1.0 })
      : nativeImage.createFromBuffer(Buffer.from(FALLBACK_ICON_2X, 'base64'), { scaleFactor: 2.0 });

  icon.isMacTemplateImage = true;
  return icon;
}

function createTray() {
  const icon = buildTrayIcon();
  tray = new Tray(icon);

  tray.setToolTip('Screen Time');

  const menu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: showWindow },
    { label: 'Collect Now',    click: () => require('./scheduler').runCollect() },
    { type: 'separator' },
    { label: 'Quit',           click: () => app.exit(0) },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleWindow);
}

function showWindow() {
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    showWindow();
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Initialize the screentime.db schema before anything else
  initSchema();

  // Register all IPC handlers before any window is created
  registerIpcHandlers();

  createWindow();
  createTray();

  // Start the hourly + on-wake collection scheduler
  startScheduler();

  // If FDA is missing, show the dashboard anyway (it will display the onboarding overlay)
  const { granted } = checkFDA();
  if (granted) {
    // FDA is good — show the window on first launch
    win.show();
  } else {
    // Show the window so the user sees the FDA onboarding screen
    win.show();
  }
});

// Bring window to front if a second-instance is attempted
app.on('second-instance', () => showWindow());

// Don't quit when all windows are closed — we're a menu bar app
app.on('window-all-closed', () => { /* intentionally empty */ });
