import json
import sqlite3
import subprocess
import sys
from collections import defaultdict
from datetime import date, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

PORT = 8765
DB = Path(__file__).parent / "screentime.db"
STATIC = Path(__file__).parent

DEVICE_TYPE = """
    CASE
        WHEN device_model IS NULL OR device_model = '' THEN 'mac'
        WHEN LOWER(device_model) LIKE 'iphone%' THEN 'iphone'
        WHEN LOWER(device_model) LIKE 'ipad%' THEN 'ipad'
        ELSE 'mac'
    END
"""


def parse_range(params):
    from_ts = int(params.get("from", [0])[0])
    to_ts = int(params.get("to", [9_999_999_999])[0])
    return from_ts, to_ts


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        routes = {
            "/api/screentime":     self._api_screentime,
            "/api/daily":          self._api_daily,
            "/api/hourly":         self._api_hourly,
            "/api/devices":        self._api_devices,
            "/api/collection-log": self._api_collection_log,
        }

        if parsed.path in routes:
            try:
                routes[parsed.path](qs)
            except Exception as e:
                self._json({"error": str(e)}, 500)
        elif parsed.path in ("/", "/index.html"):
            self._serve_file("index.html", "text/html; charset=utf-8")
        else:
            self._respond(404, b"Not Found", "text/plain")

    # ── API handlers ──────────────────────────────────────────────────────────

    def _api_screentime(self, params):
        from_ts, to_ts = parse_range(params)
        if not DB.exists():
            self._json({"apps": []})
            return

        with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
            rows = con.execute(f"""
                SELECT app, {DEVICE_TYPE} AS dtype, SUM(usage_seconds) AS total
                FROM screentime
                WHERE start_time >= ? AND start_time <= ?
                  AND app IS NOT NULL AND usage_seconds > 0
                GROUP BY app, dtype
            """, (from_ts, to_ts)).fetchall()

        apps = defaultdict(lambda: {"mac": 0, "iphone": 0, "ipad": 0})
        for app, dtype, total in rows:
            apps[app][dtype] += round(total)

        result = sorted(
            [{"app": a, **d} for a, d in apps.items()],
            key=lambda x: x["mac"] + x["iphone"] + x["ipad"],
            reverse=True,
        )[:40]
        self._json({"apps": result})

    def _api_daily(self, params):
        from_ts, to_ts = parse_range(params)
        if not DB.exists():
            self._json({"days": []})
            return

        with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
            rows = con.execute(f"""
                SELECT DATE(start_time, 'unixepoch', 'localtime') AS day,
                       {DEVICE_TYPE} AS dtype,
                       SUM(usage_seconds) AS total
                FROM screentime
                WHERE start_time >= ? AND start_time <= ?
                  AND app IS NOT NULL AND usage_seconds > 0
                GROUP BY day, dtype
                ORDER BY day ASC
            """, (from_ts, to_ts)).fetchall()

        # Build a complete date range (fill missing days with 0)
        all_days = {}
        d = date.fromtimestamp(from_ts)
        end = date.fromtimestamp(min(to_ts, date.today().toordinal() * 86400))
        while d <= date.today() and d <= date.fromtimestamp(to_ts):
            all_days[d.isoformat()] = {"mac": 0, "iphone": 0, "ipad": 0}
            d += timedelta(days=1)

        for day, dtype, total in rows:
            if day in all_days:
                all_days[day][dtype] = round(total)

        self._json({"days": [{"date": k, **v} for k, v in sorted(all_days.items())]})

    def _api_hourly(self, params):
        from_ts, to_ts = parse_range(params)
        if not DB.exists():
            self._json({"hours": [], "num_days": 1})
            return

        num_days = max(1, round((to_ts - from_ts) / 86400))

        with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
            rows = con.execute(f"""
                SELECT CAST(strftime('%H', start_time, 'unixepoch', 'localtime') AS INTEGER) AS hour,
                       {DEVICE_TYPE} AS dtype,
                       SUM(usage_seconds) AS total
                FROM screentime
                WHERE start_time >= ? AND start_time <= ?
                  AND app IS NOT NULL AND usage_seconds > 0
                GROUP BY hour, dtype
                ORDER BY hour ASC
            """, (from_ts, to_ts)).fetchall()

        all_hours = {h: {"mac": 0, "iphone": 0, "ipad": 0} for h in range(24)}
        for hour, dtype, total in rows:
            all_hours[hour][dtype] = round(total)

        self._json({
            "hours": [{"hour": h, **v} for h, v in sorted(all_hours.items())],
            "num_days": num_days,
        })

    def _api_devices(self, _params):
        if not DB.exists():
            self._json({"types": ["mac"]})
            return

        with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
            rows = con.execute(f"""
                SELECT DISTINCT {DEVICE_TYPE} AS dtype
                FROM screentime
                WHERE usage_seconds > 0
            """).fetchall()

        self._json({"types": sorted({r[0] for r in rows})})

    def _api_collection_log(self, params):
        if not DB.exists():
            self._json({"runs": []})
            return

        limit = int(params.get("limit", [50])[0])
        with sqlite3.connect(f"file:{DB}?mode=ro", uri=True) as con:
            rows = con.execute("""
                SELECT ran_at, records_fetched, records_inserted, error
                FROM collection_log
                ORDER BY ran_at DESC
                LIMIT ?
            """, (limit,)).fetchall()

        self._json({"runs": [
            {"ran_at": r[0], "fetched": r[1], "inserted": r[2], "error": r[3]}
            for r in rows
        ]})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/collect":
            try:
                script = Path(__file__).parent / "collect.py"
                result = subprocess.run(
                    [sys.executable, str(script)],
                    capture_output=True, text=True, timeout=60,
                )
                output = (result.stdout + result.stderr).strip()
                ok = result.returncode == 0
                self._json({"ok": ok, "output": output})
            except subprocess.TimeoutExpired:
                self._json({"ok": False, "output": "Timed out after 60s."}, 500)
            except Exception as e:
                self._json({"ok": False, "output": str(e)}, 500)
        else:
            self._respond(404, b"Not Found", "text/plain")

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _serve_file(self, filename, content_type):
        path = STATIC / filename
        if not path.exists():
            self._respond(404, b"Not Found", "text/plain")
            return
        self._respond(200, path.read_bytes(), content_type)

    def _json(self, data, status=200):
        self._respond(status, json.dumps(data).encode(), "application/json")

    def _respond(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"Dashboard → http://localhost:{PORT}")
    print("Ctrl+C to stop.")
    HTTPServer(("", PORT), Handler).serve_forever()
