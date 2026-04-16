use rusqlite::{Connection, Result as SqlResult, params};
use serde::Serialize;
use std::collections::HashMap;

// Apple Core Data epoch starts 2001-01-01; Unix epoch 1970-01-01.
pub const APPLE_EPOCH_OFFSET: i64 = 978_307_200;

pub const KNOWLEDGE_DB: &str = "Library/Application Support/Knowledge/knowledgeC.db";

// ── Schema ────────────────────────────────────────────────────────────────────

pub fn init_schema(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch("
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS screentime (
            app           TEXT    NOT NULL,
            usage_seconds REAL,
            start_time    INTEGER NOT NULL,
            end_time      INTEGER,
            tz_offset     INTEGER,
            device_id     TEXT    NOT NULL DEFAULT '',
            device_model  TEXT,
            PRIMARY KEY (app, start_time, device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_start_time ON screentime(start_time);

        CREATE TABLE IF NOT EXISTS collection_log (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            ran_at           INTEGER NOT NULL,
            records_fetched  INTEGER NOT NULL,
            records_inserted INTEGER NOT NULL,
            error            TEXT
        );

        CREATE TABLE IF NOT EXISTS app_names (
            bundle_id    TEXT PRIMARY KEY,
            display_name TEXT NOT NULL
        );
    ")
}

// ── Device type helper ────────────────────────────────────────────────────────

fn device_type_expr(alias: &str) -> String {
    let prefix = if alias.is_empty() { String::new() } else { format!("{}.", alias) };
    format!(
        "CASE \
            WHEN {p}device_model IS NULL OR {p}device_model = '' THEN 'mac' \
            WHEN LOWER({p}device_model) LIKE 'iphone%' THEN 'iphone' \
            WHEN LOWER({p}device_model) LIKE 'ipad%' THEN 'ipad' \
            ELSE 'mac' \
        END",
        p = prefix
    )
}

// ── Query result types ────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Default)]
pub struct AppRow {
    pub app: String,
    pub display_name: String,
    pub mac: i64,
    pub iphone: i64,
    pub ipad: i64,
}

#[derive(Serialize)]
pub struct ScreentimeResult {
    pub apps: Vec<AppRow>,
}

#[derive(Serialize, Clone, Default)]
pub struct DayRow {
    pub date: String,
    pub mac: i64,
    pub iphone: i64,
    pub ipad: i64,
}

#[derive(Serialize)]
pub struct DailyResult {
    pub days: Vec<DayRow>,
}

#[derive(Serialize, Clone, Default)]
pub struct HourRow {
    pub hour: i64,
    pub mac: i64,
    pub iphone: i64,
    pub ipad: i64,
}

#[derive(Serialize)]
pub struct HourlyResult {
    pub hours: Vec<HourRow>,
    pub num_days: i64,
}

#[derive(Serialize)]
pub struct DevicesResult {
    pub types: Vec<String>,
}

#[derive(Serialize)]
pub struct CollectionLogEntry {
    pub ran_at: i64,
    pub fetched: i64,
    pub inserted: i64,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct CollectionLogResult {
    pub runs: Vec<CollectionLogEntry>,
}

// ── Queries ───────────────────────────────────────────────────────────────────

pub fn get_screentime(conn: &Connection, from: i64, to: i64) -> SqlResult<ScreentimeResult> {
    let dtype = device_type_expr("s");
    let sql = format!(
        "SELECT s.app, COALESCE(n.display_name, s.app) AS display_name, {dtype} AS dtype, \
         CAST(SUM(usage_seconds) AS INTEGER) AS total \
         FROM screentime s \
         LEFT JOIN app_names n ON s.app = n.bundle_id \
         WHERE s.start_time >= ?1 AND s.start_time <= ?2 \
           AND s.app IS NOT NULL AND s.usage_seconds > 0 \
         GROUP BY s.app, dtype",
        dtype = dtype
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut apps: HashMap<String, AppRow> = HashMap::new();

    let rows = stmt.query_map(params![from, to], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
        ))
    })?;

    for row in rows {
        let (app, display_name, dtype, total) = row?;
        let entry = apps.entry(app.clone()).or_insert_with(|| AppRow {
            app: app.clone(),
            display_name: display_name.clone(),
            ..Default::default()
        });
        entry.display_name = display_name;
        match dtype.as_str() {
            "iphone" => entry.iphone = total,
            "ipad"   => entry.ipad = total,
            _        => entry.mac = total,
        }
    }

    let mut result: Vec<AppRow> = apps.into_values().collect();
    result.sort_by(|a, b| {
        let ta = a.mac + a.iphone + a.ipad;
        let tb = b.mac + b.iphone + b.ipad;
        tb.cmp(&ta)
    });
    result.truncate(40);

    Ok(ScreentimeResult { apps: result })
}

pub fn get_daily(conn: &Connection, from: i64, to: i64) -> SqlResult<DailyResult> {
    let dtype = device_type_expr("");
    let sql = format!(
        "SELECT DATE(start_time, 'unixepoch', 'localtime') AS day, \
         {dtype} AS dtype, \
         CAST(SUM(usage_seconds) AS INTEGER) AS total \
         FROM screentime \
         WHERE start_time >= ?1 AND start_time <= ?2 \
           AND app IS NOT NULL AND usage_seconds > 0 \
         GROUP BY day, dtype \
         ORDER BY day ASC",
        dtype = dtype
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<(String, String, i64)> = stmt.query_map(params![from, to], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?.filter_map(|r| r.ok()).collect();

    // Build contiguous date range
    use std::collections::BTreeMap;
    let mut days: BTreeMap<String, DayRow> = BTreeMap::new();

    let end_ts = to.min(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    );

    // Iterate day by day from `from` to `end_ts`
    let mut cursor = from - (from % 86400); // floor to day boundary (UTC approx)
    while cursor <= end_ts {
        let iso = unix_to_date_local(cursor);
        days.insert(iso.clone(), DayRow { date: iso, ..Default::default() });
        cursor += 86400;
    }

    for (day, dtype, total) in rows {
        if let Some(entry) = days.get_mut(&day) {
            match dtype.as_str() {
                "iphone" => entry.iphone = total,
                "ipad"   => entry.ipad = total,
                _        => entry.mac = total,
            }
        }
    }

    Ok(DailyResult { days: days.into_values().collect() })
}

pub fn get_hourly(conn: &Connection, from: i64, to: i64) -> SqlResult<HourlyResult> {
    let num_days = ((to - from) as f64 / 86400.0).round().max(1.0) as i64;
    let dtype = device_type_expr("");
    let sql = format!(
        "SELECT CAST(strftime('%H', start_time, 'unixepoch', 'localtime') AS INTEGER) AS hour, \
         {dtype} AS dtype, \
         CAST(SUM(usage_seconds) AS INTEGER) AS total \
         FROM screentime \
         WHERE start_time >= ?1 AND start_time <= ?2 \
           AND app IS NOT NULL AND usage_seconds > 0 \
         GROUP BY hour, dtype \
         ORDER BY hour ASC",
        dtype = dtype
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<(i64, String, i64)> = stmt.query_map(params![from, to], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?.filter_map(|r| r.ok()).collect();

    let mut hours: Vec<HourRow> = (0..24).map(|h| HourRow { hour: h, ..Default::default() }).collect();

    for (hour, dtype, total) in rows {
        if let Some(entry) = hours.get_mut(hour as usize) {
            match dtype.as_str() {
                "iphone" => entry.iphone = total,
                "ipad"   => entry.ipad = total,
                _        => entry.mac = total,
            }
        }
    }

    Ok(HourlyResult { hours, num_days })
}

pub fn get_devices(conn: &Connection) -> SqlResult<DevicesResult> {
    let dtype = device_type_expr("");
    let sql = format!(
        "SELECT DISTINCT {dtype} AS dtype FROM screentime WHERE usage_seconds > 0",
        dtype = dtype
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut types: Vec<String> = stmt.query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    types.sort();
    Ok(DevicesResult { types })
}

pub fn get_collection_log(conn: &Connection, limit: i64) -> SqlResult<CollectionLogResult> {
    let mut stmt = conn.prepare(
        "SELECT ran_at, records_fetched, records_inserted, error \
         FROM collection_log ORDER BY ran_at DESC LIMIT ?1"
    )?;
    let runs = stmt.query_map(params![limit], |row| {
        Ok(CollectionLogEntry {
            ran_at:   row.get(0)?,
            fetched:  row.get(1)?,
            inserted: row.get(2)?,
            error:    row.get(3)?,
        })
    })?.filter_map(|r| r.ok()).collect();
    Ok(CollectionLogResult { runs })
}

pub fn update_app_name(conn: &Connection, bundle_id: &str, display_name: &str) -> SqlResult<()> {
    if display_name.trim().is_empty() {
        conn.execute("DELETE FROM app_names WHERE bundle_id = ?1", params![bundle_id])?;
    } else {
        conn.execute(
            "INSERT INTO app_names (bundle_id, display_name) VALUES (?1, ?2) \
             ON CONFLICT(bundle_id) DO UPDATE SET display_name = excluded.display_name",
            params![bundle_id, display_name.trim()],
        )?;
    }
    Ok(())
}

pub fn log_collection(conn: &Connection, ran_at: i64, fetched: i64, inserted: i64, error: Option<&str>) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO collection_log (ran_at, records_fetched, records_inserted, error) VALUES (?1, ?2, ?3, ?4)",
        params![ran_at, fetched, inserted, error],
    )?;
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn unix_to_date_local(ts: i64) -> String {
    // Use strftime via a temporary in-memory DB for simplicity
    // (avoids pulling in the chrono crate)
    if let Ok(mem) = Connection::open_in_memory() {
        let result: Result<String, _> = mem.query_row(
            "SELECT DATE(?1, 'unixepoch', 'localtime')",
            params![ts],
            |row| row.get(0),
        );
        if let Ok(s) = result { return s; }
    }
    // Fallback: crude UTC date
    let days = ts / 86400;
    let y = 1970 + days / 365;
    format!("{:04}-01-01", y)
}
