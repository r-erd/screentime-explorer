use rusqlite::{Connection, OpenFlags, params};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use crate::db::{APPLE_EPOCH_OFFSET, log_collection};
use crate::biome;

#[derive(Serialize, Clone, Debug)]
pub struct CollectResult {
    pub ok: bool,
    pub fetched: i64,
    pub inserted: i64,
    pub error: Option<String>,
}

// ── FDA check ─────────────────────────────────────────────────────────────────

pub fn knowledge_db_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(crate::db::KNOWLEDGE_DB)
}

#[derive(Serialize)]
pub struct FdaResult {
    pub granted: bool,
    pub error: Option<String>,
}

pub fn check_fda() -> FdaResult {
    let path = knowledge_db_path();
    match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) {
        Ok(conn) => {
            drop(conn);
            FdaResult { granted: true, error: None }
        }
        Err(e) => FdaResult { granted: false, error: Some(e.to_string()) },
    }
}

// ── Collection query ──────────────────────────────────────────────────────────

const QUERY: &str = "\
SELECT
  ZOBJECT.ZVALUESTRING                                    AS app,
  (ZOBJECT.ZENDDATE - ZOBJECT.ZSTARTDATE)                AS usage_seconds,
  (ZOBJECT.ZSTARTDATE + 978307200)                       AS start_time,
  (ZOBJECT.ZENDDATE   + 978307200)                       AS end_time,
  ZOBJECT.ZSECONDSFROMGMT                                AS tz_offset,
  COALESCE(ZSOURCE.ZDEVICEID, '')                        AS device_id,
  ZMODEL                                                 AS device_model
FROM ZOBJECT
  LEFT JOIN ZSTRUCTUREDMETADATA
    ON ZOBJECT.ZSTRUCTUREDMETADATA = ZSTRUCTUREDMETADATA.Z_PK
  LEFT JOIN ZSOURCE
    ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
  LEFT JOIN ZSYNCPEER
    ON ZSOURCE.ZDEVICEID = ZSYNCPEER.ZDEVICEID
WHERE ZSTREAMNAME = '/app/usage'
  AND ZOBJECT.ZSTARTDATE > ?1
ORDER BY ZSTARTDATE ASC
";

struct Row {
    app: String,
    usage_seconds: f64,
    start_time: i64,
    end_time: i64,
    tz_offset: i64,
    device_id: String,
    device_model: Option<String>,
}

/// Read rows from knowledgeC.db. Returns `Err(message)` when the DB can't
/// be opened or queried; row-level decode errors are propagated via `?`.
fn read_knowledge_rows(kdb_path: &std::path::Path, apple_last_ts: i64) -> Result<Vec<Row>, String> {
    let src = Connection::open_with_flags(kdb_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|e| e.to_string())?;
    let mut stmt = src.prepare(QUERY).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![apple_last_ts], |row| {
        Ok(Row {
            app:          row.get(0)?,
            usage_seconds: row.get(1)?,
            start_time:   row.get(2)?,
            end_time:     row.get(3)?,
            tz_offset:    row.get(4)?,
            device_id:    row.get(5)?,
            device_model: row.get(6)?,
        })
    })
    .map_err(|e| e.to_string())?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(|e| e.to_string());
    rows
}

pub fn collect(dst_conn: Arc<Mutex<Connection>>, on_progress: impl Fn(CollectResult)) -> CollectResult {
    let ran_at = unix_now();
    let mut error: Option<String> = None;

    // Find last collected timestamp
    let last_ts: i64 = {
        let conn = dst_conn.lock().unwrap();
        conn.query_row(
            "SELECT COALESCE(MAX(start_time), 0) FROM screentime",
            [],
            |row| row.get(0),
        ).unwrap_or(0)
    };
    let apple_last_ts = if last_ts > 0 { last_ts - APPLE_EPOCH_OFFSET } else { 0 };

    // Read from knowledgeC.db (read-only)
    let kdb_path = knowledge_db_path();
    let rows = match read_knowledge_rows(&kdb_path, apple_last_ts) {
        Ok(r)  => r,
        Err(e) => { error = Some(e); Vec::new() }
    };

    let fetched = rows.len() as i64;

    // ── Biome collection (iPhone/iPad via iCloud sync) ────────────────────────
    let (biome_rows, biome_error) = biome::collect_biome();
    let biome_fetched = biome_rows.len() as i64;

    // Combine errors
    if let Some(be) = biome_error {
        error = Some(match error {
            Some(e) => format!("{}; Biome: {}", e, be),
            None    => format!("Biome: {}", be),
        });
    }

    // Insert knowledgeC rows
    let mut inserted = 0i64;
    {
        let conn = dst_conn.lock().unwrap();
        if let Ok(tx) = conn.unchecked_transaction() {
            for r in &rows {
                let result = conn.execute(
                    "INSERT OR IGNORE INTO screentime \
                     (app, usage_seconds, start_time, end_time, tz_offset, device_id, device_model) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![r.app, r.usage_seconds, r.start_time, r.end_time, r.tz_offset, r.device_id, r.device_model],
                );
                if let Ok(n) = result { inserted += n as i64; }
            }
            let _ = tx.commit();
        };
    }

    // Insert Biome rows (device_model = 'iPhone' so device_type_expr classifies them correctly)
    let mut biome_inserted = 0i64;
    if !biome_rows.is_empty() {
        let conn = dst_conn.lock().unwrap();
        if let Ok(tx) = conn.unchecked_transaction() {
            for r in &biome_rows {
                let result = conn.execute(
                    "INSERT OR IGNORE INTO screentime \
                     (app, usage_seconds, start_time, end_time, tz_offset, device_id, device_model) \
                     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
                    params![r.app, r.usage_seconds, r.start_time, r.end_time, r.device_id, r.device_model],
                );
                if let Ok(n) = result { biome_inserted += n as i64; }
            }
            let _ = tx.commit();
        };
    }

    inserted += biome_inserted;

    // Log the run
    {
        let conn = dst_conn.lock().unwrap();
        let _ = log_collection(
            &conn, ran_at,
            fetched, inserted - biome_inserted,
            biome_fetched, biome_inserted,
            error.as_deref(),
        );
    }

    let result = CollectResult { ok: error.is_none(), fetched, inserted, error };
    on_progress(result.clone());
    result
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
