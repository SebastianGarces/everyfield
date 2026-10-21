// 4 C's, interview and commitment rules (WP-014/ui) that the Person page applies while a save runs or after it. A silent
// break would show a wrong latest record, a demoted stage, a wrong first commitment date or a duplicate save. They run
// in node against the real module the cards use; no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	advancedStage,
	sendTwice,
	withCard,
	withRecord,
} from "../../../apps/web/src/features/people/assessments/model.ts";

const rec = (id, occurredOn, recordedAt) => ({ id, occurredOn, recordedAt });

test("AC:TARGET-PPL-012 a late historical record joins history in date order and never becomes the latest", () => {
	const items = [rec("b", "2026-10-10", "2026-10-10T10:00:00Z"), rec("a", "2026-09-01", "2026-09-01T10:00:00Z")];
	const late = rec("c", "2026-09-20", "2026-10-21T09:00:00Z");
	assert.deepEqual(
		withRecord(items, late).map((r) => r.id),
		["b", "c", "a"],
	);
	// Same date: the later recorded instant is the latest. A record already shown keeps one place.
	const same = rec("d", "2026-10-10", "2026-10-11T08:00:00Z");
	assert.deepEqual(
		withRecord(withRecord(items, same), same).map((r) => r.id),
		["d", "b", "a"],
	);
});

test("AC:TARGET-PPL-013 AC:TARGET-PPL-014 a record moves an earlier stage up and never moves a later stage back", () => {
	assert.equal(advancedStage("prospect", "interviewed"), "interviewed");
	assert.equal(advancedStage("interviewed", "interviewed"), "interviewed");
	assert.equal(advancedStage("leader", "interviewed"), "leader");
	assert.equal(advancedStage("following_up", "core_group"), "core_group");
	assert.equal(advancedStage("launch_team", "core_group"), "launch_team");
});

test("AC:TARGET-PPL-026 a new card sets the first commitment only when it is earlier; unknown stays unknown", () => {
	const card = { id: "k2", occurredOn: "2026-09-01" };
	assert.deepEqual(withCard({ status: "none" }, card), { status: "known", occurredOn: "2026-09-01", evidenceId: "k2" });
	const known = { status: "known", occurredOn: "2026-08-15", evidenceId: "k1" };
	assert.equal(withCard(known, card), known);
	assert.deepEqual(withCard({ ...known, occurredOn: "2026-10-01" }, card).evidenceId, "k2");
	assert.deepEqual(withCard({ status: "unknown" }, card), { status: "unknown" });
});

test("INV-request-key: a lost answer is sent once more through the same call; a second loss goes back to the person", async () => {
	const calls = [];
	const replies = [{ status: "lost" }, { status: "ok", value: 1 }];
	const call = () => (calls.push("same-key"), Promise.resolve(replies.shift()));
	assert.deepEqual(await sendTwice(call), { status: "ok", value: 1 });
	assert.equal(calls.length, 2);
	let n = 0;
	const failing = () => (n++, Promise.reject(new Error("network")));
	assert.deepEqual(await sendTwice(failing), { status: "lost" });
	assert.equal(n, 2);
	let refused = 0;
	assert.deepEqual(await sendTwice(() => (refused++, Promise.resolve({ status: "refused", code: "conflict" }))), {
		status: "refused",
		code: "conflict",
	});
	assert.equal(refused, 1);
});
