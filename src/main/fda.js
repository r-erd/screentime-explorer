'use strict';

/**
 * Full Disk Access detection.
 *
 * knowledgeC.db is protected by macOS TCC. Any attempt to open it without FDA
 * granted to this application raises SQLITE_CANTOPEN. We use this as the
 * detection signal — if we can open it read-only, FDA is granted.
 *
 * Least-privilege: we open the file read-only and close it immediately.
 * We never write to knowledgeC.db under any circumstance.
 */

const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const KNOWLEDGE_DB = path.join(
  os.homedir(),
  'Library/Application Support/Knowledge/knowledgeC.db'
);

/**
 * Returns { granted: true } or { granted: false, error: string }.
 * Safe to call repeatedly — opens and closes the DB immediately.
 */
function checkFDA() {
  let db;
  try {
    db = new Database(KNOWLEDGE_DB, { readonly: true, fileMustExist: true });
    return { granted: true };
  } catch (err) {
    return { granted: false, error: err.message };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

module.exports = { checkFDA, KNOWLEDGE_DB };
