import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { owner as ownerSchema } from "../../../packages/contracts/src/common/index.ts";
import { readViewer, type WriteTx } from "../../../packages/domain/src/access/session.ts";
import { readPipelinePerson } from "../../../packages/domain/src/access/pipeline.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import {
	pipelineWriter,
	programWriter,
	readEnrollment,
	readPipelineBoard,
	readPipelineGoals,
	readPipelinePersonRecord,
	readProgram,
} from "../../../packages/domain/src/organizations/index.ts";
import { evryActor, invokeRead } from "../../../packages/evry/src/index.ts";
import { PIPELINE_READS } from "../../../packages/evry/src/adapters/pipeline/reads/index.ts";
import { fixture, ok, type Actor, type Workspace } from "../../support/fixture.mts";
import { frozenClock } from "../../support/test-database.mts";
import { recorded, touched, untouched } from "../../support/recorded.mts";
import { authorityOf } from "../people/people-support.mts";

export const NOW = new Date("2026-10-17T16:00:00Z");
export type Organization = Workspace & { kind: "organization" };
export type Scene = Awaited<ReturnType<Awaited<ReturnType<typeof sendingWorld>>["scene"]>>;
type Row = Record<string, unknown>;
type Reply = { status: string; refusal?: { code: string; field?: string } };

export const refusedWith = (reply: Reply, code = "unavailable", field?: string) => {
	assert.equal(reply.status, "refused", JSON.stringify(reply));
	assert.equal(reply.refusal?.code, code);
	if (field) assert.equal(reply.refusal?.field, field);
};

