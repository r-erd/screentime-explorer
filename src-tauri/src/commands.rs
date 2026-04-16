use std::sync::{Arc, Mutex};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, State};
use crate::collect::{check_fda, FdaResult};
use crate::db;
use crate::scheduler;

pub struct DbState(pub Arc<Mutex<Connection>>);
pub struct DbPathState(pub String);

// ── Helpers ───────────────────────────────────────────────────────────────────

fn map_err(e: impl std::fmt::Display) -> String { e.to_string() }

fn validate_ts(from: i64, to: i64) -> Result<(), String> {
    if from < 0 || to < 0 || from > to || to > 9_999_999_999 {
        return Err("Invalid timestamp range".into());
    }
    Ok(())
}

fn today_str() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    if let Ok(mem) = rusqlite::Connection::open_in_memory() {
        let r: Result<String, _> = mem.query_row(
            "SELECT DATE(?1, 'unixepoch', 'localtime')",
            rusqlite::params![secs],
            |row| row.get(0),
        );
        if let Ok(s) = r { return s; }
    }
    "today".to_string()
}

// ── Data queries ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_screentime(from: i64, to: i64, state: State<'_, DbState>) -> Result<db::ScreentimeResult, String> {
    validate_ts(from, to)?;
    let conn = state.0.lock().map_err(map_err)?;
    db::get_screentime(&conn, from, to).map_err(map_err)
}

#[tauri::command]
pub fn get_daily(from: i64, to: i64, state: State<'_, DbState>) -> Result<db::DailyResult, String> {
    validate_ts(from, to)?;
    let conn = state.0.lock().map_err(map_err)?;
    db::get_daily(&conn, from, to).map_err(map_err)
}

#[tauri::command]
pub fn get_hourly(from: i64, to: i64, state: State<'_, DbState>) -> Result<db::HourlyResult, String> {
    validate_ts(from, to)?;
    let conn = state.0.lock().map_err(map_err)?;
    db::get_hourly(&conn, from, to).map_err(map_err)
}

#[tauri::command]
pub fn get_devices(state: State<'_, DbState>) -> Result<db::DevicesResult, String> {
    let conn = state.0.lock().map_err(map_err)?;
    db::get_devices(&conn).map_err(map_err)
}

#[tauri::command]
pub fn get_collection_log(limit: Option<i64>, state: State<'_, DbState>) -> Result<db::CollectionLogResult, String> {
    let safe_limit = limit.unwrap_or(50).clamp(1, 500);
    let conn = state.0.lock().map_err(map_err)?;
    db::get_collection_log(&conn, safe_limit).map_err(map_err)
}

// ── Actions ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn trigger_collect(app: AppHandle, state: State<'_, DbState>) -> serde_json::Value {
    if scheduler::is_running() {
        return serde_json::json!({ "ok": false, "error": "Collection already in progress" });
    }
    scheduler::run_collect(&app, state.0.clone());
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn check_fda_cmd() -> FdaResult {
    check_fda()
}

#[tauri::command]
pub async fn open_privacy_settings(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles", None::<&str>)
        .map_err(map_err)
}

#[tauri::command]
pub fn update_app_name(bundle_id: String, name: String, state: State<'_, DbState>) -> Result<(), String> {
    if bundle_id.is_empty() || bundle_id.len() > 512 {
        return Err("Invalid bundleId".into());
    }
    if name.len() > 256 {
        return Err("Name too long".into());
    }
    let conn = state.0.lock().map_err(map_err)?;
    db::update_app_name(&conn, &bundle_id, &name).map_err(map_err)
}

// ── Export / Import ───────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ExportResult {
    ok: bool,
    path: Option<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn export_db(app: AppHandle, db_path_state: State<'_, DbPathState>) -> Result<ExportResult, String> {
    use tauri_plugin_dialog::DialogExt;
    let db_path = db_path_state.0.clone();

    let file = app.dialog()
        .file()
        .set_title("Export Database Backup")
        .set_file_name(&format!("screenlog_backup_{}.db", today_str()))
        .add_filter("SQLite Database", &["db"])
        .blocking_save_file();

    match file {
        Some(dest) => {
            let dest_str = dest.to_string();
            match std::fs::copy(&db_path, &dest_str) {
                Ok(_) => Ok(ExportResult { ok: true, path: Some(dest_str), error: None }),
                Err(e) => Ok(ExportResult { ok: false, path: None, error: Some(e.to_string()) }),
            }
        }
        None => Ok(ExportResult { ok: false, path: None, error: None }),
    }
}

#[derive(Serialize)]
pub struct ImportResult {
    ok: bool,
    error: Option<String>,
}

#[tauri::command]
pub async fn import_db(app: AppHandle, db_path_state: State<'_, DbPathState>) -> Result<ImportResult, String> {
    use tauri_plugin_dialog::DialogExt;
    let db_path = db_path_state.0.clone();

    let file = app.dialog()
        .file()
        .set_title("Import Database Backup")
        .add_filter("SQLite Database", &["db"])
        .blocking_pick_file();

    let source = match file {
        Some(f) => f.to_string(),
        None => return Ok(ImportResult { ok: false, error: None }),
    };

    let confirmed = app.dialog()
        .message("This will completely replace your current history with the data from the backup file. This cannot be undone and the app will restart.")
        .title("Restore backup?")
        .blocking_show();

    if !confirmed {
        return Ok(ImportResult { ok: false, error: None });
    }

    match std::fs::copy(&source, &db_path) {
        Ok(_) => {
            app.restart();
            #[allow(unreachable_code)]
            Ok(ImportResult { ok: true, error: None })
        }
        Err(e) => Ok(ImportResult { ok: false, error: Some(e.to_string()) }),
    }
}

// ── App drill-down ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_app_daily(app_id: String, from: i64, to: i64, state: State<'_, DbState>) -> Result<db::AppDailyResult, String> {
    validate_ts(from, to)?;
    if app_id.is_empty() || app_id.len() > 512 {
        return Err("Invalid app_id".into());
    }
    let conn = state.0.lock().map_err(map_err)?;
    db::get_app_daily(&conn, &app_id, from, to).map_err(map_err)
}

// ── Notifications ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn show_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(map_err)
}

// ── Autostart (launch at login) ───────────────────────────────────────────────

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(map_err)
}

#[tauri::command]
pub fn set_autostart(enabled: bool, app: AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled { mgr.enable().map_err(map_err) } else { mgr.disable().map_err(map_err) }
}

// ── CSV export ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn save_csv(app: AppHandle, filename: String, content: String) -> Result<ExportResult, String> {
    use tauri_plugin_dialog::DialogExt;
    let file = app.dialog()
        .file()
        .set_title("Export as CSV")
        .set_file_name(&filename)
        .add_filter("CSV", &["csv"])
        .blocking_save_file();

    match file {
        Some(dest) => {
            let dest_str = dest.to_string();
            match std::fs::write(&dest_str, content) {
                Ok(_) => Ok(ExportResult { ok: true, path: Some(dest_str), error: None }),
                Err(e) => Ok(ExportResult { ok: false, path: None, error: Some(e.to_string()) }),
            }
        }
        None => Ok(ExportResult { ok: false, path: None, error: None }),
    }
}
