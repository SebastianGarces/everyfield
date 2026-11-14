// What a result card says (WP-051 slice 2). It runs in node against the module the card uses; no browser.
//   AC:EVRY-CONTEXT-BOUNDS INV-households-card: a listHouseholds result is a Households card with household words, a
//     household icon, no link and no person wording.
//   INV-household-detail: getHousehold and getHouseholdMembers name people in the count; member rows show the household
//     role and link to the person; no household row links to /people/.
//   INV-result-card-*: every non-person read has its own title, count noun and rows (T-160): tags, a person's tags and
//     skills, history, the pipeline, the import template, preview and receipt, and the export as a count card.
//   INV-result-card-duplicate-pairs: listDuplicatePairs lists each imported person with the person it may duplicate.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardView } from "../../../apps/web/src/features/evry/conversation/resultView.ts";

const H = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";
const household = (id = H, memberCount = "2", city = "North Ridgeville") => ({
	kind: "household",
	id,
	label: "Okafor household",
	fields: { name: "Okafor household", city, memberCount, revision: "1" },
});
const member = (id, label, role) => ({ kind: "person", id, label, fields: { role, city: null, householdId: H } });
const result = (operation, rows, extra = {}) => ({
	operation,
	status: "available",
	rows,
	total: rows.length,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
	...extra,
});

test("AC:EVRY-CONTEXT-BOUNDS INV-households-card: one household reads as a Households card with city, member count and no link", () => {
	const view = cardView("people.listHouseholds", result("people.listHouseholds", [household()]), null);
	assert.equal(view.title, "Households");
	assert.equal(view.summary, "1 household");
	assert.equal(view.icon, "household");
	assert.deepEqual(view.facts, []);
	const [row] = view.rows;
	assert.deepEqual(
		[row.name, row.line, row.avatar, row.href, row.mark],
		["Okafor household", "North Ridgeville · 2 members", "household", null, null],
	);
});

test("INV-households-card: the count words, 'N of M', the member word and a missing city", () => {
	const two = cardView(
		"people.listHouseholds",
		result("people.listHouseholds", [household(H, "1"), household(P1, "3", "")]),
		null,
	);
	assert.equal(two.summary, "2 households");
	assert.deepEqual(
		two.rows.map((r) => r.line),
		["North Ridgeville · 1 member", "3 members"],
	);
	const page = cardView(
		"people.listHouseholds",
		result("people.listHouseholds", [household()], { total: 30, completeness: "partial", next: 2 }),
		null,
	);
	assert.equal(page.summary, "1 of 30");
	assert.deepEqual(page.facts, ["More households match. Ask Evry for page 2."]);
});

test("INV-households-card: an empty result says so in household words", () => {
	const view = cardView("people.listHouseholds", result("people.listHouseholds", []), null);
	assert.equal(view.summary, "0 households");
	assert.deepEqual(view.facts, ["No household in this church matches, or you can't see them."]);
	const withheld = cardView(
		"people.listHouseholds",
		result("people.listHouseholds", [], { total: null, completeness: "partial", withheldRows: 1 }),
		null,
	);
	assert.deepEqual(withheld.facts, [
		"No household in this church matches, or you can't see them.",
		"1 row is no longer available and not shown.",
		"Only the first matches are shown.",
	]);
});

test("INV-household-detail: titles, a people count, member roles and links; the household row has none", () => {
	const rows = [household(), member(P1, "James Okafor", "head"), member(P2, "Ruth Allen", "spouse")];
	const one = cardView("people.getHousehold", result("people.getHousehold", rows), null);
	assert.equal(one.title, "Household");
	assert.equal(one.summary, "2 people");
	const members = cardView("people.getHouseholdMembers", result("people.getHouseholdMembers", rows), null);
	assert.equal(members.title, "Household members");
	assert.equal(members.summary, "2 people");
	assert.deepEqual(
		one.rows.map((r) => [r.name, r.line, r.href]),
		[
			["Okafor household", "North Ridgeville · 2 members", null],
			["James Okafor", "Head", `/people/${P1}`],
			["Ruth Allen", "Spouse", `/people/${P2}`],
		],
	);
	assert.ok(one.rows.filter((r) => r.avatar === "household").every((r) => r.href === null));
	assert.equal(
		cardView(
			"people.getHouseholdMembers",
			result("people.getHouseholdMembers", [household(), member(P1, "James Okafor", "head")]),
			null,
		).summary,
		"1 person",
	);
});

