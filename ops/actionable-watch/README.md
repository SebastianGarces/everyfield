# Actionable-change watcher

A Mac-local observer that wakes the Grok Bot routine `everyfield-actionable-change-webhook` only when
something needs attention. It reads, it never acts: it does not release, approve, merge, decide, step,
guard or control Herdr. Status: **BUILT/TESTED, AWAITING LIVE RECEPTION**. The `dry-run` and `webhook`
transports both work. It is LIVE only after Sebastian or the parent sees a run of the routine start from a
real `--test-wake` (step 3 below).

## Architecture and scope

- Dependency-free Node 24 TypeScript (type stripping, no build), next to `ops/maintenance/`.
- `observe.mts` is pure: parse `evf status --json` and main CI runs, reduce them to a canonical snapshot,
  derive events, advance dedup state, build the payload.
- `io.mts` holds every side effect: the two allowlisted commands, the state file, the lock, the capped
  log and the transport (one HTTPS POST to the routine's webhook).
- `provision.mts` writes `webhook.json` from two native hidden-input prompts (see Webhook hookup).
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
line and leaves the state untouched. An unexpected shape names where it failed, by list, item index and
field name with its type, never a value: `poll_failed code=evf_bad_shape list=agents index=0 fields=run:string`.
While a decision is open, evf adds a `needs_you` row to `agents` with no `run` or `step` and a `task` that
can be null; the parser accepts it, and the decision event is the only wake for that transition. A gh failure keeps the last known CI and turns only the CI check off.

## Wake payload and logs

The payload holds `source`, `version`, `at` and, per event, `kind`, `key` and only these identifiers:
`task`, `label`, `step`, `run`, `decision`, `sha`, `conclusion`. A label or step that is not a short slug
becomes `""`. No titles, ask text, transcripts, pane or activity text, emails, URLs or keys.

The `dry-run` transport writes `dry-run wake payload=...` to the log and counts as delivered.

The `webhook` transport follows the routine's documented sender contract: one `POST` to the exact URL from
the routine panel, with exactly `Authorization: Bearer <key>` and `Content-Type: application/json`, and the
payload above as the JSON body. Only HTTP 200 counts as delivered (the run was accepted and started). Any
other status, a network error or a timeout is not delivered, and the event stays pending. Redirects are not
followed. The routine documents no path template, body-size limit or idempotency, so none is assumed:

- The URL and key are read from `webhook.json` at send time only. The send is refused, with a named code
  and no request, when the file is missing (`webhook_config_missing`), unreadable or a symlink
  (`webhook_config_unreadable`), not owned by you (`webhook_config_not_owner`), readable by group or others
  (`webhook_config_mode`), not JSON (`webhook_config_invalid_json`), lacks a string `url` or a bearer-safe
  `key` (`webhook_config_invalid`), or has a bad or non-`https:` URL (`webhook_config_invalid_url`,
  `webhook_url_not_https`).
- In-poll retries (3 tries, 1 s and 2 s backoff) happen only when no request can have reached the routine
  (DNS or connect errors) or it answered 5xx. A 4xx (including 429), a timeout or a dropped connection
  waits for the next poll, so a run that may have started is not started again within the poll.
- Each try has a 10 s timeout. Every POST counts against `WEBHOOK_SENDS_PER_HOUR` = 20 in a rolling hour,
  persisted in `state.json` as `sends`, far under the routine's 200 runs per routine per hour (300 across
  all routines). At the cap the poll logs `wake_capped` once and keeps the event pending.

Log lines name only the transport, the result (`http_<status>`, `dns_error`, `connect_error`, `tls_error`,
`timeout`, `network_error` or a config code) and the event keys: `wake webhook result=http_200 events=1
keys=decision:D-9 ...`, `wake_failed transport=webhook tries=1 result=http_429 pending=1 keys=...`. The URL,
its path or token, the key and the Authorization header never appear in a log line, the state file, an
error code, argv or the plist.

## Files the watcher creates

| Path | What |
|---|---|
| `~/Library/LaunchAgents/com.everyfield.actionable-watch.plist` | the launchd job (rendered from the template here) |
| `~/Library/Application Support/everyfield-actionable-watch/app/*.mts` | installed copy of `observe.mts`, `io.mts`, `run.mts`, `provision.mts` |
| `~/Library/Application Support/everyfield-actionable-watch/state.json` | last snapshot, sent keys, pending events, recent webhook send times (0600) |
| `~/Library/Application Support/everyfield-actionable-watch/webhook.json` | the routine's URL and key, written only by `provision.mts` from Sebastian's paste, or by him by hand (0600) |
| `~/Library/Application Support/everyfield-actionable-watch/provision.status` | the last provisioning outcome, one values-free line (0600) |
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
cp ops/actionable-watch/observe.mts ops/actionable-watch/io.mts ops/actionable-watch/run.mts ops/actionable-watch/provision.mts "$APP/"
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

## Webhook hookup

