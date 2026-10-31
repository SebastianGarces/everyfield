//! Drawing. Layout after the OpenRig reference: explorer left, tabs right, summary line and key footer at the bottom,
//! detail and help as overlays.

use crate::app::{App, Attention, Focus, Tab};
use crate::{git, timefmt};
use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{
    Block, Cell, Clear, List, ListItem, ListState, Paragraph, Row as TableRow, Table, TableState,
    Tabs, Wrap,
};
use ratatui::Frame;

const DIM: Style = Style::new().fg(Color::DarkGray);
const ACCENT: Style = Style::new().fg(Color::Cyan);
const WARN: Style = Style::new().fg(Color::Yellow);
const BAD: Style = Style::new().fg(Color::Red);
const GOOD: Style = Style::new().fg(Color::Green);

pub fn draw(frame: &mut Frame, app: &mut App) {
    let [header, body, summary, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(frame.area());
    draw_header(frame, header, app);
    let [left, right] =
        Layout::horizontal([Constraint::Length(28), Constraint::Fill(1)]).areas(body);
    draw_explorer(frame, left, app);
    match app.tab {
        Tab::Table => draw_table(frame, right, app),
        Tab::Recent => draw_recent(frame, right, app),
        Tab::Health => draw_health(frame, right, app),
    }
    draw_summary(frame, summary, app);
    draw_footer(frame, footer, app);
    if app.detail.is_some() {
        draw_detail(frame, frame.area(), app);
    }
    if app.help {
        draw_help(frame, frame.area());
    }
}

fn state_style(state: &str) -> Style {
    match state {
        "working" => GOOD,
        "blocked" | "escalated" | "needs pick" | "awaiting owner" => {
            WARN.add_modifier(Modifier::BOLD)
        }
        "idle" | "done" | "merged" => DIM,
        "no pane" | "herdr?" => BAD,
        _ => Style::new(),
    }
}

#[cfg(test)]
pub fn state_style_for_test(state: &str) -> Style {
    state_style(state)
}

fn draw_header(frame: &mut Frame, area: Rect, app: &App) {
    let tabs = Tabs::new(
        Tab::ALL
            .iter()
            .map(|t| Line::from(t.title()))
            .collect::<Vec<_>>(),
    )
    .select(app.tab.index())
    .highlight_style(ACCENT.add_modifier(Modifier::BOLD))
    .style(DIM)
    .divider(" ");
    let [tabs_area, right] =
        Layout::horizontal([Constraint::Length(34), Constraint::Fill(1)]).areas(area);
    frame.render_widget(tabs, tabs_area);
    let mut spans = vec![
        Span::styled("evf tui", Style::new().bold()),
        Span::styled(" · ", DIM),
    ];
    match (&app.store_error, &app.snapshot, app.store_known) {
        (Some(e), _, _) => spans.push(Span::styled(format!("store error: {e}"), BAD)),
        (None, Some(s), _) => spans.push(Span::styled(
            format!("store schema {}", s.schema_version),
            DIM,
        )),
        (None, None, true) => spans.push(Span::styled("no store yet (evf db migrate)", WARN)),
        (None, None, false) => spans.push(Span::styled("opening store…", DIM)),
    }
    spans.push(Span::styled(" · ", DIM));
    match (&app.herdr.error, app.herdr_at) {
        (Some(e), _) => spans.push(Span::styled(format!("herdr: {e}"), BAD)),
        (None, None) => spans.push(Span::styled("herdr…", DIM)),
        (None, Some(_)) => spans.push(Span::styled(
            format!("herdr {} agents", app.herdr.agents.len()),
            DIM,
        )),
    }
    let hidden = app.queued_hidden();
    if hidden > 0 {
        spans.push(Span::styled(" · ", DIM));
        spans.push(Span::styled(format!("queued {hidden} hidden"), WARN));
    }
    if !app.filter.is_empty() || app.editing_filter {
        spans.push(Span::styled(" · /", DIM));
        spans.push(Span::styled(
            format!(
                "{}{}",
                app.filter,
                if app.editing_filter { "_" } else { "" }
            ),
            WARN,
        ));
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).alignment(Alignment::Right),
        right,
    );
}

