#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;
mod collect;
mod scheduler;
mod commands;

use std::sync::{Arc, Mutex};
use tauri::{
    AppHandle, Manager,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    image::Image,
};
use commands::{DbState, DbPathState};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // ── Database ──────────────────────────────────────────────────────
            let data_dir = app.path().app_data_dir()
                .expect("could not get app data dir");
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("screentime.db");
            let db_path_str = db_path.to_string_lossy().to_string();

            let conn = rusqlite::Connection::open(&db_path)
                .expect("failed to open screentime.db");
            db::init_schema(&conn).expect("failed to init schema");

            let shared_conn = Arc::new(Mutex::new(conn));
            app.manage(DbState(shared_conn.clone()));
            app.manage(DbPathState(db_path_str));

            // ── Tray icon ─────────────────────────────────────────────────────
            let quit = MenuItemBuilder::with_id("quit", "Quit Screenlog").build(app)?;
            let show = MenuItemBuilder::with_id("show", "Show Dashboard").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

            // Load template icon from assets dir next to the binary
            let icon = load_tray_icon(app);

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        toggle_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => show_window(app),
                    _ => {}
                })
                .build(app)?;

            // No Dock icon — LSUIElement in Info.plist handles it, but also set here
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // ── Plugins ───────────────────────────────────────────────────────
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent, None,
            ))?;
            app.handle().plugin(tauri_plugin_notification::init())?;
            app.handle().plugin(tauri_plugin_window_state::Builder::default().build())?;

            // ── Scheduler ─────────────────────────────────────────────────────
            scheduler::start_scheduler(app.handle().clone(), shared_conn);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_screentime,
            commands::get_daily,
            commands::get_hourly,
            commands::get_devices,
            commands::get_collection_log,
            commands::trigger_collect,
            commands::check_fda_cmd,
            commands::open_privacy_settings,
            commands::update_app_name,
            commands::export_db,
            commands::import_db,
            commands::get_app_daily,
            commands::show_notification,
            commands::get_autostart,
            commands::set_autostart,
            commands::save_csv,
        ])
        .on_window_event(|window, event| {
            // Hide instead of close — app lives in the menu bar
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Screenlog");
}

// ── Tray icon loading ─────────────────────────────────────────────────────────

fn load_tray_icon(app: &tauri::App) -> Image<'static> {
    // Tauri maps `../assets/` → `_up_/assets/` inside Contents/Resources
    let resource_dir = app.path().resource_dir().ok();
    let icon_bytes: Option<Vec<u8>> = resource_dir.as_ref().and_then(|d| {
        let base = d.join("_up_").join("assets");
        let p2x = base.join("iconTemplate@2x.png");
        let p1x = base.join("iconTemplate.png");
        std::fs::read(&p2x).or_else(|_| std::fs::read(&p1x)).ok()
    });

    match icon_bytes {
        Some(bytes) => Image::from_bytes(&bytes).unwrap_or_else(|_| default_icon()),
        None => default_icon(),
    }
}

fn default_icon() -> Image<'static> {
    // 16×16 white square as absolute fallback (visible on both light/dark bars)
    let pixels: Vec<u8> = std::iter::repeat([255u8, 255, 255, 255])
        .take(16 * 16)
        .flatten()
        .collect();
    Image::new_owned(pixels, 16, 16)
}

// ── Window helpers ────────────────────────────────────────────────────────────

fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            show_window(app);
        }
    }
}

fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}
