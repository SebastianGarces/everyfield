# Actionable-change watcher

A Mac-local observer that wakes the Grok Bot routine `everyfield-actionable-change-webhook` only when
something needs attention. It reads, it never acts: it does not release, approve, merge, decide, step,
guard or control Herdr. Status: **BUILT/TESTED, AWAITING HOOKUP**. Only the `dry-run` transport works.
It is LIVE only after the parent verifies a real reception by the routine.

## Architecture and scope

- Dependency-free Node 24 TypeScript (type stripping, no build), next to `ops/maintenance/`.
- `observe.mts` is pure: parse `evf status --json` and main CI runs, reduce them to a canonical snapshot,
  derive events, advance dedup state, build the payload.
- `io.mts` holds every side effect: the two allowlisted commands, the state file, the lock, the capped
  log and the transport.
- `run.mts` does one poll and exits. launchd's `StartInterval` (90 s) owns cadence and restart, so the
  watcher has no loop, no daemon and no retry spin.

It reads only two things, both read-only:

| Command | Purpose |
|---|---|
| `~/.cargo/bin/evf status --json` (cwd `~/dev/everyfield_v3`, the main checkout) | tasks, seats, decisions, heartbeat, `tick_error`, seat budget |
| `/opt/homebrew/bin/gh run list --repo SebastianGarces/everyfield --branch main --workflow CI --event push --limit 10 --json headSha,status,conclusion,createdAt` | main CI head and conclusion |

Each command has a 20 s timeout. It reads no evf store, config, dashboard API, cookie or token.

## Events

Each event has a stable key. A level key wakes once while its condition holds, leaves the store when it
clears, and wakes again if it recurs.

| Kind | Key | Fires when |
|---|---|---|
| `seat-finished` | `seat-finished:<task>:<run>:<step>` | a running task's run ends or its step changes (edge) |
| `task-error` | `task-error:<task>:<value>` | phase, agent state or lifecycle reads failed, error, errored, stuck or crashed |
| `tick-error` | `tick-error` | evf `tick_error` is set |
| `stuck-heartbeat` | `stuck-heartbeat` | evf `now - heartbeat` reaches 15 min (`HEARTBEAT_STALE_MS`) |
| `stuck-seat` | `stuck-seat:<run>` | a seat is not `live` while its task reads running, on 2 polls in a row |
| `slot-available` | `slot-available:<task>` | seats used < max and a released, eligible task waited on 2 polls in a row |
| `ci-failed` | `ci-failed:<sha>` | the newest main CI head sha has a failed run |
| `decision-open` | `decision:<id>` | a new id appears in evf `decisions` (agent `rulings` block nothing and are ignored) |

A task counts as eligible waiting work only when its lifecycle is `open`, it has no `hold` or `hold_by`,
its phase is waiting, queued or ready, no decision is open on it, and its wait text does not name an
owner, decision, approval, ruling, review, hold, block or another task. The notice only informs.

Stuck never means "long". A live seat with recent activity is healthy at any runtime (a test runs a
6-hour live seat through 5 polls with no event).

Volatile fields (`now`, `heartbeat`, `machine`, `since`, `activity`, `activity_at`, `doing`, cost,
tokens, audit, wait prose) never enter the snapshot, so they cannot defeat dedup. The first run, or a
missing or corrupt state file, re-baselines: whatever is already true counts as sent, and nothing wakes.
An evf failure (missing, not executable, non-zero exit, timeout, invalid JSON, unexpected shape) logs one
line and leaves the state untouched. A gh failure keeps the last known CI and turns only the CI check off.

## Wake payload and logs

The payload holds `source`, `version`, `at` and, per event, `kind`, `key` and only these identifiers:
`task`, `label`, `step`, `run`, `decision`, `sha`, `conclusion`. A label or step that is not a short slug
becomes `""`. No titles, ask text, transcripts, pane or activity text, emails, URLs or keys.

