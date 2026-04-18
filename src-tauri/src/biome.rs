//! Biome App.InFocus parser — iPhone/iPad screen time via iCloud sync.
//!
//! Data sources (require Full Disk Access, same as knowledgeC.db):
//!   ~/Library/Biome/sync/sync.db
//!       → DevicePeer table: UUID of each synced iOS/iPadOS device (platform = 2)
//!   ~/Library/Biome/streams/restricted/App.InFocus/remote/<UUID>/
//!       → SEGB binary files containing protobuf-encoded App.InFocus events
//!
//! This module is intentionally defensive. Any parse failure is silently
//! skipped so the rest of the app continues to work with Mac-only data.

use rusqlite::{Connection, OpenFlags};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;

const APPLE_EPOCH_OFFSET: i64 = 978_307_200; // seconds between 2001-01-01 and 1970-01-01

/// A stitched app-usage interval derived from Biome App.InFocus events.
pub struct BiomeRow {
    pub app: String,
    pub usage_seconds: f64,
    pub start_time: i64,    // Unix timestamp
    pub end_time: i64,      // Unix timestamp
    pub device_id: String,
    pub device_model: String, // e.g. "iPhone14,5" or "iPad13,18"
}

/// Raw focus-change event decoded from an SEGB record.
struct FocusEvent {
    bundle_id: String,
    in_foreground: bool,
    unix_ts: i64,
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Collect Biome data for all paired iOS/iPadOS devices.
///
/// Returns `(rows, error_string)`.  `error_string` is `Some` only when
/// something unexpected happened; an absence of synced devices is not an error.
pub fn collect_biome() -> (Vec<BiomeRow>, Option<String>) {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return (vec![], None),
    };

    let devices = match get_ios_device_ids(&home) {
        Ok(ids) => ids,
        Err(e)  => return (vec![], Some(format!("Biome sync.db: {}", e))),
    };

    if devices.is_empty() {
        return (vec![], None);
    }

    let mut all_rows: Vec<BiomeRow> = Vec::new();
    let mut errors: Vec<String>     = Vec::new();

    for (device_id, device_model) in &devices {
        let dir = PathBuf::from(&home)
            .join("Library/Biome/streams/restricted/App.InFocus/remote")
            .join(device_id);

        match collect_device(&dir, device_id, device_model) {
            Ok(rows) => all_rows.extend(rows),
            Err(e)   => errors.push(format!(
                "device {}: {}",
                &device_id[..device_id.len().min(8)],
                e
            )),
        }
    }

    let error = if errors.is_empty() { None } else { Some(errors.join("; ")) };
    (all_rows, error)
}

// ── Device discovery ──────────────────────────────────────────────────────────

/// Returns `(device_id, device_model)` pairs for all paired iOS/iPadOS devices.
/// `device_model` is e.g. "iPhone14,5" or "iPad13,18" — the existing
/// `device_type_expr` SQL already handles those prefixes correctly.
/// Falls back to "iPhone" if `hardware_id` is not available.
fn get_ios_device_ids(home: &str) -> Result<Vec<(String, String)>, String> {
    let path = PathBuf::from(home).join("Library/Biome/sync/sync.db");
    if !path.exists() {
        return Ok(vec![]);  // Biome not present — old macOS or no iCloud sync
    }

    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;

    // Check whether a hardware_id column exists (not guaranteed on all macOS versions).
    let has_hardware_id: bool = conn
        .prepare("PRAGMA table_info(DevicePeer)")
        .ok()
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, String>(1)).ok()
                .map(|iter| iter.filter_map(|r| r.ok()).any(|col| col == "hardware_id"))
        })
        .unwrap_or(false);

    let devices: Vec<(String, String)> = if has_hardware_id {
        let mut stmt = conn
            .prepare("SELECT DISTINCT device_identifier, COALESCE(hardware_id, '') FROM DevicePeer WHERE platform = 2")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
        rows.into_iter()
        .filter(|(id, _)| !id.is_empty())
        .map(|(id, hw)| {
            // Normalise: "iPad13,18" → kept as-is (matches LIKE 'ipad%')
            //            "iPhone14,5" → kept as-is (matches LIKE 'iphone%')
            //            anything else → fall back to "iPhone"
            let model = if !hw.is_empty() { hw } else { "iPhone".to_string() };
            (id, model)
        })
        .collect()
    } else {
        // No hardware_id column — default all to iPhone
        let mut stmt = conn
            .prepare("SELECT DISTINCT device_identifier FROM DevicePeer WHERE platform = 2")
            .map_err(|e| e.to_string())?;
        let ids: Vec<String> = stmt.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        ids.into_iter()
            .filter(|s| !s.is_empty())
            .map(|id| (id, "iPhone".to_string()))
            .collect()
    };

    Ok(devices)
}

