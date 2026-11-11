// T-167 (appshell/web-11): the route, role, date and mail-env helpers the features share live once, and a node test
// reaches each by relative path. These rows pin what the former copies did, so a change to the shared copy shows here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDay, MONTHS } from "../../../apps/web/src/features/shared/dates.ts";
import { params } from "../../../apps/web/src/features/shared/search-params.ts";
import { canWrite } from "../../../apps/web/src/features/shared/seat-role.ts";
import { mailEnv } from "../../../apps/web/src/server/mail-env.ts";

test("search params: an array value becomes repeated keys and an undefined value adds none", () => {
	const out = params({ stage: ["new", "visitor"], q: "ann", empty: undefined });
	assert.equal(out.toString(), "stage=new&stage=visitor&q=ann");
});

test("seat role: Owners and Admins write, Members do not", () => {
	assert.deepEqual(
		["owner", "admin", "member"].map((role) => canWrite({ role })),
		[true, true, false],
	);
});

test("dates: short month names and a day on the zone's calendar", () => {
	assert.equal(MONTHS.length, 12);
	assert.equal(`${MONTHS[0]} ${MONTHS[11]}`, "Jan Dec");
	// 03:30 UTC on Oct 3 is still Oct 2 in Chicago.
	assert.equal(formatDay("2026-10-03T03:30:00Z", "America/Chicago"), "Oct 2, 2026");
	assert.equal(formatDay("2026-10-03T03:30:00Z", "UTC"), "Oct 3, 2026");
});

test("mail env: two 64-hex keys and a sender address, nothing looser", () => {
	const key = "a".repeat(64);
	assert.equal(mailEnv.IDENTITY_MAIL_KEY.safeParse(key).success, true);
	assert.equal(mailEnv.IDENTITY_ADDRESS_KEY.safeParse(key).success, true);
	assert.equal(mailEnv.IDENTITY_MAIL_KEY.safeParse("A".repeat(64)).success, false);
	assert.equal(mailEnv.IDENTITY_ADDRESS_KEY.safeParse(key.slice(1)).success, false);
	assert.equal(mailEnv.IDENTITY_MAIL_FROM.safeParse("hello@example.com").success, true);
	assert.equal(mailEnv.IDENTITY_MAIL_FROM.safeParse("not an address").success, false);
});
