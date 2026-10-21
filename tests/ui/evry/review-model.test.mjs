// Evry review card rules (WP-053/ui) that a silent break would turn into a false state on an approval, or a revision
// that changes facts the person did not edit. They run in node against the module the card uses; no browser.
//   AC:UI45-004 AC:INH-REGRESSION-EXPIRED-APPROVAL INV-phase: the card's state comes from the saved review and the
//     clock: a pending review past its expiry is expired, an approved one without an outcome is still running, a saved
//     outcome stays saved after its person is gone, and a failed run can go again only while its approval lasts.
//   AC:INH-REGRESSION-REVISED-APPROVAL INV-revise: a revision sends the native command's exact reviewed input with only
//     the edited values changed, for every People reviewed write.
import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseOf, retryable, reviseInput } from "../../../apps/web/src/features/evry/review/model.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const later = "2026-10-21T12:10:00Z";
const earlier = "2026-10-21T11:59:59Z";
const maria = { kind: "person", id: "11111111-1111-4111-8111-111111111111", label: "Maria Santos" };
const review = (over = {}) => ({
	id: "p",
	conversationId: "c",
	operation: "people.updatePerson",
	revision: 1,
	digest: "d",
	expiresAt: later,
	approvedAt: null,
	status: "pending",
	review: { target: maria, changes: [{ field: "city", before: "Dallas", after: "Austin" }] },
	outcome: null,
	executing: false,
	receipt: null,
	...over,
});

test("AC:UI45-004 AC:INH-REGRESSION-EXPIRED-APPROVAL INV-phase: each saved state shows as itself", () => {
	assert.equal(phaseOf(review(), NOW), "pending");
	assert.equal(phaseOf(review({ expiresAt: earlier }), NOW), "expired");
	assert.equal(
		phaseOf(review({ expiresAt: new Date(NOW).toISOString() }), NOW),
		"expired",
		"expiresAt itself is too late",
	);
	assert.equal(phaseOf(review({ status: "cancelled" }), NOW), "cancelled");
	// An approval whose reply was lost reads back as approved with no outcome yet: running, never "not approved".
	assert.equal(phaseOf(review({ status: "approved", executing: true }), NOW), "running");
	assert.equal(phaseOf(review({ status: "approved", outcome: "completed" }), NOW), "completed");
	assert.equal(phaseOf(review({ status: "approved", outcome: "refused" }), NOW), "refused");
	assert.equal(phaseOf(review({ status: "approved", outcome: "unknown" }), NOW), "unconfirmed");
	const gone = { target: null, changes: [], withheld: true };
	assert.equal(phaseOf(review({ review: gone }), NOW), "withheld");
	assert.equal(phaseOf(review({ review: gone, status: "approved", outcome: "completed" }), NOW), "completed");

	assert.equal(retryable(review({ status: "approved", outcome: "failed" }), NOW), true);
	assert.equal(retryable(review({ status: "approved", outcome: "failed", expiresAt: earlier }), NOW), false);
	assert.equal(retryable(review({ status: "approved", outcome: "refused" }), NOW), false);
});

test("AC:INH-REGRESSION-REVISED-APPROVAL INV-revise: a revision rebuilds the exact input with only the edits", () => {
	const change = (field, before, after) => ({ field, before, after });
	const of = (operation, changes) => review({ operation, review: { target: maria, changes } });
	const update = of("people.updatePerson", [change("city", "Dallas", "Austin"), change("phone", null, "555 0100")]);
	assert.deepEqual(reviseInput(update), { personId: maria.id, patch: { city: "Austin", phone: "555 0100" } });
	assert.deepEqual(reviseInput(update, { city: " Houston ", phone: "" }), {
		personId: maria.id,
		patch: { city: "Houston", phone: null },
	});
	const stage = of("people.changeStatus", [
		change("stage", "core_group", "attendee"),
		change("reason", null, "Moved away"),
		change("openTasksNeedingOwner", null, 2),
	]);
	assert.deepEqual(reviseInput(stage, { reason: "Moved for work" }), {
		personId: maria.id,
		stage: "attendee",
		reason: "Moved for work",
	});
	const remove = of("people.deletePerson", [change("state", "live", "retired"), change("reason", null, "Duplicate")]);
	assert.deepEqual(reviseInput(remove), { personId: maria.id, reason: "Duplicate" });
	const create = review({
		operation: "people.createPerson",
		review: { target: null, changes: [change("displayName", null, "Nora Quinn"), change("stage", null, "prospect")] },
	});
	assert.deepEqual(reviseInput(create, { displayName: "Nora Q." }), { displayName: "Nora Q.", stage: "prospect" });
	const photo = of("people.setPersonPhoto", [change("photo", null, "22222222-2222-4222-8222-222222222222")]);
	assert.deepEqual(reviseInput(photo), { personId: maria.id, uploadId: "22222222-2222-4222-8222-222222222222" });
	assert.deepEqual(reviseInput(of("people.removePersonPhoto", [change("photo", "x", null)])), { personId: maria.id });
});