test("INV-household-detail: only person rows link; a person row keeps its city and stage", () => {
	const person = cardView(
		"people.listPeople",
		result("people.listPeople", [
			{ kind: "person", id: P1, label: "Alex", fields: { city: "Chicago", stage: "prospect" } },
		]),
		null,
	);
	assert.deepEqual(
		[person.title, person.summary, person.rows[0].href, person.rows[0].mark],
		["People", "1 person", `/people/${P1}`, { kind: "stage", stage: "prospect" }],
	);
});

test("a message read is a Messages card with the send time, no person wording and no avatar", () => {
	const friday = {
		kind: "message",
		id: H,
		label: "Friday note",
		fields: {
			state: "scheduled",
			sendsAt: "Fri 2026-11-06 09:00",
			sendsAtInstant: "2026-11-06T15:00:00Z",
			zone: "America/Chicago",
		},
	};
	const draft = { kind: "message", id: P1, label: "Untitled draft", fields: { state: "draft", sendsAt: null } };
	const view = cardView("communication.list", result("communication.list", [friday, draft]), null);
	assert.equal(view.title, "Messages");
	assert.equal(view.summary, "2 messages");
	assert.equal(view.icon, "message");
	assert.deepEqual(
		view.rows.map((r) => [r.name, r.line, r.avatar, r.href]),
		[
			["Friday note", "Sends Fri, Nov 6, 9:00 AM CST", null, null],
			["Untitled draft", "Draft", null, null],
		],
	);
	const none = cardView("communication.list", result("communication.list", [], { status: "not_found" }), null);
	assert.deepEqual(none.facts.slice(0, 1), ["No draft or scheduled message in this church matches."]);
});

// ---------- each non-person read has its own card (T-160)
const T1 = "44444444-4444-4444-8444-444444444441";
const T2 = "44444444-4444-4444-8444-444444444442";
const T3 = "44444444-4444-4444-8444-444444444443";
const tag = (id, name, linkedPeople) => ({
	kind: "tag",
	id,
	label: name,
	fields: { name, color: "blue", linkedPeople, revision: "1" },
});
const linksNoPerson = (view) => view.rows.every((r) => r.href === null && r.avatar !== "person");

test("INV-result-card-tags: listTags is a Tags card with tag rows, a tag count and no person link or avatar", () => {
	const three = cardView(
		"people.listTags",
		result("people.listTags", [tag(T1, "Volunteers", "12"), tag(T2, "Worship team", "1"), tag(T3, "New", "0")]),
		null,
	);
	assert.equal(three.title, "Tags");
	assert.equal(three.summary, "3 tags");
	assert.equal(three.icon, "tag");
	assert.deepEqual(
		three.rows.map((r) => [r.name, r.line, r.avatar, r.href, r.mark]),
		[
			["Volunteers", "12 people", "tag", null, null],
			["Worship team", "1 person", "tag", null, null],
			["New", "0 people", "tag", null, null],
		],
	);
	assert.deepEqual(three.facts, []);
	assert.equal(
		cardView("people.listTags", result("people.listTags", [tag(T1, "Volunteers", "12")]), null).summary,
		"1 tag",
	);
	assert.deepEqual(cardView("people.listTags", result("people.listTags", []), null).facts, [
		"This church has no tags yet, or you can't see them.",
	]);
});

