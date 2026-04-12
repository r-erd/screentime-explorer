import sqlite3
from os.path import expanduser
from datetime import datetime, timezone

knowledge_db = expanduser("~/Library/Application Support/Knowledge/knowledgeC.db")

query = """
SELECT
    ZOBJECT.ZVALUESTRING AS app,
    (ZOBJECT.ZENDDATE - ZOBJECT.ZSTARTDATE) AS usage_seconds,
    (ZOBJECT.ZSTARTDATE + 978307200) as start_time,
    (ZOBJECT.ZENDDATE + 978307200) as end_time,
    ZOBJECT.ZSECONDSFROMGMT AS tz_offset,
    ZSOURCE.ZDEVICEID AS device_id,
    ZMODEL AS device_model
FROM
    ZOBJECT
    LEFT JOIN ZSTRUCTUREDMETADATA ON ZOBJECT.ZSTRUCTUREDMETADATA = ZSTRUCTUREDMETADATA.Z_PK
    LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
    LEFT JOIN ZSYNCPEER ON ZSOURCE.ZDEVICEID = ZSYNCPEER.ZDEVICEID
WHERE
    ZSTREAMNAME = "/app/usage"
ORDER BY
    ZSTARTDATE DESC
LIMIT 20
"""

try:
    with sqlite3.connect(knowledge_db) as con:
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        cur.execute(query)
        rows = cur.fetchall()

    if not rows:
        print("No rows returned. Screen Time data may not be synced yet.")
    else:
        print(f"Found {len(rows)} recent entries (showing up to 20):\n")
        print(f"{'App':<40} {'Duration':>10}  {'Start Time':<20}  {'Device'}")
        print("-" * 100)
        for row in rows:
            app = row["app"] or "(unknown)"
            secs = int(row["usage_seconds"] or 0)
            duration = f"{secs // 60}m {secs % 60}s"
            start = datetime.fromtimestamp(row["start_time"], timezone.utc).strftime("%Y-%m-%d %H:%M:%S") if row["start_time"] else ""
            device = row["device_model"] or row["device_id"] or ""
            print(f"{app:<40} {duration:>10}  {start:<20}  {device}")

except sqlite3.OperationalError as e:
    print(f"Database error: {e}")
    print("\nMake sure:")
    print("  1. You've granted Terminal/IDE full disk access in System Settings > Privacy & Security")
    print("  2. Screen Time 'Share across devices' is enabled on your iPhone (Settings > Screen Time)")
