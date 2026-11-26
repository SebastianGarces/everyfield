import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { asSchema } from "../../../packages/evry/node_modules/ai/dist/index.js";
import { PgDialect } from "../../../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { sql } from "../../../packages/db/src/query.ts";
import {
	MEMBER_INTELLIGENCE,
	MEMBER_PHASES,
	READ_DOMAINS,
	readCatalog,
	SELECT_RETURNED_ROWS,
} from "../../../packages/evry/src/catalog/catalog.ts";
import type { EvryActor } from "../../../packages/evry/src/context/actor.ts";
import { capabilitiesAnswer } from "../../../packages/evry/src/context/compile.ts";
import { rowLive } from "../../../packages/evry/src/conversations/liveness.ts";
import { allowedWrites, REVIEWED_WRITES } from "../../../packages/evry/src/proposals/store.ts";
import { modelTools } from "../../../packages/evry/src/runtime/tools.ts";

const read = (path: string) =>
	JSON.parse(readFileSync(new URL(`../../../docs/catalog/${path}`, import.meta.url), "utf8"));
const operations = new Map<string, Record<string, unknown>>(
	(read("operations.json").operations ?? read("operations.json")).map((o: Record<string, unknown>) => [o.id, o]),
);
const generated = new Set<string>(read("evry-tools.json").operation_ids);

