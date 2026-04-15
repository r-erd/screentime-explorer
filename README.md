# Screenlog

A macOS menu bar app that visualizes your Screen Time data — across Mac, iPhone, and iPad. No cloud services, no Python, no server. Data stays entirely on your machine.

## Features

- **Menu bar app** — lives in your menu bar, no Dock icon
- **Automatic collection** — gathers data hourly and on every wake from sleep
- **Multi-device** — shows Mac, iPhone, and iPad usage side by side (requires iCloud Screen Time sync)
- **Three views** — Overview (top apps), Daily (usage per day), Hourly (average by hour)
- **Period navigation** — Day / Week / Month / Year with ‹ › arrows
- **Daily goal** — set a screen time target; days that meet it turn green, a threshold line appears on the chart, and KPI cards show your success rate and streaks
- **App renaming** — double-click any bar in the Overview chart to give an app a friendly name
- **Import / Export** — back up and restore your history database
- **Secure** — reads Apple's database read-only, all data stays local

## Requirements

- macOS 12 or later
- Node.js (for building from source)

## Install

### Download (recommended)

Download the latest `Screenlog-*.dmg` from [Releases](../../releases), open it, and drag **Screenlog** to Applications.

### Build from source

```bash
git clone https://github.com/YOUR_USERNAME/screentime-check.git
cd screentime-check
npm install
npm start
```

> **Note:** `npm install` runs `electron-builder install-app-deps` via postinstall, which compiles `better-sqlite3` against the correct Electron runtime automatically.

To build a distributable `.dmg`:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build        # arm64 (Apple Silicon)
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:x64    # Intel
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:universal  # both in one binary
```

## First launch

On first launch, Screenlog will show a setup screen asking for **Full Disk Access**.

Apple's Screen Time database (`~/Library/Application Support/Knowledge/knowledgeC.db`) is protected by macOS privacy controls. Full Disk Access is required to read it.

1. Click **Open System Settings** in the app
2. Go to **Privacy & Security → Full Disk Access**
3. Click `+` and add **Screenlog** (or **Electron** if running via `npm start`)
4. Click **Check Again** in the app

> **Development note:** When running via `npm start`, grant FDA to `node_modules/electron/dist/Electron.app`. For testing the packaged app, run `npm run build` and open `dist/mac-arm64/Screenlog.app` directly.

## iPhone & iPad data

> **macOS 13+ limitation:** On Ventura and later, Apple moved synced device Screen Time data into a private, sandboxed database (`RMAdminStore-Cloud.sqlite`) that is protected beyond Full Disk Access — even `sudo` cannot read it. Only Apple's own ScreenTimeAgent process has access. **Screenlog can only show Mac usage data on macOS 13+.**

On macOS 12 (Monterey) and earlier, iPhone and iPad data is stored in `knowledgeC.db` alongside Mac data and is fully accessible. If you are on Monterey, enable **Settings → Screen Time → Share Across Devices** on your iPhone/iPad and click **Collect now**.

## Usage

### Views

| Tab | What it shows |
|-----|--------------|
| **Overview** | Top apps ranked by total usage for the period, as a horizontal bar chart. Double-click any bar to rename the app. |
| **Daily** | Total screen time per day as a vertical bar chart. Green bars indicate days the daily goal was met. |
| **Hourly** | Average usage by hour of day across the period. |

### Period selector

Use **Day / Week / Month / Year** buttons to set the period granularity, and the **‹ ›** arrows to navigate. Click the period label (e.g. "This Week") to jump back to the current period.

### Daily goal

Open **Settings** (⚙ in the header) and enter a target in hours under **Daily Goal**. Once set:
- Days that meet the target show as **green bars** in the Daily chart
- A red dashed **threshold line** appears on the Daily chart
- Four **KPI cards** appear in both the Overview and Daily tabs:
  - **Days on Target** — how many days with data were under the limit
  - **Success Rate** — percentage of days on target (green ≥ 80 %, red < 50 %)
  - **Current Streak** — consecutive days meeting the goal from the most recent day with data
  - **Best Streak** — longest consecutive run within the current period

### App renaming

In the Overview chart, double-click any bar to open a rename popover. The friendly name is saved locally and persists across restarts.

### Settings (⚙)

| Section | Options |
|---------|---------|
| **Daily Goal** | Set or clear a daily screen time target in hours |
| **Data** | Export a backup of your database, or import a previous backup |
| **Collection History** | Log of every collection run with row counts and error messages |

## How it works

macOS writes Screen Time data for all devices on the same iCloud account into a local SQLite database at `~/Library/Application Support/Knowledge/knowledgeC.db`. Screenlog reads from that database (read-only, never writes to it), stores the records in its own database at `~/Library/Application Support/Screenlog/screentime.db`, and displays them in the dashboard.

Collection runs automatically every hour and whenever your Mac wakes from sleep.

## Updating icons

Use `generate-icons.sh` to regenerate icon assets from source PNGs:

```bash
./generate-icons.sh --app assets/screentime_app.png        # regenerates icon.icns
./generate-icons.sh --menubar assets/screentime_menu.png   # regenerates iconTemplate PNGs
```

Source images should be provided at the largest size (1024 × 1024 for the app icon, any size for the menu bar icon). The script converts the menu bar icon to a black-on-transparent template image automatically.

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