test("INV-result-card-person-fields: a person's tags and skills have their own titles and nouns and no /people/ link", () => {
	const tags = cardView(
		"people.getPersonTags",
		result("people.getPersonTags", [
			{ kind: "tag", id: T1, label: "Volunteers", fields: { name: "Volunteers", color: "blue" } },
			{ kind: "tag", id: T2, label: "Greeters", fields: { name: "Greeters", color: "green" } },
		]),
		null,
	);
	assert.deepEqual([tags.title, tags.summary, tags.icon], ["Assigned tags", "2 tags", "tag"]);
	assert.deepEqual(
		tags.rows.map((r) => [r.name, r.line]),
		[
			["Volunteers", null],
			["Greeters", null],
		],
	);
	assert.ok(linksNoPerson(tags));
	const skill = (id, name, category, proficiency) => ({
		kind: "skill",
		id,
		label: name,
		fields: { name, category, proficiency },
	});
	const skills = cardView(
		"people.getPersonSkills",
		result(
			"people.getPersonSkills",
			[skill(T1, "Guitar", "worship", "advanced"), skill(T2, "Sound desk", "tech", null)],
			{
				exclusions: ["skill notes"],
			},
		),
		null,
	);
	assert.deepEqual([skills.title, skills.summary, skills.icon], ["Skills", "2 skills", "skill"]);
	assert.deepEqual(
		skills.rows.map((r) => [r.name, r.line, r.avatar]),
		[
			["Guitar", "Worship · Advanced", "skill"],
			["Sound desk", "Tech", "skill"],
		],
	);
	assert.ok(linksNoPerson(skills));
	assert.deepEqual(skills.facts, ["Not included: skill notes."]);
	assert.equal(
		cardView("people.getPersonSkills", result("people.getPersonSkills", [skill(T1, "Guitar", "worship", null)]), null)
			.summary,
		"1 skill",
	);
});

test("INV-result-card-history: getActivities is a History card that names what happened, with no note text and no people wording", () => {
	// Midday UTC, so the date reads the same in any time zone the test runs in.
	const at = "2026-11-03T12:00:00.000Z";
	const activity = (id, label, fields) => ({
		kind: "activity",
		id,
		label,
		fields: { personId: P1, occurredAt: at, ...fields },
	});
	const rows = [
		activity(T1, "Note", { kind: "note", revision: "2" }),
		activity(T2, "Note removed", { kind: "note_removed", revision: "3" }),
		activity(T3, "Stage", { kind: "stage_changed", from: "prospect", to: "attendee" }),
		activity(H, "commitment_recorded", {
			kind: "activity",
			action: "commitment_recorded",
			from: null,
			to: null,
			householdFrom: null,
			householdTo: null,
		}),
		activity(P2, "updated", {
			kind: "activity",
			action: "updated",
			from: null,
			to: null,
			householdFrom: null,
			householdTo: "Okafor household (head)",
		}),
	];
	const view = cardView(
		"people.getActivities",
		result("people.getActivities", rows, {
			total: null,
			completeness: "partial",
			next: 2,
			exclusions: ["note bodies"],
		}),
		null,
	);
	assert.deepEqual([view.title, view.summary, view.icon], ["History", "5 activities", "activity"]);
	assert.deepEqual(
		view.rows.map((r) => [r.name, r.line]),
		[
			["Note added", "Nov 3, 2026"],
			["Note removed", "Nov 3, 2026"],
			["Stage changed", "Prospect → Attendee · Nov 3, 2026"],
			["Commitment recorded", "Nov 3, 2026"],
			["Details changed", "No household → Okafor household (head) · Nov 3, 2026"],
		],
	);
	assert.ok(linksNoPerson(view));
	assert.deepEqual(view.facts, ["More activities match. Ask Evry for page 2.", "Not included: note bodies."]);
	assert.doesNotMatch(JSON.stringify(view), /\bpeople\b|\bperson\b/i);
	assert.equal(cardView("people.getActivities", result("people.getActivities", [rows[0]]), null).summary, "1 activity");
});

