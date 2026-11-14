// The pipeline fixture (WP-101), the acceptance fixture for the pipeline evals, seeded next to Hope Fellowship
// (golden-church.mts) on its Grace Austin and Hill Country Network organizations (America/Chicago). Grace Austin has an
// Owner (Dana Brooks), an Admin (Luis Ortega) and two Members: Ana Ruiz, who directs the residency and is responsible
// for Casey Lee, and Ben Carter, who is responsible for no one. Its pipeline: Jordan Reyes, placed in Potential leader
// 190 days ago and never moved since; Casey Lee, placed 100 days ago and moved to Apprentice 14 days ago, with a note
// from Ana; and Sam Patel, placed in Potential leader 30 days ago. Hill Country Network's own pipeline has only Morgan
// Diaz, placed 200 days ago; its Owner is Ruth Calder (golden-church.mts). Every placement and move is made by the native
// pipeline writer, then dated relative to the database clock, as the Pipeline page's own tests do.
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { pipelineWriter, readPipelineBoard } from "../../../packages/domain/src/organizations/pipeline.ts";
import { ACTOR_SPECS, GRACE_AUSTIN, NETWORK } from "./golden-church.mts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
type Spec = { account: string; user: string; session: string; name: string; role: "owner" | "admin" | "member" };
const spec = (k: number, name: string, role: Spec["role"]): Spec => ({
	account: id(0xa00 + k),
	user: id(0xa10 + k),
	session: id(0xa20 + k),
	name,
	role,
});
export const PIPELINE_SPECS = {
	dana: spec(1, "Dana Brooks", "owner"),
	luis: spec(2, "Luis Ortega", "admin"),
	ana: spec(3, "Ana Ruiz", "member"),
	ben: spec(4, "Ben Carter", "member"),
} as const;
/** The Grace Austin seats, and Hill Country Network's Owner from the golden church. */
export type PipelineName = keyof typeof PIPELINE_SPECS | "hill";
export const sessionOf = (who: PipelineName) =>
	who === "hill" ? ACTOR_SPECS.network.session : PIPELINE_SPECS[who].session;

export const PEOPLE = { jordan: id(0xa101), casey: id(0xa102), sam: id(0xa103), morgan: id(0xa104) } as const;
/** Ana's note on Casey: staff-only text that no Evry read may return. */
export const ANA_NOTE = "Casey is steady with the youth group; we talked through the Austin plant timeline.";

function ok<T>(reply: { status: string; value?: T; refusal?: unknown }): T {
	if (reply.status !== "ok") throw Error(`pipeline fixture refused: ${JSON.stringify(reply.refusal)}`);
	return reply.value as T;
}

/** Seeds the Grace Austin seats into the schema `admin` writes, then both pipelines through the native writer. */
export async function seedPipeline(admin: Database, runtime: Database) {
	for (const [who, a] of Object.entries(PIPELINE_SPECS)) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${a.user},${`${who}@graceaustin.example.test`},true,${a.name})`,
		);
		await admin.execute(sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind)
			VALUES(${a.account},${a.user},'active','sending_church')`);
		await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
			VALUES(${a.session},${a.user},${`pipeline-${who}`},clock_timestamp()+interval '1 day')`);
		await admin.execute(sql`INSERT INTO seat(account_id,organization_id,role,accepted_at)
			VALUES(${a.account},${GRACE_AUSTIN},${a.role},clock_timestamp()-interval '1 day')`);
	}
	const authority = (who: PipelineName) => RequestActor.resolve(runtime, sessionOf(who) as never) as Promise<RequestActor>;
	const seat = async (who: keyof typeof PIPELINE_SPECS) =>
		String(
			(
				await admin.execute(
					sql`SELECT id FROM seat WHERE account_id=${PIPELINE_SPECS[who].account} AND organization_id=${GRACE_AUSTIN}`,
				)
			).rows[0]!.id,
		);
	const stages = async (who: PipelineName) =>
		Object.fromEntries(
			ok(await readPipelineBoard(runtime, await authority(who), {})).stages.map((s) => [s.label, s.id]),
		) as Record<string, string>;
	const grace = await stages("dana");
	const hill = await stages("hill");
	const add = async (who: PipelineName, personId: string, displayName: string, stageId: string, responsible: string | null) =>
		ok(
			await pipelineWriter.addPerson(runtime, await authority(who), {
				personId,
				displayName,
				email: null,
				responsibleSeatId: responsible,
				stageId,
			}),
		);
	await add("dana", PEOPLE.jordan, "Jordan Reyes", grace["Potential leader"]!, null);
	await add("dana", PEOPLE.casey, "Casey Lee", grace["Potential leader"]!, await seat("ana"));
	await add("dana", PEOPLE.sam, "Sam Patel", grace["Potential leader"]!, null);
	ok(
		await pipelineWriter.movePerson(runtime, await authority("dana"), {
			personId: PEOPLE.casey,
			expectedRevision: "1",
			stageId: grace.Apprentice!,
			reason: "Started the apprenticeship with Ana.",
		}),
	);
	ok(
		await pipelineWriter.addNote(runtime, await authority("ana"), {
			personId: PEOPLE.casey,
			noteId: randomUUID(),
			body: ANA_NOTE,
		}),
	);
	await add("hill", PEOPLE.morgan, "Morgan Diaz", hill["Potential leader"]!, null);
	// Each placement and move dated as the example has it, relative to the database clock.
	const age = (person: string, organization: string, days: number, first: boolean) =>
		admin.execute(sql`UPDATE audit_event a SET occurred_at=clock_timestamp()-make_interval(days=>${days})
			FROM pipeline_stage_move m JOIN pipeline_person pp ON pp.id=m.pipeline_person_id
			WHERE a.id=m.id AND pp.person_id=${person} AND pp.organization_id=${organization} AND (m.from_stage_id IS NULL)=${first}`);
	await age(PEOPLE.jordan, GRACE_AUSTIN, 190, true);
	await age(PEOPLE.casey, GRACE_AUSTIN, 100, true);
	await age(PEOPLE.casey, GRACE_AUSTIN, 14, false);
	await age(PEOPLE.sam, GRACE_AUSTIN, 30, true);
	await age(PEOPLE.morgan, NETWORK, 200, true);
	return { grace, hill, anaSeat: await seat("ana") };
}
