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

        CREATE TABLE IF NOT EXISTS device_names (
            device_id    TEXT PRIMARY KEY,
            display_name TEXT NOT NULL
        );
    ")?;

    // Migrate: add per-source columns to collection_log if they don't exist yet.
    // ALTER TABLE ADD COLUMN fails silently when the column is already present.
    for sql in &[
        "ALTER TABLE collection_log ADD COLUMN mac_fetched   INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE collection_log ADD COLUMN mac_inserted  INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE collection_log ADD COLUMN biome_fetched  INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE collection_log ADD COLUMN biome_inserted INTEGER NOT NULL DEFAULT 0",
    ] {
        let _ = conn.execute(sql, []);
    }

    Ok(())
}

// ── Query result types ────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Default)]
pub struct AppRow {
    pub app:          String,
    pub display_name: String,
    pub by_device:    HashMap<String, i64>,
}

#[derive(Serialize)]
pub struct ScreentimeResult {
    pub apps:        Vec<AppRow>,
    pub dedup_total: i64,   // union of all intervals across devices for the period
}

#[derive(Serialize, Clone, Default)]
pub struct DayRow {
    pub date:        String,
    pub by_device:   HashMap<String, i64>,
    pub dedup_total: i64,   // union of all intervals for this day
}

#[derive(Serialize)]
pub struct DailyResult {
    pub days: Vec<DayRow>,
}

#[derive(Serialize, Clone, Default)]
pub struct HourRow {
    pub hour:       i64,
    pub by_device:  HashMap<String, i64>,
    pub dedup_secs: i64,  // average deduplicated seconds per day for this hour
}

#[derive(Serialize)]
pub struct HourlyResult {
    pub hours:    Vec<HourRow>,
    pub num_days: i64,
}

#[derive(Serialize, Clone)]
pub struct DeviceInfo {
    pub device_id:    String,
    pub device_type:  String,   // "mac" | "iphone" | "ipad"
    pub display_name: String,
}

#[derive(Serialize)]
pub struct DevicesResult {
    pub devices: Vec<DeviceInfo>,
}

#[derive(Serialize)]
pub struct CollectionLogEntry {
    pub ran_at:        i64,
    pub fetched:       i64,
    pub inserted:      i64,
    pub mac_fetched:   i64,
    pub mac_inserted:  i64,
    pub biome_fetched:  i64,
    pub biome_inserted: i64,
    pub error:         Option<String>,
}

#[derive(Serialize)]
pub struct CollectionLogResult {
    pub runs: Vec<CollectionLogEntry>,
}

// ── Interval-union helpers ────────────────────────────────────────────────────

/// Merge a list of `(start, end)` intervals and return the total deduplicated
/// duration in seconds. Intervals need not be sorted on entry.
fn merge_intervals(mut ivs: Vec<(i64, i64)>) -> i64 {
    if ivs.is_empty() { return 0; }
    ivs.sort_unstable_by_key(|&(s, _)| s);
    let mut total = 0i64;
    let (mut cs, mut ce) = ivs[0];
    for (s, e) in ivs.into_iter().skip(1) {
        if s <= ce { ce = ce.max(e); }
        else { total += ce - cs; cs = s; ce = e; }
    }
    total + (ce - cs)
}

/// Fetch every (start_time, effective_end_time) interval in [from, to],
/// grouped by local date string "YYYY-MM-DD".
/// `effective_end = COALESCE(end_time, start_time + CAST(usage_seconds AS INTEGER))`
fn fetch_intervals_by_day(
    conn: &Connection, from: i64, to: i64,
) -> SqlResult<HashMap<String, Vec<(i64, i64)>>> {
    let mut stmt = conn.prepare(
        "SELECT DATE(start_time, 'unixepoch', 'localtime'), \
         start_time, \
         COALESCE(end_time, start_time + CAST(usage_seconds AS INTEGER)) \
         FROM screentime \
         WHERE start_time >= ?1 AND start_time <= ?2 \
           AND app IS NOT NULL AND usage_seconds > 0"
    )?;
    let mut map: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    let rows = stmt.query_map(params![from, to], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
    })?.filter_map(|r| r.ok());
    for (day, s, e) in rows {
        map.entry(day).or_default().push((s, e));
    }
    Ok(map)
}

