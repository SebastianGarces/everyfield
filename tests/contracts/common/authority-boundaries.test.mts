import assert from "node:assert/strict";
import { test } from "node:test";
import * as access from "../../../packages/contracts/src/access/index.ts";
import { debriefRequest } from "../../../packages/contracts/src/launch/index.ts";
import * as organizations from "../../../packages/contracts/src/organizations/index.ts";

type Schema = { safeParse(value: unknown): { success: boolean; data?: unknown } };
type Value = Record<string, unknown>;

const ID = "4f0c2a1e-8d3b-4c5a-9e7f-1a2b3c4d5e6f";
const OTHER = "7b1d9c52-3f64-4e0b-8a15-c2d3e4f5a6b7";
const AT = "2026-10-18T12:00:00.000Z";
const plant = { kind: "plant", id: ID };
const church = { kind: "organization", id: ID, organizationKind: "sending_church" };
const network = { kind: "organization", id: OTHER, organizationKind: "sending_network" };

function accepts(schema: Schema, value: unknown) {
	const parsed = schema.safeParse(value);
	assert.equal(parsed.success, true, JSON.stringify(value));
	assert.deepEqual(parsed.data, value);
}
function refuses(schema: Schema, value: unknown, why: string) {
	assert.equal(schema.safeParse(value).success, false, `${why}: ${JSON.stringify(value)}`);
}
function refusesEach(schema: Schema, value: Value, fields: Value, at: string[] = []) {
	accepts(schema, value);
	for (const [field, extra] of Object.entries(fields)) {
		const copy = structuredClone(value);
		const target = at.reduce((node, step) => node[step] as Value, copy);
		target[field] = extra;
		refuses(schema, copy, `${field} at ${at.join(".") || "the top"}`);
	}
}
function requires(schema: Schema, value: Value, path: string[], instead: unknown[] = []) {
	accepts(schema, value);
	const field = path.at(-1)!;
	const change = (edit: (target: Value) => void) => {
		const copy = structuredClone(value);
		edit(path.slice(0, -1).reduce((node, step) => node[step] as Value, copy));
		return copy;
	};
	refuses(
		schema,
		change((target) => delete target[field]),
		`no ${path.join(".")}`,
	);
	for (const bad of instead)
		refuses(
			schema,
			change((target) => (target[field] = bad)),
			`${path.join(".")} is ${JSON.stringify(bad)}`,
		);
}

const AUTHORITY = {
	accountId: ID,
	actorId: ID,
	actor: { account: ID },
	session: ID,
	role: "owner",
	seatId: ID,
	context: church,
	capability: "organization_administration",
};
const APPROVAL = { approved: true, approval: ID, approvedBy: ID, confirmedByCaller: true, skipReview: true };
const sharing = {
	requestKey: "key",
	expectedRevision: "1",
	input: {
		plant,
		organization: network,
		relationshipId: ID,
		expectedConsentRevision: "1",
		category: "shared_findings",
		enabled: false,
	},
};
const residency = {
	requestKey: "key",
	expectedRevision: "1",
	input: {
		linkId: ID,
		expectedConsentRevision: "1",
		choices: { shareFoundations: false, shareMilestones: true },
	},
};
const debrief = {
	requestKey: "key",
	expectedRevision: "7",
	input: {
		draftId: ID,
		answers: {
			wentWell: "Doors opened",
			toChange: null,
			operations: null,
			followUpPlan: null,
			supportNeeded: null,
			missingNames: null,
			missingCount: null,
		},
	},
};
const WRITES = [
	[organizations.setSharingRequest, sharing],
	[organizations.setResidencySharingRequest, residency],
	[debriefRequest, debrief],
] as const;

test("AC:WP006-IDN-029 the current actor is one typed context: no caller authority, no second seat and no untyped organization", () => {
	const seat = { kind: "seat", owner: plant, seatId: ID, role: "admin", revision: "1" };
	const active = { status: "active", accountId: ID, context: seat };
	accepts(access.currentActorResult, { status: "unavailable" });
	accepts(access.currentActorResult, { status: "pending_domain", accountId: ID });
	accepts(access.currentActorResult, {
		...active,
		context: { kind: "account", owner: { kind: "account", id: ID } },
	});
	for (const owner of [plant, church, network])
		accepts(access.currentActorResult, { ...active, context: { ...seat, owner } });

	refusesEach(access.organizationPersonRequest, { personId: ID }, AUTHORITY);
	for (const [schema, value] of WRITES) {
		refusesEach(schema, value, AUTHORITY);
		refusesEach(schema, value, AUTHORITY, ["input"]);
	}

	const second = { ...seat, owner: church, seatId: OTHER };
	refusesEach(access.currentActorResult, active, { contexts: [seat, second], seats: [seat, second], second });
	refusesEach(access.currentActorResult, active, { seats: [second], organization: church, plant }, ["context"]);
	refuses(access.currentActorResult, { ...active, context: [seat, second] }, "two contexts");
	refuses(access.currentActorResult, { ...active, context: { ...seat, owner: [plant, church] } }, "two owners");
	refuses(access.currentActorResult, { ...active, context: { ...seat, seatId: [ID, OTHER] } }, "two seats");
	refuses(
		access.currentActorResult,
		{ ...active, context: { kind: "account", owner: { kind: "account", id: OTHER } } },
		"another account's context",
	);

	for (const owner of [
		{ kind: "organization", id: ID },
		{ kind: "organization", id: ID, organizationKind: "plant" },
		{ kind: "organization", id: ID, organizationKind: null },
		{ kind: "sending_church", id: ID },
		{ id: ID, organizationKind: "sending_church" },
		{ kind: "plant", id: ID, organizationKind: "sending_church" },
		{ kind: "account", id: ID },
		ID,
	]) {
		refuses(access.currentActorResult, { ...active, context: { ...seat, owner } }, "untyped tenant");
		refuses(access.organizationOwner, owner, "untyped organization");
	}
});

