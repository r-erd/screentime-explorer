import sqlite3
import time
from os.path import expanduser
from pathlib import Path

KNOWLEDGE_DB = expanduser("~/Library/Application Support/Knowledge/knowledgeC.db")
SCREENTIME_DB = Path(__file__).parent / "screentime.db"

QUERY = """
SELECT
    ZOBJECT.ZVALUESTRING AS app,
    (ZOBJECT.ZENDDATE - ZOBJECT.ZSTARTDATE) AS usage_seconds,
    (ZOBJECT.ZSTARTDATE + 978307200) AS start_time,
    (ZOBJECT.ZENDDATE + 978307200) AS end_time,
    ZOBJECT.ZSECONDSFROMGMT AS tz_offset,
    COALESCE(ZSOURCE.ZDEVICEID, '') AS device_id,
    ZMODEL AS device_model
FROM
    ZOBJECT
    LEFT JOIN ZSTRUCTUREDMETADATA ON ZOBJECT.ZSTRUCTUREDMETADATA = ZSTRUCTUREDMETADATA.Z_PK
    LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
    LEFT JOIN ZSYNCPEER ON ZSOURCE.ZDEVICEID = ZSYNCPEER.ZDEVICEID
WHERE
    ZSTREAMNAME = "/app/usage"
    AND ZOBJECT.ZSTARTDATE > ?
ORDER BY ZSTARTDATE ASC
"""


def init_db(con):
    con.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS screentime (
            app         TEXT    NOT NULL,
            usage_seconds REAL,
            start_time  INTEGER NOT NULL,
            end_time    INTEGER,
            tz_offset   INTEGER,
            device_id   TEXT    NOT NULL DEFAULT '',
            device_model TEXT,
            PRIMARY KEY (app, start_time, device_id)
        );
        CREATE INDEX IF NOT EXISTS idx_start_time ON screentime(start_time);
        CREATE TABLE IF NOT EXISTS collection_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ran_at          INTEGER NOT NULL,
            records_fetched INTEGER NOT NULL,
            records_inserted INTEGER NOT NULL,
            error           TEXT
        );
    """)


def collect():
    with sqlite3.connect(SCREENTIME_DB) as dst:
        init_db(dst)
        last_ts = dst.execute("SELECT MAX(start_time) FROM screentime").fetchone()[0] or 0

    # Convert unix timestamp back to Apple Core Data epoch for the WHERE clause
    apple_last_ts = last_ts - 978307200 if last_ts else 0

    error = None
    rows = []
    try:
        with sqlite3.connect(KNOWLEDGE_DB) as src:
            rows = src.execute(QUERY, (apple_last_ts,)).fetchall()
    except sqlite3.OperationalError as e:
        error = str(e)
        print(f"Error reading knowledgeC.db: {e}")
        print("Ensure Full Disk Access is granted to Terminal (or cron) in System Settings.")

    inserted = 0
    with sqlite3.connect(SCREENTIME_DB) as dst:
        if rows:
            before = dst.total_changes
            dst.executemany("""
                INSERT OR IGNORE INTO screentime
                    (app, usage_seconds, start_time, end_time, tz_offset, device_id, device_model)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, rows)
            inserted = dst.total_changes - before
        dst.execute(
            "INSERT INTO collection_log (ran_at, records_fetched, records_inserted, error) VALUES (?,?,?,?)",
            (int(time.time()), len(rows), inserted, error),
        )

    print(f"Fetched {len(rows)} records since last run, inserted {inserted} new.")


if __name__ == "__main__":
    collect()