/// Total deduplicated duration for [from, to] across all devices.
fn fetch_dedup_total(conn: &Connection, from: i64, to: i64) -> SqlResult<i64> {
    let mut stmt = conn.prepare(
        "SELECT start_time, \
         COALESCE(end_time, start_time + CAST(usage_seconds AS INTEGER)) \
         FROM screentime \
         WHERE start_time >= ?1 AND start_time <= ?2 \
           AND app IS NOT NULL AND usage_seconds > 0"
    )?;
    let ivs: Vec<(i64, i64)> = stmt.query_map(params![from, to], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?.filter_map(|r| r.ok()).collect();
    Ok(merge_intervals(ivs))
}

// ── Queries ───────────────────────────────────────────────────────────────────

pub fn get_screentime(conn: &Connection, from: i64, to: i64) -> SqlResult<ScreentimeResult> {
    let mut stmt = conn.prepare(
        "SELECT s.app, COALESCE(n.display_name, s.app) AS display_name, \
         s.device_id, \
         CAST(SUM(s.usage_seconds) AS INTEGER) AS total \
         FROM screentime s \
         LEFT JOIN app_names n ON s.app = n.bundle_id \
         WHERE s.start_time >= ?1 AND s.start_time <= ?2 \
           AND s.app IS NOT NULL AND s.usage_seconds > 0 \
         GROUP BY s.app, s.device_id"
    )?;

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
        let (app, display_name, device_id, total) = row?;
        let entry = apps.entry(app.clone()).or_insert_with(|| AppRow {
            app: app.clone(),
            display_name: display_name.clone(),
            by_device: HashMap::new(),
        });
        entry.display_name = display_name;
        entry.by_device.insert(device_id, total);
    }

    let mut result: Vec<AppRow> = apps.into_values().collect();
    result.sort_by(|a, b| {
        let ta: i64 = a.by_device.values().sum();
        let tb: i64 = b.by_device.values().sum();
        tb.cmp(&ta)
    });
    result.truncate(40);

    let dedup_total = fetch_dedup_total(conn, from, to)?;

    Ok(ScreentimeResult { apps: result, dedup_total })
}