The URL and key exist only in one local file, filled from Sebastian's own paste. No agent sees, asks for,
prints or stores them, and they never go through chat, a task, an ask answer, argv, the plist, a log or an
evidence file.

1. **Provision.** Run one command, or let the agent open it for you:

   ```sh
   APP="$HOME/Library/Application Support/everyfield-actionable-watch/app"
   NODE="$(plutil -extract ProgramArguments.0 raw "$HOME/Library/LaunchAgents/com.everyfield.actionable-watch.plist")"
   "$NODE" "$APP/provision.mts" --detach
   ```

   Two native macOS dialogs open in turn, each with a hidden field: first paste the "POST to" URL from the
   routine `everyfield-actionable-change-webhook`'s panel and press Save, then its sender key and press Save.
   Each dialog has Cancel and closes itself after 30 minutes. The values reach the helper only over a pipe
   from `osascript`. It trims surrounding whitespace, checks both with the transport's own validator, and
   writes `webhook.json` at 0600 (a 0600 temp file in the same 0700 directory, fsynced, then renamed), and
   then re-reads it through the transport's loader. It reads no clipboard, keychain, app file or API.

   `--detach` prints only `pid=<pid> status=<path>` and returns. The helper keeps running after the
   launching shell or agent turn ends. Without `--detach` it waits and prints `webhook_config ok` or a
   code. Either way the outcome goes to `provision.status`, one line with no values:

   ```text
   state=waiting code=none at=...                      before the first prompt
   state=ok code=webhook_config_ok at=...              webhook.json written and accepted
   state=cancelled code=cancelled at=...               Cancel pressed; nothing written
   state=timed_out code=timed_out at=...               a dialog gave up; nothing written
   state=invalid code=<code> at=...                    e.g. webhook_url_not_https, webhook_config_invalid,
                                                       webhook_config_invalid_url, prompt_failed; nothing written
   ```

   On cancel, timeout or invalid input any existing `webhook.json` stays as it was. Then check the file the
   way a send would read it. This sends nothing and does not read or change `state.json`:

   ```sh
   "$NODE" "$APP/run.mts" --check-config     # prints "webhook_config ok" (exit 0) or a refusal code (exit 1)
   ```

   **Fallback, by hand:** create the file with a local editor, keep it at 0600 (any wider mode refuses
   every send), and run `--check-config`:

   ```sh
   install -m 600 /dev/null "$HOME/Library/Application Support/everyfield-actionable-watch/webhook.json"
   open -e "$HOME/Library/Application Support/everyfield-actionable-watch/webhook.json"
   ```

   Its whole content is `{"url": "<the POST to URL>", "key": "<the sender key>"}`.

2. **Test wake.** Only after `--check-config` prints `webhook_config ok`, send one payload marked
   `{"kind": "test"}`. It makes one try, logs only the result and does not read or change `state.json`:

   ```sh
   NODE="$(plutil -extract ProgramArguments.0 raw "$HOME/Library/LaunchAgents/com.everyfield.actionable-watch.plist")"
   "$NODE" "$HOME/Library/Application Support/everyfield-actionable-watch/app/run.mts" --test-wake --transport webhook
   ```

   It prints `test-wake transport=webhook result=http_200` when the routine accepted the run. The same
   flag with `--transport dry-run` logs the test payload instead.

3. **Confirm reception.** Sebastian or the parent checks the routine panel for a run started by the test
   wake. Only then is the watcher LIVE.

4. **Switch the job to webhook.** In `~/Library/LaunchAgents/com.everyfield.actionable-watch.plist`,
   change the `--transport` argument from `dry-run` to `webhook`, then reload and run one poll. Remove, then
   insert: on macOS 27 `plutil -replace` on an array index inserts beside the old value instead of replacing it.

   ```sh
   PLIST="$HOME/Library/LaunchAgents/com.everyfield.actionable-watch.plist"
   plutil -remove ProgramArguments.3 "$PLIST" && plutil -insert ProgramArguments.3 -string webhook "$PLIST" && plutil -lint "$PLIST"
   launchctl bootout gui/$UID/com.everyfield.actionable-watch
   launchctl bootstrap gui/$UID "$PLIST"
   tail -n 3 "$HOME/Library/Logs/everyfield-actionable-watch/watch.log"   # expect "poll ok"
   ```

### Webhook rollback

Switch the job back to `dry-run`, reload it and delete the config and the provisioning status:

```sh
PLIST="$HOME/Library/LaunchAgents/com.everyfield.actionable-watch.plist"
plutil -remove ProgramArguments.3 "$PLIST" && plutil -insert ProgramArguments.3 -string dry-run "$PLIST" && plutil -lint "$PLIST"
launchctl bootout gui/$UID/com.everyfield.actionable-watch
launchctl bootstrap gui/$UID "$PLIST"
rm -f "$HOME/Library/Application Support/everyfield-actionable-watch/webhook.json" \
      "$HOME/Library/Application Support/everyfield-actionable-watch/provision.status"
```

Only the parent may later move the hourly drive routine to a longer backstop; the watcher never changes a
routine, its instruction or its schedule.
