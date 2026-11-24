import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { RequestActor, type WriteTx } from "../../../../../packages/domain/src/access/session.ts";
import type { MeetingsReply } from "../../../../../packages/contracts/src/meetings/index.ts";
import type { TeamsReply } from "../../../../../packages/contracts/src/teams/index.ts";
import { withFollowUpWrite, type FollowUpReply } from "../../../../../packages/domain/src/followups/index.ts";
import { withMeetingsWrite, type MeetingsContext } from "../../../../../packages/domain/src/meetings/index.ts";
import type { WriteContext } from "../../../../../packages/domain/src/people/core.ts";
import { withTaskWrite, type TaskContext, type TaskReply } from "../../../../../packages/domain/src/tasks/index.ts";
import { withTeamsWrite } from "../../../../../packages/domain/src/teams/index.ts";
import type { TeamsContext } from "../../../../../packages/domain/src/teams/core.ts";
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";
import {
	peopleMerge,
	peopleReader,
	peopleUnmerge,
	peopleWriter,
	searchPeople,
	withPeopleWrite,
} from "../../../../../packages/domain/src/people/index.ts";
import { sql, type SQL } from "../../../../../packages/db/src/query.ts";
import { fixture, ok, type Actor } from "../../../../support/fixture.mts";
import { personId as personIdValue } from "../../../../../packages/contracts/src/common/values.ts";
import { church, type Reply } from "../../../people/people-support.mts";

export type Row = Record<string, unknown>;
type Json = Record<string, unknown>;
export type Case = {
	id: string;
	given: Json;
	action: { operation: string; arguments: Json };
	expected: { state: Json; result: Json };
	subcases?: (Pick<Case, "action" | "expected"> & { name: string; given: Json })[];
};
export function caseOf(file: string, id: string): Case {
	const path = new URL(`../../../../../docs/acceptance/${file}.json`, import.meta.url);
	const found = (JSON.parse(readFileSync(path, "utf8")) as { cases: Case[] }).cases.find((c) => c.id === id);
	assert.ok(found, id);
	return found;
}

export const key = () => randomUUID();

