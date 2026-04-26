/// push.rs — Push daily aggregates to a remote PostgreSQL database so
/// Grafana can visualise them via its built-in PostgreSQL data source.
///
/// Table created on first push:
///
///   CREATE TABLE screenlog_daily (
///       day         DATE    PRIMARY KEY part,
///       app         TEXT    NOT NULL,
///       device_id   TEXT    NOT NULL DEFAULT '',
///       device_type TEXT    NOT NULL DEFAULT 'mac',   -- mac | iphone | ipad
///       device_name TEXT    NOT NULL DEFAULT 'Mac',
///       usage_secs  BIGINT  NOT NULL DEFAULT 0,
///       PRIMARY KEY (day, app, device_id)
///   );

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use time::{Date, format_description};
use tokio_postgres::NoTls;

// ── Config ────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct PushConfig {
    pub host:     String,
    pub port:     u16,
    pub database: String,
    pub user:     String,
    pub password: String,
}

// ── Results ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct PushResult {
    pub ok:    bool,
    pub rows:  i64,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct TestResult {
    pub ok:    bool,
    pub error: Option<String>,
}

// ── Internal row type ─────────────────────────────────────────────────────────

struct DailyRow {
    date:        String,   // "YYYY-MM-DD"
    app:         String,
    device_id:   String,
    device_type: String,
    device_name: String,
    usage_secs:  i64,
}

// ── Postgres helpers ──────────────────────────────────────────────────────────

async fn make_client(cfg: &PushConfig) -> Result<tokio_postgres::Client, String> {
    if cfg.host.is_empty() || cfg.database.is_empty() || cfg.user.is_empty() {
        return Err("Incomplete connection settings".into());
    }
    let port = if cfg.port == 0 { 5432 } else { cfg.port };
    let conn_str = format!(
        "host={} port={} dbname={} user={} password={} connect_timeout=10",
        cfg.host, port, cfg.database, cfg.user, cfg.password
    );
    let (client, connection) = tokio_postgres::connect(&conn_str, NoTls)
        .await
        .map_err(|e| e.to_string())?;
    // Drive the connection in the background; errors are silently dropped
    // once we finish our work — that's fine for short-lived push sessions.
    tokio::spawn(async move { let _ = connection.await; });
    Ok(client)
}

async fn ensure_schema(client: &tokio_postgres::Client) -> Result<(), String> {
    client.batch_execute("
        CREATE TABLE IF NOT EXISTS screenlog_daily (
            day         DATE   NOT NULL,
            app         TEXT   NOT NULL,
            device_id   TEXT   NOT NULL DEFAULT '',
            device_type TEXT   NOT NULL DEFAULT 'mac',
            device_name TEXT   NOT NULL DEFAULT 'Mac',
            usage_secs  BIGINT NOT NULL DEFAULT 0,
            PRIMARY KEY (day, app, device_id)
        );
        CREATE INDEX IF NOT EXISTS screenlog_daily_day_idx ON screenlog_daily(day);
    ").await.map_err(|e| e.to_string())
}

// ── SQLite fetch ──────────────────────────────────────────────────────────────

fn fetch_local_rows(conn: &Connection) -> rusqlite::Result<Vec<DailyRow>> {
    let mut stmt = conn.prepare(
        "SELECT \
            DATE(s.start_time, 'unixepoch', 'localtime')   AS day, \
            s.app, \
            s.device_id, \
            CASE \
                WHEN COALESCE(MAX(s.device_model),'') = ''            THEN 'mac' \
                WHEN LOWER(MAX(s.device_model)) LIKE 'iphone%'        THEN 'iphone' \
                WHEN LOWER(MAX(s.device_model)) LIKE 'ipad%'          THEN 'ipad' \
                ELSE 'mac' \
            END                                                        AS device_type, \
            COALESCE(MAX(dn.display_name), \
                CASE \
                    WHEN COALESCE(MAX(s.device_model),'') = ''        THEN 'Mac' \
                    WHEN LOWER(MAX(s.device_model)) LIKE 'iphone%'    THEN COALESCE(MAX(s.device_model),'iPhone') \
                    WHEN LOWER(MAX(s.device_model)) LIKE 'ipad%'      THEN COALESCE(MAX(s.device_model),'iPad') \
                    ELSE 'Mac' \
                END \
            )                                                          AS device_name, \
            CAST(SUM(s.usage_seconds) AS INTEGER)                     AS usage_secs \
         FROM screentime s \
         LEFT JOIN device_names dn ON s.device_id = dn.device_id \
         WHERE s.app IS NOT NULL AND s.usage_seconds > 0 \
         GROUP BY day, s.app, s.device_id \
         ORDER BY day, s.app"
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DailyRow {
                date:        row.get(0)?,
                app:         row.get(1)?,
                device_id:   row.get(2)?,
                device_type: row.get(3)?,
                device_name: row.get(4)?,
                usage_secs:  row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn parse_date(s: &str) -> Option<Date> {
    let fmt = format_description::parse("[year]-[month]-[day]").ok()?;
    Date::parse(s, &fmt).ok()
}

// ── Public API ────────────────────────────────────────────────────────────────

pub async fn test_connection(cfg: &PushConfig) -> TestResult {
    match make_client(cfg).await {
        Err(e) => TestResult { ok: false, error: Some(e) },
        Ok(client) => match client.execute("SELECT 1", &[]).await {
            Err(e) => TestResult { ok: false, error: Some(e.to_string()) },
            Ok(_)  => TestResult { ok: true, error: None },
        },
    }
}

pub async fn push_all(cfg: &PushConfig, sqlite: Arc<Mutex<Connection>>) -> PushResult {
    // Connect
    let mut client = match make_client(cfg).await {
        Ok(c)  => c,
        Err(e) => return PushResult { ok: false, rows: 0, error: Some(e) },
    };

    // Ensure table exists
    if let Err(e) = ensure_schema(&client).await {
        return PushResult { ok: false, rows: 0, error: Some(e) };
    }

    // Read from local SQLite (holding the lock as briefly as possible)
    let rows = {
        let conn = sqlite.lock().unwrap();
        match fetch_local_rows(&conn) {
            Ok(r)  => r,
            Err(e) => return PushResult { ok: false, rows: 0, error: Some(e.to_string()) },
        }
    };

    let total = rows.len() as i64;

    // Upsert in a transaction for speed
    let tx = match client.build_transaction().start().await {
        Ok(t)  => t,
        Err(e) => return PushResult { ok: false, rows: 0, error: Some(e.to_string()) },
    };

    let stmt = match tx.prepare(
        "INSERT INTO screenlog_daily (day, app, device_id, device_type, device_name, usage_secs) \
         VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (day, app, device_id) DO UPDATE SET \
             usage_secs  = EXCLUDED.usage_secs, \
             device_name = EXCLUDED.device_name, \
             device_type = EXCLUDED.device_type"
    ).await {
        Ok(s)  => s,
        Err(e) => return PushResult { ok: false, rows: 0, error: Some(e.to_string()) },
    };

    for row in &rows {
        let date = match parse_date(&row.date) {
            Some(d) => d,
            None    => continue,
        };
        if let Err(e) = tx.execute(
            &stmt,
            &[&date, &row.app, &row.device_id, &row.device_type, &row.device_name, &row.usage_secs],
        ).await {
            return PushResult { ok: false, rows: 0, error: Some(e.to_string()) };
        }
    }

    if let Err(e) = tx.commit().await {
        return PushResult { ok: false, rows: 0, error: Some(e.to_string()) };
    }

    PushResult { ok: true, rows: total, error: None }
}
