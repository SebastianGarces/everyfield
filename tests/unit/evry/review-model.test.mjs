import assert from "node:assert/strict";
import { test } from "node:test";
import {
	approvable,
	carryOverText,
	approvalLeft,
	consequence,
	delayedText,
	digestSchedule,
	documentRefusalText,
	draftRows,
	editableChanges,
	fieldLabel,
	invitationName,
	openCriteria,
	reviewedNotices,
	settingChanges,
	isRequired,
	itemField,
	missingRequired,
	openAfter,
	operationTitle,
	peopleResult,
	phaseOf,
	refusalText,
	retryable,
	reviseInput,
	savedText,
	shownChanges,
	shownNotes,
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
	assert.equal(approvalLeft(review()), 600_000);
	assert.equal(approvalLeft(review({ expiresAt: earlier })), -1000);
	assert.equal(approvalLeft(review({ expiresAt: now })), 0);
	assert.equal(phaseOf(review(), false), "pending");
	assert.equal(phaseOf(review(), true), "expired", "the time the server gave ran out");
	assert.equal(phaseOf(review({ status: "expired" }), false), "expired");
	assert.equal(phaseOf(review({ status: "cancelled" }), false), "cancelled");
	assert.equal(phaseOf(review({ status: "approved", executing: true }), false), "running");
	assert.equal(phaseOf(review({ status: "approved", outcome: "completed" }), true), "completed");
	assert.equal(phaseOf(review({ status: "approved", outcome: "refused" }), false), "refused");
	assert.equal(phaseOf(review({ status: "approved", outcome: "unknown" }), false), "unconfirmed");
	assert.equal(phaseOf(review({ status: "approved", outcome: "failed" }), false), "unconfirmed");
	const gone = { target: null, changes: [], withheld: true };
	assert.equal(phaseOf(review({ review: gone }), false), "withheld");
	assert.equal(phaseOf(review({ review: gone, status: "approved", outcome: "completed" }), false), "completed");

	assert.equal(retryable(review({ status: "approved", outcome: "unknown" }), false), true);
	assert.equal(retryable(review({ status: "approved", outcome: "failed" }), false), true);
	assert.equal(retryable(review({ status: "approved", outcome: "unknown" }), true), false);
	assert.equal(retryable(review({ status: "approved", outcome: "refused" }), false), false);
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
	assert.equal(isRequired("adultClassification"), true);
	assert.equal(
		missingRequired(with_([change("adultClassification", null, "unknown")]), { ...edits, adultClassification: "" })
			?.field,
		"adultClassification",
	);
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
	assert.equal(savedText(review()), "Saved. Maria Santos is updated.");
});

test("INV-review-judgments: a recorded judgment's review shows exactly what was given, in the People screens' words", async () => {
	const { afterOnly, editableChanges, fieldLabel, valueText } =
		await import("../../../apps/web/src/features/evry/review/model.ts");
	assert.equal(fieldLabel("chemistry"), "Team chemistry");
	assert.equal(valueText("chemistry", { rating: "concern", notes: "Needs time" }), "Concern · Needs time");
	assert.equal(valueText("committed", { score: 4, notes: null }), "4 of 5");
	assert.equal(valueText("result", "qualified_with_notes"), "Qualified with notes");
	assert.equal(valueText("occurredOn", "2026-10-12"), "Oct 12, 2026");
	assert.equal(valueText("kind", "core_group"), "Core group");
	assert.equal(valueText("commitment", "withdrawn"), "Withdrawn");
	const interview = { operation: "people.createInterview" };
	assert.equal(afterOnly(interview, "maturity"), true);
	assert.equal(afterOnly(interview, "stage"), false);
	assert.equal(afterOnly({ operation: "people.correctPersonRecord" }, "occurredOn"), false);
	assert.equal(afterOnly({ operation: "people.mergePeople" }, "keeps"), true);
	for (const operation of [
		"people.createInterview",
		"people.createAssessment",
		"people.mergePeople",
		"people.unmergePeople",
	])
		assert.deepEqual(
			editableChanges({
				operation,
				review: { target: null, changes: [{ field: "occurredOn", before: null, after: "2026-10-12" }] },
			}),
			[],
			operation,
		);
});