fn draw_explorer(frame: &mut Frame, area: Rect, app: &App) {
    let items = app.explorer();
    let width = area.width.saturating_sub(4) as usize;
    let list_items: Vec<ListItem> = items
        .iter()
        .map(|item| {
            let indent = "  ".repeat(item.depth as usize);
            let count = if item.count > 0 {
                item.count.to_string()
            } else {
                String::new()
            };
            let label_width = width.saturating_sub(indent.len() + count.len() + 1);
            let label: String = item.label.chars().take(label_width).collect();
            let pad = label_width.saturating_sub(label.chars().count());
            ListItem::new(Line::from(vec![
                Span::styled(indent, DIM),
                Span::styled(
                    label,
                    if item.depth == 2 {
                        Style::new()
                    } else {
                        Style::new().bold()
                    },
                ),
                Span::raw(" ".repeat(pad + 1)),
                Span::styled(count, GOOD),
            ]))
        })
        .collect();
    let focused = app.focus == Focus::Explorer;
    let block = Block::bordered()
        .title(Span::styled(
            " EXPLORER ",
            if focused { ACCENT.bold() } else { DIM },
        ))
        .border_style(if focused { ACCENT } else { DIM });
    let list = List::new(list_items)
        .block(block)
        .highlight_style(if focused {
            Style::new().add_modifier(Modifier::REVERSED)
        } else {
            Style::new().add_modifier(Modifier::BOLD)
        });
    let mut state = ListState::default().with_selected(Some(app.explorer_sel));
    frame.render_stateful_widget(list, area, &mut state);
}

/// The task label, with `+N` when N older rows of the same ref sit behind it.
pub fn task_cell(task: &str, extra: usize) -> String {
    if extra > 0 {
        format!("{task} +{extra}")
    } else {
        task.to_string()
    }
}

fn main_block(title: &str, focused: bool) -> Block<'static> {
    Block::bordered()
        .title(Span::styled(
            format!(" {title} "),
            if focused { ACCENT.bold() } else { DIM },
        ))
        .border_style(if focused { ACCENT } else { DIM })
}

fn draw_table(frame: &mut Frame, area: Rect, app: &App) {
    let rows = app.rows();
    let focused = app.focus == Focus::Main;
    let block = main_block(&format!("TABLE · {} rows", rows.len()), focused);
    if rows.is_empty() {
        let text = match (&app.snapshot, app.store_known) {
            (None, false) => "Opening the store…".to_string(),
            (None, true) => format!(
                "No work store at {}. Run evf db migrate.",
                app.db_path.display()
            ),
            (Some(_), _) if !app.filter.is_empty() => {
                "No row matches the filter. Esc clears it.".into()
            }
            (Some(_), _) => "No open tasks and no running seats. evf task new … starts one.".into(),
        };
        frame.render_widget(Paragraph::new(text).style(DIM).block(block), area);
        return;
    }
    let header = TableRow::new(
        [
            "TASK", "STAGE", "SEAT", "MODEL", "EFFORT", "STATE", "ROUND", "PROOF", "GATE", "NOW",
            "",
        ]
        .into_iter()
        .map(|h| Cell::from(Span::styled(h, Style::new().bold().fg(Color::Blue)))),
    );
    let table_rows: Vec<TableRow> = rows
        .iter()
        .map(|r| {
            let base = if r.needs_you { WARN } else { Style::new() };
            let term = if r.run_id.is_some() && r.herdr_agent.is_some() {
                Span::styled("term ▸", ACCENT.bold())
            } else if r.workspace.is_some() {
                Span::styled("ws ▸", ACCENT)
            } else {
                Span::styled("-", DIM)
            };
            TableRow::new(vec![
                Cell::from(Span::styled(
                    if r.first {
                        task_cell(&r.task, r.extra)
                    } else {
                        String::new()
                    },
                    Style::new().bold(),
                )),
                Cell::from(r.stage.clone()),
                Cell::from(r.seat.clone()),
                Cell::from(r.model.clone()),
                Cell::from(r.effort.clone()),
                Cell::from(Span::styled(r.state.clone(), state_style(&r.state))),
                Cell::from(r.round.clone()),
                Cell::from(r.proof.clone()),
                Cell::from(Span::styled(
                    r.gate.clone(),
                    if r.gate == "-" { DIM } else { WARN },
                )),
                Cell::from(Span::styled(
                    r.now.clone(),
                    if r.run_id.is_some() {
                        Style::new()
                    } else {
                        DIM
                    },
                )),
                Cell::from(term),
            ])
            .style(base)
        })
        .collect();
    let table = Table::new(
        table_rows,
        [
            Constraint::Length(14),
            Constraint::Length(9),
            Constraint::Length(26),
            Constraint::Length(12),
            Constraint::Length(6),
            Constraint::Length(14),
            Constraint::Length(5),
            Constraint::Length(5),
            Constraint::Length(10),
            Constraint::Fill(1),
            Constraint::Length(6),
        ],
    )
    .header(header)
    .column_spacing(1)
    .block(block)
    .row_highlight_style(if focused {
        Style::new().add_modifier(Modifier::REVERSED)
    } else {
        Style::new().add_modifier(Modifier::BOLD)
    });
    let mut state = TableState::default().with_selected(Some(app.table_sel));
    frame.render_stateful_widget(table, area, &mut state);
}

