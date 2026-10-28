//! The work store, read-only. Only the views the migrations define (`v_tasks`, `v_seats`, `v_recent`, `v_health`)
//! and the small `proofs` and `tasks` reads the detail panel needs. The connection never writes and never runs a
//! migration; `evf db migrate` owns the schema.

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags, Row};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Task {
    pub id: i64,
    pub reference: Option<String>,
    pub slug: String,
    pub mode: String,
    pub status: String,
    pub round: i64,
    pub pr_number: Option<i64>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub herdr_workspace_id: Option<String>,
    pub title: String,
    pub goal_key: Option<String>,
    pub stage: Option<String>,
    pub stage_status: Option<String>,
    pub active_seats: i64,
    pub proofs_met: i64,
    pub proofs_total: i64,
    pub last_event_at: Option<String>,
    pub updated_at: String,
}

impl Task {
    pub fn label(&self) -> &str {
        self.reference.as_deref().unwrap_or(&self.slug)
    }

    pub fn is_open(&self) -> bool {
        !matches!(self.status.as_str(), "merged" | "done" | "abandoned")
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Seat {
    pub run_id: i64,
    pub task_id: i64,
    pub stage: String,
    pub role: String,
    pub seat: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub round: i64,
    pub session_id: Option<String>,
    pub herdr_agent: Option<String>,
    pub herdr_pane: Option<String>,
    pub started_at: String,
    pub last_event: Option<String>,
    pub last_event_at: Option<String>,
    pub last_summary: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Event {
    pub id: i64,
    pub ts: String,
    pub kind: String,
    pub task_id: Option<i64>,
    pub run_id: Option<i64>,
    pub reference: Option<String>,
    pub slug: Option<String>,
    pub seat: Option<String>,
    pub summary: Option<String>,
}

impl Event {
    pub fn task_label(&self) -> &str {
        self.reference
            .as_deref()
            .or(self.slug.as_deref())
            .unwrap_or("-")
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Health {
    pub open_tasks: i64,
    pub escalated_tasks: i64,
    pub active_seats: i64,
    pub merged_24h: i64,
    pub merged_7d: i64,
    pub rounds_per_merge_7d: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    pub schema_version: i64,
    pub tasks: Vec<Task>,
    pub seats: Vec<Seat>,
    pub recent: Vec<Event>,
    pub health: Health,
}

impl Snapshot {
    pub fn task(&self, id: i64) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Proof {
    pub id: i64,
    pub head_sha: String,
    pub criterion: String,
    pub status: String,
    pub evidence_url: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Detail {
    pub task_id: i64,
    pub ask: String,
    pub spec: Option<String>,
    pub proofs: Vec<Proof>,
}

pub const RECENT_LIMIT: usize = 200;

/// Read-only, WAL-aware, 200 ms busy timeout: a hook holding the write lock never waits on the TUI and the TUI never
/// waits long on a hook.
pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open {} read-only", path.display()))?;
    conn.busy_timeout(Duration::from_millis(200))?;
    conn.execute_batch("PRAGMA query_only = 1")?;
    Ok(conn)
}

/// Changes when another connection commits; the poller re-reads only then.
pub fn data_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("PRAGMA data_version", [], |r| r.get(0))?)
}

fn task_row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get("id")?,
        reference: r.get("ref")?,
        slug: r.get("slug")?,
        mode: r.get("mode")?,
        status: r.get("status")?,
        round: r.get("round")?,
        pr_number: r.get("pr_number")?,
        branch: r.get("branch")?,
        worktree: r.get("worktree")?,
        herdr_workspace_id: r.get("herdr_workspace_id")?,
        title: r.get("title")?,
        goal_key: r.get("goal_key")?,
        stage: r.get("stage")?,
        stage_status: r.get("stage_status")?,
        active_seats: r.get("active_seats")?,
        proofs_met: r.get("proofs_met")?,
        proofs_total: r.get("proofs_total")?,
        last_event_at: r.get("last_event_at")?,
        updated_at: r.get("updated_at")?,
    })
}

pub fn read(conn: &Connection) -> Result<Snapshot> {
    let schema_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let tasks = conn
        .prepare("SELECT * FROM v_tasks ORDER BY updated_at DESC, id DESC")?
        .query_map([], task_row)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("read v_tasks")?;
    let mut seats = conn
        .prepare("SELECT * FROM v_seats ORDER BY started_at, run_id")?
        .query_map([], |r| {
            Ok(Seat {
                run_id: r.get("run_id")?,
                task_id: r.get("task_id")?,
                stage: r.get("stage")?,
                role: r.get("role")?,
                seat: r.get("seat")?,
                model: r.get("model")?,
                effort: r.get("effort")?,
                round: r.get("round")?,
                session_id: r.get("session_id")?,
                herdr_agent: r.get("herdr_agent")?,
                herdr_pane: r.get("herdr_pane")?,
                started_at: r.get("started_at")?,
                last_event: r.get("last_event")?,
                last_event_at: r.get("last_event_at")?,
                last_summary: None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("read v_seats")?;
    // The last event's one-line summary per run, for the NOW column.
    let mut summaries = conn.prepare(
        "SELECT run_id, json_extract(payload, '$.summary') AS summary FROM events \
         WHERE id IN (SELECT MAX(id) FROM events WHERE run_id IS NOT NULL GROUP BY run_id)",
    )?;
    let pairs = summaries
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>("run_id")?,
                r.get::<_, Option<String>>("summary")?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for seat in &mut seats {
        if let Some((_, s)) = pairs.iter().find(|(run, _)| *run == seat.run_id) {
            seat.last_summary = s.clone();
        }
    }
    let recent = conn
        .prepare(&format!("SELECT * FROM v_recent LIMIT {RECENT_LIMIT}"))?
        .query_map([], |r| {
            Ok(Event {
                id: r.get("id")?,
                ts: r.get("ts")?,
                kind: r.get("type")?,
                task_id: r.get("task_id")?,
                run_id: r.get("run_id")?,
                reference: r.get("ref")?,
                slug: r.get("slug")?,
                seat: r.get("seat")?,
                summary: r.get("summary")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("read v_recent")?;
    let health = conn
        .query_row("SELECT * FROM v_health", [], |r| {
            Ok(Health {
                open_tasks: r.get("open_tasks")?,
                escalated_tasks: r.get("escalated_tasks")?,
                active_seats: r.get("active_seats")?,
                merged_24h: r.get("merged_24h")?,
                merged_7d: r.get("merged_7d")?,
                rounds_per_merge_7d: r.get("rounds_per_merge_7d")?,
            })
        })
        .context("read v_health")?;
    Ok(Snapshot {
        schema_version,
        tasks,
        seats,
        recent,
        health,
    })
}

pub fn detail(conn: &Connection, task_id: i64) -> Result<Detail> {
    let (ask, spec): (String, Option<String>) = conn
        .query_row(
            "SELECT ask, spec FROM tasks WHERE id = ?1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .with_context(|| format!("task {task_id} is not in the store"))?;
    let proofs = conn
        .prepare("SELECT id, head_sha, criterion, status, evidence_url, notes FROM proofs WHERE task_id = ?1 ORDER BY id")?
        .query_map([task_id], |r| {
            Ok(Proof {
                id: r.get(0)?,
                head_sha: r.get(1)?,
                criterion: r.get(2)?,
                status: r.get(3)?,
                evidence_url: r.get(4)?,
                notes: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Detail {
        task_id,
        ask,
        spec,
        proofs,
    })
}

/// Opens, reads one task's detail and closes; used from the main thread on Enter.
pub fn detail_at(path: &Path, task_id: i64) -> Result<Detail> {
    detail(&open(path)?, task_id)
}

/// What one poll of the store tells the screen.
pub type Outcome = std::result::Result<Option<Snapshot>, String>;

/// Keeps one read-only connection and reports a snapshot only when `PRAGMA data_version` moved, so a quiet store
/// costs one pragma per poll. A missing file reports `Ok(None)` once and is re-checked until it appears.
pub struct Reader {
    path: PathBuf,
    conn: Option<Connection>,
    version: Option<i64>,
    reported_missing: bool,
    last_error: Option<String>,
}

impl Reader {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            conn: None,
            version: None,
            reported_missing: false,
            last_error: None,
        }
    }

    pub fn poll(&mut self) -> Option<Outcome> {
        if !self.path.exists() {
            self.conn = None;
            self.version = None;
            self.last_error = None;
            if self.reported_missing {
                return None;
            }
            self.reported_missing = true;
            return Some(Ok(None));
        }
        self.reported_missing = false;
        let result = self.try_read();
        match result {
            Ok(snapshot) => {
                self.last_error = None;
                snapshot.map(|s| Ok(Some(s)))
            }
            Err(e) => {
                self.conn = None;
                self.version = None;
                let msg = format!("{e:#}");
                if self.last_error.as_deref() == Some(&msg) {
                    return None;
                }
                self.last_error = Some(msg.clone());
                Some(Err(msg))
            }
        }
    }

    fn try_read(&mut self) -> Result<Option<Snapshot>> {
        if self.conn.is_none() {
            self.conn = Some(open(&self.path)?);
            self.version = None;
        }
        let conn = self.conn.as_ref().expect("connection just opened");
        let version = data_version(conn)?;
        if self.version == Some(version) {
            return Ok(None);
        }
        let snapshot = read(conn)?;
        self.version = Some(version);
        Ok(Some(snapshot))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const MIGRATIONS: [&str; 2] = [
        include_str!("../../evf/db/migrations/001-init.sql"),
        include_str!("../../evf/db/migrations/002-prototype-statuses.sql"),
    ];

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A fresh store with evf's real migrations, in WAL mode like evf's writers, in its own temp directory.
    pub struct TempStore {
        pub dir: PathBuf,
        pub path: PathBuf,
    }

    impl TempStore {
        pub fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "evf-tui-test-{}-{}-{n}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("work.sqlite");
            let db = Connection::open(&path).unwrap();
            db.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);").unwrap();
            for (i, sql) in MIGRATIONS.iter().enumerate() {
                db.execute_batch(sql).unwrap();
                db.execute(
                    "INSERT INTO schema_version (version, name, applied_at) VALUES (?1, ?2, '2026-10-27T00:00:00.000Z')",
                    (i as i64 + 1, format!("m{}", i + 1)),
                )
                .unwrap();
            }
            Self { dir, path }
        }

        pub fn writer(&self) -> Connection {
            let db = Connection::open(&self.path).unwrap();
            db.busy_timeout(Duration::from_millis(5000)).unwrap();
            db
        }

        /// A task with one started seat, one event on it and one proof. Returns (task id, run id).
        pub fn seed(&self) -> (i64, i64) {
            let db = self.writer();
            db.execute(
                "INSERT INTO tasks (slug, mode, ref, title, ask, spec, status, worktree, branch, herdr_workspace_id, pr_number, round, created_at, updated_at) \
                 VALUES ('wp-101', 'implement', 'WP-101', 'Comments', 'Build comments', 'Goal: comments\nDone:\n1. list\n2. post', 'active', '/w/.worktrees/wp-101', 'task/wp-101', 'wA', NULL, 1, '2026-10-27T20:00:00.000Z', '2026-10-27T20:30:00.000Z')",
                [],
            )
            .unwrap();
            let task_id = db.last_insert_rowid();
            db.execute(
                "INSERT INTO runs (task_id, stage, role, model, effort, round, herdr_agent, herdr_pane, session_id, status, started_at) \
                 VALUES (?1, 'implement', 'implementer', 'claude-sonnet-5-5', 'medium', 1, 'implementer-wp-101', 'wA:p1', '11111111-1111-4111-8111-111111111111', 'started', '2026-10-27T20:10:00.000Z')",
                [task_id],
            )
            .unwrap();
            let run_id = db.last_insert_rowid();
            db.execute(
                "INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?1, ?2, '2026-10-27T20:10:01.000Z', 'stage_start', '{\"summary\":\"implementer@WP-101 started in wA\"}')",
                (task_id, run_id),
            )
            .unwrap();
            db.execute(
                "INSERT INTO proofs (task_id, run_id, head_sha, criterion, status, created_at) VALUES (?1, ?2, 'abc123', '1', 'met', '2026-10-27T20:20:00.000Z')",
                (task_id, run_id),
            )
            .unwrap();
            (task_id, run_id)
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn reads_the_views_read_only() {
        let store = TempStore::new();
        let (task_id, run_id) = store.seed();
        let conn = open(&store.path).unwrap();
        let snap = read(&conn).unwrap();
        assert_eq!(snap.schema_version, 2);
        assert_eq!(snap.tasks.len(), 1);
        let task = &snap.tasks[0];
        assert_eq!(task.id, task_id);
        assert_eq!(task.label(), "WP-101");
        assert_eq!(task.stage.as_deref(), Some("implement"));
        assert_eq!((task.proofs_met, task.proofs_total), (1, 1));
        assert!(task.is_open());
        assert_eq!(snap.seats.len(), 1);
        let seat = &snap.seats[0];
        assert_eq!(seat.run_id, run_id);
        assert_eq!(seat.seat, "implementer@WP-101");
        assert_eq!(seat.last_event.as_deref(), Some("stage_start"));
        assert_eq!(
            seat.last_summary.as_deref(),
            Some("implementer@WP-101 started in wA")
        );
        assert_eq!(snap.recent.len(), 1);
        assert_eq!(snap.recent[0].kind, "stage_start");
        assert_eq!(snap.recent[0].task_label(), "WP-101");
        assert_eq!(snap.health.open_tasks, 1);
        assert_eq!(snap.health.active_seats, 1);
        let d = detail(&conn, task_id).unwrap();
        assert_eq!(d.ask, "Build comments");
        assert!(d.spec.unwrap().starts_with("Goal: comments"));
        assert_eq!(d.proofs.len(), 1);
        assert_eq!(d.proofs[0].status, "met");
        // The connection refuses writes.
        let err = conn
            .execute("INSERT INTO events (ts, type) VALUES ('x', 'y')", [])
            .unwrap_err();
        assert!(err.to_string().contains("readonly"), "{err}");
        assert!(detail(&conn, 999).is_err());
    }

    #[test]
    fn reads_while_a_writer_holds_the_lock() {
        let store = TempStore::new();
        store.seed();
        let writer = store.writer();
        writer
            .execute_batch("BEGIN IMMEDIATE; INSERT INTO events (ts, type) VALUES ('2026-10-27T20:40:00.000Z', 'check_result');")
            .unwrap();
        let started = std::time::Instant::now();
        let conn = open(&store.path).unwrap();
        let snap = read(&conn).unwrap();
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "a WAL reader must not wait on the writer"
        );
        assert_eq!(snap.recent.len(), 1, "the uncommitted event is invisible");
        writer.execute_batch("COMMIT").unwrap();
        assert_eq!(read(&conn).unwrap().recent.len(), 2);
    }

    #[test]
    fn reader_reports_only_changes_and_missing_files_once() {
        let store = TempStore::new();
        let missing = store.dir.join("absent.sqlite");
        let mut reader = Reader::new(missing.clone());
        assert!(matches!(reader.poll(), Some(Ok(None))));
        assert!(reader.poll().is_none());
        std::fs::copy(&store.path, &missing).unwrap();
        let first = reader.poll().unwrap().unwrap().unwrap();
        assert_eq!(first.tasks.len(), 0);
        assert!(reader.poll().is_none(), "no commit, no report");
        let mut reader = Reader::new(store.path.clone());
        assert_eq!(reader.poll().unwrap().unwrap().unwrap().tasks.len(), 0);
        store.seed();
        let after = reader.poll().unwrap().unwrap().unwrap();
        assert_eq!(after.tasks.len(), 1);
        assert!(reader.poll().is_none());
        std::fs::write(&missing, b"not a database").unwrap();
        let mut broken = Reader::new(missing);
        assert!(matches!(broken.poll(), Some(Err(_))));
        assert!(broken.poll().is_none(), "the same error is reported once");
    }
}