test("AC:INH-REGRESSION-CAPABILITIES INV-catalog: every installed model tool is a flagged, generated, read-only operation", () => {
	const installed = [
		...Object.values(READ_DOMAINS).flatMap((adapters) => adapters.map((a) => a.operation)),
		SELECT_RETURNED_ROWS,
	];
	assert.deepEqual(installed, [
		"people.listPeople",
		"people.getPerson",
		"people.getPersonPhoto",
		"people.checkForDuplicates",
		"people.listDuplicatePairs",
		"people.getStatusWarnings",
		"people.exportPeople",
		"people.generateCsvTemplate",
		"people.getActivities",
		"people.getHousehold",
		"people.getHouseholdMembers",
		"people.getImportReceipt",
		"people.getPersonSkills",
		"people.getPersonTags",
		"people.getPipelineData",
		"people.listHouseholds",
		"people.listTags",
		"people.previewImport",
		"people.getInterviews",
		"people.getAssessments",
		"people.getCommitments",
		"people.getCommitmentDownload",
		"people.getMergeReview",
		"people.previewUnmerge",
		"people.listRecordCorrections",
		"people.mergedPersonDestination",
		"communication.list",
		"communication.preview",
		"communication.get",
		"communication.forPerson",
		"communication.templates.list",
		"communication.resendCandidates",
		"communication.forMeeting",
		"communication.meetingRecipientTracking",
		"communication.deliveryTotals",
		"communication.listAudienceTeams",
		"communication.searchRecipients",
		"mail.suppression.listForSelf",
		"communication.getDraft",
		"tasks.list",
		"tasks.count",
		"tasks.get",
		"tasks.statusHistory",
		"tasks.listSubtasks",
		"tasks.listPrerequisites",
		"tasks.prerequisiteCandidates",
		"tasks.findOpenOccurrence",
		"tasks.eligibleAssignees",
		"tasks.relationOptions",
		"tasks.listTemplates",
		"tasks.previewTemplate",
		"tasks.readPhaseOffer",
		"tasks.importReceipt",
		"tasks.listFollowUpOwners",
		"followups.readObligations",
		"followups.listContactHistory",
		"tasks.followUpCoverage",
		"tasks.planHandoff",
		"notifications.feed",
		"notifications.preferences.get",
		"notifications.previewPlanterDigest",
		"notifications.previewOversightDigest",
		"teams.list",
		"teams.get",
		"teams.searchMembers",
		"teams.staffingSummary",
		"teams.personTeamCounts",
		"teams.staffingFacts",
		"teams.health",
		"teams.aggregateHealth",
		"teams.trainingMatrix",
		"teams.readRequiredTrainingParticipants",
		"teams.previewRequiredTrainingParticipants",
		"teams.listTraining",
		"teams.personTraining",
		"teams.trainingHistory",
		"teams.personAssignments",
		"teams.membershipHistory",
		"teams.history",
		"teams.listRoles",
		"teams.leaderCandidates",
		"teams.orgChart",
		"teams.exportOrgChart",
		"teams.listImportTemplates",
		"teams.previewTemplateImport",
		"teams.listResponsibilities",
		"teams.previewResponsibilities",
		"teams.listMeetings",
		"phases.readCatalog",
		"phases.readHistory",
		"phases.readReadiness",
		"intelligence.readExitCriteria",
		"intelligence.readJourney",
		"signals.listDefinitions",
		"signals.getHistory",
		"meetings.list",
		"meetings.get",
		"meetings.hasHistory",
		"meetings.readAgenda",
		"meetings.listKit",
		"meetings.listGuests",
		"meetings.listCards",
		"meetings.cardBreakdown",
		"meetings.invitationAttribution",
		"meetings.communicationContext",
		"meetings.listCompletedPreLaunchPractices",
		"meetings.getOwnRsvp",
		"meetings.listAttendance",
		"meetings.attendanceSummary",
		"meetings.getEvaluation",
		"meetings.evaluationHistory",
		"meetings.evaluationTrend",
		"meetings.compareEvaluation",
		"meetings.attendanceTrend",
		"meetings.summaryStats",
		"meetings.linkedTaskProgress",
		"meetings.readAnalytics",
		"meetings.previewRosterImport",
		"venues.list",
		"venues.get",
		"venues.history",
		"evry.readWorkflowHint",
		"seats.list",
		"seats.listInvitations",
		"privacy.getSharing",
		"onboarding.getResume",
		"discovery.getProfile",
		"dashboard.availableActions",
		"dashboard.metrics",
		"dashboard.activity",
		"dashboard.readSetupGaps",
		"feedback.listOwn",
		"feedback.getOwnStatus",
		"pipeline.listPeople",
		"development.draftPlan",
		"development.readProgram",
		"pipeline.readGoals",
		"pipeline.readConversationCounts",
		"intelligence.readCommittedAdultCohort",
		"intelligence.readScorecard",
		"intelligence.readAssessment",
		"intelligence.readAssessmentDelta",
		"intelligence.readAssessmentHistory",
		"intelligence.readAssessmentRun",
		"intelligence.readColdStartGuidance",
		"intelligence.readOwnFeedback",
		"oversight.listPlants",
		"oversight.getPlant",
		"organizationIntelligence.read",
		"organizationIntelligence.readHistory",
		"organizationIntelligence.readLocations",
		"organizationIntelligence.readLocationHistory",
		"oversight.listSendingChurches",
		"oversight.getSendingChurch",
		"calendar.getContext",
		"calendar.resolve",
		"wiki.search",
		"wiki.referenceExcerpt",
		"wiki.recommendForPhase",
		"wiki.reading.resume",
		"wiki.article.exportPdf",
		"wiki.navigation",
		"wiki.articles.list",
		"wiki.tableOfContents",
		"wiki.articleNeighbors",
		"wiki.contextGuide",
		"wiki.bookmarks.list",
		"wiki.reading.recent",
		"wiki.reading.stats",
		"wiki.feedback.getMine",
		"documents.listOwned",
		"documents.read",
		"documents.readCoreValuesEvidence",
		"documents.templates.list",
		"documents.templates.contextual",
		"documents.templates.get",
		"documents.resolveContext",
		"documents.preview",
		"documents.history.list",
		"documents.history.get",
		"documents.download",
		"launch.readCountdown",
		"launch.readWorkspace",
		"launch.readJournal",
		"launch.readDebrief",
		"associations.listInvitations",
		"associations.getHistory",
		"settings.getSection",
		"organizations.getProfile",
		"account.getAvatar",
		"geography.listReportingRegionCandidates",
		"evry.selectReturnedRows",
	]);
	for (const id of installed) {
		const op = operations.get(id);
		assert.ok(op, id);
		assert.deepEqual([op.model_tool, op.kind, op.durable_write, generated.has(id)], [true, "query", false, true], id);
	}
	const recipeSteps = ["meetings.schedule", "meetings.inviteGuest", "communication.sendReviewed"];
	for (const [id, write] of Object.entries(REVIEWED_WRITES)) {
		const op = operations.get(id);
		assert.ok(op, id);
		if (id.startsWith("evry.")) {
			assert.deepEqual([op.evry, op.model_tool, op.kind, op.durable_write], [true, false, "command", true], id);
			for (const step of recipeSteps) {
				const native = operations.get(step);
				assert.deepEqual([native?.model_tool, native?.evry_review], [true, true], `${id} step ${step}`);
			}
			continue;
		}
		assert.deepEqual(
			[op.model_tool, op.kind, op.durable_write, op.evry_review, generated.has(id)],
			"approveNow" in write && write.approveNow?.reason
				? [true, "query", false, false, true]
				: [true, "command", true, true, true],
			id,
		);
	}
	assert.equal(operations.get("pipeline.moveStage")?.model_tool, false);
	const teams = [...operations.values()].filter(
		(op) =>
			op.model_tool === true && ((op.evry_packages as string[]) ?? []).some((p) => p === "WP-069" || p === "WP-070"),
	);
	assert.deepEqual(
		teams.map((op) => op.id).sort(),
		[
			...installed.filter((id) => id.startsWith("teams.")),
			...Object.keys(REVIEWED_WRITES).filter((id) => id.startsWith("teams.")),
		].sort(),
	);
	for (const id of [
		"evry.submitTurn",
		"evry.cancelTurn",
		"evry.selectQualifiedModel",
		"access.checkOperation",
		"evry.approveProposal",
		"evry.executeProposal",
	])
		assert.equal(operations.get(id)?.model_tool, false, id);
});