export async function sendingWorld(prefix: string) {
	const database = await fixture({ prefix, max: 8, clock: NOW });
	const { admin } = database;
	const db = database.pools.runtime;
	const rows = async <R extends Row = Row>(query: SQL) => (await admin.execute<R>(query)).rows;
	const one = async <R extends Row = Row>(query: SQL) => {
		const [row] = await rows<R>(query);
		assert.ok(row);
		return row;
	};
	const count = async (query: SQL) => (await one<{ n: number }>(query)).n;
	const authority = (a: Pick<Actor, "session">) => authorityOf(db, a);
	async function at<T>(instant: string, body: () => Promise<T>): Promise<T> {
		await admin.execute(sql`UPDATE seat SET accepted_at='2026-01-01T00:00:00Z'`);
		await admin.execute(sql`UPDATE auth_session SET expires_at='2026-11-12T16:00:00Z'`);
		return frozenClock(admin, database.schema, instant, body);
	}
	const tx = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(db, body);
	const seatOf = async (a: Actor, o: Organization) =>
		(
			await one<{ id: string }>(
				sql`SELECT id FROM seat WHERE account_id=${a.id}::uuid AND organization_id=${o.id}::uuid AND ended_at IS NULL`,
			)
		).id;
	const board = async (a: Actor, query: object = {}) => ok(await readPipelineBoard(db, await authority(a), query));
	const record = async (a: Actor, personId: string) => readPipelinePersonRecord(db, await authority(a), { personId });
	const goals = async (a: Actor) => ok(await readPipelineGoals(db, await authority(a)));
	const program = async (a: Actor, programId: string) => ok(await readProgram(db, await authority(a), { programId }));
	const enrollment = async (a: Actor, enrollmentId: string) =>
		ok(await readEnrollment(db, await authority(a), { enrollmentId }));
	const duty = (a: Actor, o: Organization, personId: string) =>
		tx((t) => readPipelinePerson(t, a.session, ownerSchema.parse(o), { personId }));
	async function modelContent(
		a: Actor,
		inputs: Partial<Record<(typeof PIPELINE_READS)[number]["operation"], object[]>> = {},
	) {
		const viewer = await readViewer(db, a.session);
		const actor = evryActor(viewer!.authority!);
		const shown: unknown[] = [];
		for (const read of PIPELINE_READS)
			for (const input of [{}, ...(inputs[read.operation] ?? [])])
				shown.push(await invokeRead(db, actor, read as never, input));
		return JSON.stringify(shown);
	}
	async function place(
		by: Actor,
		displayName: string,
		{ email = null, stage = "potential_leader", responsible = null as string | null } = {} as {
			email?: string | null;
			stage?: string;
			responsible?: string | null;
		},
	) {
		const personId = randomUUID();
		const at = (await board(by)).stages.find((s) => s.kind === stage);
		assert.ok(at);
		ok(
			await pipelineWriter.addPerson(db, await authority(by), {
				personId,
				displayName,
				email,
				responsibleSeatId: responsible,
				stageId: at.id,
			}),
		);
		await admin.execute(sql`UPDATE person SET created_at='2026-01-01T00:00:00Z' WHERE id=${personId}`);
		return personId;
	}
	async function link(
		o: Organization,
		personId: string,
		account: Actor,
		{ shareFoundations = true, shareMilestones = true } = {},
	) {
		const ids = { affiliation: randomUUID(), invitation: randomUUID(), link: randomUUID() };
		const accepted = sql`'2026-09-30T16:00:00Z'::timestamptz`;
		await admin.execute(sql`INSERT INTO affiliation(id,account_id,organization_id,accepted_at,share_people,share_meetings,
			share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${ids.affiliation},${account.id},${o.id},${accepted},false,false,false,false,false,false,false)`);
		await admin.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,
			accepted_account_id,resident_person_id,revision) VALUES(${ids.invitation},${o.id},'residency_link',${account.email},
			${randomUUID()},'accepted',${accepted},${account.id},${personId},2)`);
		await admin.execute(sql`INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,
			accepted_at,consent_revision,revision,share_foundations,share_milestones) VALUES(${ids.link},${o.id},${personId},
			${account.id},${ids.affiliation},${ids.invitation},${accepted},2,2,${shareFoundations},${shareMilestones})`);
		await admin.execute(sql`UPDATE person SET linked_account_id=${account.id} WHERE id=${personId}`);
		return ids.link;
	}
	async function residency(by: Actor, directorSeatId: string, director: Actor, milestones = ["Lead a small group"]) {
		const programId = randomUUID();
		ok(
			await programWriter.createProgram(db, await authority(by), {
				programId,
				kind: "residency",
				name: "Residency",
				directorSeatId,
				plan: {
					rhythm: "monthly",
					expectedMonths: 15,
					stages: [{ label: "Assimilating", minMonths: 2, maxMonths: 3 }],
					milestones: milestones.map((title) => ({
						lineage: randomUUID(),
						title,
						description: `${title} and debrief with the director.`,
						handsOn: true,
					})),
					readings: [],
				},
			}),
		);
		const draft = await program(by, programId);
		ok(
			await programWriter.publishVersion(db, await authority(director), {
				programId,
				expectedRevision: draft.revision,
			}),
		);
		await admin.execute(
			sql`UPDATE development_program_version SET published_at='2026-09-15T16:00:00Z' WHERE program_id=${programId}`,
		);
		return programId;
	}
	async function enroll(by: Actor, programId: string, personId: string) {
		const enrollmentId = randomUUID();
		const published = (await program(by, programId)).published!;
		ok(
			await programWriter.enroll(db, await authority(by), {
				enrollmentId,
				programId,
				personId,
				cohort: "Autumn 2026",
				startedOn: "2026-10-01",
				expectedEndOn: "2028-01-01",
				stageId: published.stages[0]!.id,
				nextMeetingAt: null,
			}),
		);
		return enrollmentId;
	}
	async function scene(role: "owner" | "admin" | "member" = "admin") {
		const O = await database.organization("sending_church", { name: "Grace Austin", timezone: "America/Chicago" });
		const B = await database.organization("sending_church", { name: "Hope Dallas", timezone: "America/Chicago" });
		const staff = (o: Organization, as: "owner" | "admin" | "member", name: string) =>
			database.actor(o, as, { user: { name } });
		const A = await staff(O, role, "Alex"),
			D = await staff(O, "member", "Dee"),
			lead = role === "member" ? await staff(O, "owner", "Olive") : A;
		const R = await database.actor(null, "owner", { user: { name: "Casey Lee" } });
		const foreign = await staff(B, "admin", "Blair");
		const seats = { A: await seatOf(A, O), D: await seatOf(D, O), foreign: await seatOf(foreign, B) };
		return { O, B, A, D, lead, R, foreign, seats };
	}
	return {
		...database,
		db,
		rows,
		one,
		count,
		authority,
		at,
		tx,
		board,
		record,
		goals,
		program,
		enrollment,
		duty,
		modelContent,
		place,
		link,
		residency,
		enroll,
		scene,
		recorded: <T,>(body: () => Promise<T>) => recorded(admin, body),
		touched: <T,>(body: () => Promise<T>) => touched(admin, body),
		untouched: <T,>(body: () => Promise<T>) => untouched(admin, body),
	};
}