fn draw_recent(frame: &mut Frame, area: Rect, app: &App) {
    let events = app.recent();
    let focused = app.focus == Focus::Main;
    let block = main_block(
        &format!("RECENT · newest first · {} events · ET", events.len()),
        focused,
    );
    if events.is_empty() {
        frame.render_widget(
            Paragraph::new("No events yet.").style(DIM).block(block),
            area,
        );
        return;
    }
    let items: Vec<ListItem> = events
        .iter()
        .map(|e| {
            let who = e.seat.clone().unwrap_or_else(|| e.task_label().to_string());
            ListItem::new(Line::from(vec![
                Span::styled(timefmt::clock_et(&e.ts), ACCENT),
                Span::raw(" "),
                Span::styled(format!("{who:<26}"), Style::new().bold()),
                Span::raw(" "),
                Span::styled(format!("{:<16}", e.kind), kind_style(&e.kind)),
                Span::raw(" "),
                Span::raw(e.summary.clone().unwrap_or_default()),
            ]))
        })
        .collect();
    let list = List::new(items).block(block).highlight_style(if focused {
        Style::new().add_modifier(Modifier::REVERSED)
    } else {
        Style::new().add_modifier(Modifier::BOLD)
    });
    let mut state = ListState::default().with_selected(Some(app.recent_sel));
    frame.render_stateful_widget(list, area, &mut state);
}

fn kind_style(kind: &str) -> Style {
    match kind {
        "loop_cap_hit" | "escalation" | "stop_blocked" => BAD.bold(),
        "stage_end" | "check_result" => WARN,
        "stage_start" | "prompt_sent" => GOOD,
        _ => DIM,
    }
}

fn draw_health(frame: &mut Frame, area: Rect, app: &App) {
    let block = main_block("HEALTH", app.focus == Focus::Main);
    let mut lines: Vec<Line> = Vec::new();
    match &app.snapshot {
        None => lines.push(Line::from(Span::styled("No store yet.", DIM))),
        Some(snap) => {
            let h = &snap.health;
            lines.push(Line::from(vec![
                Span::styled("open tasks ", DIM),
                Span::raw(h.open_tasks.to_string()),
                Span::styled("   escalated ", DIM),
                Span::styled(
                    h.escalated_tasks.to_string(),
                    if h.escalated_tasks > 0 {
                        WARN
                    } else {
                        Style::new()
                    },
                ),
                Span::styled("   active seats ", DIM),
                Span::raw(h.active_seats.to_string()),
            ]));
            lines.push(Line::from(vec![
                Span::styled("merged 24 h ", DIM),
                Span::raw(h.merged_24h.to_string()),
                Span::styled("   merged 7 d ", DIM),
                Span::raw(h.merged_7d.to_string()),
                Span::styled("   rounds per merge 7 d ", DIM),
                Span::raw(
                    h.rounds_per_merge_7d
                        .map(|r| format!("{r:.2}"))
                        .unwrap_or_else(|| "-".into()),
                ),
            ]));
            lines.push(Line::default());
            let needs = app.attention();
            lines.push(Line::from(Span::styled(
                format!("needs you ({})", needs.len()),
                if needs.is_empty() { DIM } else { WARN.bold() },
            )));
            for Attention { what, command } in &needs {
                lines.push(Line::from(vec![Span::raw("  "), Span::raw(what.clone())]));
                lines.push(Line::from(vec![
                    Span::raw("    "),
                    Span::styled(command.clone(), ACCENT),
                ]));
            }
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                "The counters come from v_health. The busywork signal (evf health, rail 4) is not built yet.",
                DIM,
            )));
        }
    }
    lines.push(Line::default());
    lines.push(Line::from(vec![
        Span::styled("store   ", DIM),
        Span::raw(app.db_path.display().to_string()),
    ]));
    lines.push(Line::from(vec![
        Span::styled("herdr   ", DIM),
        Span::raw(match (&app.herdr.error, &app.herdr.version) {
            (Some(e), _) => e.clone(),
            (None, Some(v)) => format!("{v}, {} agents", app.herdr.agents.len()),
            (None, None) => "waiting for the first snapshot".into(),
        }),
    ]));
    lines.push(Line::from(vec![
        Span::styled("git     ", DIM),
        Span::raw(format!("{} worktrees", app.worktrees.len())),
    ]));
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .block(block),
        area,
    );
}