test("INV-result-card-pipeline: getPipelineData is a Pipeline card of linked people with stage marks", () => {
	const card = (id, label, stage) => ({
		kind: "person",
		id,
		label,
		fields: { city: "Austin", stage, column: stage, inactivity: "none", coverage: "uncovered" },
	});
	const view = cardView(
		"people.getPipelineData",
		result("people.getPipelineData", [card(P1, "James Okafor", "interviewed"), card(P2, "Ruth Allen", "prospect")], {
			total: 30,
			completeness: "partial",
			next: 2,
			exclusions: ["email", "phone"],
		}),
		null,
	);
	assert.deepEqual([view.title, view.summary, view.icon], ["Pipeline", "2 of 30", "people"]);
	assert.deepEqual(
		view.rows.map((r) => [r.name, r.line, r.avatar, r.href, r.mark]),
		[
			["James Okafor", "Austin", "person", `/people/${P1}`, { kind: "stage", stage: "interviewed" }],
			["Ruth Allen", "Austin", "person", `/people/${P2}`, { kind: "stage", stage: "prospect" }],
		],
	);
	assert.deepEqual(view.facts, ["More people match. Ask Evry for page 2.", "Not included: email, phone."]);
});

const DIGEST = "a".repeat(64);
test("INV-result-card-import: the template, a preview and a receipt read as a file and its rows, not as people", () => {
	const template = cardView(
		"people.generateCsvTemplate",
		result(
			"people.generateCsvTemplate",
			[
				{
					kind: "file",
					id: "people-import-template.csv",
					label: "people-import-template.csv",
					fields: { mediaType: "text/csv; charset=utf-8", columns: "first_name,last_name,email,phone\r\n" },
				},
			],
			{ exclusions: ["church data"] },
		),
		null,
	);
	assert.deepEqual([template.title, template.summary, template.icon], ["Import template", "1 file", "file"]);
	assert.deepEqual(
		template.rows.map((r) => [r.name, r.line, r.avatar, r.href]),
		[["people-import-template.csv", "4 columns", "file", null]],
	);
	assert.deepEqual(template.facts, ["Not included: church data."]);

	const file = {
		kind: "file",
		id: DIGEST,
		label: "Import preview",
		fields: {
			fileDigest: DIGEST,
			reviewDigest: DIGEST,
			rows: "3",
			valid: "2",
			invalid: "1",
			existingDuplicates: "1",
			withinFileDuplicates: "1",
		},
	};
	const valid = (n, name, suggested, extra = {}) => ({
		kind: "import",
		id: String(n),
		label: name,
		fields: {
			status: "valid",
			suggested,
			duplicatePersonIds: null,
			withinFileDuplicateOf: null,
			problems: null,
			...extra,
		},
	});
	const preview = cardView(
		"people.previewImport",
		result(
			"people.previewImport",
			[
				file,
				valid(2, "Ada Park", "create_and_review", { duplicatePersonIds: P1 }),
				{
					kind: "import",
					id: "3",
					label: "Row 3",
					fields: {
						status: "invalid",
						suggested: null,
						duplicatePersonIds: null,
						withinFileDuplicateOf: null,
						problems: "name_required,invalid_email",
					},
				},
				valid(4, "Ada Park", "skip", { withinFileDuplicateOf: "2" }),
				{ kind: "person", id: P1, label: "Ada Parker", fields: { match: "exact" } },
			],
			{ total: 3, exclusions: ["contact values", "notes"] },
		),
		null,
	);
	assert.deepEqual([preview.title, preview.summary, preview.icon], ["Import preview", "3 rows", "file"]);
	assert.deepEqual(
		preview.rows.map((r) => [r.name, r.line, r.avatar, r.href, r.mark]),
		[
			["Your file", "2 valid rows · 1 invalid row · 1 possible duplicate", "file", null, null],
			["Row 2", "Ada Park · Add, then review the possible duplicate", null, null, null],
			["Row 3", "Name required · Email not valid", null, null, { kind: "status", text: "Invalid", warn: true }],
			["Row 4", "Ada Park · Same as row 2 · Skip suggested", null, null, null],
			["Ada Parker", null, "person", `/people/${P1}`, { kind: "match", exact: true }],
		],
	);

	const receipt = cardView(
		"people.getImportReceipt",
		result(
			"people.getImportReceipt",
			[
				{ kind: "file", id: H, label: "partial", fields: { created: "1", skipped: "1", failed: "1", remaining: "0" } },
				{ kind: "import", id: "2", label: "created", fields: { status: "created", personId: P1, reason: null } },
				{ kind: "person", id: P1, label: "Imported person", fields: { row: "2" } },
				{ kind: "import", id: "3", label: "skipped", fields: { status: "skipped", personId: null, reason: null } },
				{ kind: "import", id: "4", label: "failed", fields: { status: "failed", personId: null, reason: "invalid" } },
			],
			{ total: 3 },
		),
		null,
	);
	assert.deepEqual([receipt.title, receipt.summary], ["Import results", "3 rows"]);
	assert.deepEqual(
		receipt.rows.map((r) => [r.name, r.line, r.href, r.mark]),
		[
			["Import partly complete", "1 added · 1 skipped · 1 failed", null, null],
			["Row 2", null, `/people/${P1}`, { kind: "status", text: "Added", warn: false }],
			["Row 3", null, null, { kind: "status", text: "Skipped", warn: false }],
			["Row 4", "Not valid", null, { kind: "status", text: "Failed", warn: true }],
		],
	);
	for (const view of [template, preview, receipt]) assert.doesNotMatch(view.summary, /person|people/);
});

