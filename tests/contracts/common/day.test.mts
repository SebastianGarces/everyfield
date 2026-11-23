import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const contracts = createRequire(new URL("../../../packages/contracts/package.json", import.meta.url));
const { addDays, dayText, weekdayOf } = (await import(
	pathToFileURL(contracts.resolve("@everyfield/contracts/common")).href
)) as typeof import("../../../packages/contracts/src/common/index.ts");

test("dayText writes the civil day in en-US with no time zone shift", () => {
	assert.equal(dayText("2026-11-23"), "Nov 23, 2026");
	assert.equal(dayText("2026-01-01"), "Jan 1, 2026");
	assert.equal(dayText("2025-12-31"), "Dec 31, 2025");
	assert.equal(dayText("2028-02-29"), "Feb 29, 2028");
});

test("dayText drops the year never, or only inside the given year", () => {
	assert.equal(dayText("2026-11-23", { year: "never" }), "Nov 23");
	assert.equal(dayText("2026-11-23", { year: 2026 }), "Nov 23");
	assert.equal(dayText("2027-01-04", { year: 2026 }), "Jan 4, 2027");
});

test("dayText gives the short and long weekday and month forms", () => {
	assert.equal(dayText("2026-11-23", { weekday: "short" }), "Mon, Nov 23, 2026");
	assert.equal(dayText("2026-11-23", { weekday: "long", month: "long", year: "never" }), "Monday, November 23");
	assert.equal(dayText("2026-11-23", { weekday: "long", year: "never" }), "Monday, Nov 23");
	assert.equal(dayText("2026-09-07", { year: "never" }), "Sep 7");
});

test("dayText refuses a string that is not a civil day", () => {
	for (const bad of ["", "2026-11-23T12:00:00Z", "2026-2-3", "2026-13-01", "2026-02-30", "2027-02-29", "Nov 23"])
		assert.throws(() => dayText(bad), RangeError, bad);
	assert.throws(() => addDays("2026-02-30", 1), RangeError);
	assert.throws(() => weekdayOf("soon"), RangeError);
});

test("addDays moves across month, year and leap-day edges", () => {
	assert.equal(addDays("2026-11-23", 0), "2026-11-23");
	assert.equal(addDays("2026-11-30", 1), "2026-12-01");
	assert.equal(addDays("2026-12-31", 1), "2027-01-01");
	assert.equal(addDays("2027-01-01", -1), "2026-12-31");
	assert.equal(addDays("2028-02-28", 1), "2028-02-29");
	assert.equal(addDays("2028-02-29", 1), "2028-03-01");
	assert.equal(addDays("2027-02-28", 1), "2027-03-01");
	assert.equal(addDays("2028-03-01", -1), "2028-02-29");
	assert.equal(addDays("2026-11-23", -28), "2026-10-26");
});

test("weekdayOf counts from Sunday as 0", () => {
	assert.deepEqual(["2026-11-22", "2026-11-23", "2026-11-28", "2028-02-29"].map(weekdayOf), [0, 1, 6, 2]);
});
