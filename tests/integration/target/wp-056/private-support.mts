import "../../platform/setup.mts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { personId } from "../../../../packages/contracts/src/common/index.ts";
import { activityRequest, listPeopleRequest } from "../../../../packages/contracts/src/people/index.ts";
import { sql } from "../../../../packages/db/src/query.ts";
import { communicationWriter, withCommunicationWrite } from "../../../../packages/domain/src/communication/index.ts";
import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { dashboardReader } from "../../../../packages/domain/src/dashboard/index.ts";
import { followUpReader } from "../../../../packages/domain/src/followups/index.ts";
import {
	createAssessmentJob,
	createAssessments,
	createFacts,
	createPrivateCare,
	createSignals,
	runAssessmentBatch,
} from "../../../../packages/domain/src/intelligence/index.ts";
import { createLaunchReader } from "../../../../packages/domain/src/launch/index.ts";
import { meetingsReader } from "../../../../packages/domain/src/meetings/index.ts";
import {
	compileOversightDigest,
	compilePlanterDigest,
	createNotificationProducer,
	previewOversightDigest,
	previewPlanterDigest,
	readFeedPage,
	renderOversightDigest,
	renderPlanterDigest,
} from "../../../../packages/domain/src/notifications/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import {
	pipelineWriter,
	readPipelineBoard,
	readPipelineChoices,
	readPipelineExport,
	readPipelineGoals,
	readPipelinePersonRecord,
	readPlantSharing,
} from "../../../../packages/domain/src/organizations/index.ts";
import {
	getPlant,
	getSendingChurch,
	listPlants,
	listSendingChurches,
	readIntelligence,
	requestIntelligenceRefresh,
} from "../../../../packages/domain/src/oversight/index.ts";
import {
	assessments as fourCs,
	checkForDuplicates,
	commitments,
	interviews,
	listDuplicatePairs,
	peopleCsv,
	peopleReader,
	peopleWriter,
	readPersonPage,
	readPipelineMetrics,
	recordCorrections,
	searchPeople,
	withPeopleWrite,
} from "../../../../packages/domain/src/people/index.ts";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import { phaseReader } from "../../../../packages/domain/src/phases/index.ts";
import { createTaskWriter, taskReader, withTaskWrite } from "../../../../packages/domain/src/tasks/index.ts";
import { teamsReader, trainingReader } from "../../../../packages/domain/src/teams/index.ts";
import { scriptedAssessmentDrafter } from "../../../../packages/evry-scripted/src/scripted-assessment.ts";
import { evryActor } from "../../../../packages/evry/src/context/actor.ts";
import { READ_DOMAINS } from "../../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter } from "../../../../packages/evry/src/catalog/types.ts";
import { z } from "../../../../packages/evry/node_modules/zod/index.js";
import { ok, type Actor } from "../../../support/fixture.mts";
import { church } from "../../intelligence/assessment-church.mts";

export const VIEWERS = ["author", "admin", "member", "lead", "director", "staff", "foreign"] as const;
export type Viewer = (typeof VIEWERS)[number];
export const KINDS = ["direct", "search", "notification", "digest", "export", "evry", "summary"] as const;
export type Kind = (typeof KINDS)[number];

export const CARE_NOTE = "hushcarenote";
export const DRAFT_SUBJECT = "hushdraftsubject";
export const DRAFT_BODY = "hushdraftbody";
export const CONTACT = { email: "hushdana@example.test", phone: "+1 555 017 3344", street: "17 Hushcontact Lane" };
export const CANDIDATE_EMAIL = "hushcandidate@example.test";
export const INTAKE_NOTE = "hushintakenote";
export const PERSON_NOTE = "hushpersonnote";

export type Ids = Record<
	"person" | "candidate" | "draft" | "run" | "week" | "email" | "phone" | "subject" | "body" | "candidateEmail",
	string
>;
const digits = () => String(1_000_000 + (parseInt(randomUUID().slice(0, 6), 16) % 9_000_000));
export const randomIds = (): Ids => ({
	person: randomUUID(),
	candidate: randomUUID(),
	draft: randomUUID(),
	run: randomUUID(),
	week: randomUUID(),
	email: `${randomUUID()}@example.test`,
	phone: `+1 555 ${digits()}`,
	subject: randomUUID(),
	body: randomUUID(),
	candidateEmail: `${randomUUID()}@example.test`,
});

