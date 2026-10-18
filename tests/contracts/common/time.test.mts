import assert from "node:assert/strict";
import { test } from "node:test";
import { calendarContext, frozenClock, instant, localDate, localDateTime, timeZone, resolvedTime, resolveCalendar, localDayBounds, addCivilDays } from "../../../packages/contracts/src/common/index.ts";
const chicago = timeZone.parse("America/Chicago");

test("AC:TARGET-TSK-018 entered gap/fold require a valid wall time or explicit occurrence", () => {
  const gap = localDateTime.parse("2026-03-08T02:30:00");
  assert.deepEqual(resolveCalendar(gap, chicago, "entered"), { kind: "gap", entered: gap, zone: chicago });
  const fold = localDateTime.parse("2026-11-01T01:30:00");
  assert.deepEqual(resolveCalendar(fold, chicago, "entered"), { kind: "fold", entered: fold, zone: chicago, choices: [
    { instant: "2026-11-01T06:30:00.000Z", offsetSeconds: -18000 },
    { instant: "2026-11-01T07:30:00.000Z", offsetSeconds: -21600 },
  ] });
  for (const [offset, expected] of [[-18000, "2026-11-01T06:30:00.000Z"], [-21600, "2026-11-01T07:30:00.000Z"]] as const) {
    assert.deepEqual(resolveCalendar(fold, chicago, "entered", offset), { kind: "resolved", entered: fold, zone: chicago,
      occurrence: { instant: expected, offsetSeconds: offset }, resolverVersion: 1, adjustmentSeconds: 0 });
  }
  assert.equal(resolveCalendar(fold, chicago, "entered", 0).kind, "invalid_offset");
});

test("INV-time: resolver v1 preserves earlier folds and shifts by actual gaps, including half-hour and skipped-date transitions", () => {
  for (const [wall, zone, expected, offset, shift] of [
    ["2026-03-08T02:30:00", "America/Chicago", "2026-03-08T08:30:00.000Z", -18000, 3600],
    ["2026-11-01T01:30:00", "America/Chicago", "2026-11-01T06:30:00.000Z", -18000, 0],
    ["2026-10-04T02:15:00", "Australia/Lord_Howe", "2026-10-03T15:45:00.000Z", 39600, 1800],
    ["2011-12-30T12:00:00", "Pacific/Apia", "2011-12-30T22:00:00.000Z", 50400, 86400],
  ] as const) {
    const result = resolveCalendar(localDateTime.parse(wall), timeZone.parse(zone), "automatic");
    assert.deepEqual(result, { kind: "resolved", entered: wall, zone, occurrence: { instant: expected, offsetSeconds: offset }, resolverVersion: 1, adjustmentSeconds: shift });
    if (result.kind !== "resolved") throw new Error("Expected resolved occurrence");
    const { kind, ...saved } = result;
    assert.equal(kind, "resolved");
    assert.deepEqual(resolvedTime.parse(JSON.parse(JSON.stringify(saved))), saved);
    assert.equal(resolvedTime.safeParse({ ...saved, occurrence: { ...saved.occurrence, instant: "invalid" } }).success, false);
  }
});

test("AC:TARGET-TSK-018 local-day boundaries follow 23/25-hour days and frozen context ignores the host zone", () => {
  for (const [date, start, end, hours] of [
    ["2026-03-08", "2026-03-08T06:00:00.000Z", "2026-03-09T05:00:00.000Z", 23],
    ["2026-11-01", "2026-11-01T05:00:00.000Z", "2026-11-02T06:00:00.000Z", 25],
  ] as const) {
    const bounds = localDayBounds(localDate.parse(date), chicago);
    assert.deepEqual(bounds, { start, end });
    assert.equal((Date.parse(bounds.end) - Date.parse(bounds.start)) / 3600000, hours);
  }
  const asOf = instant.parse("2026-03-09T04:59:59Z");
  const clock = frozenClock(asOf);
  assert.deepEqual(calendarContext(chicago, clock), { asOf: "2026-03-09T04:59:59.000Z", zone: "America/Chicago", localDate: "2026-03-08", resolverVersion: 1 });
  assert.deepEqual(calendarContext(timeZone.parse("Pacific/Auckland"), clock), { asOf: "2026-03-09T04:59:59.000Z", zone: "Pacific/Auckland", localDate: "2026-03-09", resolverVersion: 1 });
  assert.equal(addCivilDays(localDate.parse("2026-03-08"), 2), "2026-03-10");
  assert.equal(localDate.safeParse("2026-02-29").success, false);
  assert.equal(localDateTime.safeParse("2026-03-08T24:00:00").success, false);
  assert.equal(timeZone.safeParse("+05:00").success, false);
});
