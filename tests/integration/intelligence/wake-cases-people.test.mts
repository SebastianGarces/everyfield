import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { captureFacts } from "../../../packages/domain/src/intelligence/index.ts";
import { enqueueJob } from "../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { timezoneOperations, type SettingsEffects } from "../../../packages/domain/src/settings/index.ts";
import { randomUUID } from "node:crypto";
import { assessments, commitments, peopleMerge, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { createAttendanceWriter, meetingsWriter } from "../../../packages/domain/src/meetings/index.ts";
import { createTaskWriter } from "../../../packages/domain/src/tasks/index.ts";
import { teamsReader, teamsWriter, trainingReader, trainingWriter } from "../../../packages/domain/src/teams/index.ts";
import { ok } from "../../support/fixture.mts";
import { listed, wakeCase, wakeWorld, type LoadedWakeCase, type WakePlant, type WakeWorld } from "./wake-world.mts";

let W: WakeWorld;
before(async () => {
	W = await wakeWorld("mw1");
});
after(() => W?.close());

type Json = Record<string, unknown>;
type Row<T> = {
	id: string;
	marker: `AC:${string} `;
	operation: string;
	producer: string;
	arrange: (w: Omit<WakePlant<T>, "r0" | "arranged">, k: LoadedWakeCase) => Promise<T>;
	facts: (w: WakePlant<T>) => Promise<Json>;
	write: (w: WakePlant<T>, k: LoadedWakeCase) => Promise<unknown>;
	action?: string;
};
const row = <T,>(r: Row<T>) => r as Row<unknown>;

const replan: SettingsEffects["replan"] = (tx, input) =>
	enqueueJob(tx, {
		tenant: input.owner.id,
		kind: "digest",
		subject: input.owner.id,
		key: `settings/${input.kind}/${input.operationId}/${input.revision}`,
		revision: input.revision,
		eligibleAt: W.clock.now(),
	});
const zones = () => timezoneOperations({ replan }, undefined, W.clock);
const localDate = async (p: { id: string }, at: string) => (await captureFacts(W.db, p.id, at))!.today;
const snapshotOf = async (w: { P: { id: string } }) => (await captureFacts(W.db, w.P.id, null))!;
type Arranged = { ids: Record<string, string>; raw?: unknown };
const labelOf = (a: Arranged, id: string) => Object.entries(a.ids).find(([, v]) => v === id)?.[0] ?? id;
const revisionOf = async (table: string, id: string, column = "revision") =>
	(
		await W.c.one<{ r: string }>(sql`SELECT ${sql.identifier(column)}::text AS r FROM ${sql.identifier(table)}
		WHERE id=${id}`)
	).r;
const asAdmin = <R,>(w: WakePlant<unknown>, op: (tx: never, ctx: never, raw: never) => Promise<R>, raw: unknown) =>
	gatedTransaction(W.db, (tx) => op(tx as never, w.A.ctx as never, raw as never));
async function once(w: WakePlant<unknown>, build: () => Promise<unknown>) {
	const a = w.arranged as Arranged;
	a.raw ??= await build();
	return a.raw;
}
const requestKey = (k: LoadedWakeCase) => W.key(String(k.action.arguments.request_key));
const args = (k: LoadedWakeCase) => k.action.arguments as Record<string, unknown>;
const at = (iso: string | Date | null) => (iso === null ? null : new Date(iso).toISOString().replace(".000Z", "Z"));
async function contacted(w: WakePlant<unknown>, person: string, occurredAt: string) {
	const id = randomUUID();
	await W.c.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},'contact_outcome',${w.P.id})`);
	await W.c.admin.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,outcome,occurred_at,recorded_at,
		contact_channel) VALUES(${id},${w.P.id},${person},'contacted',${occurredAt}::timestamptz,${occurredAt}::timestamptz,'phone')`);
}
const genuineDates = async (w: { P: { id: string } }) =>
	(
		await W.c.rows<{ d: string }>(sql`SELECT DISTINCT min(k.signed_on)::text AS d FROM commitment k
			JOIN person p ON p.id=k.person_id AND p.tenant_id=k.plant_id AND p.state='live'
			WHERE k.plant_id=${w.P.id} AND k.voided_at IS NULL GROUP BY k.person_id ORDER BY 1`)
	).map((r) => r.d);