Delivery makes up to 3 tries with 1 s and 2 s backoff and a 10 s per-try timeout, all inside one poll.
An event whose send fails stays pending, gets one delivery attempt per poll, and is marked sent only on
success. The `dry-run` transport writes `dry-run wake payload=...` to the log and counts as delivered.

## Files the watcher creates

| Path | What |
|---|---|
| `~/Library/LaunchAgents/com.everyfield.actionable-watch.plist` | the launchd job (rendered from the template here) |
| `~/Library/Application Support/everyfield-actionable-watch/app/*.mts` | installed copy of `observe.mts`, `io.mts`, `run.mts` |
| `~/Library/Application Support/everyfield-actionable-watch/state.json` | last snapshot, sent keys, pending events (0600) |
| `~/Library/Application Support/everyfield-actionable-watch/watch.lock` | single-instance lock, `pid at`, present only during a poll |
| `~/Library/Logs/everyfield-actionable-watch/watch.log` and `watch.log.1` | one line per poll, rolls at 1 MB |
| `~/Library/Logs/everyfield-actionable-watch/launchd.log` | launchd stdout and stderr, normally empty |

## Install

Run from the repository root. It touches only the watcher's own label and paths.

```sh
APP="$HOME/Library/Application Support/everyfield-actionable-watch/app"
NODE="$HOME/.nvm/versions/node/v24.22.1/bin/node"   # Node 24.22+, absolute path
mkdir -p "$APP" "$HOME/Library/Logs/everyfield-actionable-watch"
chmod 700 "$HOME/Library/Application Support/everyfield-actionable-watch"
cp ops/actionable-watch/observe.mts ops/actionable-watch/io.mts ops/actionable-watch/run.mts "$APP/"
sed -e "s|__NODE__|$NODE|" -e "s|__HOME__|$HOME|g" ops/actionable-watch/com.everyfield.actionable-watch.plist \
  > "$HOME/Library/LaunchAgents/com.everyfield.actionable-watch.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.everyfield.actionable-watch.plist"
launchctl bootstrap gui/$UID "$HOME/Library/LaunchAgents/com.everyfield.actionable-watch.plist"
```

Check and restart:

```sh
launchctl print gui/$UID/com.everyfield.actionable-watch | grep -E 'state|runs|last exit|run interval'
tail -n 20 "$HOME/Library/Logs/everyfield-actionable-watch/watch.log"
launchctl kickstart -k gui/$UID/com.everyfield.actionable-watch   # run a poll now
```

## Rollback

Unload, then remove every file the watcher created:

```sh
launchctl bootout gui/$UID/com.everyfield.actionable-watch
rm -f "$HOME/Library/LaunchAgents/com.everyfield.actionable-watch.plist"
rm -rf "$HOME/Library/Application Support/everyfield-actionable-watch"
rm -rf "$HOME/Library/Logs/everyfield-actionable-watch"
```

Nothing else changes: no evf service, dashboard, routine, schedule or GitHub setting is touched.

## Webhook hookup (pending the contract)

`--transport webhook` refuses to start today and logs exactly what is missing: the routine's
documented public sender contract, meaning the endpoint URL shape, the auth header name and value
format, and the payload schema (content type and required fields). No endpoint, header or key is
hard-coded, and no agent asks for or sees the sender key.

Once the parent supplies that contract and the code supports it, Sebastian provisions it locally:

1. Open the routine panel for `everyfield-actionable-change-webhook` and read its sender instructions.
2. Create the config with a local editor, never through chat:
   `install -m 600 /dev/null "$HOME/Library/Application Support/everyfield-actionable-watch/webhook.json"`,
   then open that file in a local editor and paste the URL and key from the panel.
3. Do not paste the URL or key into any chat, task, log or evidence file.
4. The parent coordinates one live reception test. Only after the routine shows the reception may the
   watcher be called LIVE, and only then may the parent move the drive routine to a 2–3 hour backstop.
