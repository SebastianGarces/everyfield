# Meeting status machine

Generated from `packages/contracts/src/machines/meeting-status.ts` by `node tools/ci/machines.ts --write`.
`node tools/ci/machines.ts --check` fails when this page differs from the table, and when the writer census below
finds a write of the column that does not carry the machine's guard.

- Column: `meeting.status`
- States: `planning`, `ready`, `in_progress`, `completed`, `cancelled`
- Subjects the guards tell apart: `vision`, `orientation`, `team`, `practice`
- Refusal for every move the chart does not show: `status_transition`
- A request for the current state writes nothing: `meetings.changeStatus`

```mermaid
stateDiagram-v2
  [*] --> planning: meetings.schedule
  planning --> ready: meetings.changeStatus
  planning --> in_progress: meetings.changeStatus
  planning --> cancelled: meetings.changeStatus
  ready --> planning: meetings.changeStatus / meetings.correctPracticeOccurrence when practice
  ready --> in_progress: meetings.changeStatus
  ready --> cancelled: meetings.changeStatus
  in_progress --> ready: meetings.changeStatus
  in_progress --> completed: meetings.changeStatus unless practice / meetings.completePractice when practice / meetings.correctPracticeOccurrence when practice
  in_progress --> cancelled: meetings.changeStatus
  completed --> in_progress: meetings.changeStatus unless practice
  cancelled --> planning: meetings.changeStatus / meetings.correctPracticeOccurrence when practice
  planning --> completed: meetings.completePractice when practice / meetings.correctPracticeOccurrence when practice
  ready --> completed: meetings.completePractice when practice / meetings.correctPracticeOccurrence when practice
  completed --> completed: meetings.completePractice when practice / meetings.correctPracticeOccurrence when practice
  planning --> planning: meetings.correctPracticeOccurrence when practice
  in_progress --> planning: meetings.correctPracticeOccurrence when practice
  completed --> planning: meetings.correctPracticeOccurrence when practice
  cancelled --> completed: meetings.correctPracticeOccurrence when practice
  note right of completed : stays on meetings.correctOccurrence
```

## Refused moves

| Subject | Event | From | To |
|---|---|---|---|
| vision | `meetings.changeStatus` | planning | completed |
| vision | `meetings.changeStatus` | ready | completed |
| vision | `meetings.changeStatus` | in_progress | planning |
| vision | `meetings.changeStatus` | completed | ready |
| vision | `meetings.changeStatus` | completed | cancelled |
| vision | `meetings.changeStatus` | completed | planning |
| vision | `meetings.changeStatus` | cancelled | ready |
| vision | `meetings.changeStatus` | cancelled | in_progress |
| vision | `meetings.changeStatus` | cancelled | completed |
| vision | `meetings.correctOccurrence` | planning | planning |
| vision | `meetings.correctOccurrence` | ready | ready |
| vision | `meetings.correctOccurrence` | in_progress | in_progress |
| vision | `meetings.correctOccurrence` | cancelled | cancelled |
| orientation | `meetings.changeStatus` | planning | completed |
| orientation | `meetings.changeStatus` | ready | completed |
| orientation | `meetings.changeStatus` | in_progress | planning |
| orientation | `meetings.changeStatus` | completed | ready |
| orientation | `meetings.changeStatus` | completed | cancelled |
| orientation | `meetings.changeStatus` | completed | planning |
| orientation | `meetings.changeStatus` | cancelled | ready |
| orientation | `meetings.changeStatus` | cancelled | in_progress |
| orientation | `meetings.changeStatus` | cancelled | completed |
| orientation | `meetings.correctOccurrence` | planning | planning |
| orientation | `meetings.correctOccurrence` | ready | ready |
| orientation | `meetings.correctOccurrence` | in_progress | in_progress |
| orientation | `meetings.correctOccurrence` | cancelled | cancelled |
| team | `meetings.changeStatus` | planning | completed |
| team | `meetings.changeStatus` | ready | completed |
| team | `meetings.changeStatus` | in_progress | planning |
| team | `meetings.changeStatus` | completed | ready |
| team | `meetings.changeStatus` | completed | cancelled |
| team | `meetings.changeStatus` | completed | planning |
| team | `meetings.changeStatus` | cancelled | ready |
| team | `meetings.changeStatus` | cancelled | in_progress |
| team | `meetings.changeStatus` | cancelled | completed |
| team | `meetings.correctOccurrence` | planning | planning |
| team | `meetings.correctOccurrence` | ready | ready |
| team | `meetings.correctOccurrence` | in_progress | in_progress |
| team | `meetings.correctOccurrence` | cancelled | cancelled |
| practice | `meetings.changeStatus` | planning | completed |
| practice | `meetings.changeStatus` | ready | completed |
| practice | `meetings.changeStatus` | in_progress | planning |
| practice | `meetings.changeStatus` | in_progress | completed |
| practice | `meetings.changeStatus` | completed | ready |
| practice | `meetings.changeStatus` | completed | in_progress |
| practice | `meetings.changeStatus` | completed | cancelled |
| practice | `meetings.changeStatus` | completed | planning |
| practice | `meetings.changeStatus` | cancelled | ready |
| practice | `meetings.changeStatus` | cancelled | in_progress |
| practice | `meetings.changeStatus` | cancelled | completed |
| practice | `meetings.completePractice` | cancelled | completed |
| practice | `meetings.correctOccurrence` | planning | planning |
| practice | `meetings.correctOccurrence` | ready | ready |
| practice | `meetings.correctOccurrence` | in_progress | in_progress |
| practice | `meetings.correctOccurrence` | cancelled | cancelled |

## Writers of the column

| File | Statement | Guard |
|---|---|---|
| `packages/domain/src/meetings/meetings.ts` | update | from-state filter |
| `packages/domain/src/meetings/meetings.ts` | insert | initial state |

The census is a static scan of git-tracked product code and SQL files under apps, packages, ops, scripts and
tools. It reads SQL literals (with an optional schema prefix), SET fragments in a file that also holds a dynamic
`SET ${…}` on the table, Drizzle `update`/`insert` calls, and `.sql` files. A guarded UPDATE filters on
`status = ANY(${fromStates(meetingStatusMachine, …)})` in the same statement; a guarded INSERT writes the
initial state. A column name or statement start built at runtime, or a Drizzle object that is not a literal, counts
as an unguarded writer.

It cannot see: a SET fragment passed in from another file, SQL text assembled from variables that hold no
literal naming the table, statements sent outside this repository, or writes made by hand in a database
session. Only a database trigger generated from this table would refuse those.

## Proof

`tests/integration/meetings/status-machine.test.mts` walks every edge and every refused move against Postgres through the public operations and
reads each state back from the row. Run it with `EVF_MACHINE_COVERAGE=<file>` set, then attach this chart and
the report below to a change that touches this machine:

```sh
node tools/ci/machines.ts coverage <file>
```