const as = (contextKind: EvryActor["contextKind"], role: EvryActor["role"]): EvryActor => ({
	authority: null as never,
	accountId: "5b6d1f0e-0000-4000-8000-000000000f01",
	session: "5b6d1f0e-0000-4000-8000-000000000f21" as EvryActor["session"],
	owner: (contextKind === "account" || contextKind === "plant"
		? { kind: contextKind, id: "5b6d1f0e-0000-4000-8000-000000000001" }
		: { kind: "organization", id: "5b6d1f0e-0000-4000-8000-000000000003", organizationKind: contextKind }) as never,
	contextKind,
	role,
	seatId: role ? "5b6d1f0e-0000-4000-8000-000000000f31" : null,
	selfPersonId: null,
});
test("INV-discovery-offers: a Discovery planter is offered starting a church from the space, never a second space or a new church beside it, and the answer says so; a plain seatless account and a church seat keep theirs", () => {
	const starts = ["onboarding.createPlant", "discovery.create", "discovery.convertToPlant"];
	const offered = (actor: EvryActor) =>
		readCatalog(actor)
			.reviewedWrites.map((w) => w.operation)
			.filter((o) => starts.includes(o));
	const planter = { ...as("account", null), discovery: true };
	assert.deepEqual(offered(planter), ["discovery.convertToPlant"]);
	assert.deepEqual(offered(as("account", null)), starts);
	assert.ok(allowedWrites(planter).every((w) => w.operation !== "discovery.create"));
	assert.doesNotMatch(
		JSON.stringify(
			Object.values(modelTools(planter, {} as never)).map((t) => asSchema(t.inputSchema as never).jsonSchema),
		),
		/"discovery\.create"|"onboarding\.createPlant"/,
	);
	const answer = capabilitiesAnswer(readCatalog(planter), planter);
	assert.match(answer, /public Wiki/);
	assert.match(answer, /your own documents/);
	assert.match(answer, /turning your Discovery space into a church/);
	assert.doesNotMatch(answer, /Coming later|Prepare a private Discovery space|starting a new church/);
	assert.match(
		capabilitiesAnswer(readCatalog(as("account", null)), as("account", null)),
		/Prepare a private Discovery space/,
	);
	const owner = as("plant", "owner");
	assert.equal(
		capabilitiesAnswer(readCatalog({ ...owner, discovery: true }), owner),
		capabilitiesAnswer(readCatalog(owner), owner),
	);
});

