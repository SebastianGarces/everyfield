import test, { after } from "node:test";
import assert from "node:assert/strict";
import { invokeRead } from "../../../../../packages/evry/src/catalog/invoke.ts";
import { preview } from "../../../../../packages/evry/src/adapters/communication/reads/index.ts";
import type { ReadAdapter } from "../../../../../packages/evry/src/catalog/types.ts";
import { goldenChurch, MEETINGS } from "../../../evals/golden-church.mts";

const church = await goldenChurch();
after(church.close);

const INTEREST_MEETING = "5b6d1f0e-0000-4000-8000-000000000d21";
const meetingsFor = async (input: Record<string, unknown>) =>
	(
		await invokeRead(church.db, church.actors.owner, preview as ReadAdapter<unknown>, {
			subject: "You're invited",
			body: "Join us.",
			audience: { groups: ["prospects"], teamIds: [], personIds: [] },
			...input,
		})
	).rows
		.filter((r) => r.kind === "meeting")
		.map((r) => [r.id, r.label, r.fields.startsAt]);

test("An invitation's meeting words list the next matching meeting first, then later ones, before any past meeting", async () => {
	assert.deepEqual(await meetingsFor({ meetingWords: "vision night" }), [
		[MEETINGS.thursday, "Vision Meeting #4", "Thu 2026-11-12 19:00"],
		[MEETINGS.sunday, "Launch team orientation", "Sun 2026-11-15 16:00"],
		[INTEREST_MEETING, "Interest meeting", "Thu 2026-11-19 18:30"],
	]);
});

test("With no upcoming match, the meeting words list past meetings latest first", async () => {
	assert.deepEqual(await meetingsFor({ meetingWords: "vision", meetingOn: "2026-11-08" }), [
		[MEETINGS.lastNight, "Vision Meeting #3", "Sun 2026-11-08 18:00"],
	]);
	assert.deepEqual(
		(await meetingsFor({ meetingWords: "rehearsal practice" })).map(([id]) => id),
		[MEETINGS.soundCheck, MEETINGS.rehearsal],
	);
});
