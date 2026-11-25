import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as catalog from "../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter, SourceResult } from "../../../packages/evry/src/catalog/types.ts";
import { cardView, FALLBACK } from "../../../apps/web/src/features/evry/conversation/resultView.ts";
import { withPeopleWrite } from "../../../packages/domain/src/people/core.ts";
import { peopleMerge } from "../../../packages/domain/src/people/merge/index.ts";
import { recordCorrections } from "../../../packages/domain/src/people/corrections/index.ts";
import { PeopleReadContext } from "../../../packages/domain/src/people/core.ts";
import {
	ANA_COMMITMENT,
	byName,
	DANIEL_INTERVIEW,
	DOCS,
	goldenChurch,
	GRACE_AUSTIN,
	IMPORT_KEY,
	MEETINGS,
	PLANT,
	programId,
	taskId,
	teamId,
	WELCOME,
	WIKI,
} from "../evals/golden-church.mts";
import { nativePorts } from "../evals/settings-ports.mts";
import { seedSetup, SETUP_SPECS } from "../evals/setup-church.mts";
import { PIPELINE_SPECS, seedPipeline } from "../evals/pipeline-church.mts";
import { seedGuests, seedLaunched, seedOutcome, seedScheduled } from "../evals/launch-church.mts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { evryActor, type EvryActor } from "../../../packages/evry/src/context/actor.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { feedbackWriter } from "../../../packages/domain/src/feedback/index.ts";
import { randomUUID } from "node:crypto";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { intelligenceChurch, type IntelligenceChurch } from "../evals/intelligence-church.mts";

const church = await goldenChurch();
after(church.close);
let intelligence: Promise<IntelligenceChurch> | null = null;
let delta = false;
const oversightChurch = () => (intelligence ??= intelligenceChurch("evrycards"));
after(async () => (intelligence ? (await intelligence).database.close() : undefined));
const oversightActor = async (who: "owner" | "director") => {
	const ch = await oversightChurch();
	return evryActor((await readViewer(ch.db, ch.seats[who].session as never))!.authority!);
};
const native = nativePorts();
await seedSetup(church.admin, church.db, native);
const setupActor = async (session: string) => evryActor((await readViewer(church.db, session as never))!.authority!);
let feedbackId: string | undefined;
async function sentFeedback() {
	if (feedbackId) return feedbackId;
	const authority = (await setupActor(SETUP_SPECS.setupOwner.session)).authority;
	const r = await gatedTransaction(church.db, (tx) =>
		feedbackWriter.submit(
			tx as never,
			authority,
			{ requestKey: randomUUID(), category: "other", description: "Probe" },
			{ appVersion: null },
		),
	);
	assert.equal(r.status, "ok");
	return (feedbackId = (r as { value: { id: string } }).value.id);
}
const pipeline = await seedPipeline(church.admin, church.db);
await seedScheduled(church.admin, church.db);
await seedLaunched(church.db);
await seedOutcome(church.db, 150);
await seedGuests(church.db);
const adapters = new Map<string, ReadAdapter<unknown>>(
	Object.values(catalog.READ_DOMAINS)
		.flat()
		.map((a) => [a.operation, a as ReadAdapter<unknown>]),
);
const read = (operation: string, input: unknown) =>
	invokeRead(church.db, church.actors.owner, adapters.get(operation)!, input);
const withNative = (operation: string, actor: EvryActor, input: unknown) =>
	invokeRead(church.db, actor, adapters.get(operation)!, input, native);
const made = (operation: string, rows: SourceResult["rows"]) => async (): Promise<SourceResult> => ({
	operation,
	status: "available",
	rows,
	total: 1,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
});
const TEMPLATE: SourceResult["rows"][number] = {
	kind: "template",
	id: "follow-up-letter",
	label: "Vision Meeting Follow-up Letter",
	fields: { about: "A letter", formats: "PDF", format: "pdf", rendered: true, overrides: "{}" },
};
const FIELD: SourceResult["rows"][number] = {
	kind: "item",
	id: "church_name",
	label: "Church Name",
	fields: { key: "church_name", value: "Hope Fellowship", from: "from the church profile", required: true },
};
const MADE_FILE: SourceResult["rows"][number] = {
	kind: "file",
	id: "5b6d1f0e-0000-4000-8000-00000000f11e",
	label: "Vision Meeting Follow-up Letter",
	fields: { format: "PDF", madeAt: "2026-11-01T15:00:00.000Z", state: "Ready" },
};
const JAMES = byName("James Okafor").id;
const MARK = byName("Mark Thompson").id;
const FILE = "first_name,last_name,email\r\nAda,Park,ada@example.test\r\n,,\r\nJames,Okafor,\r\n";
const withTask =
	(operation: string, build: (taskId: string) => Record<string, unknown>, search?: string) => async () => {
		const found = (await read("tasks.list", search ? { search } : {})).rows[0];
		assert.ok(found, `the eval church has an open task${search ? ` "${search}"` : ""}`);
		return read(operation, build(found.id));
	};