// ── Per-device collection ─────────────────────────────────────────────────────

fn collect_device(dir: &PathBuf, device_id: &str, device_model: &str) -> Result<Vec<BiomeRow>, String> {
    if !dir.exists() {
        return Ok(vec![]);  // Device dir not yet synced
    }

    // Collect SEGB files sorted by mtime, oldest first.
    let mut files: Vec<(std::time::SystemTime, PathBuf)> =
        std::fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let name = entry.file_name();
                if name.to_string_lossy().starts_with('.') { return None; }  // skip hidden
                let meta = entry.metadata().ok()?;
                if !meta.is_file() { return None; }
                Some((meta.modified().unwrap_or(std::time::UNIX_EPOCH), entry.path()))
            })
            .collect();

    files.sort_by_key(|(mtime, _)| *mtime);

    // Parse events from every file, skipping any that fail.
    let mut all_events: Vec<FocusEvent> = Vec::new();
    for (_, path) in &files {
        if let Ok(events) = parse_segb_file(path) {
            all_events.extend(events);
        }
        // Silently skip unparseable files — Apple may change the format.
    }

    if all_events.is_empty() {
        return Ok(vec![]);
    }

    // Sort by timestamp (files are ordered but events within a file may not cross-sort).
    all_events.sort_by_key(|e| e.unix_ts);

    Ok(stitch_events(all_events, device_id, device_model))
}

// ── SEGB version dispatch ─────────────────────────────────────────────────────

fn parse_segb_file(path: &PathBuf) -> Result<Vec<FocusEvent>, String> {
    let file  = File::open(path).map_err(|e| e.to_string())?;
    let mut r = BufReader::new(file);

    let mut magic_buf = [0u8; 56];
    let n = r.read(&mut magic_buf).map_err(|e| e.to_string())?;
    r.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;

    if n >= 4 && &magic_buf[0..4] == b"SEGB" {
        parse_segb_v2(&mut r)
    } else if n >= 56 && &magic_buf[52..56] == b"SEGB" {
        parse_segb_v1(&mut r)
    } else {
        Ok(vec![])  // Unknown format
    }
}

// ── SEGB v1 parser ────────────────────────────────────────────────────────────
//
// Header (56 bytes):
//   [0..4]   u32 LE  end_of_data_offset (absolute)
//   [4..52]  padding
//   [52..56] magic "SEGB"
//
// Records from byte 56, until position >= end_of_data_offset:
//   [0..4]   i32 LE  record_length
//   [4..8]   i32 LE  entry_state  (1=Written, 3=Deleted, 4=Empty)
//   [8..24]  f64×2   timestamps (metadata)
//   [24..28] u32 LE  crc32
//   [28..32] i32 LE  unknown
//   [32..]   <record_length> bytes of protobuf
//   then pad to 8-byte alignment

fn parse_segb_v1<R: Read + Seek>(r: &mut R) -> Result<Vec<FocusEvent>, String> {
    let mut hdr = [0u8; 56];
    r.read_exact(&mut hdr).map_err(|e| e.to_string())?;
    let end_of_data = u32::from_le_bytes(hdr[0..4].try_into().unwrap()) as u64;

    let mut events = Vec::new();

    loop {
        let pos = r.stream_position().map_err(|e| e.to_string())?;
        if pos >= end_of_data { break; }

        let mut rec_hdr = [0u8; 32];
        if r.read_exact(&mut rec_hdr).is_err() { break; }

        let record_length = i32::from_le_bytes(rec_hdr[0..4].try_into().unwrap());
        let entry_state   = i32::from_le_bytes(rec_hdr[4..8].try_into().unwrap());
        let crc32_stored  = u32::from_le_bytes(rec_hdr[24..28].try_into().unwrap());

        if record_length <= 0 || record_length > 1_000_000 { break; }

        let mut payload = vec![0u8; record_length as usize];
        if r.read_exact(&mut payload).is_err() { break; }

        // Advance to next 8-byte boundary
        let consumed = 32u64 + record_length as u64;
        let aligned  = (consumed + 7) / 8 * 8;
        if aligned > consumed {
            r.seek(SeekFrom::Current((aligned - consumed) as i64)).ok();
        }

        if entry_state == 3 || entry_state == 4 { continue; }
        if payload.iter().all(|&b| b == 0)      { continue; }
        if crc32_stored != 0 && crc32fast::hash(&payload) != crc32_stored { continue; }

        if let Some(ev) = decode_proto(&payload) {
            events.push(ev);
        }
    }

    Ok(events)
}