export async function world(prefix: string) {
	const database = await fixture({ prefix, clock: new Date("2026-10-13T16:00:00.000Z") });
	const { admin } = database;
	const db = database.pools.runtime;
	const P = database.tenant.id;
	const Q = (await database.plant()).id;
	const actors = {
		owner: database.actors.owner,
		admin: database.actors.admin,
		member: database.actors.member,
		foreign: await database.actor({ kind: "plant", id: Q }, "admin"),
	};
	type Who = keyof typeof actors;
	const ctx = (who: Who = "admin") => ({
		session: actors[who].session,
		selected: church(who === "foreign" ? Q : P),
	});
	const tx = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(db, body);
	const authority = async (actor: Pick<Actor, "session"> = actors.admin) => {
		const found = await RequestActor.resolve(db, actor.session);
		assert.ok(found instanceof RequestActor);
		return found;
	};
	const write = {
		meetings: async <T,>(
			op: (t: WriteTx, c: MeetingsContext, raw: unknown) => Promise<MeetingsReply<T>>,
			input: unknown,
			who: Who = "admin",
		) => withMeetingsWrite(db, await authority(actors[who]), (t, c) => op(t, c, input)),
		tasks: async <T,>(
			op: (t: WriteTx, c: TaskContext, raw: unknown) => Promise<TaskReply<T>>,
			input: unknown,
			who: Who = "admin",
		) => withTaskWrite(db, await authority(actors[who]), (t, c) => op(t, c, input)),
		followUps: async <T,>(
			op: (t: WriteTx, c: TaskContext, raw: unknown) => Promise<FollowUpReply<T>>,
			input: unknown,
			who: Who = "admin",
		) => withFollowUpWrite(db, await authority(actors[who]), (t, c) => op(t, c, input)),
		teams: async <T,>(
			op: (t: WriteTx, c: TeamsContext, raw: unknown) => Promise<TeamsReply<T>>,
			input: unknown,
			who: Who = "admin",
		) => withTeamsWrite(db, await authority(actors[who]), (t, c) => op(t, c, input)),
		people: async <T,>(
			op: (t: WriteTx, c: WriteContext, raw: unknown) => Promise<Reply<T>>,
			input: unknown,
			who: Who = "admin",
		) => withPeopleWrite(db, await authority(actors[who]), (t, c) => op(t, c, input)),
	};
	const rows = async <R extends Row = Row>(query: SQL) => (await admin.execute<R>(query)).rows;
	const one = async <R extends Row = Row>(query: SQL) => {
		const [row] = await rows<R>(query);
		assert.ok(row, "one row");
		return row;
	};
	const revisionOf = async (table: string, id: string) =>
		String((await one(sql`SELECT revision::text AS r FROM ${sql.identifier(table)} WHERE id=${id}::uuid`)).r);
	async function insert(table: string, values: Row) {
		const id = (values.id as string | undefined) ?? key();
		const entries = Object.entries({ id, plant_id: P, ...values }).filter(([, v]) => v !== undefined);
		await admin.execute(
			sql`INSERT INTO ${sql.identifier(table)}(${sql.join(
				entries.map(([k]) => sql.identifier(k)),
				sql`,`,
			)}) VALUES(${sql.join(
				entries.map(([, v]) => (v && typeof v === "object" && "getSQL" in v ? (v as SQL) : sql.param(v))),
				sql`,`,
			)})`,
		);
		return id;
	}
	async function person(displayName: string, input: Row = {}, who: Who = "admin") {
		return ok(
			await tx((t) =>
				peopleWriter.createPerson(t, ctx(who), {
					requestKey: key(),
					input: { displayName, adultClassification: "adult", ...input },
				}),
			),
		).person.id;
	}
	const personRow = (id: string) =>
		one<{
			state: string;
			merged_into_person_id: string | null;
			revision: string;
			display_name: string;
			retired: boolean;
		}>(
			sql`SELECT state,merged_into_person_id,revision::text,display_name,retired_at IS NOT NULL AS retired FROM person WHERE id=${id}::uuid`,
		);
	async function update(personId: string, patch: Row) {
		return ok(
			await tx(async (t) =>
				peopleWriter.updatePerson(t, ctx(), {
					requestKey: key(),
					expectedRevision: (await personRow(personId)).revision,
					input: { personId, patch },
				}),
			),
		);
	}
	const review = (sourceId: string, survivorId: string, who: Who = "admin") =>
		tx((t) => peopleMerge.getMergeReview(t, ctx(who), { sourceId, survivorId }));
	const digestOf = async (sourceId: string, survivorId: string) => ok(await review(sourceId, survivorId)).reviewDigest;
	const mergeWith = (
		input: {
			sourceId: string;
			survivorId: string;
			reviewDigest: string;
			fieldChoices?: Record<string, "source">;
		},
		{ who = "admin" as Who, requestKey = key() as string } = {},
	) => tx((t) => peopleMerge.mergePeople(t, ctx(who), { requestKey, input }));
	const merge = async (
		sourceId: string,
		survivorId: string,
		fieldChoices: Record<string, "source"> = {},
		who: Who = "admin",
	) => {
		const { reviewDigest } = ok(await review(sourceId, survivorId, who));
		return ok(await mergeWith({ sourceId, survivorId, reviewDigest, fieldChoices }, { who }));
	};
	const preview = (mergeId: string, who: Who = "admin") =>
		tx((t) => peopleUnmerge.previewUnmerge(t, ctx(who), { mergeId }));
	const unmergeWith = (
		mergeId: string,
		expectedRevision: string,
		{ who = "admin" as Who, requestKey = key() as string } = {},
	) =>
		tx((t) =>
			peopleUnmerge.unmergePeople(t, ctx(who), {
				requestKey,
				expectedRevision,
				input: { mergeId },
			}),
		);
	const unmerge = async (mergeId: string) => unmergeWith(mergeId, ok(await preview(mergeId)).reviewRevision);
	const destination = (personId: string, who: Who = "admin") =>
		tx((t) => peopleMerge.mergedPersonDestination(t, ctx(who), { personId }));
	const ownerPerson = await person("Duty owner");
	await admin.execute(sql`UPDATE person SET linked_account_id=${actors.member.id} WHERE id=${ownerPerson}::uuid`);
	async function retireRequest(personId: string) {
		const row = await personRow(personId);
		const duties = await rows<{
			id: string;
			revision: string;
		}>(sql`SELECT id,revision::text FROM task
			WHERE person_id=${personId}::uuid AND deleted_at IS NULL AND status NOT IN ('complete','no_longer_needed')`);
		const warnings = ok(
			await tx((t) => peopleReader.getStatusWarnings(t, ctx(), { personId: personIdValue.parse(personId) })),
		);
		return {
			requestKey: key(),
			expectedRevision: row.revision,
			input: {
				personId,
				reason: "Moved away",
				reviewRevision: warnings.reviewRevision,
				handoffs: duties.map((d) => ({
					kind: "assign",
					dutyId: d.id,
					expectedRevision: d.revision,
					toPersonId: ownerPerson,
				})),
			},
		};
	}
	const retireWith = (request: Awaited<ReturnType<typeof retireRequest>>, who: Who = "admin") =>
		tx((t) => peopleWriter.retirePerson(t, ctx(who), request, async () => undefined as never));
	const retire = async (personId: string) => ok(await retireWith(await retireRequest(personId)));
	const selectable = async (personId: string, name: string) =>
		ok(await tx((t) => searchPeople(t, ctx(), name, 1000))).some((hit) => hit.id === personId);

	const tables = (
		await rows<{
			name: string;
		}>(sql`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
			WHERE n.nspname=current_schema() AND c.relkind='r' AND c.relname NOT LIKE 'schema_%' ORDER BY 1`)
	).map((r) => r.name);
	async function everything() {
		return one(
			sql`SELECT ${sql.join(
				tables.map(
					(name) =>
						sql`(SELECT md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) FROM ${sql.identifier(name)} x) AS ${sql.identifier(name)}`,
				),
				sql`,`,
			)}`,
		);
	}
	const effects = () =>
		one(sql`SELECT (SELECT count(*)::int FROM mail) AS mail,(SELECT count(*)::int FROM mail_attempt) AS attempts,
			(SELECT count(*)::int FROM job WHERE kind='mail') AS jobs,(SELECT count(*)::int FROM notice) AS notices`);
	async function changed(before: Row) {
		const now = await everything();
		return Object.keys(now).filter((name) => now[name] !== before[name]);
	}
	async function commitFault<T>(table: string, body: () => Promise<T>, when: "commit" | "write" = "commit") {
		const name = "fault_" + key().replaceAll("-", "");
		await admin.execute(
			sql.raw(
				`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'required_write_failed'; END $$`,
			),
		);
		await admin.execute(
			sql.raw(
				when === "commit"
					? `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT OR UPDATE ON ${table} DEFERRABLE INITIALLY DEFERRED
						FOR EACH ROW EXECUTE FUNCTION ${name}()`
					: `CREATE TRIGGER ${name} AFTER INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
			),
		);
		try {
			await assert.rejects(
				async () => refusedToo(await body()),
				(error) => /required_write_failed/.test(reasons(error)),
			);
			return "required_write_failed";
		} finally {
			await admin.execute(sql.raw(`DROP TRIGGER ${name} ON ${table}`));
			await admin.execute(sql.raw(`DROP FUNCTION ${name}()`));
		}
	}
	return {
		database,
		admin,
		db,
		P,
		Q,
		actors,
		ctx,
		tx,
		authority,
		write,
		rows,
		one,
		revisionOf,
		insert,
		person,
		personRow,
		update,
		review,
		digestOf,
		mergeWith,
		merge,
		preview,
		unmergeWith,
		unmerge,
		destination,
		retireRequest,
		retireWith,
		retire,
		selectable,
		everything,
		changed,
		effects,
		commitFault,
	};
}

function reasons(error: unknown): string {
	return error instanceof Error ? `${error.message} ${reasons(error.cause)}` : "";
}

function refusedToo(result: unknown) {
	const reply = result as { status?: string };
	if (reply.status === "refused") throw Error(JSON.stringify(reply));
}
