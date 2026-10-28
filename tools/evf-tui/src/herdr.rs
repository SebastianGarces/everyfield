//! Herdr state from `herdr api snapshot`, polled every second in a child process. The join key to a store run is the
//! Claude session id: evf pre-assigns it with `--session-id` and Herdr reports it as `agent_session.value`.

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::process::Command;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Agent {
    pub name: String,
    pub status: String,
    pub session: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Workspace {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct State {
    pub agents: Vec<Agent>,
    pub workspaces: Vec<Workspace>,
    pub version: Option<String>,
    /// Set when Herdr could not be read; the last good agents stay on screen with this note.
    pub error: Option<String>,
}

impl State {
    pub fn by_session(&self, session: &str) -> Option<&Agent> {
        self.agents
            .iter()
            .find(|a| a.session.as_deref() == Some(session))
    }

    pub fn by_name(&self, name: &str) -> Option<&Agent> {
        self.agents.iter().find(|a| a.name == name)
    }

    pub fn workspace(&self, id: &str) -> Option<&Workspace> {
        self.workspaces.iter().find(|w| w.id == id)
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Accepts the CLI envelope (`{"id", "result": {"snapshot": {...}}}`), a bare `{"snapshot": {...}}` or the snapshot itself.
pub fn parse(json: &str) -> Result<State> {
    let root: Value = serde_json::from_str(json).context("herdr snapshot is not JSON")?;
    let snapshot = root
        .pointer("/result/snapshot")
        .or_else(|| root.get("snapshot"))
        .unwrap_or(&root);
    let agents = snapshot
        .get("agents")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("herdr snapshot has no agents list"))?
        .iter()
        .map(|a| Agent {
            name: text(a, "name").unwrap_or_default(),
            status: text(a, "agent_status").unwrap_or_else(|| "unknown".into()),
            session: a
                .get("agent_session")
                .and_then(|s| text(s, "value"))
                .filter(|s| !s.is_empty()),
            workspace_id: text(a, "workspace_id"),
        })
        .collect();
    let workspaces = snapshot
        .get("workspaces")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|w| Workspace {
                    id: text(w, "workspace_id").unwrap_or_default(),
                    label: text(w, "label").unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(State {
        agents,
        workspaces,
        version: text(snapshot, "version"),
        error: None,
    })
}

fn run(bin: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(bin)
        .args(args)
        .output()
        .with_context(|| format!("run {bin} {}", args.join(" ")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = if err.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).to_string()
        } else {
            err.to_string()
        };
        return Err(anyhow!(
            "{bin} {} failed: {}",
            args.join(" "),
            msg.trim().lines().next().unwrap_or("")
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// One snapshot; a failure becomes `State::error` so the caller keeps the previous agents.
pub fn snapshot(bin: &str) -> State {
    match run(bin, &["api", "snapshot"]).and_then(|s| parse(&s)) {
        Ok(state) => state,
        Err(e) => State {
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

/// Jump to a seat: `herdr agent focus <name>`, then `herdr workspace focus <id>` as the fallback.
pub fn focus(bin: &str, agent: Option<&str>, workspace: Option<&str>) -> Result<String> {
    let mut errors = Vec::new();
    if let Some(name) = agent {
        match run(bin, &["agent", "focus", name]) {
            Ok(_) => return Ok(format!("focused {name}")),
            Err(e) => errors.push(e.to_string()),
        }
    }
    if let Some(id) = workspace {
        match run(bin, &["workspace", "focus", id]) {
            Ok(_) => return Ok(format!("focused workspace {id}")),
            Err(e) => errors.push(e.to_string()),
        }
    }
    if errors.is_empty() {
        return Err(anyhow!("this row has no Herdr agent or workspace to focus"));
    }
    Err(anyhow!("{}", errors.join("; ")))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub const SAMPLE: &str = r#"{"id":"cli:api","result":{"snapshot":{"agents":[
      {"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"11111111-1111-4111-8111-111111111111"},"agent_status":"working","cwd":"/w/.worktrees/wp-101","focused":false,"name":"implementer-wp-101","pane_id":"wA:p1","terminal_title_stripped":"implement","workspace_id":"wA"},
      {"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"22222222-2222-4222-8222-222222222222"},"agent_status":"blocked","cwd":"/w/.worktrees/wp-102","name":"verifier-wp-102","pane_id":"wB:p1","workspace_id":"wB"},
      {"agent":"claude","agent_status":"idle","cwd":"/home","name":"scratch","pane_id":"wC:p1","workspace_id":"wC"}
    ],"workspaces":[{"active_tab_id":"wA:t1","agent_status":"working","focused":false,"label":"wp-101","number":1,"workspace_id":"wA"}],"version":"0.9.5"},"type":"session_snapshot"}}"#;

    #[test]
    fn parses_the_cli_envelope_and_joins_by_session() {
        let state = parse(SAMPLE).unwrap();
        assert_eq!(state.agents.len(), 3);
        assert_eq!(state.version.as_deref(), Some("0.9.5"));
        let a = state
            .by_session("11111111-1111-4111-8111-111111111111")
            .unwrap();
        assert_eq!(a.name, "implementer-wp-101");
        assert_eq!(a.status, "working");
        assert_eq!(a.workspace_id.as_deref(), Some("wA"));
        assert!(state.by_session("missing").is_none());
        assert_eq!(state.by_name("scratch").unwrap().session, None);
        assert_eq!(state.workspace("wA").unwrap().label, "wp-101");
    }

    #[test]
    fn accepts_a_bare_snapshot_and_rejects_junk() {
        let bare = r#"{"agents":[{"name":"x","agent_status":"done"}]}"#;
        assert_eq!(parse(bare).unwrap().agents[0].status, "done");
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"result":{}}"#).is_err());
    }

    #[test]
    fn a_missing_herdr_binary_becomes_an_error_state() {
        let state = snapshot("/nonexistent/herdr-binary");
        assert!(state.agents.is_empty());
        assert!(state
            .error
            .unwrap()
            .contains("run /nonexistent/herdr-binary"));
        assert!(focus("/nonexistent/herdr-binary", Some("a"), Some("w")).is_err());
        assert!(focus("/nonexistent/herdr-binary", None, None).is_err());
    }
}