const PROBES: Record<string, Record<string, unknown> | (() => Promise<SourceResult>)> = {
	"people.listPeople": {},
	"people.getPerson": { personId: JAMES },
	"people.getPersonPhoto": { personId: JAMES },
	"people.checkForDuplicates": { displayName: "James Okafor" },
	"people.listDuplicatePairs": {},
	"people.exportPeople": {},
	"people.generateCsvTemplate": {},
	"people.getActivities": { personId: byName("Kevin Walsh").id },
	"people.getHousehold": { personId: JAMES },
	"people.getHouseholdMembers": { personId: JAMES },
	"people.getImportReceipt": { requestKey: IMPORT_KEY },
	"people.getPersonSkills": { personId: MARK },
	"people.getPersonTags": { personId: MARK },
	"people.getPipelineData": {},
	"people.listHouseholds": {},
	"people.listTags": {},
	"people.previewImport": { file: FILE },
	"people.getInterviews": { personId: byName("Daniel Cruz").id },
	"people.getAssessments": { personId: byName("Mike Brennan").id },
	"people.getCommitments": { personId: byName("Ana Rivera").id },
	"people.getCommitmentDownload": { commitmentId: ANA_COMMITMENT },
	"people.getMergeReview": { sourceId: byName("John Smith").id, survivorId: byName("Jon Smith").id },
	"people.previewUnmerge": async () => {
		const pair = { sourceId: byName("John Smith").id, survivorId: byName("Jon Smith").id };
		const authority = church.actors.owner.authority;
		const review = await gatedTransaction(church.db, (tx) =>
			peopleMerge.getMergeReview(tx, new PeopleReadContext(authority), pair),
		);
		assert.equal(review.status, "ok");
		const merged = await withPeopleWrite(church.db, authority, (tx, ctx) =>
			peopleMerge.mergePeople(tx, ctx, {
				requestKey: "result-card-merge",
				input: { ...pair, reviewDigest: review.status === "ok" ? review.value.reviewDigest : "" },
			}),
		);
		assert.equal(merged.status, "ok");
		return read("people.previewUnmerge", { personId: pair.survivorId });
	},
	"people.listRecordCorrections": async () => {
		const daniel = byName("Daniel Cruz").id;
		const fixed = await withPeopleWrite(church.db, church.actors.owner.authority, (tx, ctx) =>
			recordCorrections.correctPersonRecord(tx, ctx, {
				requestKey: "result-card-correction",
				expectedRevision: "1",
				input: {
					recordType: "interview",
					personId: daniel,
					recordId: DANIEL_INTERVIEW,
					changes: { occurredOn: "2026-10-01" },
				},
			}),
		);
		assert.equal(fixed.status, "ok");
		return read("people.listRecordCorrections", { personId: daniel });
	},
	"people.mergedPersonDestination": { personId: JAMES },
	"communication.list": {},
	"tasks.list": {},
	"tasks.count": {},
	"tasks.get": withTask("tasks.get", (taskId) => ({ taskId })),
	"tasks.statusHistory": { taskId: taskId("packet") },
	"tasks.listSubtasks": withTask("tasks.listSubtasks", (parentId) => ({ parentId }), "Prepare launch Sunday"),
	"tasks.listPrerequisites": withTask("tasks.listPrerequisites", (taskId) => ({ taskId }), "Prepare launch Sunday"),
	"tasks.prerequisiteCandidates": withTask("tasks.prerequisiteCandidates", (taskId) => ({ taskId })),
	"tasks.findOpenOccurrence": withTask("tasks.findOpenOccurrence", (taskId) => ({ taskId }), "Weekly team check-in"),
	"tasks.eligibleAssignees": {},
	"tasks.relationOptions": { kind: "person", search: "James" },
	"tasks.listTemplates": {},
	"tasks.previewTemplate": async () => {
		const first = (await read("tasks.listTemplates", {})).rows[0];
		assert.ok(first, "Everyfield has a phase checklist");
		return read("tasks.previewTemplate", { checklistKey: first.id });
	},
	"tasks.readPhaseOffer": {},
	"tasks.importReceipt": {},
	"tasks.listFollowUpOwners": {},
	"tasks.followUpCoverage": {},
	"tasks.planHandoff": { fromAccountId: church.actors.owner.accountId },
	"followups.readObligations": {},
	"followups.listContactHistory": { personId: byName("Beth Johnson").id },
	"communication.preview": {
		subject: "You're invited: Vision Night",
		body: "Hi {{name}}, come to Vision Night.",
		audience: { groups: ["prospects"], teamIds: [], personIds: [] },
		meetingWords: "vision night",
	},
	"communication.get": {},
	"communication.forPerson": { personId: byName("Maria Santos").id },
	"communication.templates.list": {},
	"communication.resendCandidates": { communicationId: WELCOME, selection: "delivered_nonopeners" },
	"communication.forMeeting": { meetingWords: "vision meeting" },
	"communication.meetingRecipientTracking": { meetingWords: "vision meeting" },
	"communication.deliveryTotals": {},
	"communication.listAudienceTeams": {},
	"communication.searchRecipients": { query: "Casey" },
	"mail.suppression.listForSelf": async () =>
		invokeRead(church.db, church.actors.owner, adapters.get("mail.suppression.listForSelf")!, {}, null, undefined, {
			keys: {
				encryptionKey: Buffer.alloc(32, 7),
				addressKey: Buffer.alloc(32, 9),
				from: "church@example.test",
				origin: "https://app.example.test",
			},
			transport: {
				paused: false,
				send: async () => ({ outcome: "ids", ids: [] }),
				cancel: async () => [],
				reschedule: async () => [],
			},
		}),
	"notifications.feed": { unread: true },
	"notifications.preferences.get": {},
	"notifications.previewPlanterDigest": {},
	"notifications.previewOversightDigest": () =>
		invokeRead(church.db, church.actors.org, adapters.get("notifications.previewOversightDigest")!, {}),
	"teams.list": {},
	"teams.get": { teamId: teamId("Worship") },
	"teams.searchMembers": { q: "Sam" },
	"teams.staffingSummary": {},
	"teams.personTeamCounts": { minTeams: 3 },
	"teams.staffingFacts": { teamId: teamId("Core team") },
	"teams.health": { teamId: teamId("Core team") },
	"teams.aggregateHealth": {},
	"teams.trainingMatrix": { teamId: teamId("Kids ministry") },
	"teams.readRequiredTrainingParticipants": { programId: programId("Kids ministry training") },
	"teams.previewRequiredTrainingParticipants": {
		programId: programId("Hospitality training"),
		personIds: [byName("Alex Rivera").id],
	},
	"teams.listTraining": {},
	"teams.personTraining": { personId: byName("Sam Patel").id },
	"teams.trainingHistory": { personId: byName("Alex Rivera").id },
	"teams.personAssignments": { personId: byName("Sam Patel").id },
	"teams.membershipHistory": { teamId: teamId("Hospitality") },
	"teams.history": { teamId: teamId("Hospitality") },
	"teams.listRoles": { teamId: teamId("Hospitality") },
	"teams.leaderCandidates": { q: "Casey" },
	"teams.orgChart": {},
	"teams.exportOrgChart": {},
	"teams.listImportTemplates": {},
	"teams.previewTemplateImport": { selections: [{ teamKey: "prayer", roleKeys: ["prayer_lead"] }] },
	"teams.listResponsibilities": { teamId: teamId("Worship") },
	"teams.previewResponsibilities": { teamId: teamId("Worship") },
	"teams.listMeetings": { teamId: teamId("Core team") },
	"phases.readCatalog": {},
	"phases.readHistory": {},
	"phases.readReadiness": {},
	"intelligence.readExitCriteria": {},
	"intelligence.readJourney": {},
	"signals.listDefinitions": {},
	"signals.getHistory": {},
	"meetings.list": { window: "upcoming" },
	"meetings.get": { meetingId: MEETINGS.thursday },
	"meetings.hasHistory": {},
	"meetings.readAgenda": { meetingId: MEETINGS.sunday },
	"meetings.listKit": { meetingId: MEETINGS.thursday, only: "unchecked" },
	"meetings.listGuests": { meetingId: MEETINGS.thursday },
	"meetings.listCards": { meetingId: MEETINGS.lastNight },
	"meetings.cardBreakdown": { meetingId: MEETINGS.lastNight },
	"meetings.invitationAttribution": { meetingId: MEETINGS.thursday },
	"meetings.communicationContext": { meetingId: MEETINGS.thursday },
	"meetings.listCompletedPreLaunchPractices": {},
	"meetings.getOwnRsvp": { meetingId: MEETINGS.thursday },
	"meetings.listAttendance": { meetingId: MEETINGS.lastWeek },
	"meetings.attendanceSummary": { meetingId: MEETINGS.lastNight },
	"meetings.getEvaluation": { meetingId: MEETINGS.earlier },
	"meetings.evaluationHistory": { meetingId: MEETINGS.earlier },
	"meetings.evaluationTrend": {},
	"meetings.compareEvaluation": { meetingId: MEETINGS.earlier },
	"meetings.attendanceTrend": { limit: 3 },
	"meetings.summaryStats": {},
	"meetings.linkedTaskProgress": { meetingId: MEETINGS.lastNight },
	"meetings.readAnalytics": { meetingId: MEETINGS.lastNight },
	"meetings.previewRosterImport": { meetingId: MEETINGS.training },
	"venues.list": {},
	"evry.readWorkflowHint": { workflow: "vision_night_follow_up" },
	"venues.get": { venueId: MEETINGS.coffee },
	"venues.history": { venueId: MEETINGS.coffee },
	"seats.list": {},
	"seats.listInvitations": () =>
		invokeRead(church.db, church.actors.owner, adapters.get("seats.listInvitations")!, {}, nativePorts()),
	"privacy.getSharing": {},
	"onboarding.getResume": async () =>
		invokeRead(
			church.db,
			await setupActor(SETUP_SPECS.setupOwner.session),
			adapters.get("onboarding.getResume")!,
			{},
			native,
		),
	"discovery.getProfile": async () =>
		invokeRead(
			church.db,
			await setupActor(SETUP_SPECS.discovery.session),
			adapters.get("discovery.getProfile")!,
			{},
			native,
		),
	"launch.readCountdown": {},
	"launch.readWorkspace": {},
	"launch.readJournal": {},
	"launch.readDebrief": {},
	...Object.fromEntries(
		[
			["intelligence.readCommittedAdultCohort", "owner"],
			["intelligence.readScorecard", "owner"],
			["intelligence.readAssessment", "owner"],
			["intelligence.readAssessmentDelta", "owner"],
			["oversight.listPlants", "director"],
			["organizationIntelligence.read", "director"],
			["organizationIntelligence.readHistory", "director"],
			["organizationIntelligence.readLocations", "director"],
		].map(([op, who]) => [
			op,
			async () => {
				const ch = await oversightChurch();
				if (op === "intelligence.readAssessmentDelta" && !delta) {
					await ch.classify();
					await ch.publish();
					delta = true;
				}
				return invokeRead(ch.db, await oversightActor(who as "owner"), adapters.get(op!)!, {});
			},
		]),
	),
	"organizationIntelligence.readLocationHistory": async () => {
		const ch = await oversightChurch();
		return invokeRead(
			ch.db,
			await oversightActor("director"),
			adapters.get("organizationIntelligence.readLocationHistory")!,
			{
				plantId: ch.plants["Harvest Point"]!.id,
			},
		);
	},
	"oversight.getPlant": async () => {
		const ch = await oversightChurch();
		return invokeRead(ch.db, await oversightActor("director"), adapters.get("oversight.getPlant")!, {
			plantId: ch.plants["Redeemer Church"]!.id,
		});
	},
	...Object.fromEntries(
		["dashboard.availableActions", "dashboard.metrics", "dashboard.activity", "dashboard.readSetupGaps"].map((op) => [
			op,
			async () => invokeRead(church.db, await setupActor(SETUP_SPECS.setupOwner.session), adapters.get(op)!, {}),
		]),
	),
	"feedback.listOwn": async () => {
		await sentFeedback();
		return invokeRead(
			church.db,
			await setupActor(SETUP_SPECS.setupOwner.session),
			adapters.get("feedback.listOwn")!,
			{},
		);
	},
	"feedback.getOwnStatus": async () =>
		invokeRead(church.db, await setupActor(SETUP_SPECS.setupOwner.session), adapters.get("feedback.getOwnStatus")!, {
			feedbackId: await sentFeedback(),
		}),
	"pipeline.listPeople": async () =>
		invokeRead(church.db, await setupActor(PIPELINE_SPECS.dana.session), adapters.get("pipeline.listPeople")!, {}),
	"development.draftPlan": async () =>
		invokeRead(church.db, await setupActor(PIPELINE_SPECS.dana.session), adapters.get("development.draftPlan")!, {}),
	"calendar.getContext": {},
	"calendar.resolve": { date: "2026-11-01", time: "01:30" },
	"wiki.search": { query: "vision meeting" },
	"wiki.referenceExcerpt": { articleId: WIKI.vision.article },
	"wiki.recommendForPhase": {},
	"wiki.reading.resume": {},
	"wiki.article.exportPdf": { articleId: WIKI.vision.article },
	"documents.listOwned": {},
	"documents.read": { documentId: DOCS.septemberAgenda.id },
	"documents.readCoreValuesEvidence": {},
	"documents.templates.list": {},
	"documents.templates.contextual": made("documents.templates.contextual", [TEMPLATE]),
	"documents.templates.get": made("documents.templates.get", [TEMPLATE, FIELD]),
	"documents.resolveContext": made("documents.resolveContext", [TEMPLATE, FIELD]),
	"documents.preview": made("documents.preview", [TEMPLATE, FIELD]),
	"documents.history.list": made("documents.history.list", [MADE_FILE]),
	"documents.history.get": made("documents.history.get", [MADE_FILE]),
	"documents.download": made("documents.download", [MADE_FILE]),
	"associations.listInvitations": async () => {
		const id = randomUUID();
		await church.admin
			.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,inviter_id,token_hash,state,created_at,revision)
			VALUES(${id},${PLANT},'plant_church','cards@example.test',${church.actors.owner.accountId},${id},'pending',clock_timestamp(),1)`);
		await church.admin
			.execute(sql`INSERT INTO relationship_invitation(invitation_id,plant_id,organization_id,inviter_description,subject_revision)
			VALUES(${id},${PLANT},${GRACE_AUSTIN},'Hope Fellowship',1)`);
		return read("associations.listInvitations", {});
	},
	"associations.getHistory": () => withNative("associations.getHistory", church.actors.owner, {}),
	"settings.getSection": () => withNative("settings.getSection", church.actors.owner, { section: "church" }),
	"organizations.getProfile": () => withNative("organizations.getProfile", church.actors.network, {}),
	"account.getAvatar": () => withNative("account.getAvatar", church.actors.owner, {}),
	"development.readProgram": async () =>
		invokeRead(church.db, await setupActor(PIPELINE_SPECS.dana.session), adapters.get("development.readProgram")!, {
			programId: pipeline.residency.programId,
		}),
	[catalog.SELECT_RETURNED_ROWS]: async () => {
		const list = await read("people.listPeople", {});
		return { ...list, operation: catalog.SELECT_RETURNED_ROWS, rows: list.rows.slice(0, 2), total: 2 };
	},
};

const catalogTools = Object.values(catalog).flatMap((v) => (typeof v === "string" && v.startsWith("evry.") ? [v] : []));
const installed = [
	...Object.values(catalog.READ_DOMAINS).flatMap((adapters) => adapters.map((a) => a.operation)),
	...catalogTools,
];

test("INV-result-card-views: every installed read and catalog tool has its own card title and count words", async () => {
	assert.ok(catalogTools.includes("evry.selectReturnedRows"));
	const problems: string[] = [];
	for (const operation of installed) {
		const probe = PROBES[operation];
		if (!probe) {
			problems.push(`${operation}: no probe in result-cards.test.mts`);
			continue;
		}
		const result = typeof probe === "function" ? await probe() : await read(operation, probe);
		if (!result.rows.length) problems.push(`${operation}: the probe returned no rows`);
		const view = cardView(operation, result, null);
		if (view.title === FALLBACK.title) problems.push(`${operation}: falls back to the "${FALLBACK.title}" card`);
		const persons = view.rows.filter((r) => r.avatar === "person" || r.href?.startsWith("/people/")).length;
		const counted = /^([\d,]+) (?:person|people)$/.exec(view.summary);
		if (counted && view.rows.length && Number(counted[1]!.replaceAll(",", "")) !== persons)
			problems.push(`${operation}: "${view.summary}" but the card shows ${persons} person rows`);
		const words = [view.title, ...view.facts].join(" ");
		if (/\b(person|people)\b/i.test(words) && view.rows.length && !persons)
			problems.push(`${operation}: speaks of people but shows no person row: ${words}`);
	}
	assert.deepEqual(problems, []);
});

test("INV-result-card-views: a rendered template preview carries what the card draws, and a failed one draws nothing", async () => {
	const at = async (rendered: boolean) => {
		const result = await made("documents.preview", [{ ...TEMPLATE, fields: { ...TEMPLATE.fields, rendered } }])();
		return cardView("documents.preview", { ...result, facts: { rendered } }, null);
	};
	assert.deepEqual((await at(true)).rows[0]!.preview, {
		templateId: "follow-up-letter",
		title: "Vision Meeting Follow-up Letter",
		format: "pdf",
		overrides: {},
		meetingId: null,
		page: null,
	});
	const failed = await at(false);
	assert.equal(failed.rows[0]!.preview, undefined);
	assert.ok(failed.facts.includes("The preview could not be made. Nothing was saved."));
});