const PHASE_TOOLS = {
	phases: [
		"phases.readCatalog",
		"phases.readHistory",
		"phases.readReadiness",
		"intelligence.readExitCriteria",
		"intelligence.readJourney",
	],
	signals: ["signals.listDefinitions", "signals.getHistory"],
	writes: ["phases.declare", "phases.transition", "signals.attest", "signals.correct", "signals.reaffirm"],
};

test("INV-catalog: the phase and signal tools follow the context: Owner and Admin get them, a Member, an organization seat and an account get none", () => {
	const phaseTools = (actor: EvryActor) => {
		const catalog = readCatalog(actor);
		const ops = (domain: string) =>
			catalog.domains.find((d) => d.domain === domain)?.operations.map((o) => o.operation) ?? [];
		return {
			phases: ops("phases"),
			signals: ops("signals"),
			writes: catalog.reviewedWrites.map((w) => w.operation).filter((o) => /^(phases|signals)\./.test(o)),
			withheld: catalog.withheld,
		};
	};
	for (const role of ["owner", "admin"] as const)
		assert.deepEqual(phaseTools(as("plant", role)), { ...PHASE_TOOLS, withheld: [] }, role);
	assert.deepEqual(phaseTools(as("plant", "member")), {
		phases: [],
		signals: [],
		writes: [],
		withheld: [MEMBER_PHASES, MEMBER_INTELLIGENCE],
	});
	for (const actor of [as("sending_church", "owner"), as("sending_network", "admin"), as("account", null)]) {
		assert.deepEqual(phaseTools(actor), { phases: [], signals: [], writes: [], withheld: [] }, actor.contextKind);
		const plantDomains = ["people", "peopleOrganization", "tasks", "followups", "meetings", "teams"];
		const shared = ["wiki", "documents"];
		assert.deepEqual(
			readCatalog(actor)
				.domains.filter((d) => [...plantDomains, ...shared].includes(d.domain))
				.map((d) => d.domain),
			actor.contextKind === "account" ? shared : [],
			actor.contextKind,
		);
	}
});

const operationsOf = (catalog: ReturnType<typeof readCatalog>) => [
	...catalog.domains.flatMap((d) => d.operations.map((o) => o.operation)),
	...catalog.reviewedWrites.map((w) => w.operation),
];
const actorAs = (owner: EvryActor["owner"], role: EvryActor["role"]) => ({ owner, role }) as unknown as EvryActor;
const plant = { kind: "plant", id: "00000000-0000-4000-8000-000000000001" } as EvryActor["owner"];

test("Meetings tools follow the native floor: an organization seat and an account context see none", () => {
	const meetings = (actor: EvryActor) =>
		operationsOf(readCatalog(actor)).filter((op) => /^(meetings|venues)\./.test(op));
	const flagged = (pkg: string, kind: string) =>
		[...operations.values()]
			.filter((o) => (o.evry_packages as string[]).includes(pkg) && o.model_tool === true && o.kind === kind)
			.map((o) => String(o.id))
			.sort();
	const owner = meetings(actorAs(plant, "owner"));
	assert.deepEqual(owner.filter((op) => operations.get(op)?.kind === "query").sort(), flagged("WP-065", "query"));
	assert.deepEqual(owner.filter((op) => operations.get(op)?.kind === "command").sort(), flagged("WP-066", "command"));
	assert.deepEqual(
		meetings(actorAs({ kind: "organization", id: plant.id, organizationKind: "sending_church" } as never, "owner")),
		[],
	);
	assert.deepEqual(meetings(actorAs({ kind: "account", id: plant.id } as never, null)), []);
	for (const op of [
		"meeting.describeRsvpToken",
		"meeting.answerRsvpToken",
		"meetings.readTokenRsvp",
		"meetings.resolveTokenRsvp",
		"meetings.planNotifications",
		"meetings.syncNotifications",
	])
		assert.equal(owner.includes(op), false, op);
});