test("INV-result-card-export: exportPeople is a count card: the export count, no rows and where the file is", () => {
	const exported = (matched) =>
		result(
			"people.exportPeople",
			[
				{
					kind: "file",
					id: "export",
					label: "people-2026-11-11.csv",
					fields: {
						matched: String(matched),
						returned: String(matched),
						completeness: "complete",
						mediaType: "text/csv; charset=utf-8",
					},
				},
			],
			{ total: matched, exclusions: ["contact values", "notes", "csv bytes"] },
		);
	const view = cardView("people.exportPeople", exported(203), null);
	assert.deepEqual(
		[view.title, view.summary, view.icon, view.rows, view.facts],
		["Directory export", "203 people", "file", [], ["Download the file from the People page."]],
	);
	assert.equal(cardView("people.exportPeople", exported(1), null).summary, "1 person");
});

test("INV-result-card-duplicate-pairs: listDuplicatePairs is a Duplicates to review card: each imported person links to their page with the person they may duplicate", () => {
	const pair = (id, label, mayDuplicate) => ({
		kind: "person",
		id,
		label,
		fields: { mayDuplicateId: P2, mayDuplicate },
	});
	const exclusions = ["pairs marked not a duplicate", "retired or merged people", "pairs no import flagged"];
	const view = cardView(
		"people.listDuplicatePairs",
		result(
			"people.listDuplicatePairs",
			[pair(P1, "John Smith", "Jon Smith"), pair(H, "Casey Brooks", "Casey Morgan")],
			{
				exclusions,
			},
		),
		null,
	);
	assert.deepEqual([view.title, view.summary, view.icon], ["Duplicates to review", "2 people", "people"]);
	assert.deepEqual(
		view.rows.map((r) => [r.name, r.line, r.avatar, r.href, r.mark]),
		[
			["John Smith", "May duplicate Jon Smith", "person", `/people/${P1}`, null],
			["Casey Brooks", "May duplicate Casey Morgan", "person", `/people/${H}`, null],
		],
	);
	assert.deepEqual(view.facts, [
		"Not included: pairs marked not a duplicate, retired or merged people, pairs no import flagged.",
	]);
	// Past the first 100 pairs the total is unknown, and the card says only the first are shown.
	const partial = cardView(
		"people.listDuplicatePairs",
		result("people.listDuplicatePairs", [pair(P1, "John Smith", "Jon Smith")], {
			total: null,
			completeness: "partial",
		}),
		null,
	);
	assert.equal(partial.summary, "1 person");
	assert.equal(partial.facts[0], "Only the first matches are shown.");
	const none = cardView("people.listDuplicatePairs", result("people.listDuplicatePairs", []), null);
	assert.deepEqual(
		[none.summary, none.facts],
		["0 people", ["No import has flagged a possible duplicate that still needs review."]],
	);
});

