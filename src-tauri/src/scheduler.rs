use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};
use crate::collect::{collect, check_fda};

static IS_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn is_running() -> bool {
    IS_RUNNING.load(Ordering::SeqCst)
}

pub fn run_collect(app: &AppHandle, conn: Arc<Mutex<Connection>>) {
    if IS_RUNNING.swap(true, Ordering::SeqCst) {
        return; // already running
    }

    let fda = check_fda();
    if !fda.granted {
        IS_RUNNING.store(false, Ordering::SeqCst);
        return;
    }

    let app2 = app.clone();
    let conn2 = conn.clone();
    thread::spawn(move || {
        let result = collect(conn2, |progress| {
            let _ = app2.emit("collect:progress", &progress);
        });
        IS_RUNNING.store(false, Ordering::SeqCst);
        // Send final result too so UI can update last-run time
        let _ = app2.emit("collect:progress", &result);
    });
}

pub fn start_scheduler(app: AppHandle, conn: Arc<Mutex<Connection>>) {
    // Run immediately on startup
    run_collect(&app, conn.clone());

    // Then every hour, with wake-from-sleep detection
    thread::spawn(move || {
        const INTERVAL: Duration = Duration::from_secs(3600);
        let mut last_ran = Instant::now();

        loop {
            thread::sleep(Duration::from_secs(30));

            let elapsed = last_ran.elapsed();
            // Collect if 1 hour has passed OR if we detect a large elapsed time
            // (e.g., sleep/wake: the thread was paused for a long time)
            let slept_long = elapsed > Duration::from_secs(60);
            let hour_passed = elapsed >= INTERVAL;

            if hour_passed || (slept_long && elapsed > Duration::from_secs(120)) {
                run_collect(&app, conn.clone());
                last_ran = Instant::now();
            }
        }
    });
}