test("A Member reads meetings and proposes only what the native floor lets a Member do: never a delete", () => {
	const member = actorAs(plant, "member");
	const ops = operationsOf(readCatalog(member));
	assert.ok(ops.includes("meetings.list"));
	assert.ok(ops.includes("meetings.listGuests"));
	assert.equal(ops.includes("meetings.attendanceTrend"), false, "reports are Owner or Admin");
	assert.deepEqual(
		allowedWrites(member)
			.map((w) => w.operation)
			.filter((op) => /^(meetings|venues)\./.test(op))
			.sort(),
		[
			"meetings.captureAttendanceBatch",
			"meetings.checkIn",
			"meetings.clearAttendance",
			"meetings.finalizeAttendance",
			"meetings.reconcileAttendance",
			"meetings.saveOwnRsvp",
			"meetings.schedule",
			"meetings.setAttendance",
		],
	);
});

test("INV-member-capabilities: a Member who may change only their own notifications is still told an Owner or Admin changes records", async () => {
	const { describeCatalog } = await import("../../../packages/evry/src/context/compile.ts");
	const catalog = (writes: string[]) =>
		({
			context: "plant",
			domains: [{ domain: "people", operations: [{ operation: "people.listPeople", description: "List people" }] }],
			selection: [SELECT_RETURNED_ROWS],
			reviewedWrites: writes.map((operation) => ({ operation, description: operation })),
			withheld: [],
		}) as unknown as Parameters<typeof describeCatalog>[0];
	const member = describeCatalog(catalog(["notifications.markSelectedRead", "notifications.setPreferences"]));
	assert.match(member, /an Owner or Admin of this church has to make them/);
	assert.match(member, /your own notifications/);
	assert.match(describeCatalog(catalog([])), /an Owner or Admin of this church has to make them/);
	assert.doesNotMatch(describeCatalog(catalog(["people.updatePerson"])), /Owner or Admin/);
});

