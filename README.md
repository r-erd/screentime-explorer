# Screenlog

A lightweight macOS menu bar app that visualises your Screen Time data.
No cloud, no Python, no server — everything stays on your Mac.

Built with [Tauri v2](https://tauri.app) (Rust backend + system WKWebView). The entire app bundle is **~6 MB**.

## Why Screenlog instead of the built-in Screen Time app?

macOS has a Screen Time panel in System Settings, but it is designed for parental controls and gives you almost no analytical power as a regular user:

- **No history beyond a week** — you cannot look back more than 7 days
- **No daily goal tracking** — no threshold line, no streak, no success rate
- **No notifications** — it won't warn you when you are halfway through your daily budget
- **No data export** — you cannot get your usage data out in any form
- **No per-app history** — you can't see how a single app's usage has changed over time
- **No menu bar access** — you have to dig into System Settings every time

Screenlog reads the same underlying database that macOS populates, adds its own lightweight storage layer, and surfaces everything in a persistent menu bar dashboard.

## Features

- **Menu bar app** — no Dock icon; click the tray icon to show or hide the window
- **Automatic collection** — gathers data on startup, every hour, and on every wake from sleep
- **Daily goal** — set a target in hours; a threshold line appears on the chart and KPI cards track your success rate and streak
- **Screen time warnings** — optional notifications at 50% and 100% of your daily goal
- **App drill-down** — click any bar in the Overview to see that app's full daily history
- **App renaming** — give any app a friendlier display name
- **Export** — back up the database or export the current view as CSV
- **Dark mode** — follows system appearance, or force Light / Dark in Settings
- **Launch at login** — optional, configured in Settings
- **Secure** — reads Apple's database read-only, all data stays local

## Requirements

- macOS 12 (Monterey) or later
- Rust + `@tauri-apps/cli` (build from source only)

## Install

### Download (recommended)

Download the latest `Screenlog-*.dmg` from [Releases](../../releases), open it, and drag **Screenlog.app** to your Applications folder.

> **First launch:** macOS will show _"Screenlog cannot be verified"_ because the app is not notarised.
> To open it: **right-click → Open**, then click **Open** in the dialog.
> After that it launches normally. Alternatively, run:
> ```bash
> xattr -cr /Applications/Screenlog.app
> ```

### Build from source

```bash
git clone https://github.com/r-erd/screenlog.git
cd screenlog
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

## Security

- `knowledgeC.db` is opened **read-only** — the app never writes to Apple's database
- Renderer runs in a sandboxed WKWebView — no Node.js access
- Content Security Policy blocks all external network requests
- Chart.js is bundled locally — nothing is loaded from a CDN
- All data stays on your Mac

## Privacy

All data stays on your Mac. Nothing is sent anywhere.
