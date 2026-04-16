# Screenlog

A macOS menu bar app that visualises your Screen Time data. No cloud, no Python, no server — everything stays on your Mac.

Built with [Tauri v2](https://tauri.app) (Rust backend + system WKWebView). The entire app bundle is **~6 MB**.

## Features

- **Menu bar app** — no Dock icon; click the tray icon to show or hide the window
- **Automatic collection** — gathers data on startup, every hour, and on every wake from sleep
- **Three views** — Overview (top apps), Daily (usage per day), Hourly (average by hour of day)
- **Period navigation** — Day / Week / Month / Year with ‹ › arrows
- **Daily goal** — set a target in hours; days that meet it get a ✓ tick mark on the chart, a threshold line appears, and KPI cards show your success rate and streak
- **Screen time warnings** — optional notifications at 50% and 100% of your daily goal
- **App drill-down** — click any bar in the Overview chart to see that app's daily history
- **App renaming** — double-click any bar in the Overview chart to give an app a friendly name
- **Export** — back up the database or export the current view as CSV
- **Dark mode** — follows the system appearance, or force Light / Dark in Settings
- **Launch at login** — optional, configured in Settings
- **Secure** — reads Apple's database read-only, all data stays local

## Requirements

- macOS 12 (Monterey) or later
- Rust + `@tauri-apps/cli` (build from source only)

## Install

### Download (recommended)

Download the latest `Screenlog-*.zip` from [Releases](../../releases), unzip it, and move **Screenlog.app** to your Applications folder.

> **First launch:** macOS will show _"Screenlog cannot be verified"_ because the app is not notarised.
> To open it: **right-click → Open**, then click **Open** in the dialog.
> After that it launches normally. Alternatively, run:
> ```bash
> xattr -cr /Applications/Screenlog.app
> ```

### Build from source

```bash
git clone https://github.com/r-erd/screentime-explorer.git
cd screentime-explorer
npm install          # installs @tauri-apps/cli
npm run build        # compiles the Rust backend + bundles the app
```

The built app will be at `src-tauri/target/release/bundle/macos/Screenlog.app`.

> **Rust required.** If you don't have Rust installed:
> ```bash
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
> source ~/.cargo/env
> ```

## First launch

On first launch, Screenlog shows a setup screen asking for **Full Disk Access**.

Apple's Screen Time database (`~/Library/Application Support/Knowledge/knowledgeC.db`) is protected by macOS privacy controls. Full Disk Access is required to read it.

1. Click **Open System Settings** in the app
2. Go to **Privacy & Security → Full Disk Access**
3. Enable access for **Screenlog**
4. Click **Check Again** in the app

## Usage

### Views

| Tab | What it shows |
|-----|--------------|
| **Overview** | Top apps ranked by total usage for the period. Click a bar to see that app's daily history. Double-click to rename. |
| **Daily** | Total screen time per day. ✓ marks indicate days the daily goal was met. |
| **Hourly** | Average usage by hour of day across the period. |

### Period selector

Use **Day / Week / Month / Year** to set the granularity, and **‹ ›** to navigate. Click the period label to jump back to the current period.

### Daily goal & notifications

Open **Settings** (⚙) and enter a target in hours under **Daily Goal**. Once set:
- A red dashed **threshold line** appears on the Daily chart
- **✓ tick marks** appear above bars that meet the goal (toggle in Settings)
- Four **KPI cards** show days on target, success rate, and streaks
- Enable **Screen time warnings** in Settings → Notifications to get notified at 50% and 100% of your goal

### App drill-down

In the Overview chart, **single-click** any bar to open a daily history chart for that app. **Double-click** to rename it.

### Settings (⚙)

| Section | Options |
|---------|---------|
| **Appearance & System** | Light / Dark / System appearance; Launch at login |
| **Daily Goal** | Set or clear a daily screen time target; toggle tick marks |
| **Notifications** | Screen time warnings at 50% and 100% of goal |
| **Data** | Export DB backup, import backup, export current view as CSV |
| **iPhone & iPad Data** | Why synced device data is unavailable on macOS 13+ |
| **Collection History** | Log of every collection run with row counts and errors |

## iPhone & iPad data

> **macOS 13+ limitation:** On Ventura and later, Apple moved synced device Screen Time data into a private, sandboxed database (`RMAdminStore-Cloud.sqlite`) that is protected beyond Full Disk Access — even `sudo` cannot read it. Only Mac usage data is available on macOS 13+.

On macOS 12 (Monterey) and earlier, iPhone and iPad data is stored alongside Mac data and is accessible. Enable **Settings → Screen Time → Share Across Devices** on your iPhone/iPad.

## How it works

macOS continuously writes Screen Time data to `~/Library/Application Support/Knowledge/knowledgeC.db`. Screenlog reads from that database (read-only, never writes), stores records in its own database at `~/Library/Application Support/com.screenlog.dashboard/screentime.db`, and displays them in the dashboard.

Collection runs on startup, every hour, and on every wake from sleep.

## Icon generation

```bash
npm run icon   # regenerates all icon sizes from assets/screentime_app.png
./generate-icons.sh --menubar assets/screentime_menu.png  # regenerates menu bar template PNGs
```

## Security

- `knowledgeC.db` is opened **read-only** — the app never writes to Apple's database
- Renderer runs in a sandboxed WKWebView — no Node.js access
- Content Security Policy blocks all external network requests
- Chart.js is bundled locally — nothing is loaded from a CDN
- All data stays on your Mac

## Privacy

All data stays on your Mac. Nothing is sent anywhere. `screentime.db` is listed in `.gitignore`.