pub fn get_daily(conn: &Connection, from: i64, to: i64) -> SqlResult<DailyResult> {
    let mut stmt = conn.prepare(
        "SELECT DATE(start_time, 'unixepoch', 'localtime') AS day, \
         device_id, \
         CAST(SUM(usage_seconds) AS INTEGER) AS total \
         FROM screentime \
         WHERE start_time >= ?1 AND start_time <= ?2 \
           AND app IS NOT NULL AND usage_seconds > 0 \
         GROUP BY day, device_id \
         ORDER BY day ASC"
    )?;

    let rows: Vec<(String, String, i64)> = stmt.query_map(params![from, to], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?.filter_map(|r| r.ok()).collect();

    // Fetch raw intervals for dedup computation (one query covers the whole range)
    let mut ivs_by_day = fetch_intervals_by_day(conn, from, to)?;

    // Build contiguous date range
    use std::collections::BTreeMap;
    let mut days: BTreeMap<String, DayRow> = BTreeMap::new();

    let end_ts = to.min(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64,
    );

    // Iterate day by day from `from` to `end_ts`.
    // The frontend always passes `from` as local midnight, so we start there directly.
    // Flooring to UTC midnight (from % 86400) was wrong for non-UTC timezones and
    // produced a spurious empty day at the start of every period.
    let mut cursor = from;
    while cursor <= end_ts {
        let iso = unix_to_date_local(cursor);
        days.insert(iso.clone(), DayRow { date: iso, by_device: HashMap::new(), dedup_total: 0 });
        cursor += 86400;
    }

    for (day, device_id, total) in rows {
        if let Some(entry) = days.get_mut(&day) {
            entry.by_device.insert(device_id, total);
        }
    }

    // Fill dedup_total per day
    for (date, entry) in days.iter_mut() {
        let ivs = ivs_by_day.remove(date).unwrap_or_default();
        entry.dedup_total = merge_intervals(ivs);
    }

    Ok(DailyResult { days: days.into_values().collect() })
}

pub fn get_hourly(conn: &Connection, from: i64, to: i64) -> SqlResult<HourlyResult> {
    let num_days = ((to - from) as f64 / 86400.0).round().max(1.0) as i64;
    let mut stmt = conn.prepare(
        "SELECT CAST(strftime('%H', start_time, 'unixepoch', 'localtime') AS INTEGER) AS hour, \
         device_id, \
         CAST(SUM(usage_seconds) AS INTEGER) AS total \
         FROM screentime \
         WHERE start_time >= ?1 AND start_time <= ?2 \
           AND app IS NOT NULL AND usage_seconds > 0 \
         GROUP BY hour, device_id \
         ORDER BY hour ASC"
    )?;

    let rows: Vec<(i64, String, i64)> = stmt.query_map(params![from, to], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })?.filter_map(|r| r.ok()).collect();

    let mut hours: Vec<HourRow> = (0..24).map(|h| HourRow { hour: h, by_device: HashMap::new(), dedup_secs: 0 }).collect();

    for (hour, device_id, total) in rows {
        if let Some(entry) = hours.get_mut(hour as usize) {
            entry.by_device.insert(device_id, total);
        }
    }

    // ── Hourly dedup ──────────────────────────────────────────────────────────
    // For each (local_date, local_hour) bucket, merge overlapping intervals across
    // devices, then average the deduplicated seconds per hour across all days.
    {
        let mut iv_stmt = conn.prepare(
            "SELECT DATE(start_time, 'unixepoch', 'localtime'), \
             CAST(strftime('%H', start_time, 'unixepoch', 'localtime') AS INTEGER), \
             start_time, \
             COALESCE(end_time, start_time + CAST(usage_seconds AS INTEGER)) \
             FROM screentime \
             WHERE start_time >= ?1 AND start_time <= ?2 \
               AND app IS NOT NULL AND usage_seconds > 0"
        )?;

        // bucket: (day_str, hour) → Vec<(start, end)>
        let mut buckets: HashMap<(String, usize), Vec<(i64, i64)>> = HashMap::new();
        let iv_rows = iv_stmt.query_map(params![from, to], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, usize>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?.filter_map(|r| r.ok());

        for (day, hour, s, e) in iv_rows {
            buckets.entry((day, hour)).or_default().push((s, e));
        }

        // Accumulate per-hour deduplicated totals across all days, then average
        let mut dedup_sum: [i64; 24] = [0; 24];
        for ((_, hour), ivs) in buckets {
            if hour < 24 {
                dedup_sum[hour] += merge_intervals(ivs);
            }
        }
        for h in 0..24usize {
            hours[h].dedup_secs = dedup_sum[h] / num_days;
        }
    }

    Ok(HourlyResult { hours, num_days })
}

pub fn get_devices(conn: &Connection) -> SqlResult<DevicesResult> {
    let mut stmt = conn.prepare(
        "SELECT s.device_id, \
         CASE \
             WHEN COALESCE(MAX(s.device_model), '') = '' THEN 'mac' \
             WHEN LOWER(MAX(s.device_model)) LIKE 'iphone%' THEN 'iphone' \
             WHEN LOWER(MAX(s.device_model)) LIKE 'ipad%' THEN 'ipad' \
             ELSE 'mac' \
         END AS device_type, \
         COALESCE(MAX(s.device_model), '') AS model, \
         COALESCE(MAX(dn.display_name), '') AS custom_name \
         FROM screentime s \
         LEFT JOIN device_names dn ON s.device_id = dn.device_id \
         WHERE s.usage_seconds > 0 \
         GROUP BY s.device_id"
    )?;

    let mut devices: Vec<DeviceInfo> = stmt.query_map([], |row| {
        let device_id:   String = row.get(0)?;
        let device_type: String = row.get(1)?;
        let model:       String = row.get(2)?;
        let custom_name: String = row.get(3)?;
        let display_name = if !custom_name.is_empty() {
            custom_name
        } else if device_type == "mac" {
            "Mac".to_string()
        } else if !model.is_empty() {
            model
        } else if device_type == "iphone" {
            "iPhone".to_string()
        } else {
            "iPad".to_string()
        };
        Ok(DeviceInfo { device_id, device_type, display_name })
    })?.filter_map(|r| r.ok()).collect();

    // Sort: mac first, then iphone, then ipad
    devices.sort_by_key(|d| match d.device_type.as_str() {
        "mac"    => 0u8,
        "iphone" => 1,
        _        => 2,
    });

    Ok(DevicesResult { devices })
}

pub fn get_collection_log(conn: &Connection, limit: i64) -> SqlResult<CollectionLogResult> {
    let mut stmt = conn.prepare(
        "SELECT ran_at, records_fetched, records_inserted, \
                COALESCE(mac_fetched,0), COALESCE(mac_inserted,0), \
                COALESCE(biome_fetched,0), COALESCE(biome_inserted,0), \
                error \
         FROM collection_log ORDER BY ran_at DESC LIMIT ?1"
    )?;
    let runs = stmt.query_map(params![limit], |row| {
        Ok(CollectionLogEntry {
            ran_at:         row.get(0)?,
            fetched:        row.get(1)?,
            inserted:       row.get(2)?,
            mac_fetched:    row.get(3)?,
            mac_inserted:   row.get(4)?,
            biome_fetched:  row.get(5)?,
            biome_inserted: row.get(6)?,
            error:          row.get(7)?,
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

pub fn update_device_name(conn: &Connection, device_id: &str, display_name: &str) -> SqlResult<()> {
    if display_name.trim().is_empty() {
        conn.execute("DELETE FROM device_names WHERE device_id = ?1", params![device_id])?;
    } else {
        conn.execute(
            "INSERT INTO device_names (device_id, display_name) VALUES (?1, ?2) \
             ON CONFLICT(device_id) DO UPDATE SET display_name = excluded.display_name",
            params![device_id, display_name.trim()],
        )?;
    }
    Ok(())
}

pub fn log_collection(
    conn: &Connection,
    ran_at: i64,
    mac_fetched: i64, mac_inserted: i64,
    biome_fetched: i64, biome_inserted: i64,
    error: Option<&str>,
) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO collection_log \
         (ran_at, records_fetched, records_inserted, \
          mac_fetched, mac_inserted, biome_fetched, biome_inserted, error) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            ran_at,
            mac_fetched + biome_fetched,
            mac_inserted + biome_inserted,
            mac_fetched, mac_inserted,
            biome_fetched, biome_inserted,
            error,
        ],
    )?;
    Ok(())
}

#[derive(Serialize, Clone, Default)]
pub struct AppDailyRow {
    pub date:      String,
    pub total:     i64,
    pub by_device: HashMap<String, i64>,
}

#[derive(Serialize)]
pub struct AppDailyResult {
    pub days: Vec<AppDailyRow>,
}

pub fn get_app_daily(conn: &Connection, app_id: &str, from: i64, to: i64) -> SqlResult<AppDailyResult> {
    let mut stmt = conn.prepare(
        "SELECT DATE(start_time, 'unixepoch', 'localtime') AS day, \
         device_id, \
         CAST(SUM(usage_seconds) AS INTEGER) AS total \
         FROM screentime \
         WHERE app = ?1 AND start_time >= ?2 AND start_time <= ?3 \
           AND usage_seconds > 0 \
         GROUP BY day, device_id ORDER BY day ASC"
    )?;

    let mut by_date: std::collections::BTreeMap<String, AppDailyRow> = std::collections::BTreeMap::new();
    let rows = stmt.query_map(params![app_id, from, to], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
    })?.filter_map(|r| r.ok());

    for (date, device_id, total) in rows {
        let entry = by_date.entry(date.clone()).or_insert_with(|| AppDailyRow {
            date,
            total: 0,
            by_device: HashMap::new(),
        });
        entry.total += total;
        entry.by_device.insert(device_id, total);
    }

    Ok(AppDailyResult { days: by_date.into_values().collect() })
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