test("INV-organization-catalog: only an organization Owner or Admin gets the two oversight digest tools, the organization profile change, the link invitation changes, the stage, goal and program writes, the Network Intelligence writes and the four organization Wiki writes; every seat reads its pipeline and programs and may propose a next version or an enrollment change, which only a program's director gets a card for, and only a network seat reads its sending churches", () => {
	const id = "00000000-0000-4000-8000-0000000000a1";
	const actor = (owner: EvryActor["owner"], contextKind: EvryActor["contextKind"], role: EvryActor["role"]) =>
		({
			accountId: id,
			session: id,
			owner,
			contextKind,
			role,
			seatId: role ? id : null,
			selfPersonId: null,
		}) as EvryActor;
	const organization = { kind: "organization", id, organizationKind: "sending_church" } as EvryActor["owner"];
	const tools = (a: EvryActor) => {
		const c = readCatalog(a);
		return [
			...c.domains.flatMap((d) => d.operations.map((o) => o.operation)),
			...c.reviewedWrites.map((w) => w.operation),
		];
	};
	const oversight = ["notifications.previewOversightDigest", "notifications.oversightDigestCadence.set"];
	const pipeline = [
		"pipeline.listPeople",
		"development.draftPlan",
		"development.readProgram",
		"pipeline.readGoals",
		"pipeline.readConversationCounts",
		"oversight.listPlants",
		"oversight.getPlant",
		"organizationIntelligence.read",
		"organizationIntelligence.readHistory",
		"organizationIntelligence.readLocations",
		"organizationIntelligence.readLocationHistory",
	];
	const directed = [
		"development.updateEnrollment",
		"development.applyVersion",
		"development.confirmMilestone",
		"development.completeMilestone",
	];
	const ownReads = ["associations.listInvitations", "associations.getHistory", "settings.getSection"];
	const orgWiki = [
		"wiki.organizationArticles.add",
		"wiki.organizationArticles.edit",
		"wiki.organizationArticles.publish",
		"wiki.organizationArticles.hide",
	];
	for (const role of ["owner", "admin"] as const)
		assert.deepEqual(
			tools(actor(organization, "sending_church", role)),
			[
				oversight[0],
				...pipeline,
				...ownReads,
				"organizations.getProfile",
				"account.getAvatar",
				"notifications.setPreferences",
				oversight[1],
				"settings.saveSection",
				"associations.resendInvitation",
				"associations.revokeInvitation",
				"associations.declineInvitation",
				"account.removeAvatar",
				"organizations.updateProfile",
				"pipeline.proposeStageMove",
				"pipeline.saveGoal",
				"pipeline.saveStages",
				"development.saveProgram",
				"development.draftNextVersion",
				"development.enroll",
				...directed,
				...orgWiki,
				"organizationIntelligence.requestRefresh",
				"organizationIntelligence.submitFeedback",
			],
			role,
		);
	assert.deepEqual(tools(actor(organization, "sending_church", "member")), [
		...pipeline,
		...ownReads,
		"organizations.getProfile",
		"account.getAvatar",
		"settings.saveSection",
		"account.removeAvatar",
		"development.draftNextVersion",
		...directed,
		"organizationIntelligence.submitFeedback",
	]);
	assert.deepEqual(
		tools(
			actor(
				{ kind: "organization", id, organizationKind: "sending_network" } as EvryActor["owner"],
				"sending_network",
				"member",
			),
		),
		[
			...pipeline,
			"oversight.listSendingChurches",
			"oversight.getSendingChurch",
			...ownReads,
			"organizations.getProfile",
			"account.getAvatar",
			"settings.saveSection",
			"account.removeAvatar",
			"development.draftNextVersion",
			...directed,
			"organizationIntelligence.submitFeedback",
		],
	);
	assert.deepEqual(tools(actor({ kind: "account", id } as EvryActor["owner"], "account", null)), [
		"discovery.getProfile",
		"wiki.search",
		"wiki.referenceExcerpt",
		"wiki.navigation",
		"wiki.articles.list",
		"wiki.tableOfContents",
		"documents.listOwned",
		"documents.read",
		...ownReads,
		"account.getAvatar",
		"settings.saveSection",
		"associations.resendInvitation",
		"associations.revokeInvitation",
		"account.removeAvatar",
		"onboarding.createPlant",
		"discovery.create",
		"discovery.convertToPlant",
		"documents.saveNative",
		"documents.archive",
		"documents.importTextOrWord",
	]);
	const plantOwner = tools(actor({ kind: "plant", id } as EvryActor["owner"], "plant", "owner"));
	assert.ok(plantOwner.includes("notifications.previewPlanterDigest"));
	for (const op of [...oversight, ...orgWiki]) assert.equal(plantOwner.includes(op), false, op);
	for (const role of ["admin", "member"] as const) {
		const plantSeat = tools(actor({ kind: "plant", id } as EvryActor["owner"], "plant", role));
		for (const op of orgWiki) assert.equal(plantSeat.includes(op), false, `${role} ${op}`);
	}
});

