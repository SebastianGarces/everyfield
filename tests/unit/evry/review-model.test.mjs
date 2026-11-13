// Evry review card rules (WP-053/ui) that a silent break would turn into a false state on an approval, or a revision
// that changes facts the person did not edit. They run in node against the module the card uses; no browser.
//   AC:UI45-004 AC:INH-REGRESSION-EXPIRED-APPROVAL INV-phase: the card's state comes from the saved review and the
//     time the server said was left: a pending review whose time ran out is expired, an approved one without an
//     outcome is still running, a saved outcome stays saved after its person is gone, and an unconfirmed run (or an
//     old "failed" one) can go again only while its approval lasts. The time left is the server's, whatever the
//     browser's clock says (R5-5).
//   AC:INH-REGRESSION-REVISED-APPROVAL INV-revise: a revision sends the native command's exact reviewed input with only
//     the edited values changed, for every People reviewed write.
//   INV-review-tasks: a Tasks or Follow-up review says statuses, outcomes, channels and dates in words, lists several
//     items by name, opens the task or person once saved, and is approved or cancelled as prepared (no Revise).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	approvable,
	approvalLeft,
	editableChanges,
	fieldLabel,
	isRequired,
	itemField,
	missingRequired,
	openAfter,
	operationTitle,
	phaseOf,
	refusalText,
	retryable,
	reviseInput,
	savedText,
	showsBefore,
	subjectName,
	valueText,
} from "../../../apps/web/src/features/evry/review/model.ts";

const now = "2026-10-21T12:00:00Z";
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
	now,
	...over,
});

