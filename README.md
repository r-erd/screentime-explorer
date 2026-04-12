# Screen Time

A macOS menu bar app that visualizes your Screen Time data — across Mac, iPhone, and iPad. No cloud services, no Python, no server. Data stays entirely on your machine.

## Features

- **Menu bar app** — lives in your menu bar, no Dock icon
- **Automatic collection** — gathers data hourly and on every wake from sleep
- **Multi-device** — shows Mac, iPhone, and iPad usage side by side (requires iCloud Screen Time sync)
- **Three views** — Overview (top apps), Daily (usage per day), Hourly (average by hour)
- **Period navigation** — Day / Week / Month / Year with ‹ › arrows
- **Secure** — reads Apple's database read-only, all data stays local

## Requirements

- macOS 12 or later
- Node.js (for building from source)

## Install

### Download (recommended)

Download the latest `Screen Time-*.dmg` from [Releases](../../releases), open it, and drag **Screen Time** to Applications.

### Build from source

```bash
git clone https://github.com/YOUR_USERNAME/screentime-check.git
cd screentime-check
npm install
npm start
```

> **Note for contributors:** `npm install` runs `electron-builder install-app-deps` via postinstall, which compiles `better-sqlite3` against the correct Electron runtime automatically.

## First launch

On first launch, Screen Time will show a setup screen asking for **Full Disk Access**.

Apple's Screen Time database (`~/Library/Application Support/Knowledge/knowledgeC.db`) is protected by macOS privacy controls. Full Disk Access is required to read it.

1. Click **Open System Settings** in the app
2. Go to **Privacy & Security → Full Disk Access**
3. Click `+` and add **Screen Time** (or **Electron** if running via `npm start`)
4. Click **Check Again** in the app

> **Development note:** When running via `npm start`, the process is `node_modules/electron/dist/Electron.app` — you need to grant FDA to that binary, not to a built `Screen Time.app`. For testing the real app, run `npm run build` and open `dist/mac-arm64/Screen Time.app` directly.

## iPhone & iPad data

On your iPhone or iPad: **Settings → Screen Time → Share Across Devices** → enable it.

Once enabled, Apple syncs usage data to your Mac via iCloud automatically. Click **Collect now** in the app after enabling it to pick up the data immediately.

## How it works

macOS writes Screen Time data for all devices on the same iCloud account into a local SQLite database at `~/Library/Application Support/Knowledge/knowledgeC.db`. Screen Time reads from that database (read-only, never writes to it), stores the records in its own database at `~/Library/Application Support/Screen Time/screentime.db`, and displays them in the dashboard.

Collection runs automatically every hour and whenever your Mac wakes from sleep.

## Security

- `knowledgeC.db` is opened **read-only** — the app never writes to Apple's database
- `nodeIntegration` is disabled — the renderer has no Node.js access
- `contextIsolation` is enabled — preload and renderer are separate JS contexts
- `sandbox` is enabled — Chromium renderer sandbox is enforced
- Content Security Policy blocks all external network requests (`connect-src 'none'`)
- Chart.js is bundled locally — nothing is loaded from a CDN
- Single-instance lock prevents two copies running simultaneously

## Privacy

All data stays on your Mac. Nothing is sent anywhere. `screentime.db` is listed in `.gitignore` so your usage data is never accidentally committed.

## Credits

SQL query adapted from [Felix Kohlhas's ScreenFlux project](https://felixkohlhas.com/projects/screentime/) and [Bob Rudis's original R exploration](https://rud.is/b/2019/10/28/spelunking-macos-screentime-app-usage-with-r/).
# screentime-explorer