test("INV-evry-ni-feedback: a Member's prompt and tools offer their own rating and name only a refresh as an Owner's or Admin's", async () => {
	const { capabilitiesAnswer, compileContext } = await import("../../../packages/evry/src/context/compile.ts");
	const feedback = "organizationIntelligence.submitFeedback";
	const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
	for (const kind of ["sending_church", "sending_network"] as const)
		for (const role of ["owner", "admin", "member"] as const) {
			const actor = {
				owner: { kind: "organization", id, organizationKind: kind },
				contextKind: kind,
				role,
			} as unknown as EvryActor;
			const catalog = readCatalog(actor);
			const { system } = compileContext({
				actor,
				catalog,
				history: [],
				text: "x",
				references: [],
				now: new Date("2026-11-09T15:00:00Z"),
				state: null,
			});
			const described = catalog.reviewedWrites.find((w) => w.operation === feedback)!.description;
			const member = role === "member";
			assert.match(described, /their own rating|user's own rating/);
			assert.equal(/Owner or Admin/.test(described), !member, `${kind} ${role}`);
			const refresh = "Only an Owner or Admin can refresh Network Intelligence. Nothing was requested.";
			assert.equal(system.includes(refresh), member, `${kind} ${role}`);
			assert.equal(/refresh Network Intelligence or rate its patterns/.test(system), !member, `${kind} ${role}`);
			const can = capabilitiesAnswer(catalog, actor);
			assert.match(can, /your own rating of a Network Intelligence pattern/);
			assert.equal(/Network Intelligence refresh/.test(can), !member, `${kind} ${role}`);
		}
});

test("INV-golden-guidance: the prompt and tools an Owner's model gets name the next weekday, the follow-up owner check, private care, sending a draft as shown, missed notifications, the import header, a new person's source and an invitation's meeting; a seat without the tool or context gets none of it", async () => {
	const { compileContext } = await import("../../../packages/evry/src/context/compile.ts");
	const sent = (actor: EvryActor) => {
		const catalog = readCatalog(actor);
		const { system } = compileContext({
			actor,
			catalog,
			history: [],
			text: "x",
			references: [],
			now: new Date("2026-11-09T15:00:00Z"),
			state: null,
			settingsGuidance: false,
		});
		const described = [...catalog.domains.flatMap((d) => d.operations), ...catalog.reviewedWrites].map(
			(o): [string, string] => [o.operation, o.description],
		);
		return { system, tool: (operation: string) => new Map(described).get(operation) ?? "" };
	};
	const owner = sent(as("plant", "owner"));
	assert.match(owner.system, /A weekday on its own, such as "Thursday's meeting", means the next one from today/);
	assert.match(owner.system, /When the user names who should own follow-ups, read tasks\.eligibleAssignees first/);
	assert.match(
		owner.system,
		/Private care, such as care notes about a person, stays in the Everyfield app: no tool reads it/,
	);
	assert.match(
		owner.system,
		/When the user says to send or save an email you drafted, propose it with the subject and body exactly/,
	);
	assert.match(
		owner.tool("notifications.feed"),
		/When the user asks what they missed or what is new, read this first with unread true/,
	);
	assert.match(
		owner.tool("people.generateCsvTemplate"),
		/Give the user its columns as one line.*there is no file to link/,
	);
	assert.match(owner.tool("people.createPerson"), /set source to match \(vision_meeting\).*it needs no meeting/);
	assert.match(owner.tool("communication.preview"), /upcoming ones soonest first, then past ones latest first/);

	const member = sent(as("plant", "member"));
	assert.match(member.system, /Private care, such as care notes/);
	assert.doesNotMatch(member.system, /When the user says to send or save an email you drafted/);
	const account = sent(as("account", null));
	assert.doesNotMatch(account.system, /Private care|send or save an email|A weekday on its own|should own follow-ups/);
});

const outerAliases = (text: string) =>
	text
		.replace(/'(?:[^']|'')*'/g, "''")
		.match(/[\w$]+/g)
		?.filter((name) => /^[rc]$/i.test(name)) ?? [];