const heldAt = (date: string) => new Date(`${date}T23:00:00.000Z`).toISOString();
async function initTeams(
	w: WakePlant<unknown>,
	selections: { teamKey: string; roleKeys: string[] }[],
	key = randomUUID(),
) {
	const { version } = ok(await teamsReader.listImportTemplates(W.db, w.A.actor, {}));
	ok(
		await asAdmin(w, teamsWriter.initialize, {
			requestKey: key,
			input: { expectedVersion: version, mode: "import", selections },
		}),
	);
	return rolesOf(w);
}
const rolesOf = async (w: { P: { id: string } }) =>
	Object.fromEntries(
		(
			await W.c.rows<{ id: string; team: string; key: string }>(sql`SELECT id::text AS id,team_id::text AS team,
				template_key AS key FROM team_role WHERE plant_id=${w.P.id} AND template_key IS NOT NULL`)
		).map((r) => [r.key, r]),
	);
const assignRole = async (
	w: WakePlant<unknown>,
	role: { id: string; team: string },
	personId: string,
	key = randomUUID(),
) =>
	ok(
		await asAdmin(w, teamsWriter.assignRole, {
			requestKey: key,
			expectedRevision: await revisionOf("team_role", role.id),
			input: { roleId: role.id, teamId: role.team, personId },
		}),
	);
const createProgram = async (w: WakePlant<unknown>, name: string, required: boolean) =>
	(
		ok(
			await asAdmin(w, trainingWriter.createProgram, {
				requestKey: randomUUID(),
				input: { name, required, teamId: null },
			}),
		) as {
			program: { id: string };
		}
	).program.id;
async function rosterRequest(
	w: WakePlant<unknown>,
	programId: string,
	personIds: string[],
	key: string = randomUUID(),
) {
	const seen = ok(await trainingReader.readRequiredTrainingPreview(W.db, w.A.actor, { programId, personIds })) as {
		revision: string;
		rosterDigest: string;
	};
	return {
		requestKey: key,
		expectedRevision: seen.revision,
		input: { programId, personIds, rosterDigest: seen.rosterDigest },
	};
}
const saveRoster = async (w: WakePlant<unknown>, programId: string, personIds: string[]) =>
	ok(await asAdmin(w, trainingWriter.setRequiredTrainingParticipants, await rosterRequest(w, programId, personIds)));
const attest = async (w: WakePlant<unknown>, programId: string, personId: string) =>
	ok(
		await asAdmin(w, trainingWriter.attestCompletion, {
			requestKey: randomUUID(),
			expectedRevision: await revisionOf("training_program", programId),
			input: { kind: "program", personId, programId, earnedOn: W.c.day(-1) },
		}),
	);
const rosterOf = async (w: WakePlant<unknown>, programId: string) =>
	(
		await W.c.rows<{
			id: string;
		}>(sql`SELECT person_id::text AS id FROM training_assignment WHERE program_id=${programId}
			AND state='active'`)
	)
		.map((r) => labelOf(w.arranged as Arranged, r.id))
		.sort();
const completionsOf = async (w: WakePlant<unknown>, programId: string) =>
	(
		await W.c.rows<{ id: string }>(sql`SELECT person_id::text AS id FROM training_credit WHERE program_id=${programId}
			GROUP BY person_id HAVING (array_agg(kind ORDER BY recorded_at DESC,id DESC))[1]='earned'`)
	)
		.map((r) => labelOf(w.arranged as Arranged, r.id))
		.sort();
const completionRate = async (w: WakePlant<unknown>) => {
	const t = (await snapshotOf(w)).training;
	return t.total === 0 ? null : t.complete / t.total;
};

const attendance = createAttendanceWriter({ reminders: async () => {} });
const tasks = createTaskWriter({ reminders: async () => {} });
async function schedule(w: WakePlant<unknown>, type: string, date: string) {
	return (
		ok(
			await asAdmin(w, meetingsWriter.schedule, { requestKey: randomUUID(), input: { type, date, time: "18:00" } }),
		) as { meeting: { id: string } }
	).meeting.id;
}
async function held(w: WakePlant<unknown>, id: string) {
	for (const to of ["in_progress", "completed"])
		ok(
			await asAdmin(w, meetingsWriter.changeStatus, {
				requestKey: randomUUID(),
				expectedRevision: await revisionOf("meeting", id),
				input: { meetingId: id, to },
			}),
		);
}
const checkIn = async (w: WakePlant<unknown>, meetingId: string, personId: string) =>
	ok(await asAdmin(w, attendance.checkIn, { requestKey: randomUUID(), input: { meetingId, personId } }));