fn draw_summary(frame: &mut Frame, area: Rect, app: &App) {
    let s = app.summary();
    let mut spans = vec![
        Span::raw(format!(" {} seats · ", s.seats)),
        Span::styled(
            format!("{} working", s.working),
            if s.working > 0 { GOOD } else { Style::new() },
        ),
        Span::raw(" · "),
        Span::styled(
            format!("{} needs you", s.needs_you),
            if s.needs_you > 0 {
                WARN.bold()
            } else {
                Style::new()
            },
        ),
        Span::raw(format!(" · {} open tasks", s.open_tasks)),
    ];
    if let Some(at) = app.store_at {
        spans.push(Span::styled(
            format!(" · store {}s ago", at.elapsed().as_secs()),
            DIM,
        ));
    }
    if let Some((text, error)) = app.message_text() {
        spans.push(Span::raw("  "));
        spans.push(Span::styled(
            text.to_string(),
            if error { BAD } else { GOOD },
        ));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn draw_footer(frame: &mut Frame, area: Rect, app: &App) {
    let text = if app.editing_filter {
        " type to filter · Enter keep · Esc clear".to_string()
    } else if app.detail.is_some() {
        " j/k scroll · t term · Esc close".to_string()
    } else {
        " ↑↓/jk move · Tab pane · Enter detail · 1-3 tabs · / filter · z queued · t term · ? help · q quit"
            .to_string()
    };
    frame.render_widget(Paragraph::new(text).style(DIM), area);
}

fn centered(area: Rect, width_pct: u16, height_pct: u16) -> Rect {
    let [_, middle, _] = Layout::vertical([
        Constraint::Percentage((100 - height_pct) / 2),
        Constraint::Percentage(height_pct),
        Constraint::Percentage((100 - height_pct) / 2),
    ])
    .areas(area);
    let [_, center, _] = Layout::horizontal([
        Constraint::Percentage((100 - width_pct) / 2),
        Constraint::Percentage(width_pct),
        Constraint::Percentage((100 - width_pct) / 2),
    ])
    .areas(middle);
    center
}

fn draw_detail(frame: &mut Frame, area: Rect, app: &App) {
    let Some((detail, scroll)) = &app.detail else {
        return;
    };
    let task = app.snapshot.as_ref().and_then(|s| s.task(detail.task_id));
    let title = match task {
        Some(t) => format!(
            " {} · {} · {} ",
            t.label(),
            t.status,
            t.stage.as_deref().unwrap_or("-")
        ),
        None => format!(" task {} ", detail.task_id),
    };
    let mut lines: Vec<Line> = Vec::new();
    if let Some(t) = task {
        if !t.title.is_empty() {
            lines.push(Line::from(Span::styled(
                t.title.clone(),
                Style::new().bold(),
            )));
        }
        lines.push(Line::from(vec![
            Span::styled("mode ", DIM),
            Span::raw(t.mode.clone()),
            Span::styled("  round ", DIM),
            Span::raw(format!("{}/{}", t.round, crate::app::LOOP_CAP)),
            Span::styled("  proof ", DIM),
            Span::raw(format!("{}/{}", t.proofs_met, t.proofs_total)),
            Span::styled("  PR ", DIM),
            Span::raw(
                t.pr_number
                    .map(|n| format!("#{n}"))
                    .unwrap_or_else(|| "-".into()),
            ),
            Span::styled("  goal ", DIM),
            Span::raw(t.goal_key.clone().unwrap_or_else(|| "-".into())),
        ]));
        let head = t
            .worktree
            .as_deref()
            .and_then(|w| git::head_for(&app.worktrees, w))
            .map(|w| w.head.chars().take(8).collect::<String>());
        lines.push(Line::from(vec![
            Span::styled("branch ", DIM),
            Span::raw(t.branch.clone().unwrap_or_else(|| "-".into())),
            Span::styled("  head ", DIM),
            Span::raw(head.unwrap_or_else(|| "-".into())),
            Span::styled("  workspace ", DIM),
            Span::raw(match &t.herdr_workspace_id {
                Some(id) => match app.herdr.workspace(id) {
                    Some(w) => format!("{id} ({})", w.label),
                    None => id.clone(),
                },
                None => "-".into(),
            }),
        ]));
        if let Some(w) = &t.worktree {
            lines.push(Line::from(vec![
                Span::styled("worktree ", DIM),
                Span::raw(w.clone()),
            ]));
        }
        lines.push(Line::from(vec![
            Span::styled("updated ", DIM),
            Span::raw(timefmt::stamp_et(&t.updated_at)),
        ]));
    }
    if !detail.older.is_empty() {
        lines.push(Line::default());
        lines.push(Line::from(Span::styled(
            format!("OLDER ROWS OF THIS REF ({})", detail.older.len()),
            Style::new().bold().fg(Color::Blue),
        )));
        for o in &detail.older {
            lines.push(Line::from(vec![
                Span::raw(format!("  row {:<5} ", o.id)),
                Span::raw(format!("{:<10} ", o.status)),
                Span::raw(format!(
                    "{:<8} ",
                    o.pr_number
                        .map(|n| format!("#{n}"))
                        .unwrap_or_else(|| "-".into())
                )),
                Span::styled(
                    o.merged_at
                        .as_deref()
                        .map(|m| format!("merged {}", timefmt::stamp_et(m)))
                        .unwrap_or_else(|| "not merged".into()),
                    DIM,
                ),
            ]));
        }
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        "ASK",
        Style::new().bold().fg(Color::Blue),
    )));
    if detail.ask.trim().is_empty() {
        lines.push(Line::from(Span::styled("(none recorded)", DIM)));
    } else {
        for l in detail.ask.lines().take(12) {
            lines.push(Line::from(l.to_string()));
        }
        if detail.ask.lines().count() > 12 {
            lines.push(Line::from(Span::styled("…", DIM)));
        }
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        "SPEC",
        Style::new().bold().fg(Color::Blue),
    )));
    match &detail.spec {
        Some(spec) if !spec.trim().is_empty() => {
            for l in spec.lines() {
                lines.push(Line::from(l.to_string()));
            }
        }
        _ => lines.push(Line::from(Span::styled(
            "(no spec stored; evf task spec <task> --file <file>)",
            DIM,
        ))),
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        format!("PROOF ({})", detail.proofs.len()),
        Style::new().bold().fg(Color::Blue),
    )));
    for p in &detail.proofs {
        let style = match p.status.as_str() {
            "met" => GOOD,
            "unmet" => BAD,
            _ => DIM,
        };
        lines.push(Line::from(vec![
            Span::raw(format!("  {:<4} ", p.criterion)),
            Span::styled(format!("{:<6}", p.status), style),
            Span::styled(
                format!(" {} ", p.head_sha.chars().take(8).collect::<String>()),
                DIM,
            ),
            Span::raw(p.evidence_url.clone().unwrap_or_default()),
            Span::styled(
                p.notes
                    .as_ref()
                    .map(|n| format!("  {n}"))
                    .unwrap_or_default(),
                DIM,
            ),
        ]));
    }
    let area = centered(area, 86, 84);
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .scroll((*scroll, 0))
            .block(
                Block::bordered()
                    .title(Span::styled(title, ACCENT.bold()))
                    .border_style(ACCENT),
            ),
        area,
    );
}