const M1 = "44444444-4444-4444-8444-444444444444";
const M2 = "55555555-5555-4555-8555-555555555555";
const M3 = "66666666-6666-4666-8666-666666666666";

test("a Vision night with no attendance recorded says not recorded on the trend card, never 0 attended", () => {
	const point = (id, date, attended) => ({ kind: "item", id, label: "Vision Meeting", fields: { date, attended } });
	const view = cardView(
		"meetings.attendanceTrend",
		result("meetings.attendanceTrend", [
			point(M1, "2026-10-29", "18"),
			point(M2, "2026-11-05", "not recorded"),
			point(M3, "2026-11-08", "24"),
		]),
		null,
	);
	assert.equal(view.title, "Attendance trend");
	assert.deepEqual(
		view.rows.map((r) => [r.line, r.mark?.text ?? null]),
		[
			["Oct 29, 2026 · 18 attended", null],
			["Nov 5, 2026 · Not recorded", "Not recorded"],
			["Nov 8, 2026 · 24 attended", null],
		],
	);
	assert.equal(JSON.stringify(view).includes("0 attended"), false);
});

test("guests on an RSVP card are marked by their answer, never as attended, and link to their person", () => {
	const guest = (id, label, rsvp) => ({ kind: "person", id, label, fields: { rsvp, invitedBy: null } });
	const view = cardView(
		"meetings.listGuests",
		result("meetings.listGuests", [guest(P1, "Kevin Walsh", "yes"), guest(P2, "Joy Lee", "no"), guest(H, "Elena Garcia", "no answer")]),
		null,
	);
	assert.equal(view.title, "RSVPs");
	assert.deepEqual(
		view.rows.map((r) => [r.name, r.mark?.text, r.href]),
		[
			["Kevin Walsh", "RSVP yes", `/people/${P1}`],
			["Joy Lee", "RSVP no", `/people/${P2}`],
			["Elena Garcia", "No answer", `/people/${H}`],
		],
	);
	assert.equal(/attend/i.test(JSON.stringify(view)), false);
});

test("a meetings list row says when and where in the church's words, marks a cancelled one and opens the meeting", () => {
	const meeting = (id, label, status) => ({
		kind: "meeting",
		id,
		label,
		fields: { status, when: "Thu, Nov 12, 2026, 7:00 PM CST", venue: "Coffee shop" },
	});
	const view = cardView(
		"meetings.list",
		result("meetings.list", [meeting(M1, "Coffee with Pastor Nate", "cancelled"), meeting(M2, "Vision Meeting #4", "planning")]),
		null,
	);
	assert.deepEqual([view.title, view.summary], ["Meetings", "2 meetings"]);
	assert.deepEqual(
		view.rows.map((r) => [r.name, r.line, r.mark?.text ?? null, r.href]),
		[
			["Coffee with Pastor Nate", "Thu, Nov 12, 2026, 7:00 PM CST · Coffee shop", "Cancelled", `/meetings/${M1}`],
			["Vision Meeting #4", "Thu, Nov 12, 2026, 7:00 PM CST · Coffee shop", null, `/meetings/${M2}`],
		],
	);
});

test("the agenda card leads with the app's print link, opened in a new tab, then the saved sections in order", () => {
	const view = cardView(
		"meetings.readAgenda",
		result("meetings.readAgenda", [
			{ kind: "meeting", id: M1, label: "Launch team orientation", fields: { print: `/meetings/${M1}/agenda` } },
			{ kind: "item", id: "s1", label: "Welcome and coffee", fields: { order: "1", minutes: "15", starts: "16:00" } },
			{ kind: "item", id: "s2", label: "Our story and vision", fields: { order: "2", minutes: "20", starts: "16:15" } },
		]),
		null,
	);
	assert.deepEqual(
		view.rows.map((r) => [r.name, r.line, r.href, r.newTab ?? false]),
		[
			["Print agenda", "Launch team orientation", `/meetings/${M1}/agenda`, true],
			["Welcome and coffee", "4:00 pm · 15 min", null, false],
			["Our story and vision", "4:15 pm · 20 min", null, false],
		],
	);
});