test("INV-account-wording: an account's own-document and Wiki tools never speak of a church or another reader's data, and a plant's tools keep their own words", () => {
	const said = (actor: EvryActor) => {
		const catalog = readCatalog(actor);
		return new Map(
			[...catalog.domains.flatMap((d) => d.operations), ...catalog.reviewedWrites].map((o): [string, string] => [
				o.operation,
				o.description,
			]),
		);
	};
	const account = said(as("account", null));
	const plant = said(as("plant", "owner"));
	const own = [...account.keys()].filter((operation) => /^(wiki|documents)\./.test(operation));
	assert.equal(own.length, 10);
	for (const operation of own) {
		assert.doesNotMatch(account.get(operation)!, /\bchurch|\bOwner or Admin|\bseat\b/i, operation);
		assert.ok(plant.get(operation), operation);
	}
	assert.match(plant.get("documents.listOwned")!, /^List the documents this church saved in Everyfield/);
	assert.match(plant.get("wiki.search")!, /^Search this church's Wiki by key words/);
	const schema = (actor: EvryActor) =>
		JSON.stringify(asSchema(modelTools(actor, {} as never).documents_read!.inputSchema as never).jsonSchema);
	assert.doesNotMatch(schema(as("account", null)), /church/i);
	assert.match(schema(as("plant", "owner")), /Church Documents/);
});

test("INV-row-liveness: no liveness rule names a table r or c, which the queries around it use for the checked row and its conversation", () => {
	const rendered = new PgDialect().sqlToQuery(
		rowLive(sql.raw("outer_row.j"), sql.raw("outer_plant"), sql.raw("outer_account")),
	);
	assert.match(rendered.sql, /FROM article_revision wiki_r\b/);
	assert.match(rendered.sql, /FROM person p\b/);
	assert.deepEqual(outerAliases(rendered.sql), []);
	for (const planted of ["FROM person r WHERE r.id=", "JOIN seat AS c ON true", 'FROM person "R"', "FROM a x, seat r"])
		assert.notDeepEqual(outerAliases(planted), [], planted);
	assert.deepEqual(outerAliases("FROM person live_r WHERE live_r.kind='r'"), []);
});

const TOOL_SCHEMA_BUDGET = 222_000;

test("INV-tool-schemas: the Evry catalog's model-facing JSON schemas stay within their byte budget", async () => {
	const idle = {
		read: async () => ({}),
		select: async () => ({}),
		propose: async () => ({}),
		readNotes: async () => ({}),
		updateNotes: async () => ({}),
		readReview: async () => ({}),
	};
	const bytes = new Map<string, number>();
	for (const actor of [
		as("plant", "owner"),
		as("sending_church", "owner"),
		as("sending_network", "owner"),
		as("account", null),
	])
		for (const [name, tool] of Object.entries(modelTools(actor, idle))) {
			const schema = (await asSchema(tool.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema) as {
				oneOf?: unknown[];
				anyOf?: unknown[];
			};
			assert.doesNotMatch(JSON.stringify(schema), /"\$ref"/, `${name}: the sizes below would miss a shared definition`);
			for (const option of schema.oneOf ?? schema.anyOf ?? [schema]) {
				const { properties } = option as { properties: { operation?: { const: string } } };
				const tool = properties.operation?.const ?? name;
				bytes.set(tool, Math.max(bytes.get(tool) ?? 0, Buffer.byteLength(JSON.stringify(option))));
			}
		}
	const installed = [
		...Object.values(READ_DOMAINS).flatMap((adapters) => adapters.map((a) => a.operation as string)),
		...Object.keys(REVIEWED_WRITES),
		"select_returned_rows",
		"compose_reads",
		"read_planning_notes",
		"update_planning_notes",
		"read_review",
	];
	assert.deepEqual([...bytes.keys()].sort(), installed.sort(), "every installed tool is measured");
	const total = [...bytes.values()].reduce((sum, size) => sum + size, 0);
	const largest = [...bytes].sort((a, b) => b[1] - a[1]).slice(0, 5);
	assert.ok(
		total <= TOOL_SCHEMA_BUDGET,
		`Evry tool schemas: ${total} bytes, budget ${TOOL_SCHEMA_BUDGET}; every Evry call sends them. Largest: ${largest.map(([name, size]) => `${name} ${size}`).join(", ")}`,
	);
});