const church = { kind: "plant", id: "22222222-2222-4222-8222-222222222222", label: "Hope Fellowship" };
const CORE = { phase: 1, name: "Core Group Development" };
const move = (to, direction, open) =>
	review({
		operation: "phases.transition",
		review: {
			target: church,
			changes: [
				{ field: "phase", before: CORE, after: to },
				{ field: "direction", before: null, after: direction },
				{ field: "reason", before: null, after: "Ready for launch teams" },
				...(open ? [{ field: "openCriteria", before: null, after: open }] : []),
			],
		},
	});

test("INV-phase-review: a phase move names its phases, labels a move backward and never calls the church ready", () => {
	const open = [{ label: "30 committed adults", status: "no data yet" }];
	const forward = move({ phase: 2, name: "Launch Team Formation" }, "forward", open);
	assert.equal(valueText("phase", CORE), "Core Group Development");
	assert.equal(valueText("direction", "forward"), "Forward, to the next phase");
	assert.deepEqual(openCriteria(forward), open);
	assert.doesNotMatch(consequence(forward), /\bis ready\b/);
	const backward = move({ phase: 0, name: "Discovery" }, "backward", null);
	assert.equal(valueText("direction", "backward"), "Backward, to an earlier phase");
	assert.equal(consequence(backward), "This is a move backward. The phase journey keeps every earlier move.");
	assert.equal(openCriteria(backward), null);
	assert.deepEqual(
		editableChanges(forward).map((c) => c.field),
		["reason"],
	);
	assert.deepEqual(reviseInput(forward, { reason: "Teams are forming" }), { toPhase: 2, reason: "Teams are forming" });
});

test("INV-phase-review: a signal review shows the signal's name and rebuilds its exact input", () => {
	const PRAYER = { key: "prayer_rhythm_established", label: "Corporate prayer rhythm established" };
	const facts = [
		{ field: "signal", before: null, after: PRAYER },
		{ field: "value", before: null, after: "yes" },
		{ field: "asOf", before: null, after: "2026-11-09" },
		{ field: "detail", before: null, after: "We started prayer and fasting this week." },
	];
	const attest = review({ operation: "signals.attest", review: { target: church, changes: facts } });
	assert.equal(valueText("signal", PRAYER), "Corporate prayer rhythm established");
	assert.equal(valueText("value", "not_yet"), "Not yet");
	assert.equal(valueText("asOf", "today"), "Today, when you approve");
	assert.deepEqual(reviseInput(attest, { detail: "We began praying and fasting together." }), {
		key: PRAYER.key,
		value: "yes",
		asOf: "2026-11-09",
		detail: "We began praying and fasting together.",
	});
	const retract = review({
		operation: "signals.correct",
		review: { target: church, changes: [facts[0], { field: "value", before: "yes", after: "retracted" }] },
	});
	assert.deepEqual(reviseInput(retract), { action: "retract", key: PRAYER.key });
	const reaffirm = review({ operation: "signals.reaffirm", review: { target: church, changes: [facts[0]] } });
	assert.deepEqual([reviseInput(reaffirm), editableChanges(reaffirm)], [{ key: PRAYER.key }, []]);
});

test("INV-notification-review a settings review groups each category's channels, a digest review names its schedule, and neither can be revised", () => {
	const review = (operation, changes) => ({ operation, review: { target: null, changes } });
	const settings = review("notifications.setPreferences", [
		{ field: "task_due.email", before: true, after: false },
		{ field: "task_due.in_app", before: true, after: true },
		{ field: "task_overdue.email", before: true, after: false },
	]);
	assert.deepEqual(settingChanges(settings), [
		{
			category: "task_due",
			channels: [
				{ channel: "Email", before: true, after: false },
				{ channel: "In-app", before: true, after: true },
			],
		},
		{ category: "task_overdue", channels: [{ channel: "Email", before: true, after: false }] },
	]);
	assert.equal(digestSchedule({ cadence: "weekly", weekday: 0, hour: 16 }), "Weekly on Sundays at 4:00 PM");
	assert.equal(digestSchedule({ cadence: "daily", weekday: 0, hour: 8 }), "Daily at 8:00 AM");
	const marks = review("notifications.markSelectedRead", [
		{
			field: "notice",
			before: { id: "n1", title: "Due", category: "task_due", at: "2026-11-07T15:00:00.000Z", zone: "America/Chicago" },
			after: "read",
		},
	]);
	assert.deepEqual(
		reviewedNotices(marks).map((n) => n.id),
		["n1"],
	);
	for (const r of [settings, marks]) assert.deepEqual(editableChanges(r), []);
});