test("AC:UI45-004 AC:INH-REGRESSION-EXPIRED-APPROVAL INV-phase: each saved state shows as itself", () => {
	// The time left is the server's expiry minus the server's own time, with no browser clock in it.
	assert.equal(approvalLeft(review()), 600_000);
	assert.equal(approvalLeft(review({ expiresAt: earlier })), -1000);
	assert.equal(approvalLeft(review({ expiresAt: now })), 0);
	assert.equal(phaseOf(review(), false), "pending");
	assert.equal(phaseOf(review(), true), "expired", "the time the server gave ran out");
	assert.equal(phaseOf(review({ status: "expired" }), false), "expired");
	assert.equal(phaseOf(review({ status: "cancelled" }), false), "cancelled");
	// An approval whose reply was lost reads back as approved with no outcome yet: running, never "not approved".
	assert.equal(phaseOf(review({ status: "approved", executing: true }), false), "running");
	assert.equal(phaseOf(review({ status: "approved", outcome: "completed" }), true), "completed");
	assert.equal(phaseOf(review({ status: "approved", outcome: "refused" }), false), "refused");
	assert.equal(phaseOf(review({ status: "approved", outcome: "unknown" }), false), "unconfirmed");
	// A row saved before #245 as "failed" never proved that nothing changed: it is unconfirmed too.
	assert.equal(phaseOf(review({ status: "approved", outcome: "failed" }), false), "unconfirmed");
	const gone = { target: null, changes: [], withheld: true };
	assert.equal(phaseOf(review({ review: gone }), false), "withheld");
	assert.equal(phaseOf(review({ review: gone, status: "approved", outcome: "completed" }), false), "completed");

	assert.equal(retryable(review({ status: "approved", outcome: "unknown" }), false), true);
	assert.equal(retryable(review({ status: "approved", outcome: "failed" }), false), true);
	assert.equal(retryable(review({ status: "approved", outcome: "unknown" }), true), false);
	assert.equal(retryable(review({ status: "approved", outcome: "refused" }), false), false);
	// REQ-EVR-011: a new photo is approvable only while the card shows its exact upload.
	assert.equal(approvable(review({ operation: "people.setPersonPhoto" }), false), false);
	assert.equal(approvable(review({ operation: "people.setPersonPhoto" }), true), true);
	assert.equal(approvable(review({ operation: "people.removePersonPhoto" }), false), true);
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

test("AC:REQ-PPL-026 INV-revise-adult: adult or child is required only until a birth date is entered", () => {
	const change = (field, before, after) => ({ field, before, after });
	const create = (changes) => review({ operation: "people.createPerson", review: { target: null, changes } });
	const base = [change("displayName", null, "Nora Quinn"), change("stage", null, "prospect")];
	const edits = { displayName: "Nora Quinn", stage: "prospect", source: "other", reason: "Met her" };
	const with_ = (extra) =>
		create([...base, change("source", null, "other"), change("reason", null, "Met her"), ...extra]);
	// Without a birth date, an empty adult or child is still the first thing missing.
	assert.equal(isRequired("adultClassification"), true);
	assert.equal(
		missingRequired(with_([change("adultClassification", null, "unknown")]), { ...edits, adultClassification: "" })
			?.field,
		"adultClassification",
	);
	// With a birth date (reviewed or typed in the revision) it is not required, and a typed date wins over the reviewed one.
	assert.equal(isRequired("adultClassification", true), false);
	const dated = with_([change("birthDate", null, "1990-05-01"), change("adultClassification", null, "unknown")]);
	assert.equal(missingRequired(dated, { ...edits, birthDate: "1990-05-01", adultClassification: "" }), null);
	assert.equal(
		missingRequired(dated, { ...edits, birthDate: "", adultClassification: "" })?.field,
		"adultClassification",
	);
});

test("INV-review-tasks: task and follow-up reviews say their values in words and are approved as prepared", () => {
	const task = { kind: "task", id: "44444444-4444-4444-8444-444444444444", label: "Order launch banners" };
	const change = (field, before, after) => ({ field, before, after });
	const of = (operation, target, changes) => review({ operation, review: { target, changes } });

	assert.equal(valueText("status", "not_started"), "Not started");
	assert.equal(valueText("status", "complete"), "Complete");
	assert.equal(valueText("followUp", "no_longer_needed"), "No longer needed");
	assert.equal(valueText("outcome", "contacted"), "Contacted (a conversation happened)");
	assert.equal(valueText("outcome", "attempted_no_contact"), "Attempted, no conversation");
	assert.equal(valueText("outcome", "administrative_completion"), "Administrative completion");
	assert.equal(valueText("channel", "phone"), "Phone call");
	assert.equal(valueText("due", "2026-11-16 America/Chicago"), "Mon, Nov 16, 2026");
	assert.equal(
		valueText("occurredAt", "2026-11-13 14:05 America/Chicago"),
		"Fri, Nov 13, 2026, 2:05 PM (Chicago time)",
	);
	assert.equal(valueText("recurrence", "weekly on Mondays, America/Chicago"), "Weekly on Mondays (America/Chicago)");
	assert.equal(valueText("recurrence", null), "Doesn't repeat");
	assert.equal(valueText("owners", null), "Needs owner");
	assert.equal(valueText("relatedTo", task.id), "A linked record", "an id is never shown");
	assert.equal(fieldLabel("occurredAt"), "When");
	assert.equal(operationTitle("followups.recordOutcome"), "Log a contact");

	const complete = of("tasks.complete", task, [change("status", "not_started", "complete")]);
	assert.equal(savedText(complete), "Saved. Order launch banners is complete.");
	assert.deepEqual(openAfter(complete), { href: `/tasks?task=${task.id}`, label: "Open task" });
	// New Tasks and Follow-up reviews are approved or cancelled as Evry prepared them; People stays revisable.
	assert.deepEqual(editableChanges(complete), []);
	assert.equal(editableChanges(review()).length, 1);
	assert.equal(
		refusalText("conflict", task.label, "tasks.complete"),
		"Order launch banners changed after Evry prepared this, so nothing was saved. Ask Evry to prepare it again.",
	);

	const bulk = of("tasks.bulkComplete", null, [
		change("Order launch banners", "not_started", "complete"),
		change("Buy coffee", "in_progress", "complete"),
	]);
	assert.equal(itemField("tasks.bulkComplete"), "status");
	assert.equal(subjectName(bulk), "2 tasks");
	assert.equal(savedText(bulk), "Saved. 2 tasks are complete.");
	assert.deepEqual(openAfter(bulk), { href: "/tasks", label: "Open Tasks" });
	const checklist = of("tasks.createSubtask", task, [change("Print bulletins", null, "added")]);
	assert.equal(showsBefore(checklist, checklist.review.changes[0]), false, "a new item has no before");

	const log = of("followups.recordOutcome", maria, [
		change("outcome", null, "contacted"),
		change("followUp", "not_started", "complete"),
	]);
	assert.equal(showsBefore(log, log.review.changes[0]), false);
	assert.equal(showsBefore(log, log.review.changes[1]), true, "the follow-up's status before is shown");
	assert.equal(savedText(log), "Saved. The contact with Maria Santos is logged.");
	assert.deepEqual(openAfter(log), { href: `/people/${maria.id}`, label: "Open Maria Santos" });
	// People keeps its own wording.
	assert.equal(savedText(review()), "Saved. Maria Santos is updated.");
});
