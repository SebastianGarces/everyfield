//! evf-tui: one live screen of every harness task, stage and seat. Read-only. Started by `evf tui`, which builds this
//! crate when it is stale and passes `--db <git-common-dir>/evf/work.sqlite`.
//!
//! Three poll threads post into one channel: the store on a file-watch event or every 250 ms (re-read only when
//! `PRAGMA data_version` moved), `herdr api snapshot` every second, `git worktree list` every ten seconds. The main
//! thread owns the state and redraws after every message.

mod app;
mod git;
mod herdr;
mod store;
mod timefmt;
mod ui;

use anyhow::{bail, Context, Result};
use app::{App, Msg};
use notify::{RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

const USAGE: &str = "evf-tui --db <work.sqlite> [--herdr <command>] [--once]

  --db <path>       the harness work store (evf tui passes <git-common-dir>/evf/work.sqlite)
  --herdr <command> the Herdr CLI to poll and focus with (default: herdr on PATH)
  --once            print one plain-text report instead of the live screen";

struct Args {
    db: PathBuf,
    herdr: String,
    once: bool,
}

fn parse_args() -> Result<Args> {
    let mut db = None;
    let mut herdr = "herdr".to_string();
    let mut once = false;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--db" => db = Some(PathBuf::from(it.next().context("--db needs a path")?)),
            "--herdr" => herdr = it.next().context("--herdr needs a command")?,
            "--once" => once = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => bail!("unknown argument {other}\n\n{USAGE}"),
        }
    }
    Ok(Args {
        db: db.context("--db <path> is required; run it through evf tui")?,
        herdr,
        once,
    })
}

const STORE_FALLBACK: Duration = Duration::from_millis(250);
const HERDR_EVERY: Duration = Duration::from_secs(1);
const GIT_EVERY: Duration = Duration::from_secs(10);

/// Watches the store's directory: work.sqlite and work.sqlite-wal change on every commit. The watcher is best
/// effort; the 250 ms fallback poll covers a platform without file events.
fn watch_store(db: &Path, wake: Sender<()>) -> Option<notify::RecommendedWatcher> {
    let dir = db.parent()?.to_path_buf();
    if !dir.is_dir() {
        return None;
    }
    let stem = db.file_name()?.to_string_lossy().to_string();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if let Ok(event) = event {
            let hit = event.paths.iter().any(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with(&stem))
                    .unwrap_or(false)
            });
            if hit {
                let _ = wake.send(());
            }
        }
    })
    .ok()?;
    watcher.watch(&dir, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}

fn store_thread(db: PathBuf, tx: Sender<Msg>) {
    let (wake_tx, wake_rx) = mpsc::channel::<()>();
    let mut watcher = watch_store(&db, wake_tx.clone());
    let mut reader = store::Reader::new(db.clone());
    loop {
        if watcher.is_none() {
            watcher = watch_store(&db, wake_tx.clone());
        }
        let _ = wake_rx.recv_timeout(STORE_FALLBACK);
        while wake_rx.try_recv().is_ok() {}
        if let Some(outcome) = reader.poll() {
            if tx.send(Msg::Store(outcome)).is_err() {
                return;
            }
        }
    }
}

fn herdr_thread(bin: String, tx: Sender<Msg>) {
    loop {
        if tx.send(Msg::Herdr(herdr::snapshot(&bin))).is_err() {
            return;
        }
        thread::sleep(HERDR_EVERY);
    }
}

fn git_thread(git_dir: PathBuf, tx: Sender<Msg>) {
    loop {
        if tx.send(Msg::Git(git::list(&git_dir))).is_err() {
            return;
        }
        thread::sleep(GIT_EVERY);
    }
}

fn input_thread(tx: Sender<Msg>) {
    loop {
        match ratatui::crossterm::event::read() {
            Ok(event) => {
                if tx.send(Msg::Input(event)).is_err() {
                    return;
                }
            }
            Err(_) => return,
        }
    }
}

/// `<git-common-dir>/evf/work.sqlite` -> `<git-common-dir>`.
fn git_dir_of(db: &Path) -> PathBuf {
    db.parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn once(args: Args) -> Result<()> {
    let mut app = App::new(args.db.clone(), args.herdr.clone());
    let mut reader = store::Reader::new(args.db.clone());
    if let Some(outcome) = reader.poll() {
        app.handle(Msg::Store(outcome));
    }
    app.handle(Msg::Herdr(herdr::snapshot(&args.herdr)));
    app.handle(Msg::Git(git::list(&git_dir_of(&args.db))));
    print!("{}", app.plain_report());
    if let Some(e) = app.store_error {
        bail!("{e}");
    }
    Ok(())
}

fn live(args: Args) -> Result<()> {
    let (tx, rx): (Sender<Msg>, Receiver<Msg>) = mpsc::channel();
    let mut app = App::new(args.db.clone(), args.herdr.clone());
    {
        let (db, tx) = (args.db.clone(), tx.clone());
        thread::Builder::new()
            .name("store".into())
            .spawn(move || store_thread(db, tx))?;
    }
    {
        let (bin, tx) = (args.herdr.clone(), tx.clone());
        thread::Builder::new()
            .name("herdr".into())
            .spawn(move || herdr_thread(bin, tx))?;
    }
    {
        let (dir, tx) = (git_dir_of(&args.db), tx.clone());
        thread::Builder::new()
            .name("git".into())
            .spawn(move || git_thread(dir, tx))?;
    }
    let mut terminal = ratatui::init();
    {
        let tx = tx.clone();
        thread::Builder::new()
            .name("input".into())
            .spawn(move || input_thread(tx))?;
    }
    let result = (|| -> Result<()> {
        loop {
            terminal.draw(|frame| ui::draw(frame, &mut app))?;
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(msg) => app.handle(msg),
                Err(mpsc::RecvTimeoutError::Timeout) => app.handle(Msg::Tick),
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            while let Ok(msg) = rx.try_recv() {
                app.handle(msg);
            }
            if app.quit {
                break;
            }
        }
        Ok(())
    })();
    ratatui::restore();
    result
}

fn main() -> Result<()> {
    let args = parse_args()?;
    if args.once {
        once(args)
    } else {
        live(args)
    }
}
