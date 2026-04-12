'use strict';

/**
 * Collection logic — reads from knowledgeC.db (read-only), writes to screentime.db.
 *
 * Security:
 *  - knowledgeC.db opened with { readonly: true } — we never write to Apple's DB
 *  - Upsert uses INSERT OR IGNORE to avoid overwriting existing records
 *  - All SQL is parameterized
 */

const Database = require('better-sqlite3');
const { KNOWLEDGE_DB } = require('./fda');
const { getDb } = require('./db');

// Apple Core Data epoch starts 2001-01-01; Unix epoch starts 1970-01-01.
// Difference in seconds:
const APPLE_EPOCH_OFFSET = 978307200;

const QUERY = `
SELECT
  ZOBJECT.ZVALUESTRING                          AS app,
  (ZOBJECT.ZENDDATE - ZOBJECT.ZSTARTDATE)       AS usage_seconds,
  (ZOBJECT.ZSTARTDATE + ${APPLE_EPOCH_OFFSET})  AS start_time,
  (ZOBJECT.ZENDDATE   + ${APPLE_EPOCH_OFFSET})  AS end_time,
  ZOBJECT.ZSECONDSFROMGMT                       AS tz_offset,
  COALESCE(ZSOURCE.ZDEVICEID, '')               AS device_id,
  ZMODEL                                        AS device_model
FROM ZOBJECT
  LEFT JOIN ZSTRUCTUREDMETADATA
    ON ZOBJECT.ZSTRUCTUREDMETADATA = ZSTRUCTUREDMETADATA.Z_PK
  LEFT JOIN ZSOURCE
    ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
  LEFT JOIN ZSYNCPEER
    ON ZSOURCE.ZDEVICEID = ZSYNCPEER.ZDEVICEID
WHERE ZSTREAMNAME = '/app/usage'
  AND ZOBJECT.ZSTARTDATE > ?
ORDER BY ZSTARTDATE ASC
`;

/**
 * @param {(payload: object) => void} [onProgress] - Optional progress callback
 * @returns {{ ok: boolean, fetched: number, inserted: number, error: string|null }}
 */
function collect(onProgress) {
  const ran_at = Math.floor(Date.now() / 1000);
  let fetched = 0;
  let inserted = 0;
  let error = null;

  const dst = getDb();

  // Find the most recently collected record so we only fetch newer rows
  const lastTs = dst.prepare('SELECT MAX(start_time) FROM screentime').pluck().get() || 0;
  const appleLastTs = lastTs > 0 ? lastTs - APPLE_EPOCH_OFFSET : 0;

  // Read from Apple's database (read-only)
  let rows = [];
  let src;
  try {
    src = new Database(KNOWLEDGE_DB, { readonly: true, fileMustExist: true });
    rows = src.prepare(QUERY).all(appleLastTs);
  } catch (err) {
    error = err.message;
  } finally {
    try { src?.close(); } catch { /* ignore */ }
  }

  fetched = rows.length;

  // Insert new records as a single transaction for atomicity and performance
  if (rows.length > 0) {
    const insert = dst.prepare(`
      INSERT OR IGNORE INTO screentime
        (app, usage_seconds, start_time, end_time, tz_offset, device_id, device_model)
      VALUES
        (@app, @usage_seconds, @start_time, @end_time, @tz_offset, @device_id, @device_model)
    `);
    const insertAll = dst.transaction((rows) => {
      let count = 0;
      for (const row of rows) count += insert.run(row).changes;
      return count;
    });
    inserted = insertAll(rows);
  }

  // Always log the run, even if an error occurred
  dst.prepare(`
    INSERT INTO collection_log (ran_at, records_fetched, records_inserted, error)
    VALUES (?, ?, ?, ?)
  `).run(ran_at, fetched, inserted, error);

  const result = { ok: !error, fetched, inserted, error };
  onProgress?.(result);
  return result;
}

module.exports = { collect };