// ── SEGB v2 parser ────────────────────────────────────────────────────────────
//
// Header (32 bytes):
//   [0..4]   magic "SEGB"
//   [4..8]   i32 LE  entries_count
//   [8..16]  f64     file_creation_time (metadata)
//   [16..32] padding
//
// Data section: variable-length entries between byte 32 and the trailer.
//
// Trailer (entries_count × 16 bytes, at end of file):
//   [0..4]   i32 LE  end_offset  (cumulative bytes from byte 32)
//   [4..8]   i32 LE  entry_state (1=Written, 3=Deleted, 4=Empty)
//   [8..16]  f64     creation_time (metadata)
//
// Each entry = 8-byte entry-header (crc32 u32 LE + unknown i32 LE)
//            + protobuf payload
// After each entry, pad to 4-byte boundary (based on end_offset % 4).

fn parse_segb_v2<R: Read + Seek>(r: &mut R) -> Result<Vec<FocusEvent>, String> {
    const HDR: u64 = 32;

    let mut hdr = [0u8; 32];
    r.read_exact(&mut hdr).map_err(|e| e.to_string())?;
    let entries_count = i32::from_le_bytes(hdr[4..8].try_into().unwrap());

    if entries_count <= 0 || entries_count > 100_000 {
        return Ok(vec![]);
    }

    // Read trailer from end of file.
    let trailer_bytes = entries_count as i64 * 16;
    r.seek(SeekFrom::End(-trailer_bytes)).map_err(|e| e.to_string())?;

    let mut trailer: Vec<(i32, i32)> = Vec::with_capacity(entries_count as usize);
    for _ in 0..entries_count {
        let mut te = [0u8; 16];
        r.read_exact(&mut te).map_err(|e| e.to_string())?;
        let end_offset  = i32::from_le_bytes(te[0..4].try_into().unwrap());
        let entry_state = i32::from_le_bytes(te[4..8].try_into().unwrap());
        trailer.push((end_offset, entry_state));
    }

    // Process entries in ascending end_offset order.
    trailer.sort_by_key(|(off, _)| *off);

    r.seek(SeekFrom::Start(HDR)).map_err(|e| e.to_string())?;

    let mut events = Vec::new();
    let mut prev_end: i32 = 0;  // cumulative offset of the previous entry's end

    for (end_offset, entry_state) in &trailer {
        let entry_len = (end_offset - prev_end) as usize;

        // Alignment padding after this entry (before next one starts).
        let padding = if end_offset % 4 != 0 { (4 - end_offset % 4) as usize } else { 0 };

        if entry_len == 0 || *entry_state == 4 {
            // Empty slot — just consume padding.
            if padding > 0 {
                r.seek(SeekFrom::Current(padding as i64)).ok();
            }
            prev_end = end_offset + padding as i32;
            continue;
        }

        let mut entry_data = vec![0u8; entry_len];
        if r.read_exact(&mut entry_data).is_err() { break; }

        if padding > 0 {
            r.seek(SeekFrom::Current(padding as i64)).ok();
        }
        prev_end = end_offset + padding as i32;

        if *entry_state == 3 { continue; }  // Deleted
        if entry_len < 8    { continue; }   // Too short for entry header

        let crc32_stored = u32::from_le_bytes(entry_data[0..4].try_into().unwrap());
        let payload      = &entry_data[8..];

        if payload.is_empty() || payload.iter().all(|&b| b == 0) { continue; }
        if crc32_stored != 0 && crc32fast::hash(payload) != crc32_stored { continue; }

        if let Some(ev) = decode_proto(payload) {
            events.push(ev);
        }
    }

    Ok(events)
}

// ── Protobuf decoder ──────────────────────────────────────────────────────────
//
// AppInFocusEvent (proto3):
//   3  uint32  in_foreground    (1 = app gained focus, 0 = lost)
//   4  double  cf_absolute_time (CFAbsoluteTime: seconds since 2001-01-01)
//   6  string  bundle_id
//
// All other fields are skipped.