fn draw_help(frame: &mut Frame, area: Rect) {
    let keys = [
        ("↑↓ j k", "move in the focused pane"),
        ("PgUp PgDn g G", "page, top, bottom"),
        ("Tab ← →", "switch between explorer and the tabs"),
        ("1 2 3", "TABLE, RECENT, HEALTH"),
        (
            "Enter",
            "task detail: ask, spec, proof rows (explorer: jump to the table)",
        ),
        ("/", "filter rows by text; Esc clears"),
        (
            "z",
            "open or collapse the queued group (hidden under all tasks while collapsed)",
        ),
        ("Esc", "clear the filter, then the explorer scope"),
        (
            "t",
            "focus the seat's Herdr pane (herdr agent focus; workspace as the fallback)",
        ),
        ("?", "this help"),
        ("q Ctrl-C", "quit"),
    ];
    let mut lines: Vec<Line> = keys
        .iter()
        .map(|(k, what)| {
            Line::from(vec![
                Span::styled(format!(" {k:<14}"), ACCENT.bold()),
                Span::raw((*what).to_string()),
            ])
        })
        .collect();
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        " Read-only: approve, pick, ship and retry stay in the evf CLI; HEALTH names the command.",
        DIM,
    )));
    let area = centered(area, 70, 50);
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .block(
                Block::bordered()
                    .title(Span::styled(" keys ", ACCENT.bold()))
                    .border_style(ACCENT),
            ),
        area,
    );
}