async function eligible(w: WakePlant<unknown>) {
	const me = await W.c.person(w.P, "Alex Admin");
	await W.c.admin.execute(sql`UPDATE person SET linked_account_id=${w.A.id},stage='leader' WHERE id=${me.id}`);
}
const finalizeRequest = async (
	w: WakePlant<unknown>,
	meetingId: string,
	attendeeIds: string[],
	key: string = randomUUID(),
) => ({
	requestKey: key,
	expectedRevision: await revisionOf("meeting", meetingId, "attendance_revision"),
	input: { meetingId, attendeeIds, followUpAssigneeIds: [w.A.id], evaluationAssigneeIds: [w.A.id] },
});
const attendedIn = async (w: WakePlant<unknown>, meetingId: string) =>
	(
		await W.c.rows<{ id: string }>(sql`SELECT person_id::text AS id FROM participation WHERE meeting_id=${meetingId}
			AND removed_at IS NULL AND presence='attended'`)
	)
		.map((r) => labelOf(w.arranged as Arranged, r.id))
		.sort()
		.join(",") || null;
const managedOf = async (meetingId: string) =>
	W.c.one<{ obligations: number; tasks: number; origins: string | null }>(sql`SELECT
		(SELECT count(*)::int FROM obligation WHERE meeting_id=${meetingId} AND kind='follow_up') AS obligations,
		(SELECT count(*)::int FROM task t WHERE t.deleted_at IS NULL AND (t.meeting_id=${meetingId}
			OR t.obligation_id IN (SELECT id FROM obligation WHERE meeting_id=${meetingId}))) AS tasks,
		(SELECT string_agg(DISTINCT meeting_id::text,',') FROM obligation WHERE meeting_id=${meetingId}
			AND kind='follow_up') AS origins`);