fn decode_proto(data: &[u8]) -> Option<FocusEvent> {
    let mut bundle_id     = String::new();
    let mut in_foreground: Option<bool> = None;
    let mut cf_time:       Option<f64>  = None;

    let mut pos = 0usize;
    while pos < data.len() {
        let (tag, c) = read_varint(data, pos)?;
        pos += c;

        let field = tag >> 3;
        let wtype = (tag & 0x07) as u8;

        match (field, wtype) {
            // in_foreground: varint
            (3, 0) => {
                let (v, c) = read_varint(data, pos)?;
                pos += c;
                in_foreground = Some(v != 0);
            }
            // cf_absolute_time: 64-bit float
            (4, 1) => {
                if pos + 8 > data.len() { return None; }
                cf_time = Some(f64::from_le_bytes(data[pos..pos+8].try_into().ok()?));
                pos += 8;
            }
            // bundle_id: length-delimited string
            (6, 2) => {
                let (len, c) = read_varint(data, pos)?;
                pos += c;
                let len = len as usize;
                if pos + len > data.len() { return None; }
                bundle_id = String::from_utf8_lossy(&data[pos..pos+len]).into_owned();
                pos += len;
            }
            // Skip known wire types for unknown fields
            (_, 0) => { let (_, c) = read_varint(data, pos)?; pos += c; }
            (_, 1) => { if pos + 8 > data.len() { break; } pos += 8; }
            (_, 2) => {
                let (len, c) = read_varint(data, pos)?;
                pos += c;
                let len = len as usize;
                if pos + len > data.len() { break; }
                pos += len;
            }
            (_, 5) => { if pos + 4 > data.len() { break; } pos += 4; }
            _ => break,
        }
    }

    if bundle_id.is_empty() { return None; }
    let unix_ts = (cf_time? as i64) + APPLE_EPOCH_OFFSET;

    Some(FocusEvent {
        bundle_id,
        in_foreground: in_foreground.unwrap_or(false),
        unix_ts,
    })
}

/// Read a protobuf varint from `data[pos..]`.  Returns `(value, bytes_consumed)`.
fn read_varint(data: &[u8], mut pos: usize) -> Option<(u64, usize)> {
    let start = pos;
    let mut value = 0u64;
    let mut shift = 0u32;
    loop {
        if pos >= data.len() || shift >= 64 { return None; }
        let byte = data[pos]; pos += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        shift += 7;
        if byte & 0x80 == 0 { break; }
    }
    Some((value, pos - start))
}

// ── Event stitching ───────────────────────────────────────────────────────────
//
// Raw events are gain/lose-focus transitions. We stitch them into intervals:
//   - Open interval on in_foreground=true
//   - Close interval on in_foreground=false for the same app,
//     OR when a different app gains focus (implicit close)
// Intervals longer than 24 h are discarded as likely artifacts.

fn stitch_events(events: Vec<FocusEvent>, device_id: &str, device_model: &str) -> Vec<BiomeRow> {
    const MAX_SESSION_SECS: i64 = 86_400; // 24 h sanity cap

    let mut rows: Vec<BiomeRow>    = Vec::new();
    let mut open_bundle: Option<String> = None;
    let mut open_start:  Option<i64>    = None;

    let close = |bundle: &str, start: i64, end: i64, device_id: &str, rows: &mut Vec<BiomeRow>| {
        let dur = end - start;
        if dur > 0 && dur <= MAX_SESSION_SECS {
            rows.push(BiomeRow {
                app:           bundle.to_string(),
                usage_seconds: dur as f64,
                start_time:    start,
                end_time:      end,
                device_id:     device_id.to_string(),
                device_model:  device_model.to_string(),
            });
        }
    };

    for ev in &events {
        if ev.bundle_id.is_empty() { continue; }

        if ev.in_foreground {
            // Different app gained focus → close previous interval.
            if let (Some(ref b), Some(st)) = (open_bundle.as_ref(), open_start) {
                if b.as_str() != ev.bundle_id.as_str() {
                    close(b, st, ev.unix_ts, device_id, &mut rows);
                }
            }
            // Open new (or continue same).
            if open_bundle.as_deref() != Some(ev.bundle_id.as_str()) {
                open_bundle = Some(ev.bundle_id.clone());
                open_start  = Some(ev.unix_ts);
            }
        } else {
            // App lost focus → close interval if it matches.
            if let (Some(ref b), Some(st)) = (open_bundle.as_ref(), open_start) {
                if b.as_str() == ev.bundle_id.as_str() {
                    close(b, st, ev.unix_ts, device_id, &mut rows);
                    open_bundle = None;
                    open_start  = None;
                }
            }
        }
    }
    // Note: we intentionally leave the last open interval unclosed — it may
    // still be active.  The next collection run will close it.

    rows
}