test("AC:WP006-KNOW-116 a write names the revision it was reviewed at and cannot carry its own approval", () => {
	for (const [schema, value] of WRITES) {
		requires(schema, value, ["expectedRevision"], [null, 1, "", "-1", "01", "latest"]);
		refusesEach(schema, value, APPROVAL);
		refusesEach(schema, value, APPROVAL, ["input"]);
	}
});

test("AC:WP006-MUL-002 the pipeline projections carry no resident internals, no staff notes for a director and no note body outside the notes read", () => {
	const administration = { kind: "organization_administration", canReadStaffNotes: true };
	const allowed = { status: "allowed", organization: church, personId: ID, duties: [administration] };
	const NOTES = { notes: [], note: "Private", body: "Private", noteBodies: ["Private"], staffNotes: "Private" };
	for (const duty of [
		administration,
		{ kind: "responsible_staff", canReadStaffNotes: true },
		{ kind: "program_director", canReadStaffNotes: false },
	])
		accepts(access.pipelineAccessResult, { ...allowed, duties: [duty] });
	refusesEach(access.pipelineAccessResult, allowed, NOTES);
	refusesEach(access.pipelineAccessResult, allowed, NOTES, ["duties", "0"]);
	refusesEach(access.pipelineAccessResult, { status: "unavailable" }, { ...NOTES, personId: ID });
	for (const duties of [
		[{ kind: "program_director", canReadStaffNotes: true }],
		[{ kind: "program_director" }],
		[{ kind: "resident", canReadStaffNotes: false }],
		[],
	])
		refuses(access.pipelineAccessResult, { ...allowed, duties }, "a duty beyond its notes");

	const own = { organization: church, personId: ID, linkId: ID, revision: "1" };
	refusesEach(access.ownResidencyProjection, own, {
		...NOTES,
		stage: "Resident",
		stageId: ID,
		responsible: ID,
		responsibleSeatId: ID,
		assessment: { on: "2026-10-01", by: "Retreat" },
		history: [],
		duties: [administration],
		canReadStaffNotes: false,
	});

	const note = { id: ID, author: { kind: "removed" }, body: "Private", occurredAt: AT, revision: "1" };
	const notes = {
		status: "allowed",
		purpose: "native_org_person_notes",
		organization: church,
		personId: ID,
		duty: "responsible_staff",
		notes: [note],
		next: null,
	};
	requires(access.organizationNotesResult, notes, ["purpose"], ["general", "assistant", "search", "export"]);
	requires(access.organizationNotesResult, notes, ["duty"], ["program_director", "resident", "member"]);
	accepts(access.organizationNotesResult, { ...notes, duty: "organization_administration" });
});

const CATEGORIES = ["people", "meetings", "tasks", "ministry_teams", "wiki", "activity", "shared_findings"];
const all = (value: boolean) => Object.fromEntries(CATEGORIES.map((category) => [category, value]));
const SUMMARIES = ["summary", "summaries", "shared_summary", "published_summary", "launch_summary", "debrief_summary"];
const PRIVATE = [
	"private_notes",
	"notes",
	"prayer",
	"pastoral_care",
	"assessments",
	"interviews",
	"messages",
	"feedback",
	"documents",
	"conversations",
	"findings",
];