test("AC:HH-05 INV-partial: a saved change that left anyone out counts who changed and never reads as done for everyone", () => {
	const person = (n, outcome) => ({
		id: `0000000${n}-1111-4111-8111-111111111111`,
		label: `Nguyen ${n}`,
		outcome,
		...(outcome === "unchanged" && { reason: "Already at this address" }),
	});
	const saved = (people) =>
		review({ status: "approved", outcome: "completed", operation: "people.propagateAddress", receipt: { people } });
	const all = [1, 2, 3, 4].map((n) => person(n, "changed"));
	assert.equal(peopleResult(saved(all)), "Saved for all 4");
	const partial = [...all.slice(0, 3), person(4, "unchanged")];
	assert.equal(peopleResult(saved(partial)), "3 of 4 changed");
	assert.doesNotMatch(peopleResult(saved(partial)), /all|saved/i);
	assert.equal(peopleResult(review({ status: "approved", outcome: "completed", receipt: {} })), null);
});

test("INV-carry-over: a conversion revision keeps every link and ends only the ones ticked to end", () => {
	const grace = "66666666-6666-4666-8666-666666666666";
	const network = "44444444-4444-4444-8444-444444444444";
	const link = (id, organization, kind) => ({
		field: `link:${id}`,
		before: { organization, kind, share: [] },
		after: { carries: true, share: [] },
	});
	const convert = review({
		operation: "discovery.convertToPlant",
		review: {
			target: { kind: "account", id: "a", label: "Morgan Hale" },
			changes: [
				{ field: "church", before: null, after: "Grace Point" },
				{ field: "city", before: null, after: "Austin" },
				link(grace, "Grace Austin", "Sending church"),
				link(network, "Hill Country Network", "Network"),
			],
		},
	});
	assert.deepEqual(
		editableChanges(convert).map((c) => c.field),
		[`link:${grace}`, `link:${network}`],
	);
	assert.deepEqual(reviseInput(convert), { name: "Grace Point", city: "Austin", end: [] });
	assert.deepEqual(
		reviseInput(convert, {
			[`link:${grace}`]: JSON.stringify({ carries: true, share: [] }),
			[`link:${network}`]: JSON.stringify({ carries: false, share: [] }),
		}),
		{ name: "Grace Point", city: "Austin", end: [network] },
	);
	assert.equal(carryOverText({ carries: true, share: [] }), "Stays connected. It sees nothing new.");
	assert.equal(carryOverText({ carries: false, share: [] }), "The connection ends.");
});

test("INV-meetings-review: a Meetings review is revised by asking Evry, and its lists read one entry per line", async () => {
	const { editableChanges, fieldLabel, valueText } =
		await import("../../../apps/web/src/features/evry/review/model.ts");
	const review = {
		operation: "meetings.finalizeAttendance",
		review: {
			target: { kind: "meeting", id: "x", label: "Vision Meeting #2" },
			changes: [
				{ field: "attended", before: null, after: ["Maria Santos (first Vision)", "Alex Rivera"] },
				{ field: "tasks", before: null, after: ["Follow up with Maria Santos (needs an owner)"] },
			],
		},
	};
	assert.deepEqual(editableChanges(review), []);
	assert.equal(fieldLabel("tasks", "meetings.finalizeAttendance"), "Tasks it creates");
	assert.equal(fieldLabel("tasks", "privacy.setSharing"), "Tasks");
	assert.equal(fieldLabel("presence:Maria Santos"), "Maria Santos");
	assert.equal(valueText("attended", review.review.changes[0].after), "Maria Santos (first Vision)\nAlex Rivera");
});

