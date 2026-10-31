//! Screen state: the store snapshot joined to Herdr and git, the rows the table shows, the summary line and the keys.

use crate::{git, herdr, store, timefmt};
use chrono::{DateTime, Utc};
use ratatui::crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Rounds before a task escalates (tools/evf/drive.ts LOOP_CAP).
pub const LOOP_CAP: i64 = 3;
pub const MESSAGE_TTL: Duration = Duration::from_secs(6);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tab {
    Table,
    Recent,
    Health,
}

impl Tab {
    pub const ALL: [Tab; 3] = [Tab::Table, Tab::Recent, Tab::Health];

    pub fn title(self) -> &'static str {
        match self {
            Tab::Table => "1 TABLE",
            Tab::Recent => "2 RECENT",
            Tab::Health => "3 HEALTH",
        }
    }

    pub fn index(self) -> usize {
        Tab::ALL.iter().position(|t| *t == self).unwrap_or(0)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Focus {
    Explorer,
    Main,
}

/// The stage a task is in now, as the EXPLORER groups it. The order here is the order on screen.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Group {
    Queued,
    Plan,
    Implement,
    Simplify,
    Pr,
    Verify,
    Ci,
    Ship,
    AwaitingOwner,
    NeedsPick,
    Escalated,
    #[default]
    Other,
}

impl Group {
    pub const ALL: [Group; 12] = [
        Group::Queued,
        Group::Plan,
        Group::Implement,
        Group::Simplify,
        Group::Pr,
        Group::Verify,
        Group::Ci,
        Group::Ship,
        Group::AwaitingOwner,
        Group::NeedsPick,
        Group::Escalated,
        Group::Other,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Group::Queued => "queued",
            Group::Plan => "plan",
            Group::Implement => "implement",
            Group::Simplify => "simplify",
            Group::Pr => "pr",
            Group::Verify => "verify",
            Group::Ci => "ci",
            Group::Ship => "ship",
            Group::AwaitingOwner => "awaiting owner",
            Group::NeedsPick => "needs pick",
            Group::Escalated => "escalated",
            Group::Other => "other",
        }
    }
}

/// What the explorer selection narrows the table and feed to.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub enum Scope {
    #[default]
    All,
    Group(Group),
    Task(i64),
}