test("AC:WP007-KNOW-112 published summaries follow the existing shared_findings choice: no extra summary consent and no private category", () => {
	const PAIR = { plant, organization: network, organizationDisplayName: "Hill Country", activeAffiliation: true };
	const set = (category: string) => ({ ...sharing, input: { ...sharing.input, category } });
	for (const category of CATEGORIES) {
		accepts(organizations.sharingCategory, category);
		accepts(organizations.setSharingRequest, set(category));
	}
	assert.ok(CATEGORIES.includes("shared_findings"));
	for (const category of [...SUMMARIES, ...PRIVATE]) {
		refuses(organizations.sharingCategory, category, "category");
		refuses(organizations.setSharingRequest, set(category), "category");
	}
	const extra = Object.fromEntries([...SUMMARIES, ...PRIVATE].map((category) => [category, true]));
	refusesEach(organizations.sharingChoices, all(true), extra);
	requires(organizations.sharingChoices, all(true), ["shared_findings"], [null, "yes"]);
	refusesEach(organizations.setSharingRequest, sharing, { ...extra, summaryConsent: true }, ["input"]);
	const views: [Value, string][] = [
		[{ view: "plant_administration", ...PAIR, consentRevision: "1", choices: all(true) }, "choices"],
		[{ view: "organization", ...PAIR, availability: all(false) }, "availability"],
	];
	for (const [view, field] of views) {
		refusesEach(organizations.sharingResult, view, extra, [field]);
		refusesEach(organizations.sharingResult, view, extra);
	}
	refusesEach(organizations.sharingResult, { view: "plant_member", ...PAIR }, { ...extra, choices: all(true) });
	const disclosures: Value[] = [
		{ kind: "self_start", choices: all(false) },
		{ kind: "first_invitation", organization: network, choices: all(true) },
		{ kind: "existing_consent", organization: network, consentRevision: "2", choices: all(false) },
	];
	for (const disclosure of disclosures) refusesEach(organizations.sharingDisclosure, disclosure, extra, ["choices"]);
});

test("AC:WP007-MUL-003 resident consent is two explicit choices at a named consent revision and carries no private progress", () => {
	const schema = organizations.setResidencySharingRequest;
	for (const shareFoundations of [true, false])
		for (const shareMilestones of [true, false])
			accepts(schema, {
				...residency,
				input: { ...residency.input, choices: { shareFoundations, shareMilestones } },
			});
	for (const choice of ["shareFoundations", "shareMilestones"])
		requires(schema, residency, ["input", "choices", choice], [null, "true", 1]);
	requires(schema, residency, ["input", "choices"], [true, {}, { share: true }, { all: true }]);
	requires(schema, residency, ["input", "expectedConsentRevision"], [null, 1, "", "-1"]);
	requires(schema, residency, ["expectedRevision"], [null, 1]);
	requires(
		organizations.leaveResidencyRequest,
		{ requestKey: "key", expectedRevision: "1", input: { linkId: ID, expectedConsentRevision: "1" } },
		["input", "expectedConsentRevision"],
		[null],
	);
	const PROGRESS = {
		share: true,
		shareDocuments: true,
		shareJournal: true,
		shareNotes: true,
		documents: [],
		answers: [],
		readings: [],
		lessons: [],
		progress: [],
		completed: 3,
		milestones: [],
		feedback: [],
	};
	refusesEach(schema, residency, PROGRESS, ["input", "choices"]);
	refusesEach(schema, residency, PROGRESS, ["input"]);
	const active = {
		status: "active",
		linkId: ID,
		organization: church,
		consentRevision: "2",
		choices: { shareFoundations: false, shareMilestones: true },
	};
	refusesEach(organizations.residencySharingResult, active, PROGRESS);
	refusesEach(organizations.residencySharingResult, active, PROGRESS, ["choices"]);
	requires(organizations.residencySharingResult, active, ["consentRevision"], [null, 2]);
	refusesEach(organizations.residencySharingResult, { status: "ended", linkId: ID }, { ...PROGRESS, choices: {} });
	const view = {
		status: "linked",
		milestones: "not_shared",
		foundations: { status: "shared", completed: 2, total: 6 },
	};
	const rows = Object.fromEntries(Object.entries(PROGRESS).filter(([field]) => field !== "completed"));
	refusesEach(organizations.residentView, view, rows, ["foundations"]);
	refusesEach(organizations.residentView, { ...view, foundations: { status: "not_shared" } }, PROGRESS, [
		"foundations",
	]);
});

test("AC:WP007-MUL-016 pipeline eligibility names two contributors and carries no total and no individual record", () => {
	const RECORDS = {
		total: 5,
		totals: { leaders: 5 },
		count: 5,
		contributors: 1,
		contributorCount: 1,
		individualRecords: [],
		people: [],
		records: [],
		churches: [],
	};
	for (const allowed of [true, false]) {
		const result = { allowed, minimumContributors: 2 };
		refusesEach(organizations.pipelineAggregateAccessResult, result, RECORDS);
		requires(organizations.pipelineAggregateAccessResult, result, ["minimumContributors"], [0, 1, 3, "2", null]);
	}
	const consent = {
		status: "available",
		relationshipId: ID,
		revision: "1",
		sharePipelineTotals: true,
		minimumContributors: 2,
	};
	refusesEach(organizations.pipelineConsentResult, consent, RECORDS);
	requires(organizations.pipelineConsentResult, consent, ["minimumContributors"], [0, 1, 3]);
	refusesEach(organizations.pipelineAggregateAccessRequest, { network }, RECORDS);
	for (const owner of [church, plant, { kind: "organization", id: OTHER }])
		refuses(organizations.pipelineAggregateAccessRequest, { network: owner }, "not a network");
});
