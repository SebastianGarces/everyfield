# Recovery drill, 2026-11-24 (T-627, WP-095)

A real drill on synthetic data. Times are UTC. The source was a Neon branch, `drill-t627-live`, made off the development
branch and filled by the QA seed. The target was a throwaway Postgres on the restricted host, with its own file store. No
production database, production bucket or customer data was used. The figures are one drill's measurements. They are not
a customer promise, and there is no customer SLA and no disaster recovery time.

## 1. Mistake and recovery

| Step | Time |
|---|---|
| Last work committed before the mistake | 20:42:24.255 |
| An operator mistake deletes all 5 Harvest Point (QA) meetings, with their 6 guests and 23 kit items | 20:42:24.563 |
| Recovery point: the newest commit Neon history gave for a request of 20:41:54 | 20:41:47.000 |
| Neon branch `drill-t627-pitr` made from history | 20:42:47 |
| Restored into the closed schema `drill_history`, rows and bytes verified | 20:43:59.579 |
| Opened with `restore-open` | 20:44:09 |
| Owner signed in with a password on the restored app and saw the meetings | 20:44:52 |

- **Restore time:** 2 min 28 s from the mistake to verified readable data (target: 4 hours). The closed restore itself was
  done after 1 min 35 s.
- **Lost work:** 37.6 s, from 20:41:47.000 to 20:42:24.563 (target: 1 hour). Four commits of the drill's steady work, at
  20:41:54, 20:42:04, 20:42:14 and 20:42:24, fall after the recovery point. The last restored commit is 20:41:44.094.
  Work committed after the mistake, until the service stopped at 20:42:45, is not in the restored data either. Counted to
  that point, the gap is 58 s. An operator stops the service first for that reason.
- **Recovery source:** Neon point-in-time history of a non-production branch. The operator asked for a point 30 s before
  the mistake. No copy was made for it. The manifest's time is the `parent_timestamp` Neon reports for the branch, not the
  time of the capture. A first capture stamped its own time; it was thrown away and the command fixed before the restore.
- **Rows:** the restored `meeting` (5), `participation` (6), `meeting_kit_item` (23) and `task` (5) rows of the church are
  identical, column by column, to the rows read just before the mistake.
- **Files:** all 33 ready files are byte-identical to the originals.
- **Configured history:** the Neon project keeps 86,400 s (24 hours), read from the Neon API. It is not seven days.

The screenshots of the Meetings page before the mistake, after it and after the restore, at 390 and 1440 px, are in the
task's evidence folder with the drill log.

## 2. Real encrypted copy

`backup-daily` captured 4,756,491 database bytes and 33 files at one point (20:40:27.164), encrypted them on the host,
uploaded them to `everyfield-backup`, read them back and opened them. The copy was complete at 20:40:54. It restored
through the same path into `drill_bucket`, with the same identical rows and files. A scan of all 38 stored objects for
10 known plaintexts found none. Two keys made from the bucket secret did not open the copy. The first run of the day was
refused (`capture_failed`) because the drill's file store was down, and nothing counted as complete.

## 3. Deleted logins

Two logins were deleted: a planter's before the copy, and a church Admin's after it. On the restored copy both sign-ins
were refused ("Email or password is incorrect."). No row in either restored schema held their private text, their login
or their private check-ins. The copy itself did hold the second one's private text, so the restore removed it. The
Owner's own 13 check-ins were still there.

## 4. Mail and issues

On the opened copy, three passes of the real mail, scheduled-message and issue jobs ran with capture-only transports.
One mail was captured (the control) and one issue (the control). Nothing was repeated for mail that was accepted,
unknown, or refused then accepted, or for the published and unknown issues. Mail first sent after the copy was made could
not be sent again. No scheduled message was due in the drill; `drill-target.test.mts` covers a scheduled message that
already went out, with one due message as its control.

## 5. Church deletion

`deletion-check` on three throwaway churches: the pending one and the half-purged one read `not_purged` with their
remaining rows and files, and the purged one read `purged` with a copy expiry exactly 7 days after the purge. Cancel was
refused past the deadline before the purge and again after it.

## 6. Expiry in the real bucket

Five synthetic copies were added. Four were at or past their effective expiry, one of them by its subject's expiry.
`backup-expire` deleted those four and kept the other two copies. A listing by version and by deleted object showed no
remains. Versioning, snapshots and soft delete are all off on the bucket.

## 7. Limits

- The data was small and synthetic. A production restore will be slower, and nothing here measures it.
- Neon history reaches back 24 hours. A mistake found later than that falls back to the newest daily copy, with up to
  24 hours of lost work.
- The file bytes came from the live file store, where they had survived and matched their recorded hashes. If a mistake
  also deletes files, their bytes come from the newest daily copy. The app's own bucket was not tested for object
  history.
- The witnesses and receipts came from the surviving live database. The five-minute witness synchronization is not
  built, so losing the live database is not proven recoverable with current deletion state.
- Copies are stored with the same provider as the app's files.
- Provider credentials, host and schedule were exercised by hand. The schedule is not loaded.

Afterward every drill object, both Neon branches, the throwaway Postgres, the drill encryption key and the drill
credentials were deleted. The bucket listed 0 objects and 0 deleted versions.