const ROWS: Row<unknown>[] = [
	row({
		id: "MW-CASE-001",
		marker: "AC:MW-CASE-001 ",
		operation: "settings.saveSection",
		producer:
			"settings timezoneOperations.previewPlantTimezone (the reviewed future-schedule preview) + setPlantTimezone",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as { timezone: string };
			await W.c.admin.execute(sql`UPDATE plant SET timezone=${before.timezone} WHERE id=${w.P.id}`);
			const request = (k.action.arguments.request as { patch: { timezone: string } }).patch;
			return { zone: request.timezone, preview: null as string | null, revision: "" };
		},
		facts: async (w) => ({
			timezone: (await W.c.one<{ timezone: string }>(sql`SELECT timezone FROM plant WHERE id=${w.P.id}`)).timezone,
			localDateAt20261013T0430Z: await localDate(w.P, "2026-10-13T04:30:00.000Z"),
		}),
		write: async (w, k) => {
			const a = w.arranged as { zone: string; preview: string | null; revision: string };
			const plant = { kind: "plant" as const, id: w.P.id };
			if (!a.preview) {
				const preview = ok(
					await gatedTransaction(W.db, (tx) =>
						zones().previewPlantTimezone(tx, w.A.ctx as never, { plant, timeZone: a.zone }),
					),
				);
				a.preview = preview.previewId;
				a.revision = preview.expectedRevision;
			}
			return gatedTransaction(W.db, (tx) =>
				zones().setPlantTimezone(tx, w.A.ctx as never, {
					input: { plant, timeZone: a.zone, previewId: a.preview },
					expectedRevision: a.revision,
					requestKey: W.key(String(k.action.arguments.request_key)),
				}),
			);
		},
	}),
	row<Arranged>({
		id: "MW-CASE-002",
		marker: "AC:MW-CASE-002 ",
		operation: "people.updatePerson",
		producer: "peopleWriter.updatePerson (patch firstName with the displayed name)",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as { personDisplay: string; effectiveContactedAt: string };
			const maria = await W.c.committed(w.P, before.personDisplay, 30);
			await contacted(w as WakePlant<unknown>, maria.id, before.effectiveContactedAt);
			return { ids: { "Person-P": maria.id } };
		},
		facts: async (w) => {
			const id = w.arranged.ids["Person-P"]!;
			const p = await W.c.one<{ name: string; contacted: string | null }>(sql`SELECT display_name AS name,
				(SELECT max(e.occurred_at)::text FROM contact_outcome e WHERE e.person_id=${id} AND e.voided_at IS NULL
				AND e.outcome='contacted') AS contacted FROM person WHERE id=${id}`);
			return { personDisplay: p.name, effectiveContactedAt: at(p.contacted) };
		},
		write: async (w, k) => {
			const id = w.arranged.ids["Person-P"]!;
			const patch = args(k).patch as { firstName: string };
			const raw = await once(w, async () => ({
				requestKey: requestKey(k),
				expectedRevision: await revisionOf("person", id),
				input: { personId: id, patch: { firstName: patch.firstName, displayName: patch.firstName } },
			}));
			return await asAdmin(w, peopleWriter.updatePerson, raw);
		},
	}),
	row<Arranged>({
		id: "MW-CASE-003",
		marker: "AC:MW-CASE-003 ",
		operation: "people.withdrawCommitment",
		producer: "commitments.withdrawCommitment",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as { knownCurrentAdultCount: number; firstGenuineAcquisition: string };
			const days = Math.round((Date.parse(W.c.today) - Date.parse(before.firstGenuineAcquisition)) / 86_400_000);
			const adults = [];
			for (let i = 0; i < before.knownCurrentAdultCount; i++)
				adults.push(await W.c.committed(w.P, `Adult ${String(i + 1).padStart(2, "0")}`, days));
			return { ids: { "Person-P": adults[0]!.id } };
		},
		facts: async (w) => {
			const f = await snapshotOf(w);
			return {
				knownCurrentAdultCount: f.committedAdults.known,
				firstGenuineAcquisition: (await genuineDates(w))[0] ?? null,
				lastGenuineAcquisition: f.growth.lastAcquiredOn,
				daysSinceLastGenuineAcquisition: f.growth.daysSince,
				asOfLocalDate: f.today,
			};
		},
		write: async (w, k) => {
			const id = w.arranged.ids["Person-P"]!;
			const raw = await once(w, async () => ({
				requestKey: requestKey(k),
				expectedRevision: await revisionOf("person", id),
				input: { personId: id, effectiveOn: args(k).effectiveLocalDate, reason: args(k).reason },
			}));
			return await asAdmin(w, commitments.withdrawCommitment, raw);
		},
	}),
	row<Arranged>({
		id: "MW-CASE-004",
		marker: "AC:MW-CASE-004 ",
		operation: "people.mergePeople",
		producer: "peopleMerge.getMergeReview (the reviewed manifest digest) + peopleMerge.mergePeople",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as { genuineDates: string[] };
			const ago = (d: string) => Math.round((Date.parse(W.c.today) - Date.parse(d)) / 86_400_000);
			const p = await W.c.committed(w.P, "Pat Survivor", ago(before.genuineDates[0]!));
			const q = await W.c.committed(w.P, "Pat Duplicate", ago(before.genuineDates[1]!));
			await W.c.vision(w.P, 4, [p, q]);
			return { ids: { "Person-P": p.id, "Person-Q": q.id } };
		},
		facts: async (w) => {
			const a = w.arranged;
			const f = await snapshotOf(w);
			const attended = await W.c.rows<{ id: string }>(sql`SELECT DISTINCT person_id::text AS id FROM participation
				WHERE plant_id=${w.P.id} AND removed_at IS NULL AND presence='attended'`);
			const retired = await W.c.rows<{ id: string }>(sql`SELECT id::text AS id FROM person WHERE tenant_id=${w.P.id}
				AND state<>'live'`);
			return {
				distinctAdultCurrentSize: f.committedAdults.known,
				genuineDates: await genuineDates(w),
				attendanceReferences: attended.map((r) => labelOf(a, r.id)).sort(),
				retiredPerson: retired.map((r) => labelOf(a, r.id)).join(",") || null,
			};
		},
		write: async (w, k) => {
			const pair = { sourceId: w.arranged.ids["Person-Q"]!, survivorId: w.arranged.ids["Person-P"]! };
			const raw = await once(w, async () => {
				const review = ok(await asAdmin(w, peopleMerge.getMergeReview, pair)) as { reviewDigest: string };
				return {
					requestKey: requestKey(k),
					input: { ...pair, reviewDigest: review.reviewDigest, fieldChoices: args(k).fieldChoices },
				};
			});
			return await asAdmin(w, peopleMerge.mergePeople, raw);
		},
	}),
	row<Arranged>({
		id: "MW-CASE-005",
		marker: "AC:MW-CASE-005 ",
		operation: "people.createAssessment",
		producer: "people assessments.createAssessment (Four Cs)",
		arrange: async (w, k) => {
			const before = k.given["input-before"] as { stage: string };
			const leader = await W.c.person(w.P, "Lee Leader", { adultClassification: "adult", stage: before.stage });
			return { ids: { "Person-P": leader.id } };
		},
		facts: async (w) => {
			const id = w.arranged.ids["Person-P"]!;
			const f = await snapshotOf(w);
			const p = await W.c.one<{
				stage: string;
				name: string;
				total: number | null;
			}>(sql`SELECT stage,display_name AS name,
				(SELECT committed+compelled+contagious+courageous FROM four_cs WHERE person_id=${id}
				ORDER BY recorded_at DESC LIMIT 1) AS total FROM person WHERE id=${id}`);
			const shared = JSON.stringify(await W.orgState(w.orgA));
			return {
				humanAssessmentCount: f.humanRecords.fourCs.count + f.humanRecords.interviews.count,
				recordedTotal: p.total === null ? null : Number(p.total),
				stage: p.stage,
				orgIndividualQualificationVisible: shared.includes(p.name) || shared.includes(id),
			};
		},
		write: async (w, k) => {
			const id = w.arranged.ids["Person-P"]!;
			const r = args(k).criterionRatings as Record<string, { score: number; notes: string | null }>;
			const raw = await once(w, async () => ({
				requestKey: requestKey(k),
				input: {
					personId: id,
					occurredOn: args(k).eventLocalDate,
					committed: r.committed,
					compelled: r.compelled,
					contagious: r.contagious,
					courageous: r.courageous,
				},
			}));
			return await asAdmin(w, assessments.createAssessment, raw);
		},
	}),
	row<Arranged & { roles: Record<string, { id: string; team: string }>; program: string }>({
		id: "MW-CASE-007",
		marker: "AC:MW-CASE-007 ",
		operation: "teams.assignRole",
		producer: "teamsWriter.assignRole",
		arrange: async (w) => {
			const ww = w as WakePlant<unknown>;
			const p = await W.c.person(w.P, "Pat Leader");
			const q = await W.c.person(w.P, "Quinn Trainee");
			const roles = await initTeams(ww, [
				{ teamKey: "worship", roleKeys: ["worship_lead"] },
				{ teamKey: "childrens_ministry", roleKeys: ["childrens_lead"] },
			]);
			await assignRole(ww, roles.childrens_lead!, p.id);
			const program = await createProgram(ww, "Safe kids", true);
			await saveRoster(ww, program, [q.id]);
			return { ids: { "Person-P": p.id, "Person-Q": q.id }, roles, program };
		},
		facts: async (w) => {
			const coverage = (await snapshotOf(w)).coverage;
			const worship = coverage.responsibilities.find((r) => r.key === "worship")!.people;
			return {
				filledAreaCount: coverage.filled,
				distinctAssignedPeople: coverage.people,
				worshipRolePerson: worship.map((p) => labelOf(w.arranged, p.id)).join(",") || null,
				savedTrainingRoster: await rosterOf(w as WakePlant<unknown>, w.arranged.program),
			};
		},
		write: async (w, k) => {
			const role = w.arranged.roles.worship_lead!;
			const raw = await once(w as WakePlant<unknown>, async () => ({
				requestKey: requestKey(k),
				expectedRevision: await revisionOf("team_role", role.id),
				input: { roleId: role.id, teamId: role.team, personId: w.arranged.ids["Person-P"]! },
			}));
			return await asAdmin(w as WakePlant<unknown>, teamsWriter.assignRole, raw);
		},
	}),
	row<Arranged & { program: string }>({
		id: "MW-CASE-008",
		marker: "AC:MW-CASE-008 ",
		operation: "teams.correctProgram",
		producer: "trainingWriter.correctProgram",
		arrange: async (w) => {
			const ww = w as WakePlant<unknown>;
			const p = await W.c.person(w.P, "Pat Volunteer");
			const program = await createProgram(ww, "Safe kids", false);
			await saveRoster(ww, program, [p.id]);
			return { ids: { "Person-P": p.id, "Program-A": program }, program };
		},
		facts: async (w) => ({
			programRequired: (
				await W.c.one<{ r: boolean }>(sql`SELECT required AS r FROM training_program
				WHERE id=${w.arranged.program}`)
			).r,
			savedAssignments: await rosterOf(w as WakePlant<unknown>, w.arranged.program),
			applicableRequiredObligations: (await snapshotOf(w)).training.total,
		}),
		write: async (w, k) => {
			const id = w.arranged.program;
			const raw = await once(w as WakePlant<unknown>, async () => ({
				requestKey: requestKey(k),
				expectedRevision: await revisionOf("training_program", id),
				input: {
					programId: id,
					name: "Safe kids",
					required: (args(k).patch as { required: boolean }).required,
					reason: args(k).reason,
				},
			}));
			return await asAdmin(w as WakePlant<unknown>, trainingWriter.correctProgram, raw);
		},
	}),
	row<Arranged & { program: string }>({
		id: "MW-CASE-009",
		marker: "AC:MW-CASE-009 ",
		operation: "teams.setRequiredTrainingParticipants",
		producer:
			"trainingReader.readRequiredTrainingPreview (the reviewed roster digest) + trainingWriter.setRequiredTrainingParticipants",
		arrange: async (w) => {
			const ww = w as WakePlant<unknown>;
			const p = await W.c.person(w.P, "Pat Trained");
			const q = await W.c.person(w.P, "Quinn New");
			const program = await createProgram(ww, "Safe kids", true);
			await saveRoster(ww, program, [p.id]);
			await attest(ww, program, p.id);
			return { ids: { "Person-P": p.id, "Person-Q": q.id, "Program-A": program }, program };
		},
		facts: async (w) => ({
			savedRosterRevision: Number(await revisionOf("training_program", w.arranged.program)),
			roster: await rosterOf(w as WakePlant<unknown>, w.arranged.program),
			validCompletions: await completionsOf(w as WakePlant<unknown>, w.arranged.program),
			requiredCompletionRate: await completionRate(w as WakePlant<unknown>),
		}),
		write: async (w, k) => {
			const a = args(k);
			const manifest = a.reviewedSelectionManifest as { persons: string[] };
			const ids = manifest.persons.map((l) => w.arranged.ids[l]!);
			const raw = await once(w as WakePlant<unknown>, () =>
				rosterRequest(w as WakePlant<unknown>, w.arranged.program, ids, requestKey(k)),
			);
			return await asAdmin(w as WakePlant<unknown>, trainingWriter.setRequiredTrainingParticipants, raw);
		},
	}),
	row<Arranged & { program: string }>({
		id: "MW-CASE-010",
		marker: "AC:MW-CASE-010 ",
		operation: "teams.revokeCompletion",
		producer: "trainingWriter.revokeCompletion",
		arrange: async (w) => {
			const ww = w as WakePlant<unknown>;
			const p = await W.c.person(w.P, "Pat Trained");
			const q = await W.c.person(w.P, "Quinn Trained");
			const program = await createProgram(ww, "Safe kids", true);
			await saveRoster(ww, program, [p.id, q.id]);
			await attest(ww, program, p.id);
			await attest(ww, program, q.id);
			return { ids: { "Person-P": p.id, "Person-Q": q.id, "Program-A": program }, program };
		},
		facts: async (w) => ({
			roster: await rosterOf(w as WakePlant<unknown>, w.arranged.program),
			validCompletions: await completionsOf(w as WakePlant<unknown>, w.arranged.program),
			requiredCompletionRate: await completionRate(w as WakePlant<unknown>),
		}),
		write: async (w, k) => {
			const id = w.arranged.program;
			const raw = await once(w as WakePlant<unknown>, async () => ({
				requestKey: requestKey(k),
				expectedRevision: await revisionOf("training_program", id),
				input: { personId: w.arranged.ids["Person-P"]!, programId: id },
			}));
			return await asAdmin(w as WakePlant<unknown>, trainingWriter.revokeCompletion, raw);
		},
	}),
	row<Arranged & { meeting: string }>({
		id: "MW-CASE-011",
		marker: "AC:MW-CASE-011 ",
		operation: "meetings.correctPracticeOccurrence",
		producer: "meetingsWriter.correctPracticeOccurrence",
		arrange: async (w, k) => {
			const ww = w as WakePlant<unknown>;
			const before = k.given["input-before"] as { actualLocalDate: string };
			const p = await W.c.committed(w.P, "Pat Practice", 30);
			const meeting = await schedule(ww, "prelaunch_practice", before.actualLocalDate);
			ok(
				await asAdmin(ww, meetingsWriter.completePractice, {
					requestKey: randomUUID(),
					expectedRevision: await revisionOf("meeting", meeting),
					input: { meetingId: meeting, occurredAt: heldAt(before.actualLocalDate) },
				}),
			);
			await checkIn(ww, meeting, p.id);
			return { ids: { "Person-P": p.id, "Meeting-Practice": meeting }, meeting };
		},
		facts: async (w) => {
			const m = await W.c.one<{ type: string; day: string | null }>(sql`SELECT m.type,
				(m.actual_occurrence_at AT TIME ZONE pl.timezone)::date::text AS day FROM meeting m JOIN plant pl ON pl.id=m.plant_id
				WHERE m.id=${w.arranged.meeting}`);
			const held = (type: string) =>
				W.count(sql`SELECT count(*) AS n FROM meeting WHERE plant_id=${w.P.id} AND type=${type} AND status='completed'
					AND occurrence_voided_at IS NULL AND retired_at IS NULL`);
			return {
				canonicalType: m.type === "prelaunch_practice" ? "pre_launch_practice" : m.type,
				actualLocalDate: m.day,
				practiceOccurrenceCount: await held("prelaunch_practice"),
				VisionOccurrenceCount: await held("vision_meeting"),
			};
		},
		write: async (w, k) => {
			const id = w.arranged.meeting;
			const a = args(k);
			const raw = await once(w as WakePlant<unknown>, async () => ({
				requestKey: requestKey(k),
				expectedRevision: await revisionOf("meeting", id),
				input: {
					meetingId: id,
					state: a.actualOccurrenceState,
					occurredAt: heldAt(String(a.actualLocalDate)),
					reason: a.reason,
				},
			}));
			return asAdmin(w as WakePlant<unknown>, meetingsWriter.correctPracticeOccurrence, raw);
		},
	}),
	row<Arranged & { meeting: string }>({
		id: "MW-CASE-012",
		marker: "AC:MW-CASE-012 ",
		operation: "meetings.finalizeAttendance",
		producer: "createAttendanceWriter(...).finalizeAttendance",
		arrange: async (w) => {
			const ww = w as WakePlant<unknown>;
			await eligible(ww);
			const p = await W.c.person(w.P, "Pat Visitor");
			const meeting = await schedule(ww, "vision_meeting", W.c.day(-1));
			await held(ww, meeting);
			await checkIn(ww, meeting, p.id);
			return { ids: { "Person-P": p.id, "Meeting-V": meeting }, meeting };
		},
		facts: async (w) => {
			const id = w.arranged.meeting;
			const p = w.arranged.ids["Person-P"]!;
			const m = await W.c.one<{ finalized: boolean; prior: boolean; completed: string }>(sql`SELECT
				finalized_at IS NOT NULL AS finalized,
				(SELECT string_agg(id::text,',') FROM meeting WHERE plant_id=${w.P.id} AND type='vision_meeting'
					AND status='completed') AS completed,
				EXISTS(SELECT FROM participation pa JOIN meeting v ON v.id=pa.meeting_id AND v.type='vision_meeting'
					WHERE pa.person_id=${p} AND pa.presence='attended' AND pa.removed_at IS NULL AND v.id<>${id}) AS prior
				FROM meeting WHERE id=${id}`);
			const managed = await managedOf(id);
			return {
				completedMeeting: labelOf(w.arranged, m.completed),
				actualAttendee: await attendedIn(w as WakePlant<unknown>, id),
				priorAttendedVision: m.prior,
				finalized: m.finalized,
				originObligationCount: managed.obligations,
				managedTaskCount: managed.tasks,
				immutableOrigin: managed.origins && labelOf(w.arranged, managed.origins),
			};
		},
		write: async (w, k) => {
			const id = w.arranged.meeting;
			const raw = await once(w as WakePlant<unknown>, () =>
				finalizeRequest(w as WakePlant<unknown>, id, [w.arranged.ids["Person-P"]!], requestKey(k)),
			);
			return asAdmin(w as WakePlant<unknown>, attendance.finalizeAttendance, raw);
		},
	}),
	row<Arranged & { task: string; obligation: string }>({
		id: "MW-CASE-013",
		marker: "AC:MW-CASE-013 ",
		operation: "tasks.waive",
		producer: "createTaskWriter(...).waive",
		arrange: async (w) => {
			const ww = w as WakePlant<unknown>;
			await eligible(ww);
			const p = await W.c.person(w.P, "Pat Guest");
			const meeting = await schedule(ww, "vision_meeting", W.c.day(-1));
			await held(ww, meeting);
			ok(await asAdmin(ww, attendance.finalizeAttendance, await finalizeRequest(ww, meeting, [p.id])));
			const f = await W.c.one<{
				task: string;
				obligation: string;
			}>(sql`SELECT t.id::text AS task,o.id::text AS obligation
				FROM obligation o JOIN task t ON t.obligation_id=o.id WHERE o.meeting_id=${meeting} AND o.person_id=${p.id}
				AND o.kind='follow_up'`);
			return {
				ids: { "Person-P": p.id, "Meeting-V": meeting, "Task-F": f.task, "Obligation-V-P": f.obligation },
				...f,
			};
		},
		facts: async (w) => {
			const o = w.arranged.obligation;
			const s = await W.c.one<{ state: string; live: number }>(sql`SELECT
				CASE WHEN o.waived_at IS NOT NULL OR t.status='no_longer_needed' THEN 'no_longer_needed'
					WHEN t.status='complete' THEN 'complete' ELSE 'open' END AS state,
				(SELECT count(*)::int FROM task k WHERE k.obligation_id=o.id AND k.deleted_at IS NULL
					AND k.status NOT IN ('complete','no_longer_needed')) AS live
				FROM obligation o JOIN task t ON t.id=${w.arranged.task} WHERE o.id=${o}`);
			const f = (await snapshotOf(w)).followUps;
			return {
				liveTaskState: s.state,
				liveTaskCount: s.live,
				successful48hCount: f.onTime,
				contactedCount: f.contacted,
			};
		},
		write: async (w, k) => {
			const id = w.arranged.task;
			const raw = await once(w as WakePlant<unknown>, async () => ({
				requestKey: requestKey(k),
				expectedRevision: await revisionOf("task", id),
				input: { taskId: id, reason: args(k).reason },
			}));
			return asAdmin(w as WakePlant<unknown>, tasks.waive, raw);
		},
	}),
];

for (const r of ROWS)
	test(`${r.marker}${r.operation} fails all or nothing with the wakeup paused: the change is found by the sweep, a replay adds nothing and stale publications are superseded`, async () => {
		assert.equal(r.marker, `AC:${r.id} `);
		const k = wakeCase(r.id);
		assert.equal(k.action.operation, r.operation);
		assert.equal(k.replay.action.operation, r.operation);
		assert.equal(k.failure.action.operation, r.operation);
		const w = await W.plant(r.id, (base) => r.arrange(base, k));
		const facts = () => r.facts(w);
		const inputBefore = strip(k.given["input-before"] as Json);
		assert.deepEqual(listed(await facts(), inputBefore), inputBefore, "the arranged input-before");
		await W.runCase(w, k, {
			write: async () => ok((await r.write(w, k)) as never),
			attempt: () => r.write(w, k),
			facts,
			action: r.action,
		});
	});

function strip({ fixture_type: _, ...rest }: Json) {
	return rest;
}