test("INV-church-digest-review a church digest schedule review reads as the church digest, opens Church settings and is revised only by asking Evry", async () => {
	const { fieldLabel, isSettings, operationTitle, settingsLink, valueText } =
		await import("../../../apps/web/src/features/evry/review/model.ts");
	const schedule = review({
		operation: "church.digestSchedule.set",
		review: {
			target: { kind: "church", id: "x", label: "Hope Fellowship" },
			changes: [
				{ field: "digestSchedule", before: "Weekly on Sundays at 4:00 PM", after: "Weekly on Mondays at 8:00 AM" },
			],
		},
	});
	assert.equal(isSettings(schedule.operation), true);
	assert.deepEqual(settingsLink(schedule.operation), { href: "/settings/church", label: "Open Church settings" });
	assert.equal(fieldLabel("digestSchedule", schedule.operation), "Church digest");
	assert.equal(valueText("digestSchedule", "Off"), "Off");
	assert.equal(valueText("digestSchedule", "Daily at 7:00 AM"), "Daily at 7:00 AM");
	assert.deepEqual(editableChanges(schedule), []);
	assert.equal(operationTitle(schedule.operation), "Change the church digest schedule");
});

test("INV-evry-recipes: an invitation review is named after its meeting, new or existing, and opens the meeting once done", () => {
	const meeting = { kind: "meeting", id: "44444444-4444-4444-8444-444444444444", label: "Vision night" };
	const step = (title) => ({
		field: "meeting",
		before: null,
		after: { title, when: "Tue, Oct 20, 2026, 6:30 PM CDT", venue: "Northside Library", isNew: true },
	});
	const created = review({
		operation: "evry.prepareMeetingInvitation",
		review: { target: null, changes: [step("Vision Meeting #3")] },
	});
	assert.equal(invitationName(created), "Vision Meeting #3");
	const existing = review({
		operation: "evry.reuseRecipe",
		review: { target: meeting, changes: [step("Vision night")] },
	});
	assert.equal(invitationName(existing), "Vision night");
	assert.equal(openAfter(created), null);
	assert.deepEqual(
		openAfter({ ...existing, status: "approved", outcome: "completed", receipt: { meetingId: meeting.id } }),
		{
			href: `/meetings/${meeting.id}`,
			label: "Open the meeting",
		},
	);
});

test("a completed invitation card says its email is delayed, in its text and its screen-reader text, and nothing on it says the email was sent", () => {
	const card = (operation, label, changes, notes) =>
		review({
			operation,
			status: "approved",
			outcome: "completed",
			mailDelayed: true,
			review: { target: { kind: "invitation", id: "i", label }, changes, notes },
		});
	const cards = [
		card(
			"seats.invite",
			"Hope Fellowship",
			[
				{ field: "invitation", before: null, after: "ana@example.test" },
				{ field: "role", before: null, after: "admin" },
			],
			["Everyfield emails ana@example.test a link to join as an Admin. It works for 30 days."],
		),
		card(
			"seats.resendInvitation",
			"jordan@example.test",
			[{ field: "invitation", before: "pending", after: "sent_again" }],
			["Everyfield emails jordan@example.test a new link. The earlier link stops working."],
		),
		...["sending church", "network"].map((after) =>
			card(
				"associations.invite",
				"Grace Austin",
				[
					{ field: "connection", before: null, after },
					{ field: "recipientEmail", before: null, after: "connect@example.test" },
				],
				["Nothing is shared until they accept."],
			),
		),
	];
	const said = cards.map((c) => [
		delayedText(c),
		...shownChanges(c).map((x) => `${fieldLabel(x.field)}: ${valueText(x.field, x.after)}`),
		...shownNotes(c),
	]);
	const connection = [
		"The invitation to Grace Austin is saved, but its email is delayed. They have 30 days to accept. You do not need to send it again unless it expires.",
		"Email: connect@example.test",
		"Nothing is shared until they accept.",
	];
	assert.deepEqual(said, [
		[
			"The invitation to ana@example.test is saved, but its email is delayed. You do not need to send it again unless it expires.",
			"Invitation: ana@example.test",
			"Role: Admin",
		],
		[
			"The invitation to jordan@example.test is saved with a new link, but its email is delayed. The old link no longer works. You do not need to resend it unless it expires.",
			"Invitation: New link",
		],
		connection.toSpliced(1, 0, "Connection: Sending church"),
		connection.toSpliced(1, 0, "Connection: Network"),
	]);
	for (const c of cards) {
		assert.equal(savedText(c), delayedText(c));
		for (const over of [{ mailDelayed: undefined }, { outcome: null }, { outcome: "refused" }, { outcome: "failed" }]) {
			const plain = { ...c, ...over };
			assert.equal(delayedText(plain), null);
			assert.deepEqual(shownChanges(plain), c.review.changes);
			assert.deepEqual(shownNotes(plain), c.review.notes);
		}
	}
	assert.equal(delayedText(review({ outcome: "completed", mailDelayed: true })), null);
});

