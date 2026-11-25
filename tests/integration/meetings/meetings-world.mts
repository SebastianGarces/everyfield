import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tenantId } from "../../../packages/contracts/src/common/index.ts";
import type { MeetingsReply } from "../../../packages/contracts/src/meetings/index.ts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { RequestActor, type WriteTx } from "../../../packages/domain/src/access/session.ts";
import {
	createAttendanceWriter,
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	withMeetingsWrite,
	type MeetingsContext,
} from "../../../packages/domain/src/meetings/index.ts";
import { fixture, ok, raced, type Actor } from "../../support/fixture.mts";
import { failingWrite, NOTHING, recorded, touched } from "../../support/recorded.mts";

export const NOW = new Date("2026-10-13T16:00:00Z");
type Row = Record<string, unknown>;
type Write<R> = (tx: WriteTx, context: MeetingsContext, raw: unknown) => Promise<MeetingsReply<R>>;
export const key = () => randomUUID();
export const effects = (...audits: string[]) => ({ ...NOTHING, audits });

export async function meetingsWorld(prefix: string, clock = NOW) {
	const database = await fixture({ prefix, max: 8, clock });
	const { admin } = database;
	const db = database.pools.runtime;
	const P = database.tenant;
	const Q = await database.plant({ timezone: "America/New_York" });
	const actors = {
		owner: database.actors.owner,
		admin: database.actors.admin,
		member: database.actors.member,
		foreign: await database.actor(Q, "admin"),
		foreignMember: await database.actor(Q, "member"),
	};
	type Who = keyof typeof actors;
	const authority = async (who: Who | Actor) => {
		const actor = await RequestActor.resolve(db, (typeof who === "string" ? actors[who] : who).session);
		assert.ok(actor instanceof RequestActor);
		return actor;
	};
	const context = (who: Who) => ({
		session: actors[who].session,
		selected: { kind: "plant" as const, id: tenantId.parse(who.startsWith("foreign") ? Q.id : P.id) },
	});
	const write = async <R,>(op: Write<R>, raw: unknown, who: Who = "admin") =>
		withMeetingsWrite(db, await authority(who), (tx, ctx) => op(tx, ctx, raw));
	const create = <R,>(op: Write<R>, input: unknown, who: Who = "admin") => write(op, { requestKey: key(), input }, who);
	const change = <R,>(op: Write<R>, expectedRevision: string, input: unknown, who: Who = "admin") =>
		write(op, { requestKey: key(), expectedRevision, input }, who);
	const read = async <R,>(
		op: (executor: typeof db, actor: RequestActor, raw: unknown) => Promise<R>,
		input: unknown,
		who: Who = "admin",
	) => op(db, await authority(who), input);
	const rows = async <T extends Row>(query: SQL) => (await admin.execute<T>(query)).rows;
	const one = async <T extends Row>(query: SQL) => {
		const [row] = await rows<T>(query);
		assert.ok(row);
		return row;
	};
	const count = async (query: SQL) => (await one<{ n: number }>(query)).n;

	async function person(
		name: string,
		fields: { plant?: string; stage?: string; account?: string; email?: string } = {},
	) {
		const id = randomUUID();
		const plant = fields.plant ?? P.id;
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at,linked_account_id,email) VALUES(${id},${plant},${plant},${name},
			'other',${fields.stage ?? "prospect"},'adult','unknown',0,'live',clock_timestamp(),${fields.account ?? null},
			${fields.email ?? null})`);
		return id;
	}
	const schedule = async (fields: Row = {}, who: Who = "admin") =>
		ok(
			await create(
				meetingsWriter.schedule,
				{ type: "vision_meeting", date: "2026-10-20", time: "10:00", ...fields },
				who,
			),
		).meeting;
	const meetingOf = async (meetingId: string, who: Who = "admin") => {
		const found = ok(await read(meetingsReader.get, { meetingId }, who));
		assert.ok(found.status === "available");
		return found.meeting;
	};
	const status = async (meetingId: string, ...path: string[]) => {
		for (const to of path)
			ok(await change(meetingsWriter.changeStatus, (await meetingOf(meetingId)).revision, { meetingId, to }));
	};
	const guestsOf = async (meetingId: string, who: Who = "admin") =>
		ok(await read(meetingsReader.listGuests, { meetingId }, who)).guests;
	const guestOf = async (meetingId: string, personId: string) => {
		const found = (await guestsOf(meetingId)).find((g) => g.person.personId === personId);
		assert.ok(found);
		return found;
	};
	const invite = async (meetingId: string, personId: string, inviterPersonId: string | null = null) =>
		ok(await create(guestsWriter.inviteGuest, { meetingId, personId, inviterPersonId })).guest;
	async function changes<T>(body: () => Promise<T>) {
		const { value, tables } = await touched(admin, () => recorded(admin, body));
		return { ...value, tables };
	}
	async function unchanged<T>(body: () => Promise<T>) {
		const { value, added, tables } = await changes(body);
		assert.deepEqual([added, tables], [NOTHING, []], "nothing is written");
		return value;
	}
	const failing = <T,>(table: string, event: "INSERT" | "UPDATE", body: () => Promise<T>) =>
		failingWrite(admin, { on: table, event }, body);
	const queued = <T,>(lock: SQL, starts: (() => Promise<T>)[]) => raced(admin, db, lock, starts);
	return {
		...database,
		db,
		P,
		Q,
		actors,
		authority,
		context,
		write,
		create,
		change,
		read,
		rows,
		one,
		count,
		person,
		schedule,
		meetingOf,
		status,
		guestsOf,
		guestOf,
		invite,
		changes,
		unchanged,
		failing,
		queued,
		recorded: <T,>(body: () => Promise<T>) => recorded(admin, body),
		attendance: createAttendanceWriter({ reminders: async () => {} }),
	};
}
export type MeetingsWorld = Awaited<ReturnType<typeof meetingsWorld>>;