/// Roles that run in a Herdr pane. Any other role (`evf`) is evf itself working a stage and has no pane by design.
pub const SEAT_ROLES: [&str; 8] = [
    "planner",
    "implementer",
    "ui",
    "simplifier",
    "verifier",
    "ideator",
    "comparer",
    "prototype-merger",
];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Row {
    pub task_id: i64,
    pub run_id: Option<i64>,
    pub group: Group,
    /// Older rows of the same ref, shown as `+N` after the label.
    pub extra: usize,
    /// First row of a task group carries the task label; the seats below it leave the column blank.
    pub first: bool,
    pub task: String,
    pub stage: String,
    pub seat: String,
    pub model: String,
    pub effort: String,
    pub state: String,
    pub round: String,
    pub proof: String,
    pub gate: String,
    pub now: String,
    pub needs_you: bool,
    pub working: bool,
    pub herdr_agent: Option<String>,
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Summary {
    pub seats: usize,
    pub working: usize,
    pub needs_you: usize,
    pub open_tasks: usize,
}

impl Summary {
    pub fn line(&self) -> String {
        format!(
            "{} seats · {} working · {} needs you · {} open tasks",
            self.seats, self.working, self.needs_you, self.open_tasks
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExplorerItem {
    pub label: String,
    pub depth: u8,
    pub scope: Scope,
    pub count: usize,
}

pub enum Msg {
    Store(store::Outcome),
    Herdr(herdr::State),
    Git(Vec<git::Worktree>),
    Input(Event),
    Tick,
}

/// Something Sebastian must do, with the exact command.
#[derive(Debug, Clone, PartialEq)]
pub struct Attention {
    pub what: String,
    pub command: String,
}

pub fn short_model(model: Option<&str>) -> String {
    match model {
        Some(m) => m.strip_prefix("claude-").unwrap_or(m).to_string(),
        None => "-".into(),
    }
}

fn gate_of(task: &store::Task) -> String {
    match task.status.as_str() {
        "awaiting_pick" => "pick".into(),
        "escalated" => "escalated".into(),
        _ => match task.pr_number {
            Some(n) => format!("PR #{n}"),
            None if task.status == "pr_open" => "pr open".into(),
            None => "-".into(),
        },
    }
}

fn task_needs_you(task: &store::Task) -> bool {
    matches!(task.status.as_str(), "awaiting_pick" | "escalated")
}

/// A merged task shows in TABLE this long after its `merged` event, as `merged_24h` counts it. The time of the
/// event, not `updated_at`, which any later store write refreshes.
const MERGED_VISIBLE_HOURS: i64 = 24;

fn recently_merged(task: &store::Task, now: DateTime<Utc>) -> bool {
    task.status == "merged"
        && task
            .merged_at
            .as_deref()
            .and_then(timefmt::parse)
            .is_some_and(|at| now - at < chrono::Duration::hours(MERGED_VISIBLE_HOURS))
}

/// One task per ref: the latest row by id that is not abandoned. Older rows of the ref add `+N`, not a row.
pub fn current_tasks(snap: &store::Snapshot) -> Vec<&store::Task> {
    let mut latest: HashMap<&str, i64> = HashMap::new();
    for t in snap.tasks.iter().filter(|t| t.status != "abandoned") {
        let id = latest.entry(t.label()).or_insert(t.id);
        *id = (*id).max(t.id);
    }
    snap.tasks
        .iter()
        .filter(|t| t.status != "abandoned" && latest.get(t.label()) == Some(&t.id))
        .collect()
}

fn is_seat_role(role: &str) -> bool {
    SEAT_ROLES.contains(&role)
}

/// Verified and waiting on Sebastian: the PR is open, no seat works on it, and the latest event is the drive's
/// owner-approval wait or a drive stopped inside its ship stage (the coordinator holding the ship).
fn is_held(task: &store::Task, seats: &[&store::Seat]) -> bool {
    task.status == "pr_open"
        && !seats.iter().any(|s| is_seat_role(&s.role))
        && match task.last_event.as_deref() {
            Some("owner_approval_wait") => true,
            Some("drive_stopped") => task.stage.as_deref() == Some("ship"),
            _ => false,
        }
}

fn seats_of<'a>(snap: &'a store::Snapshot, task: &store::Task) -> Vec<&'a store::Seat> {
    snap.seats.iter().filter(|s| s.task_id == task.id).collect()
}

/// The EXPLORER group of an open task.
pub fn group_of(snap: &store::Snapshot, task: &store::Task) -> Group {
    match task.status.as_str() {
        "new" | "specced" => return Group::Queued,
        "awaiting_pick" => return Group::NeedsPick,
        "escalated" => return Group::Escalated,
        _ => {}
    }
    if is_held(task, &seats_of(snap, task)) {
        return Group::AwaitingOwner;
    }
    match task.stage.as_deref() {
        Some("plan") => Group::Plan,
        Some("implement") => Group::Implement,
        Some("simplify") => Group::Simplify,
        Some("pr") => Group::Pr,
        Some("verify") => Group::Verify,
        Some("ci") => Group::Ci,
        Some("ship") => Group::Ship,
        _ => Group::Other,
    }
}

/// One row per running seat under its task, plus one row for every open task with no seat (a gate or a wait)
/// and for every task that merged in the last day. Merged rows are never open and never need you. A ref shows
/// once, as its latest row.
pub fn build_rows(snap: &store::Snapshot, herdr: &herdr::State, now: DateTime<Utc>) -> Vec<Row> {
    let mut rows = Vec::new();
    for task in current_tasks(snap) {
        let seats = seats_of(snap, task);
        let merged = recently_merged(task, now);
        if !task.is_open() && !merged {
            continue;
        }
        let held = is_held(task, &seats);
        let group = group_of(snap, task);
        let extra = (task.ref_rows - 1).max(0) as usize;
        let gate = gate_of(task);
        let proof = format!("{}/{}", task.proofs_met, task.proofs_total);
        if merged || seats.is_empty() || held {
            let state = if merged {
                "merged"
            } else if held {
                "awaiting owner"
            } else {
                match task.status.as_str() {
                    "awaiting_pick" => "needs pick",
                    "escalated" => "escalated",
                    "pr_open" => "pr open",
                    "new" | "specced" => task.status.as_str(),
                    _ => "no seat",
                }
            };
            let at = if merged {
                task.merged_at.as_deref()
            } else {
                None
            }
            .or(task.last_event_at.as_deref())
            .unwrap_or(&task.updated_at);
            rows.push(Row {
                task_id: task.id,
                run_id: None,
                group,
                extra,
                first: true,
                task: task.label().to_string(),
                stage: task.stage.clone().unwrap_or_else(|| "-".into()),
                seat: "-".into(),
                model: "-".into(),
                effort: "-".into(),
                state: state.into(),
                round: format!("{}/{LOOP_CAP}", task.round),
                proof,
                gate,
                now: format!("{} · {}", task.status, timefmt::ago(at, now)),
                needs_you: !merged && (task_needs_you(task) || held),
                working: false,
                herdr_agent: None,
                workspace: task.herdr_workspace_id.clone(),
            });
            continue;
        }
        for (i, seat) in seats.iter().enumerate() {
            // evf runs its own stages: such a run has no session, no pane and no Herdr agent by design.
            let agent = if is_seat_role(&seat.role) {
                seat.session_id
                    .as_deref()
                    .and_then(|s| herdr.by_session(s))
                    .or_else(|| seat.herdr_agent.as_deref().and_then(|n| herdr.by_name(n)))
            } else {
                None
            };
            let state = if !is_seat_role(&seat.role) {
                format!("{} {}", seat.role, seat.stage)
            } else {
                match agent {
                    Some(a) => a.status.clone(),
                    None if herdr.error.is_some() && herdr.agents.is_empty() => "herdr?".into(),
                    None => "no pane".into(),
                }
            };
            let at = seat.last_event_at.as_deref().unwrap_or(&seat.started_at);
            let blocked = state == "blocked";
            // A "blocked on a prompt" event is true only while Herdr says the seat is blocked. Once the prompt is
            // answered the stale event would keep the row red, so the live status stands in for it.
            let what = if seat.last_event.as_deref() == Some("blocked") && !blocked {
                state.clone()
            } else {
                seat.last_summary
                    .clone()
                    .or_else(|| seat.last_event.clone())
                    .unwrap_or_else(|| "started".into())
            };
            let working = state == "working";
            rows.push(Row {
                task_id: task.id,
                run_id: Some(seat.run_id),
                group,
                extra,
                first: i == 0,
                task: task.label().to_string(),
                stage: seat.stage.clone(),
                seat: seat.seat.clone(),
                model: short_model(seat.model.as_deref()),
                effort: seat.effort.clone().unwrap_or_else(|| "-".into()),
                state: state.clone(),
                round: format!("{}/{LOOP_CAP}", seat.round),
                proof: proof.clone(),
                gate: gate.clone(),
                now: format!("{what} · {}", timefmt::ago(at, now)),
                needs_you: blocked || (i == 0 && task_needs_you(task)),
                working,
                herdr_agent: agent
                    .map(|a| a.name.clone())
                    .or_else(|| seat.herdr_agent.clone()),
                workspace: agent
                    .and_then(|a| a.workspace_id.clone())
                    .or_else(|| task.herdr_workspace_id.clone()),
            });
        }
    }
    rows
}

pub fn summarize(rows: &[Row], snap: &store::Snapshot) -> Summary {
    Summary {
        seats: rows.iter().filter(|r| r.run_id.is_some()).count(),
        working: rows.iter().filter(|r| r.working).count(),
        needs_you: rows.iter().filter(|r| r.needs_you).count(),
        open_tasks: current_tasks(snap).iter().filter(|t| t.is_open()).count(),
    }
}

/// The human gates and blocked seats, each with the command that clears it.
pub fn attention(snap: &store::Snapshot, rows: &[Row]) -> Vec<Attention> {
    let mut out = Vec::new();
    for task in current_tasks(snap).into_iter().filter(|t| t.is_open()) {
        let label = task.label();
        match task.status.as_str() {
            "awaiting_pick" => out.push(Attention {
                what: format!("{label} waits for the prototype pick"),
                command: format!("evf task pick {label} <1|2|3> --owner-approval \"<words>\""),
            }),
            "escalated" => out.push(Attention {
                what: format!("{label} escalated after {LOOP_CAP} rounds"),
                command: format!("evf status {label}"),
            }),
            _ => {
                if group_of(snap, task) == Group::AwaitingOwner {
                    let pr = task
                        .pr_number
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| "<PR>".into());
                    out.push(Attention {
                        what: format!("{label} PR #{pr} waits for Sebastian's approval"),
                        command: format!("evf approve {pr} --owner-approval \"<his words>\""),
                    });
                }
            }
        }
    }
    for row in rows.iter().filter(|r| r.state == "blocked") {
        out.push(Attention {
            what: format!("{} is blocked in Herdr", row.seat),
            command: match &row.herdr_agent {
                Some(a) => format!("herdr agent focus {a}"),
                None => format!("evf status {}", row.task),
            },
        });
    }
    out
}

pub struct App {
    pub db_path: PathBuf,
    pub herdr_bin: String,
    pub snapshot: Option<store::Snapshot>,
    pub store_error: Option<String>,
    pub store_at: Option<Instant>,
    pub store_known: bool,
    pub herdr: herdr::State,
    pub herdr_at: Option<Instant>,
    pub worktrees: Vec<git::Worktree>,
    pub tab: Tab,
    pub focus: Focus,
    pub table_sel: usize,
    pub recent_sel: usize,
    pub explorer_sel: usize,
    pub scope: Scope,
    /// The `queued` group is collapsed by default: its rows hide under `all tasks` until `z` opens it.
    pub queued_open: bool,
    pub filter: String,
    pub editing_filter: bool,
    pub detail: Option<(store::Detail, u16)>,
    pub help: bool,
    pub message: Option<(String, Instant, bool)>,
    pub quit: bool,
}

impl App {
    pub fn new(db_path: PathBuf, herdr_bin: String) -> Self {
        Self {
            db_path,
            herdr_bin,
            snapshot: None,
            store_error: None,
            store_at: None,
            store_known: false,
            herdr: herdr::State::default(),
            herdr_at: None,
            worktrees: Vec::new(),
            tab: Tab::Table,
            focus: Focus::Main,
            table_sel: 0,
            recent_sel: 0,
            explorer_sel: 0,
            scope: Scope::All,
            queued_open: false,
            filter: String::new(),
            editing_filter: false,
            detail: None,
            help: false,
            message: None,
            quit: false,
        }
    }

    pub fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Store(Ok(Some(snap))) => {
                self.snapshot = Some(snap);
                self.store_error = None;
                self.store_at = Some(Instant::now());
                self.store_known = true;
                if let Some((d, scroll)) = self.detail.take() {
                    self.detail = Some((
                        store::detail_at(&self.db_path, d.task_id).unwrap_or(d),
                        scroll,
                    ));
                }
            }
            Msg::Store(Ok(None)) => {
                self.snapshot = None;
                self.store_error = None;
                self.store_known = true;
            }
            Msg::Store(Err(e)) => {
                self.store_error = Some(e);
                self.store_known = true;
            }
            Msg::Herdr(state) => {
                if state.error.is_some() {
                    self.herdr.error = state.error;
                } else {
                    self.herdr = state;
                }
                self.herdr_at = Some(Instant::now());
            }
            Msg::Git(list) => self.worktrees = list,
            Msg::Input(Event::Key(key)) => self.handle_key(key),
            Msg::Input(_) | Msg::Tick => {}
        }
        self.clamp();
    }

    fn matches(&self, fields: &[&str]) -> bool {
        if self.filter.is_empty() {
            return true;
        }
        let needle = self.filter.to_lowercase();
        fields.iter().any(|f| f.to_lowercase().contains(&needle))
    }

    /// The group of the task a row or event belongs to; an event of an older row follows its ref's current row.
    fn group_of_task(&self, task_id: Option<i64>) -> Option<Group> {
        let snap = self.snapshot.as_ref()?;
        let label = snap.task(task_id?)?.label();
        let current = current_tasks(snap)
            .into_iter()
            .find(|t| t.label() == label)?;
        Some(group_of(snap, current))
    }

    fn in_scope(&self, task_id: Option<i64>) -> bool {
        match &self.scope {
            Scope::All => true,
            Scope::Group(g) => self.group_of_task(task_id) == Some(*g),
            Scope::Task(id) => task_id == Some(*id),
        }
    }

    /// Queued tasks that `all tasks` hides while the queued group is collapsed.
    pub fn queued_hidden(&self) -> usize {
        match (&self.snapshot, self.queued_open, &self.scope) {
            (Some(snap), false, Scope::All) => current_tasks(snap)
                .iter()
                .filter(|t| t.is_open() && group_of(snap, t) == Group::Queued)
                .count(),
            _ => 0,
        }
    }

    /// The table rows after the explorer scope and the text filter.
    pub fn rows(&self) -> Vec<Row> {
        let Some(snap) = &self.snapshot else {
            return Vec::new();
        };
        let hide_queued = self.scope == Scope::All && !self.queued_open;
        let mut rows: Vec<Row> = build_rows(snap, &self.herdr, Utc::now())
            .into_iter()
            .filter(|r| !(hide_queued && r.group == Group::Queued))
            .filter(|r| match &self.scope {
                Scope::All => true,
                Scope::Group(g) => r.group == *g,
                Scope::Task(id) => r.task_id == *id,
            })
            .filter(|r| {
                self.matches(&[
                    &r.task, &r.seat, &r.stage, &r.state, &r.model, &r.gate, &r.now,
                ])
            })
            .collect();
        // A filtered group still names its task on its first visible row.
        let mut last_task = None;
        for r in &mut rows {
            r.first = last_task != Some(r.task_id);
            last_task = Some(r.task_id);
        }
        rows
    }

    pub fn summary(&self) -> Summary {
        match &self.snapshot {
            Some(snap) => summarize(&build_rows(snap, &self.herdr, Utc::now()), snap),
            None => Summary::default(),
        }
    }

    pub fn attention(&self) -> Vec<Attention> {
        match &self.snapshot {
            Some(snap) => attention(snap, &build_rows(snap, &self.herdr, Utc::now())),
            None => Vec::new(),
        }
    }

    pub fn recent(&self) -> Vec<&store::Event> {
        let Some(snap) = &self.snapshot else {
            return Vec::new();
        };
        snap.recent
            .iter()
            .filter(|e| self.in_scope(e.task_id))
            .filter(|e| {
                self.matches(&[
                    e.task_label(),
                    e.seat.as_deref().unwrap_or(""),
                    &e.kind,
                    e.summary.as_deref().unwrap_or(""),
                ])
            })
            .collect()
    }

    pub fn explorer(&self) -> Vec<ExplorerItem> {
        let mut items = vec![ExplorerItem {
            label: "all tasks".into(),
            depth: 0,
            scope: Scope::All,
            count: self.snapshot.as_ref().map(|s| s.seats.len()).unwrap_or(0),
        }];
        let Some(snap) = &self.snapshot else {
            return items;
        };
        let current: Vec<(&store::Task, Group)> = current_tasks(snap)
            .into_iter()
            .filter(|t| t.is_open())
            .map(|t| (t, group_of(snap, t)))
            .collect();
        for group in Group::ALL {
            let tasks: Vec<&store::Task> = current
                .iter()
                .filter(|(_, g)| *g == group)
                .map(|(t, _)| *t)
                .collect();
            if tasks.is_empty() {
                continue;
            }
            items.push(ExplorerItem {
                label: group.label().into(),
                depth: 1,
                scope: Scope::Group(group),
                count: tasks.len(),
            });
            if group == Group::Queued && !self.queued_open {
                continue;
            }
            for t in tasks {
                items.push(ExplorerItem {
                    label: t.label().to_string(),
                    depth: 2,
                    scope: Scope::Task(t.id),
                    count: t.active_seats as usize,
                });
            }
        }
        items
    }

    pub fn message_text(&self) -> Option<(&str, bool)> {
        match &self.message {
            Some((text, at, error)) if at.elapsed() < MESSAGE_TTL => Some((text, *error)),
            _ => None,
        }
    }

    fn say(&mut self, text: impl Into<String>, error: bool) {
        self.message = Some((text.into(), Instant::now(), error));
    }

    fn clamp(&mut self) {
        let rows = self.rows().len();
        self.table_sel = self.table_sel.min(rows.saturating_sub(1));
        let recent = self.recent().len();
        self.recent_sel = self.recent_sel.min(recent.saturating_sub(1));
        let items = self.explorer();
        self.explorer_sel = self.explorer_sel.min(items.len().saturating_sub(1));
        if let Some(item) = items.get(self.explorer_sel) {
            if item.scope != self.scope && self.focus == Focus::Explorer {
                self.scope = item.scope.clone();
            }
        }
    }

    fn step(&mut self, delta: isize) {
        let len = match self.focus {
            Focus::Explorer => self.explorer().len(),
            Focus::Main => match self.tab {
                Tab::Table => self.rows().len(),
                Tab::Recent => self.recent().len(),
                Tab::Health => return,
            },
        };
        let sel = match self.focus {
            Focus::Explorer => &mut self.explorer_sel,
            Focus::Main => match self.tab {
                Tab::Table => &mut self.table_sel,
                Tab::Recent => &mut self.recent_sel,
                Tab::Health => return,
            },
        };
        if len == 0 {
            *sel = 0;
            return;
        }
        let next = (*sel as isize + delta).clamp(0, len as isize - 1);
        *sel = next as usize;
        if self.focus == Focus::Explorer {
            if let Some(item) = self.explorer().get(self.explorer_sel) {
                self.scope = item.scope.clone();
            }
            self.table_sel = 0;
            self.recent_sel = 0;
        }
    }

    fn selected_task(&self) -> Option<i64> {
        match self.tab {
            Tab::Table => self.rows().get(self.table_sel).map(|r| r.task_id),
            Tab::Recent => self.recent().get(self.recent_sel).and_then(|e| e.task_id),
            Tab::Health => None,
        }
    }

    fn open_detail(&mut self) {
        let Some(task_id) = self.selected_task() else {
            self.say("no task on this row", true);
            return;
        };
        match store::detail_at(&self.db_path, task_id) {
            Ok(d) => self.detail = Some((d, 0)),
            Err(e) => self.say(format!("{e:#}"), true),
        }
    }

    /// `t`: the Herdr agent of the selected seat, else the task's workspace.
    pub fn focus_selected(&mut self) {
        let rows = self.rows();
        let target = match self.tab {
            Tab::Table => rows.get(self.table_sel).cloned(),
            Tab::Recent => {
                let event = self
                    .recent()
                    .get(self.recent_sel)
                    .map(|e| (e.run_id, e.task_id));
                event.and_then(|(run, task)| {
                    rows.iter()
                        .find(|r| run.is_some() && r.run_id == run)
                        .or_else(|| rows.iter().find(|r| Some(r.task_id) == task))
                        .cloned()
                })
            }
            Tab::Health => None,
        };
        let Some(row) = target else {
            self.say("no seat on this row", true);
            return;
        };
        match herdr::focus(
            &self.herdr_bin,
            row.herdr_agent.as_deref(),
            row.workspace.as_deref(),
        ) {
            Ok(done) => self.say(done, false),
            Err(e) => self.say(e.to_string(), true),
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) {
        if key.kind != KeyEventKind::Press {
            return;
        }
        if self.help {
            self.help = false;
            return;
        }
        if self.editing_filter {
            match key.code {
                KeyCode::Esc => {
                    self.filter.clear();
                    self.editing_filter = false;
                }
                KeyCode::Enter => self.editing_filter = false,
                KeyCode::Backspace => {
                    self.filter.pop();
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.filter.push(c)
                }
                _ => {}
            }
            self.table_sel = 0;
            self.recent_sel = 0;
            return;
        }
        if let Some((_, scroll)) = self.detail.as_mut() {
            match key.code {
                KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') => self.detail = None,
                KeyCode::Char('j') | KeyCode::Down => *scroll = scroll.saturating_add(1),
                KeyCode::Char('k') | KeyCode::Up => *scroll = scroll.saturating_sub(1),
                KeyCode::PageDown | KeyCode::Char(' ') => *scroll = scroll.saturating_add(10),
                KeyCode::PageUp => *scroll = scroll.saturating_sub(10),
                KeyCode::Char('t') => self.focus_selected(),
                _ => {}
            }
            return;
        }
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => self.quit = true,
            KeyCode::Char('?') => self.help = true,
            KeyCode::Char('1') => self.tab = Tab::Table,
            KeyCode::Char('2') => self.tab = Tab::Recent,
            KeyCode::Char('3') => self.tab = Tab::Health,
            KeyCode::Tab | KeyCode::BackTab | KeyCode::Left | KeyCode::Right => {
                self.focus = match self.focus {
                    Focus::Explorer => Focus::Main,
                    Focus::Main => Focus::Explorer,
                }
            }
            KeyCode::Char('/') => self.editing_filter = true,
            KeyCode::Esc => {
                if !self.filter.is_empty() {
                    self.filter.clear();
                } else {
                    self.scope = Scope::All;
                    self.explorer_sel = 0;
                }
            }
            KeyCode::Char('j') | KeyCode::Down => self.step(1),
            KeyCode::Char('k') | KeyCode::Up => self.step(-1),
            KeyCode::PageDown => self.step(10),
            KeyCode::PageUp => self.step(-10),
            KeyCode::Char('g') | KeyCode::Home => self.step(isize::MIN / 2),
            KeyCode::Char('G') | KeyCode::End => self.step(isize::MAX / 2),
            KeyCode::Enter => match self.focus {
                Focus::Explorer => self.focus = Focus::Main,
                Focus::Main => self.open_detail(),
            },
            KeyCode::Char('z') => {
                self.queued_open = !self.queued_open;
                self.table_sel = 0;
            }
            KeyCode::Char('t') => self.focus_selected(),
            _ => {}
        }
    }

    /// The `--once` report: summary and table as plain text.
    pub fn plain_report(&self) -> String {
        let mut out = String::new();
        if let Some(e) = &self.store_error {
            out.push_str(&format!("store: error: {e}\n"));
        }
        let Some(snap) = &self.snapshot else {
            out.push_str(&format!(
                "store: none at {} (run evf db migrate)\n",
                self.db_path.display()
            ));
            return out;
        };
        out.push_str(&format!(
            "store: {} (schema {})\nherdr: {}\n",
            self.db_path.display(),
            snap.schema_version,
            match &self.herdr.error {
                Some(e) => format!("error: {e}"),
                None => format!(
                    "{} agents, version {}",
                    self.herdr.agents.len(),
                    self.herdr.version.as_deref().unwrap_or("?")
                ),
            }
        ));
        out.push_str(&self.summary().line());
        out.push('\n');
        let rows = self.rows();
        out.push_str(&format!(
            "{:<14} {:<9} {:<26} {:<12} {:<6} {:<14} {:<5} {:<5} {:<10} NOW\n",
            "TASK", "STAGE", "SEAT", "MODEL", "EFFORT", "STATE", "ROUND", "PROOF", "GATE"
        ));
        for r in &rows {
            out.push_str(&format!(
                "{:<14} {:<9} {:<26} {:<12} {:<6} {:<14} {:<5} {:<5} {:<10} {}\n",
                if r.first {
                    crate::ui::task_cell(&r.task, r.extra)
                } else {
                    String::new()
                },
                r.stage,
                r.seat,
                r.model,
                r.effort,
                r.state,
                r.round,
                r.proof,
                r.gate,
                r.now
            ));
        }
        if self.queued_hidden() > 0 {
            out.push_str(&format!(
                "queued {} hidden (z opens them)\n",
                self.queued_hidden()
            ));
        }
        for a in self.attention() {
            out.push_str(&format!("needs you: {} -> {}\n", a.what, a.command));
        }
        out.push_str("explorer:\n");
        for item in self.explorer() {
            out.push_str(&format!(
                "  {}{} {}\n",
                "  ".repeat(item.depth as usize - item.depth.min(1) as usize),
                item.label,
                item.count
            ));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::tests::TempStore;
    use ratatui::crossterm::event::KeyEvent;

    fn now() -> DateTime<Utc> {
        timefmt::parse("2026-10-27T20:15:00Z").unwrap()
    }

    fn herdr_state() -> herdr::State {
        herdr::parse(crate::herdr::tests::SAMPLE).unwrap()
    }

    fn add_task(db: &rusqlite::Connection, slug: &str, status: &str, pr: Option<i64>) -> i64 {
        db.execute(
            "INSERT INTO tasks (slug, mode, ref, status, round, pr_number, created_at, updated_at) VALUES (?1, 'implement', upper(?1), ?2, 0, ?3, '2026-10-27T20:00:00.000Z', '2026-10-27T20:00:00.000Z')",
            rusqlite::params![slug, status, pr],
        )
        .unwrap();
        db.last_insert_rowid()
    }

    fn event(db: &rusqlite::Connection, task: i64, run: Option<i64>, kind: &str, ts: &str) {
        db.execute(
            "INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?1, ?2, ?3, ?4, '{}')",
            rusqlite::params![task, run, ts, kind],
        )
        .unwrap();
    }

    fn run(
        db: &rusqlite::Connection,
        task: i64,
        stage: &str,
        role: &str,
        session: Option<&str>,
        status: &str,
        started: &str,
    ) -> i64 {
        db.execute(
            "INSERT INTO runs (task_id, stage, role, round, session_id, status, started_at) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)",
            rusqlite::params![task, stage, role, session, status, started],
        )
        .unwrap();
        db.last_insert_rowid()
    }

    #[test]
    fn rows_join_seats_to_herdr_by_session_and_show_gates() {
        let store = TempStore::new();
        store.seed();
        let db = store.writer();
        db.execute(
            "INSERT INTO tasks (slug, mode, ref, status, round, created_at, updated_at) VALUES ('wp-200', 'prototype', 'WP-200', 'awaiting_pick', 0, '2026-10-27T19:00:00.000Z', '2026-10-27T19:30:00.000Z')",
            [],
        )
        .unwrap();
        db.execute(
            "INSERT INTO tasks (slug, mode, ref, status, round, pr_number, created_at, updated_at) VALUES ('wp-300', 'implement', 'WP-300', 'merged', 2, 12, '2026-10-27T18:00:00.000Z', '2026-10-27T18:30:00.000Z')",
            [],
        )
        .unwrap();
        let merged_task = db.last_insert_rowid();
        event(&db, merged_task, None, "merged", "2026-10-27T18:30:00.000Z");
        let snap = store::read(&store::open(&store.path).unwrap()).unwrap();
        let rows = build_rows(&snap, &herdr_state(), now());
        assert_eq!(
            rows.len(),
            3,
            "a task merged within a day shows as merged: {rows:?}"
        );
        let merged = rows.iter().find(|r| r.task == "WP-300").unwrap();
        assert_eq!(merged.state, "merged");
        assert_eq!(merged.gate, "PR #12");
        assert!(!merged.needs_you && !merged.working && merged.run_id.is_none());
        let seat = rows.iter().find(|r| r.run_id.is_some()).unwrap();
        assert_eq!(seat.task, "WP-101");
        assert_eq!(seat.seat, "implementer@WP-101");
        assert_eq!(seat.state, "working");
        assert_eq!(seat.model, "sonnet-5-5");
        assert_eq!(seat.round, "1/3");
        assert_eq!(seat.proof, "1/1");
        assert_eq!(seat.gate, "-");
        assert_eq!(seat.now, "implementer@WP-101 started in wA · 4m");
        assert_eq!(seat.herdr_agent.as_deref(), Some("implementer-wp-101"));
        assert_eq!(seat.workspace.as_deref(), Some("wA"));
        assert!(seat.working && !seat.needs_you);
        let pick = rows.iter().find(|r| r.task == "WP-200").unwrap();
        assert_eq!(pick.state, "needs pick");
        assert_eq!(pick.gate, "pick");
        assert!(pick.needs_you && pick.run_id.is_none());
        let summary = summarize(&rows, &snap);
        assert_eq!(
            summary.line(),
            "1 seats · 1 working · 1 needs you · 2 open tasks"
        );
        let needs = attention(&snap, &rows);
        assert_eq!(needs.len(), 1);
        assert!(needs[0].command.starts_with("evf task pick WP-200"));
    }

    #[test]
    fn merged_tasks_show_for_a_day_after_the_merge_event_and_never_count_as_open_or_needing_you() {
        let store = TempStore::new();
        let db = store.writer();
        // The test clock is 2026-10-27T20:15Z. Both rows were updated 15 minutes ago; only the merge time differs.
        let recent = add_task(&db, "wp-310", "merged", Some(7));
        event(&db, recent, None, "merged", "2026-10-27T19:15:00.000Z");
        let old = add_task(&db, "wp-311", "merged", Some(8));
        event(&db, old, None, "merged", "2026-10-24T20:15:00.000Z");
        add_task(&db, "wp-312", "merged", Some(9)); // no merged event: unknown time, hidden
        let snap = store::read(&store::open(&store.path).unwrap()).unwrap();
        let rows = build_rows(&snap, &herdr_state(), now());
        assert_eq!(rows.len(), 1, "merged 3 days ago is hidden: {rows:?}");
        assert_eq!(rows[0].task, "WP-310");
        assert_eq!(rows[0].state, "merged");
        assert_eq!(rows[0].gate, "PR #7");
        assert!(!rows[0].needs_you);
        let summary = summarize(&rows, &snap);
        assert_eq!((summary.needs_you, summary.open_tasks), (0, 0));
    }

    #[test]
    fn an_evf_run_never_shows_no_pane_and_a_seat_without_a_pane_does() {
        let store = TempStore::new();
        let db = store.writer();
        let ship = add_task(&db, "ops-85", "pr_open", Some(388));
        run(
            &db,
            ship,
            "ship",
            "evf",
            None,
            "started",
            "2026-10-27T20:10:00.000Z",
        );
        let verify = add_task(&db, "wp-400", "active", None);
        run(
            &db,
            verify,
            "verify",
            "verifier",
            Some("99999999-9999-4999-8999-999999999999"),
            "started",
            "2026-10-27T20:10:00.000Z",
        );
        let snap = store::read(&store::open(&store.path).unwrap()).unwrap();
        let rows = build_rows(&snap, &herdr_state(), now());
        let evf = rows.iter().find(|r| r.task == "OPS-85").unwrap();
        assert_eq!(evf.state, "evf ship");
        assert!(!evf.needs_you && !evf.working && evf.herdr_agent.is_none());
        assert_eq!(
            crate::ui::state_style_for_test(&evf.state),
            ratatui::style::Style::new()
        );
        let seat = rows.iter().find(|r| r.task == "WP-400").unwrap();
        assert_eq!(seat.state, "no pane");
        assert_eq!(
            crate::ui::state_style_for_test(&seat.state),
            ratatui::style::Style::new().fg(ratatui::style::Color::Red)
        );
        // Herdr down: an evf run still names its stage; the seat reads herdr?.
        let down = herdr::State {
            error: Some("herdr down".into()),
            ..Default::default()
        };
        let rows = build_rows(&snap, &down, now());
        assert_eq!(
            rows.iter().find(|r| r.task == "OPS-85").unwrap().state,
            "evf ship"
        );
        assert_eq!(
            rows.iter().find(|r| r.task == "WP-400").unwrap().state,
            "herdr?"
        );
    }

    #[test]
    fn a_ref_shows_once_as_its_latest_row_with_a_count_of_the_older_ones() {
        let store = TempStore::new();
        let db = store.writer();
        let first = add_task(&db, "wp-097", "merged", Some(386));
        event(&db, first, None, "merged", "2026-10-26T10:00:00.000Z");
        let second = add_task(&db, "wp-097", "merged", Some(394));
        event(&db, second, None, "merged", "2026-10-27T19:00:00.000Z");
        let third = add_task(&db, "wp-097", "escalated", None);
        let ghost = add_task(&db, "wp-097", "abandoned", None);
        assert!(ghost > third);
        let snap = store::read(&store::open(&store.path).unwrap()).unwrap();
        let rows = build_rows(&snap, &herdr_state(), now());
        assert_eq!(rows.len(), 1, "{rows:?}");
        assert_eq!(rows[0].task_id, third);
        assert_eq!(rows[0].state, "escalated");
        assert_eq!(rows[0].extra, 2);
        assert_eq!(
            crate::ui::task_cell(&rows[0].task, rows[0].extra),
            "WP-097 +2"
        );
        assert_eq!(summarize(&rows, &snap).open_tasks, 1);
        // The detail lists the other rows, newest first, with their PR and merge time.
        let detail = store::detail(&store::open(&store.path).unwrap(), third).unwrap();
        assert_eq!(
            detail
                .older
                .iter()
                .map(|o| (o.id, o.status.as_str(), o.pr_number, o.merged_at.is_some()))
                .collect::<Vec<_>>(),
            [
                (second, "merged", Some(394), true),
                (first, "merged", Some(386), true)
            ]
        );
    }

    #[test]
    fn a_task_held_for_the_owner_shows_awaiting_owner_and_needs_you() {
        let store = TempStore::new();
        let db = store.writer();
        // Trigger 1: the drive recorded the owner-approval wait.
        let wait = add_task(&db, "ops-85", "pr_open", Some(388));
        run(
            &db,
            wait,
            "ship",
            "evf",
            None,
            "passed",
            "2026-10-27T20:00:00.000Z",
        );
        event(
            &db,
            wait,
            None,
            "owner_approval_wait",
            "2026-10-27T20:01:00.000Z",
        );
        // Trigger 2: the drive stopped inside ship.
        let held = add_task(&db, "ops-86", "pr_open", Some(389));
        let r = run(
            &db,
            held,
            "ship",
            "evf",
            None,
            "aborted",
            "2026-10-27T20:00:00.000Z",
        );
        event(
            &db,
            held,
            Some(r),
            "drive_stopped",
            "2026-10-27T20:01:00.000Z",
        );
        // A drive stopped inside ci, and a PR whose latest event is a passed ci, are not held.
        let ci = add_task(&db, "ops-87", "pr_open", Some(390));
        let r = run(
            &db,
            ci,
            "ci",
            "evf",
            None,
            "aborted",
            "2026-10-27T20:00:00.000Z",
        );
        event(
            &db,
            ci,
            Some(r),
            "drive_stopped",
            "2026-10-27T20:01:00.000Z",
        );
        let passed = add_task(&db, "ops-88", "pr_open", Some(391));
        let r = run(
            &db,
            passed,
            "ci",
            "evf",
            None,
            "passed",
            "2026-10-27T20:00:00.000Z",
        );
        event(
            &db,
            passed,
            Some(r),
            "stage_end",
            "2026-10-27T20:01:00.000Z",
        );
        let snap = store::read(&store::open(&store.path).unwrap()).unwrap();
        let rows = build_rows(&snap, &herdr_state(), now());
        let row = |t: &str| rows.iter().find(|r| r.task == t).unwrap();
        for (task, pr) in [("OPS-85", "PR #388"), ("OPS-86", "PR #389")] {
            assert_eq!(row(task).state, "awaiting owner", "{task}");
            assert_eq!(row(task).gate, pr);
            assert!(row(task).needs_you);
        }
        assert_eq!(row("OPS-87").state, "pr open");
        assert_eq!(row("OPS-88").state, "pr open");
        assert!(!row("OPS-87").needs_you && !row("OPS-88").needs_you);
        assert_eq!(summarize(&rows, &snap).needs_you, 2);
        assert_eq!(
            crate::ui::state_style_for_test("awaiting owner"),
            ratatui::style::Style::new()
                .fg(ratatui::style::Color::Yellow)
                .add_modifier(ratatui::style::Modifier::BOLD)
        );
        let needs = attention(&snap, &rows);
        assert_eq!(needs.len(), 2);
        assert!(needs
            .iter()
            .any(|n| n.command == "evf approve 388 --owner-approval \"<his words>\""));
        // A verifier seat still working on the PR means it is not held.
        run(
            &db,
            wait,
            "verify",
            "verifier",
            None,
            "started",
            "2026-10-27T20:05:00.000Z",
        );
        let snap = store::read(&store::open(&store.path).unwrap()).unwrap();
        let rows = build_rows(&snap, &herdr_state(), now());
        assert!(rows
            .iter()
            .filter(|r| r.task == "OPS-85")
            .all(|r| r.state != "awaiting owner"));
    }

    fn loaded(db_path: &std::path::Path) -> App {
        let mut app = App::new(db_path.to_path_buf(), "/nonexistent/herdr".into());
        let mut reader = store::Reader::new(db_path.to_path_buf());
        app.handle(Msg::Store(reader.poll().unwrap()));
        app.handle(Msg::Herdr(herdr_state()));
        app
    }

    #[test]
    fn the_explorer_groups_current_tasks_by_stage_in_order_and_filters_the_table() {
        let store = TempStore::new();
        let db = store.writer();
        let impl_t = add_task(&db, "wp-501", "active", None);
        run(
            &db,
            impl_t,
            "implement",
            "implementer",
            None,
            "passed",
            "2026-10-27T19:00:00.000Z",
        );
        let verify_t = add_task(&db, "wp-502", "pr_open", Some(12));
        run(
            &db,
            verify_t,
            "verify",
            "verifier",
            None,
            "passed",
            "2026-10-27T19:00:00.000Z",
        );
        let held = add_task(&db, "wp-503", "pr_open", Some(13));
        run(
            &db,
            held,
            "ship",
            "evf",
            None,
            "passed",
            "2026-10-27T19:00:00.000Z",
        );
        event(
            &db,
            held,
            None,
            "owner_approval_wait",
            "2026-10-27T19:05:00.000Z",
        );
        let queued = add_task(&db, "wp-504", "new", None);
        add_task(&db, "wp-504", "new", None); // a second row of the same ref adds no task
        let merged = add_task(&db, "wp-505", "merged", Some(14));
        event(&db, merged, None, "merged", "2026-10-27T19:30:00.000Z");
        let mut app = loaded(&store.path);
        app.queued_open = true;
        let labels: Vec<(String, usize)> = app
            .explorer()
            .into_iter()
            .filter(|i| i.depth == 1)
            .map(|i| (i.label, i.count))
            .collect();
        assert_eq!(
            labels,
            [
                ("queued".to_string(), 1),
                ("implement".to_string(), 1),
                ("verify".to_string(), 1),
                ("awaiting owner".to_string(), 1)
            ],
            "empty groups and merged tasks are absent"
        );
        let _ = queued;
        app.scope = Scope::Group(Group::Verify);
        assert_eq!(
            app.rows()
                .iter()
                .map(|r| r.task.as_str())
                .collect::<Vec<_>>(),
            ["WP-502"]
        );
        app.scope = Scope::Group(Group::AwaitingOwner);
        assert_eq!(app.rows()[0].task, "WP-503");
        app.scope = Scope::All;
        // rows() reads the real clock, where the merge of 2026-10-27 is older than a day: only the open tasks show.
        assert_eq!(app.rows().len(), 4);
    }

    #[test]
    fn the_queued_group_is_collapsed_by_default_and_z_toggles_it() {
        let store = TempStore::new();
        let db = store.writer();
        let active = add_task(&db, "wp-601", "active", None);
        run(
            &db,
            active,
            "implement",
            "implementer",
            None,
            "passed",
            "2026-10-27T19:00:00.000Z",
        );
        for slug in ["ops-86", "ops-87", "ops-88"] {
            add_task(&db, slug, "new", None);
        }
        let mut app = loaded(&store.path);
        assert!(!app.queued_open, "collapsed by default");
        assert_eq!(app.rows().len(), 1, "queued rows hide under all tasks");
        assert_eq!(app.queued_hidden(), 3);
        let labels = |app: &App| {
            app.explorer()
                .into_iter()
                .map(|i| i.label)
                .collect::<Vec<_>>()
        };
        assert_eq!(labels(&app), ["all tasks", "queued", "implement", "WP-601"]);
        let z = Msg::Input(Event::Key(KeyEvent::from(KeyCode::Char('z'))));
        app.handle(z);
        assert!(app.queued_open);
        assert_eq!(app.rows().len(), 4);
        assert_eq!(app.queued_hidden(), 0);
        assert!(labels(&app).contains(&"OPS-86".to_string()));
        app.handle(Msg::Input(Event::Key(KeyEvent::from(KeyCode::Char('z')))));
        assert_eq!(app.rows().len(), 1);
        assert!(app.plain_report().contains("queued 3 hidden"));
    }

    #[test]
    fn a_blocked_event_shows_only_while_herdr_says_the_seat_is_blocked() {
        let store = TempStore::new();
        let (task_id, _) = store.seed();
        let db = store.writer();
        db.execute(
            "INSERT INTO runs (task_id, stage, role, model, effort, round, herdr_agent, session_id, status, started_at) VALUES (?1, 'verify', 'verifier', 'claude-opus-5-5', 'high', 1, 'verifier-wp-102', '22222222-2222-4222-8222-222222222222', 'started', '2026-10-27T20:12:00.000Z')",
            [task_id],
        )
        .unwrap();
        let run_id = db.last_insert_rowid();
        db.execute(
            "INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?1, ?2, '2026-10-27T20:13:00.000Z', 'blocked', '{\"summary\":\"verifier-wp-102 is blocked on a prompt\"}')",
            rusqlite::params![task_id, run_id],
        )
        .unwrap();
        let snap = store::read(&store::open(&store.path).unwrap()).unwrap();
        let row = |state: &herdr::State| {
            build_rows(&snap, state, now())
                .into_iter()
                .find(|r| r.herdr_agent.as_deref() == Some("verifier-wp-102"))
                .unwrap()
        };
        // Herdr still says blocked: the summary and needs_you stay.
        let blocked = row(&herdr_state());
        assert!(blocked
            .now
            .starts_with("verifier-wp-102 is blocked on a prompt"));
        assert!(blocked.needs_you);
        // The prompt is gone and the seat works: no blocked text, no needs_you.
        let mut state = herdr_state();
        for a in &mut state.agents {
            if a.name == "verifier-wp-102" {
                a.status = "working".into();
            }
        }
        let working = row(&state);
        assert!(!working.now.contains("blocked"), "{}", working.now);
        assert!(working.now.starts_with("working"));
        assert!(!working.needs_you && working.working);
    }

    #[test]
    fn a_seat_without_a_pane_and_a_blocked_seat_are_named() {
        let store = TempStore::new();
        let (task_id, _) = store.seed();
        let db = store.writer();
        db.execute(
            "INSERT INTO runs (task_id, stage, role, model, effort, round, herdr_agent, session_id, status, started_at) VALUES (?1, 'verify', 'verifier', 'claude-opus-5-5', 'high', 1, 'verifier-wp-102', '22222222-2222-4222-8222-222222222222', 'started', '2026-10-27T20:12:00.000Z')",
            [task_id],
        )
        .unwrap();
        db.execute(
            "INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?1, 'simplify', 'simplifier', 1, 'started', '2026-10-27T20:13:00.000Z')",
            [task_id],
        )
        .unwrap();
        let snap = store::read(&store::open(&store.path).unwrap()).unwrap();
        let rows = build_rows(&snap, &herdr_state(), now());
        assert_eq!(rows.len(), 3);
        assert!(rows[0].first && !rows[1].first && !rows[2].first);
        assert_eq!(rows[1].state, "blocked");
        assert!(rows[1].needs_you);
        assert_eq!(rows[2].state, "no pane");
        assert_eq!(rows[2].now, "started · 2m");
        let unreachable = herdr::State {
            error: Some("herdr down".into()),
            ..Default::default()
        };
        assert_eq!(build_rows(&snap, &unreachable, now())[0].state, "herdr?");
        assert_eq!(summarize(&rows, &snap).needs_you, 1);
        let needs = attention(&snap, &rows);
        assert_eq!(needs[0].command, "herdr agent focus verifier-wp-102");
    }

    #[test]
    fn keys_move_filter_and_scope() {
        let store = TempStore::new();
        store.seed();
        let db = store.writer();
        db.execute(
            "INSERT INTO tasks (slug, mode, ref, status, round, created_at, updated_at) VALUES ('wp-200', 'prototype', 'WP-200', 'awaiting_pick', 0, '2026-10-27T19:00:00.000Z', '2026-10-27T19:30:00.000Z')",
            [],
        )
        .unwrap();
        let mut app = App::new(store.path.clone(), "/nonexistent/herdr".into());
        let mut reader = store::Reader::new(store.path.clone());
        app.handle(Msg::Store(reader.poll().unwrap()));
        app.handle(Msg::Herdr(herdr_state()));
        assert_eq!(app.rows().len(), 2);
        let press = |c: char| Msg::Input(Event::Key(KeyEvent::from(KeyCode::Char(c))));
        app.handle(press('j'));
        assert_eq!(app.table_sel, 1);
        app.handle(press('j'));
        assert_eq!(app.table_sel, 1, "clamped at the last row");
        app.handle(Msg::Input(Event::Key(KeyEvent::from(KeyCode::Enter))));
        assert_eq!(
            app.detail.as_ref().unwrap().0.task_id,
            app.rows()[1].task_id
        );
        app.handle(Msg::Input(Event::Key(KeyEvent::from(KeyCode::Esc))));
        assert!(app.detail.is_none());
        app.handle(press('/'));
        for c in "pick".chars() {
            app.handle(press(c));
        }
        app.handle(Msg::Input(Event::Key(KeyEvent::from(KeyCode::Enter))));
        assert_eq!(app.rows().len(), 1);
        assert_eq!(app.rows()[0].task, "WP-200");
        app.handle(Msg::Input(Event::Key(KeyEvent::from(KeyCode::Esc))));
        assert_eq!(app.rows().len(), 2);
        app.handle(Msg::Input(Event::Key(KeyEvent::from(KeyCode::Tab))));
        assert_eq!(app.focus, Focus::Explorer);
        let items = app.explorer();
        assert_eq!(
            items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(),
            ["all tasks", "implement", "WP-101", "needs pick", "WP-200"]
        );
        app.handle(press('j'));
        assert_eq!(app.scope, Scope::Group(Group::Implement));
        assert_eq!(app.rows().len(), 1);
        app.handle(press('j'));
        app.handle(press('j'));
        app.handle(press('j'));
        assert_eq!(app.scope, Scope::Task(app.rows()[0].task_id));
        assert_eq!(app.rows()[0].task, "WP-200");
        assert_eq!(app.recent().len(), 0, "the feed follows the scope");
        app.handle(press('2'));
        assert_eq!(app.tab, Tab::Recent);
        app.handle(press('t'));
        assert!(
            app.message_text().unwrap().1,
            "focus without herdr reports an error"
        );
        app.handle(press('?'));
        assert!(app.help);
        app.handle(press('q'));
        assert!(!app.help && !app.quit, "the first key closes help");
        app.handle(press('q'));
        assert!(app.quit);
        let report = app.plain_report();
        assert!(
            report.contains("1 seats · 1 working · 1 needs you · 2 open tasks"),
            "{report}"
        );
        assert!(
            report.contains("needs you: WP-200 waits for the prototype pick"),
            "{report}"
        );
    }

    #[test]
    fn store_messages_replace_errors_and_herdr_errors_keep_agents() {
        let mut app = App::new(PathBuf::from("/nonexistent/work.sqlite"), "herdr".into());
        assert!(!app.store_known);
        app.handle(Msg::Store(Ok(None)));
        assert!(app.store_known && app.snapshot.is_none());
        assert!(app.plain_report().contains("store: none at"));
        app.handle(Msg::Store(Err("boom".into())));
        assert_eq!(app.store_error.as_deref(), Some("boom"));
        app.handle(Msg::Herdr(herdr_state()));
        assert_eq!(app.herdr.agents.len(), 3);
        app.handle(Msg::Herdr(herdr::State {
            error: Some("down".into()),
            ..Default::default()
        }));
        assert_eq!(app.herdr.agents.len(), 3, "the last good agents stay");
        assert_eq!(app.herdr.error.as_deref(), Some("down"));
        app.handle(Msg::Herdr(herdr_state()));
        assert!(app.herdr.error.is_none());
    }
}