test("INV-evry-collision: a task handoff that no longer applies is not shown as already saved", () => {
	const change = (field, before, after) => ({ field, before, after });
	const handoff = change("openTasksNeedingOwner", null, 1);
	const rows = (changes, earlier) =>
		draftRows({ operation: "people.changeStatus", review: { target: null, changes, earlier } }).map((r) => [
			r.field,
			r.already,
		]);
	const move = change("stage", "leader", "prospect");
	assert.deepEqual(rows([move], [move, handoff]), [["stage", false]]);
	assert.deepEqual(rows([move, handoff], [move, handoff]), [
		["stage", false],
		["openTasksNeedingOwner", false],
	]);
	assert.deepEqual(rows([], [change("city", "Elgin", "Austin")]), [["city", true]]);
});

test("an approved end shows plain words, and a withdrawn person never reads as having finished", async () => {
	const { pipelineRefusalText, reviewTitle } = await import("../../../apps/web/src/features/evry/review/model.ts");
	for (const label of ["Completed", "Withdrawn"]) {
		const ended = review({
			operation: "development.updateEnrollment",
			review: { target: maria, changes: [{ field: "status", before: "Active", after: label }] },
			status: "approved",
			outcome: "completed",
		});
		assert.equal(reviewTitle(ended), "End an enrollment");
		assert.equal(savedText(ended), `Saved. Maria Santos's enrollment has ended as ${label}.`);
		assert.doesNotMatch(savedText(ended), /finished/);
		assert.deepEqual(
			[fieldLabel("status"), valueText("status", "Active"), valueText("status", label)],
			["Status", "Active", label],
		);
	}
	const changed = review({
		operation: "development.updateEnrollment",
		review: { target: maria, changes: [{ field: "cohort", before: "Fall", after: "Winter" }] },
	});
	assert.equal(reviewTitle(changed), "Update an enrollment");
	assert.equal(savedText(changed), "Saved. Maria Santos's enrollment is updated.");
	const refusal = (code) => pipelineRefusalText(code, "development.updateEnrollment", "Maria Santos");
	assert.equal(refusal("enrollment_ended"), "Maria Santos's enrollment has already ended, so nothing was saved.");
	assert.match(refusal("revision_conflict"), /^Maria Santos's enrollment changed after Evry prepared this/);
	assert.match(refusal("access_denied"), /^Your seat no longer allows this change/);
});

test("an account's own document review says it is private, never that it is for a church to edit", () => {
	const saving = (operation, over) =>
		review({
			operation,
			review: { target: null, changes: [{ field: "title", before: null, after: "Hopes" }], ...over },
		});
	for (const operation of ["documents.saveNative", "documents.importTextOrWord"]) {
		assert.equal(
			consequence(saving(operation, { private: true })),
			"The new document opens in Documents. It's private: only you can open it.",
		);
		assert.match(consequence(saving(operation, {})), /for your church to edit\.$/);
	}
	assert.match(documentRefusalText("access_denied", true), /^Your account no longer allows/);
	assert.match(documentRefusalText("access_denied"), /^Your seat no longer allows/);
});