const VOLATILE = new Set(["asOf", "correlationId", "now", "generatedAt"]);
export function settled(value: unknown, ids: Partial<Ids> = {}): unknown {
	const text = JSON.stringify(value ?? null, (key, v: unknown) => (VOLATILE.has(key) ? `<${key}>` : v));
	let out = text.replace(/Made,\d{4}-\d\d-\d\d \d\d:\d\d /g, "Made,<made> ");
	for (const [name, id] of Object.entries(ids)) out = out.replaceAll(id, `<${name}>`);
	return JSON.parse(out);
}

const adapters = Object.values(READ_DOMAINS).flat() as unknown as readonly ReadAdapter<unknown>[];
type Shape = { properties?: Record<string, unknown>; required?: string[]; oneOf?: Shape[]; anyOf?: Shape[] };

export async function world(prefix: string) {
	const c = await church(prefix);
	try {
		return await build(c);
	} catch (error) {
		await c.database.close();
		throw error;
	}
}

async function build(c: Awaited<ReturnType<typeof church>>) {
	const { db, admin, database } = c;
	await c.release("r1");
	const org = await database.organization("sending_church", { name: "Grace Sending", timezone: "America/Chicago" });
	const P = await c.plant("Harbor Plant", { network: org });
	await admin.execute(sql`UPDATE affiliation SET share_people=true,share_meetings=true,share_tasks=true,
		share_ministry_teams=true,share_wiki=true,share_activity=true,shared_findings=true WHERE id=${P.affiliation}`);
	const Q = await c.plant("Foreign Plant");
	const leadPerson = await c.committed(P, "Lee Lead");
	for (let i = 1; i <= 12; i++) await c.committed(P, `Adult ${String(i).padStart(2, "0")}`);
	const dana = await c.person(P, "Dana Quiet");
	const meeting = await c.vision(P, 4, [dana, leadPerson]);
	await c.person(Q, "Foreign Friend");

	const zoned = { account: { personal_timezone: "America/Chicago" } };
	const seated: Record<Viewer, Actor> = {
		author: P.owner,
		admin: await database.actor(P, "admin", zoned),
		member: await database.actor(P, "member"),
		lead: await database.actor(P, "member"),
		director: await database.actor(org, "owner"),
		staff: await database.actor(org, "member"),
		foreign: Q.owner,
	};
	const team = randomUUID();
	await admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${team},'team',${P.id})`);
	await admin.execute(sql`INSERT INTO team(id,plant_id,name,state,sort_order,leader_person_id,leader_source)
		VALUES(${team},${P.id},'Welcome','active',1,${leadPerson.id},'explicit')`);
	await admin.execute(sql`UPDATE person SET linked_account_id=${seated.lead.id} WHERE id=${leadPerson.id}`);

	const who = {} as Record<Viewer, RequestActor>;
	for (const v of VIEWERS) {
		const found = await RequestActor.resolve(db, seated[v].session);
		assert.ok(found instanceof RequestActor, v);
		who[v] = found;
	}
	const tasks = createTaskWriter({ reminders: async () => {} });
	const due = c.day(1);
	const { task } = ok(
		await withTaskWrite(db, who.author, (t, ctx) =>
			tasks.create(t, ctx, {
				requestKey: randomUUID(),
				input: {
					title: "Open control task",
					due: { kind: "local_date", date: due },
					assigneeIds: [seated.author.id, seated.admin.id],
				},
			}),
		),
	) as { task: { id: string } };
	for (const v of VIEWERS) {
		const tenant = v === "foreign" ? Q.id : v === "director" || v === "staff" ? org.id : P.id;
		await admin.execute(sql`INSERT INTO notice(id,tenant_id,recipient_id,category,purpose,logical_key,source_record_id,
			source_revision,title,eligible_at,created_at,timezone) VALUES(${randomUUID()},${tenant},${seated[v].id},'task','task_due',
			${`${tenant}/task_due/${randomUUID()}`},${task.id},1,'Control notice',clock_timestamp()-interval '1 minute',clock_timestamp(),
			'America/Chicago')`);
	}

	const care = createPrivateCare();
	const assessments = createAssessments();
	const job = createAssessmentJob();
	const tx = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(db, body);
	const levels = (v: string) => ({ spiritual: v, family: v, financial: v, pace: v });

	const stage = async () => {
		const board = await readPipelineBoard(db, who.director, {});
		assert.equal(board.status, "ok", JSON.stringify(board));
		const first = (board as { value: { stages: { id: string }[] } }).value.stages[0];
		assert.ok(first);
		return first.id;
	};
	const candidate = randomUUID();
	ok(
		(await pipelineWriter.addPerson(db, who.director, {
			personId: candidate,
			displayName: "Casey Candidate",
			email: null,
			responsibleSeatId: null,
			stageId: await stage(),
		})) as { status: "ok"; value: unknown },
	);

	const ids: Ids = {
		...randomIds(),
		person: dana.id,
		candidate,
		email: CONTACT.email,
		phone: CONTACT.phone,
		subject: DRAFT_SUBJECT,
		body: DRAFT_BODY,
		candidateEmail: CANDIDATE_EMAIL,
	};

	const actions = {
		async writeCare(as: Viewer = "author", note = CARE_NOTE) {
			const current = ok(await care.readCurrent(db, who[as], {}));
			const saved = ok(
				await care.save(db, who[as], {
					requestKey: randomUUID(),
					expectedRevision: current.revision,
					input: { answers: levels("struggling"), note },
				}),
			);
			assert.ok(saved.week.id);
			if (as === "author") ids.week = saved.week.id;
			return saved;
		},
		async clearCare() {
			const current = ok(await care.readCurrent(db, who.author, {}));
			ok(
				await care.correct(db, who.author, {
					requestKey: randomUUID(),
					expectedRevision: current.revision,
					input: { weekId: ids.week, answers: levels("steady"), note: "" },
				}),
			);
		},
		async purgeCare() {
			await admin.execute(sql`DELETE FROM private_week_revision WHERE author_id=${seated.author.id}`);
			await admin.execute(sql`DELETE FROM private_week WHERE author_id=${seated.author.id}`);
			await admin.execute(sql`DELETE FROM private_calendar WHERE author_id=${seated.author.id}`);
		},
		async shareActivity(on: boolean) {
			await admin.execute(sql`UPDATE affiliation SET share_activity=${on} WHERE id=${P.affiliation}`);
		},
		async dropAssessment() {
			await admin.execute(sql`DELETE FROM assessment_insight WHERE run_id=${ids.run}`);
			await admin.execute(sql`DELETE FROM assessment_run WHERE id=${ids.run}`);
		},
		async assess() {
			const requestId = randomUUID();
			ok(await assessments.requestRefresh(db, who.author, { requestId }));
			await runAssessmentBatch(job, db, scriptedAssessmentDrafter(), 20);
			const row = await c.one<{ id: string; outcome: string }>(
				sql`SELECT id,outcome FROM assessment_run WHERE plant_id=${P.id} AND demand_key=${"manual/" + requestId}`,
			);
			assert.equal(row.outcome, "published");
			ids.run = row.id;
			return row.id;
		},
		async release() {
			ok(await assessments.markAssessmentSeen(db, who.author, { runId: ids.run }));
		},
		async assessmentText() {
			const current = ok(await assessments.readAssessment(db, who.author, {})).current;
			assert.ok(current);
			return { summary: current.summary, focus: current.focus.body, citation: current.focus.citations[0]!.key };
		},
		async draft() {
			const saved = ok(
				await withCommunicationWrite(db, who.author, (t, ctx) =>
					communicationWriter.saveDraft(t, ctx, {
						requestKey: randomUUID(),
						input: {
							subject: DRAFT_SUBJECT,
							bodyHtml: `<p>${DRAFT_BODY}</p>`,
							audience: { groups: [], teamIds: [], personIds: [dana.id] },
							meetingId: meeting,
						},
					}),
				),
			);
			ids.draft = saved.communicationId;
			return saved;
		},
		async removeDraft(revision: string) {
			ok(
				await withCommunicationWrite(db, who.author, (t, ctx) =>
					communicationWriter.deleteDraft(t, ctx, {
						requestKey: randomUUID(),
						expectedRevision: revision,
						input: { communicationId: ids.draft },
					}),
				),
			);
		},
		async contact(patch: Record<keyof typeof CONTACT, string | null>) {
			const { r } = await c.one<{ r: string }>(sql`SELECT revision::text AS r FROM person WHERE id=${dana.id}`);
			ok(
				await withPeopleWrite(db, who.author, (t, ctx) =>
					peopleWriter.updatePerson(t, ctx, {
						requestKey: randomUUID(),
						expectedRevision: r,
						input: { personId: dana.id, patch },
					}),
				),
			);
		},
		async rename(displayName: string) {
			const { r } = await c.one<{ r: string }>(sql`SELECT revision::text AS r FROM person WHERE id=${dana.id}`);
			ok(
				await withPeopleWrite(db, who.author, (t, ctx) =>
					peopleWriter.updatePerson(t, ctx, {
						requestKey: randomUUID(),
						expectedRevision: r,
						input: { personId: dana.id, patch: { displayName } },
					}),
				),
			);
		},
		async candidateEmail(email: string | null) {
			const { r } = await c.one<{ r: string }>(
				sql`SELECT revision::text AS r FROM pipeline_person WHERE person_id=${candidate}`,
			);
			ok(
				(await pipelineWriter.editPerson(db, who.director, {
					personId: candidate,
					expectedRevision: r,
					displayName: "Casey Candidate",
					email,
					responsibleSeatId: null,
				})) as { status: "ok"; value: unknown },
			);
		},
		async note() {
			const { r } = await c.one<{ r: string }>(sql`SELECT revision::text AS r FROM person WHERE id=${dana.id}`);
			ok(
				await withPeopleWrite(db, who.author, (t, ctx) =>
					peopleWriter.addNote(t, ctx, {
						requestKey: randomUUID(),
						expectedRevision: r,
						input: { personId: dana.id, body: PERSON_NOTE },
					}),
				),
			);
		},
		async intake() {
			const lens = { score: 2, notes: `${INTAKE_NOTE} lens` };
			ok(
				await withPeopleWrite(db, who.author, (t, ctx) =>
					fourCs.createAssessment(t, ctx, {
						requestKey: randomUUID(),
						input: {
							personId: dana.id,
							occurredOn: c.day(-3),
							committed: lens,
							compelled: lens,
							contagious: lens,
							courageous: lens,
						},
					}),
				),
			);
			const pass = { rating: "pass" };
			ok(
				await withPeopleWrite(db, who.author, (t, ctx) =>
					interviews.createInterview(t, ctx, {
						requestKey: randomUUID(),
						input: {
							personId: dana.id,
							occurredOn: c.day(-3),
							maturity: { rating: "pass", notes: INTAKE_NOTE },
							gifted: pass,
							chemistry: pass,
							rightReasons: pass,
							season: pass,
							result: "qualified",
							nextSteps: INTAKE_NOTE,
						},
					}),
				),
			);
		},
	};

	const producer = createNotificationProducer({ optOutKey: Buffer.alloc(32, 3) });
	const facts = createFacts();
	const signals = createSignals();
	const launch = createLaunchReader();
	const day = (n: number) => c.day(n);

	type Read = readonly [name: string, run: () => Promise<unknown>];
	function reads(v: Viewer, kind: Kind, target: Ids = ids, citation = "coverage.filled"): Read[] {
		const a = who[v];
		const ctx = new PeopleReadContext(a);
		const people = <T,>(body: (t: WriteTx, x: PeopleReadContext) => Promise<T>) => tx((t) => body(t, ctx));
		switch (kind) {
			case "direct":
				return [
					["care.readCurrent", () => care.readCurrent(db, a, {})],
					["care.readHistory", () => care.readHistory(db, a, { page: 1 })],
					["care.readTrends", () => care.readTrends(db, a, {})],
					["intelligence.readAssessment", () => assessments.readAssessment(db, a, {})],
					["intelligence.readHistory", () => assessments.readHistory(db, a, {})],
					[
						"intelligence.resolveCitation",
						() => assessments.resolveCitation(db, a, { runId: target.run, key: citation }),
					],
					["oversight.getPlant", () => getPlant(db, a, P.id)],
					["communication.get", () => tx((t) => communicationWriter.get(t, a, { id: target.draft }))],
					["communication.getDraft", () => tx((t) => communicationWriter.getDraft(t, a, { id: target.draft }))],
					["communication.getDetail", () => tx((t) => communicationWriter.getDetail(t, a, { id: target.draft }))],
					[
						"communication.deliveryTotals",
						() => tx((t) => communicationWriter.getDeliveryTotals(t, a, { communicationId: target.draft })),
					],
					[
						"communication.recipients",
						() =>
							tx((t) => communicationWriter.listHistoryRecipients(t, a, { communicationId: target.draft, limit: 10 })),
					],
					[
						"communication.executionResult",
						() => tx((t) => communicationWriter.getExecutionResult(t, a, { communicationId: target.draft })),
					],
					[
						"communication.forPerson",
						() => tx((t) => communicationWriter.listForPerson(t, a, { personId: target.person, limit: 10 })),
					],
					[
						"people.getPerson",
						() => people((t, x) => peopleReader.getPerson(t, x, { personId: personId.parse(target.person) })),
					],
					[
						"people.readPersonPage",
						() =>
							people((t, x) =>
								readPersonPage(t, x, { personId: target.person }, 50, { fields: true, records: 5, duplicates: true }),
							),
					],
					[
						"people.getActivities",
						() =>
							people((t, x) => peopleReader.getActivities(t, x, activityRequest.parse({ personId: target.person }))),
					],
					["people.getAssessments", () => people((t, x) => fourCs.getAssessments(t, x, { personId: target.person }))],
					["people.getInterviews", () => people((t, x) => interviews.getInterviews(t, x, { personId: target.person }))],
					[
						"people.getCommitments",
						() => people((t, x) => commitments.getCommitments(t, x, { personId: target.person })),
					],
					[
						"people.listRecordCorrections",
						() => people((t, x) => recordCorrections.listRecordCorrections(t, x, { personId: target.person })),
					],
					["pipeline.personRecord", () => readPipelinePersonRecord(db, a, { personId: target.candidate })],
					[
						"pipeline.organizationPerson",
						() => people((t, x) => peopleReader.getPerson(t, x, { personId: personId.parse(target.candidate) })),
					],
				];
			case "search":
				return [
					["people.search name", () => people((t, x) => searchPeople(t, x, "Dana Quiet"))],
					["people.search email", () => people((t, x) => searchPeople(t, x, target.email))],
					["people.search phone", () => people((t, x) => searchPeople(t, x, target.phone))],
					[
						"people.list email",
						() => people((t, x) => peopleReader.listPeople(t, x, listPeopleRequest.parse({ search: target.email }))),
					],
					[
						"people.duplicates",
						() => people((t, x) => checkForDuplicates(t, x, { displayName: "Someone", email: target.email })),
					],
					[
						"people.previewImport",
						async () => {
							const made = await people((t, x) =>
								peopleCsv.previewImport(t, x, {
									file: new TextEncoder().encode(`first_name,email\r\nSomeone,${target.email}\r\n`),
								}),
							);
							return made.status === "ok"
								? { matches: made.value.rows.map((r) => ("existingDuplicates" in r ? r.existingDuplicates : r.status)) }
								: made;
						},
					],
					[
						"communication.history",
						() => tx((t) => communicationWriter.listHistory(t, a, { query: target.body, limit: 50 })),
					],
					[
						"communication.recipients",
						() => tx((t) => communicationWriter.readRecipients(t, a, { query: target.email })),
					],
					["pipeline.board email", () => readPipelineBoard(db, a, { q: target.candidateEmail })],
					["launch.suggestGuests", () => launch.suggestGuests(db, a, "Dana")],
					["tasks.list", () => tx((t) => taskReader.list(t, a, { search: "hush" }))],
					["teams.searchMembers", () => teamsReader.searchMembers(db, a, { q: "Dana" })],
				];
			case "notification":
				return [
					["notifications.feed", () => readFeedPage(db, a, {})],
					["notifications.unread", () => producer.readUnreadCount(db, a, {})],
				];
			case "digest":
				return [
					["digest.previewPlanter", () => previewPlanterDigest(db, a, { plantId: P.id }, () => new Date())],
					[
						"digest.previewOversight",
						() => previewOversightDigest(db, a, { organizationId: org.id }, () => new Date()),
					],
					[
						"digest.planter mail",
						async () => {
							const made = await compilePlanterDigest(db, {
								plant: P.id,
								recipient: seated[v].id,
								asOf: new Date().toISOString(),
								through: day(7),
							});
							return renderPlanterDigest({ start: day(0), end: day(7), today: day(0) as never, ...made });
						},
					],
					[
						"digest.oversight mail",
						async () => {
							const made = await tx((t) =>
								compileOversightDigest(t, {
									organization: org.id,
									recipient: seated[v].id,
									start: day(-1),
									end: day(1),
									zone: "America/Chicago" as never,
								}),
							);
							return renderOversightDigest({ start: day(-1), end: day(1), ...made });
						},
					],
				];
			case "export":
				return [
					["people.export", () => people((t, x) => peopleCsv.exportPeople(t, x, {}))],
					["people.countExport", () => people((t, x) => peopleCsv.countExport(t, x, {}))],
					["pipeline.export", () => readPipelineExport(db, a)],
					["teams.orgChart export", () => teamsReader.readOrgChartExport(db, a, {})],
				];
			case "summary":
				return [
					["dashboard.metrics", () => dashboardReader.readMetrics(db, a)],
					["dashboard.activity", () => dashboardReader.readActivity(db, a)],
					["dashboard.setupGaps", () => dashboardReader.readSetupGaps(db, a)],
					["dashboard.actions", () => dashboardReader.readAvailableActions(db, a)],
					["people.listPeople", () => people((t, x) => peopleReader.listPeople(t, x, listPeopleRequest.parse({})))],
					[
						"people.pipelineData",
						() => people((t, x) => peopleReader.getPipelineData(t, x, listPeopleRequest.parse({}))),
					],
					["people.duplicatePairs", () => people((t, x) => listDuplicatePairs(t, x))],
					[
						"people.pipelineMetrics",
						() =>
							readPipelineMetrics(db, a, {
								asOf: new Date().toISOString(),
								from: day(-90),
								through: day(0),
								transition: { from: "prospect", to: "attendee" },
							}),
					],
					["communication.listHistory", () => tx((t) => communicationWriter.listHistory(t, a, { limit: 100 }))],
					["communication.listDrafts", () => tx((t) => communicationWriter.listDrafts(t, a))],
					[
						"communication.forMeeting",
						() => tx((t) => communicationWriter.listForMeeting(t, a, { meetingId: meeting })),
					],
					[
						"communication.audience",
						() =>
							tx((t) =>
								communicationWriter.readAudience(t, a, { groups: ["everyone"], teamIds: [], personIds: [] } as never),
							),
					],
					["meetings.list", () => meetingsReader.list(db, a, {})],
					["meetings.communicationContext", () => meetingsReader.communicationContext(db, a, { meetingId: meeting })],
					["tasks.count", () => tx((t) => taskReader.count(t, a, {}))],
					["teams.staffing", () => teamsReader.staffingSummary(db, a, {})],
					["teams.health", () => trainingReader.readAggregateHealth(db, a, {})],
					["followups.coverage", () => tx((t) => followUpReader.followUpCoverage(t, a, { personId: ids.person }))],
					["phases.history", () => phaseReader.readHistory(db, a)],
					["launch.plan", () => launch.readPlan(db, a)],
					["intelligence.facts", () => facts.readFacts(db, a, {})],
					["intelligence.trends", () => assessments.readHistory(db, a, {})],
					["signals.page", () => signals.readAttestations(db, a, {})],
					["care.trends", () => care.readTrends(db, a, {})],
					["oversight.listPlants", () => listPlants(db, a)],
					["oversight.getPlant", () => getPlant(db, a, P.id)],
					["oversight.churches", () => listSendingChurches(db, a)],
					["oversight.church", () => getSendingChurch(db, a, org.id)],
					["oversight.intelligence", () => readIntelligence(db, a, { level: "portfolio", runId: null })],
					["sharing.plant", () => readPlantSharing(db, a)],
					["pipeline.board", () => readPipelineBoard(db, a, {})],
					["pipeline.choices", () => readPipelineChoices(db, a)],
					["pipeline.goals", () => readPipelineGoals(db, a)],
				];
			case "evry":
				return adapters
					.filter((adapter) => adapter.allowed(evryActor(a)))
					.flatMap((adapter) =>
						evryInputs(adapter, target).map(
							([name, input]) => [`${adapter.operation} ${name}`, () => evry(a, adapter, input)] as const,
						),
					);
		}
	}

	function known(target: Ids): Record<string, unknown> {
		return {
			personId: target.person,
			communicationId: target.draft,
			runId: target.run,
			meetingId: meeting,
			teamId: team,
			taskId: task.id,
			plantId: P.id,
			email: target.email,
			query: target.email,
			subject: target.subject,
			parentId: task.id,
			fromAccountId: seated.author.id,
			personIds: [target.person],
			commitmentId: target.run,
			programId: target.run,
			venueId: target.run,
			articleId: target.run,
			documentId: target.run,
			feedbackId: target.run,
			sourceId: target.person,
			survivorId: leadPerson.id,
			q: "Dana",
			kind: "person",
			selection: "delivered_nonopeners",
			window: "all",
			title: "hush",
			body: "hello",
			audience: { groups: [], teamIds: [], personIds: [target.person] },
			date: day(1),
			time: "10:00",
			level: "portfolio",
		};
	}
	function evryInputs(adapter: ReadAdapter<unknown>, target: Ids): [string, unknown][] {
		const shape = z.toJSONSchema(adapter.input as never, { io: "input", unrepresentable: "any" }) as Shape;
		const values = known(target);
		const pick = (names: string[]) => Object.fromEntries(names.filter((n) => n in values).map((n) => [n, values[n]]));
		const variants = [shape, ...(shape.oneOf ?? []), ...(shape.anyOf ?? [])].flatMap((s) => {
			const required = s.required ?? [];
			return [pick(required), ...Object.keys(s.properties ?? {}).map((n) => pick([...new Set([...required, n])]))];
		});
		const seen = new Map<string, unknown>();
		for (const input of variants) {
			const parsed = adapter.input.safeParse(input);
			if (parsed.success) seen.set(Object.keys(input).join("+") || "all", parsed.data);
		}
		return [...seen];
	}
	const unasked = (v: Viewer) =>
		adapters
			.filter((adapter) => adapter.allowed(evryActor(who[v])) && evryInputs(adapter, ids).length === 0)
			.map((adapter) => adapter.operation);
	async function evry(a: RequestActor, adapter: ReadAdapter<unknown>, input: unknown) {
		return invokeRead(db, evryActor(a), adapter, input);
	}

	async function outcome(run: () => Promise<unknown>) {
		try {
			return await run();
		} catch (error) {
			const e = error as { code?: unknown; name?: string; message?: string };
			return { threw: typeof e.code === "string" ? e.code : `${e.name}: ${e.message}` };
		}
	}
	async function read(v: Viewer, kind: Kind, target: Ids = ids, citation?: string) {
		const out: Record<string, unknown> = {};
		for (const [name, run] of reads(v, kind, target, citation)) out[name] = await outcome(run);
		return out;
	}
	async function surface(v: Viewer, kinds: readonly Kind[]) {
		const out: Record<string, unknown> = {};
		for (const kind of kinds)
			for (const [name, value] of Object.entries(await read(v, kind))) out[`${kind}: ${name}`] = settled(value, ids);
		return out;
	}
	const refreshNetwork = async () => requestIntelligenceRefresh(db, who.director, { runId: randomUUID() });

	const networkGroups = async () =>
		(await readIntelligence(db, who.director, { level: "portfolio", runId: null }))!.groups;
	const directoryHealth = async () =>
		(await listPlants(db, who.director))!.plants.find((p) => p.plantId === P.id)!.health;

	return {
		c,
		db,
		admin,
		P,
		ids,
		who,
		actions,
		read,
		surface,
		unasked,
		care,
		refreshNetwork,
		networkGroups,
		directoryHealth,
		close: () => database.close(),
	};
}
export type World = Awaited<ReturnType<typeof world>>;
