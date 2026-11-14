// The pipeline fixture (WP-101), the acceptance fixture for the pipeline evals, seeded next to Hope Fellowship
// (golden-church.mts) on its Grace Austin and Hill Country Network organizations (America/Chicago). Grace Austin has an
// Owner (Dana Brooks), an Admin (Luis Ortega) and two Members: Ana Ruiz, who directs the residency and is responsible
// for Casey Lee, and Ben Carter, who is responsible for no one. Its pipeline: Jordan Reyes, placed in Potential leader
// 190 days ago and never moved since; Casey Lee, placed 100 days ago and moved to Apprentice 14 days ago, with a note
// from Ana; and Sam Patel, placed in Potential leader 30 days ago. Hill Country Network's own pipeline has only Morgan
// Diaz, placed 200 days ago; its Owner is Ruth Calder (golden-church.mts). Every placement and move is made by the native
// pipeline writer, then dated relative to the database clock, as the Pipeline page's own tests do. Ana directs
// "Church planting residency" (seedResidency): Version 1 is published, weekly over 18 months with the residency
// template's four stages and three milestones and one Wiki reading, and Casey Lee is enrolled on it and has finished
// "Start a small group and raise a replacement". The program, its publish, the enrollment and the milestone go through
// the native program writer; only the reading's Wiki article is raw rows, as no public write creates one here.
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { pipelineWriter, readPipelineBoard } from "../../../packages/domain/src/organizations/pipeline.ts";
import { programWriter, readProgram } from "../../../packages/domain/src/organizations/programs.ts";
import { RESIDENCY_TEMPLATE } from "../../../packages/contracts/src/organizations/programs.ts";
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

/** The residency's one reading: an article Grace Austin publishes in its own Wiki. */
export const RESIDENCY_READING = "Planting a church that plants churches";
const GLOBAL = "00000000-0000-0000-0000-000000000000";
type Executor = Pick<Database, "execute">;

/**
 * Seeds "Church planting residency" in organization `organization`, directed by the seat `director` signs in with:
 * Version 1 published with one reading, and `enrollee` enrolled on it with its first milestone finished. `owner` and
 * `director` resolve the Owner's and the director's authority. Returns the program's id.
 */
export async function seedResidency(
	admin: Executor,
	runtime: Database,
	o: {
		organization: string;
		directorSeatId: string;
		owner: () => Promise<RequestActor>;
		director: () => Promise<RequestActor>;
		enrollee: string;
	},
) {
	// The reading: Grace Austin's own published version of an article.
	const [section, article, revision] = [randomUUID(), randomUUID(), randomUUID()];
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section',${`residency/${section}`},${GLOBAL})`,
	);
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${article},'article',${`residency/${article}`},${GLOBAL})`,
	);
	await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,
		body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
		VALUES(${revision},${article},${o.organization},NULL,1,${RESIDENCY_READING},'residency/planting-churches',${RESIDENCY_READING},
		'[]','safe_nodes',1,1,md5(${revision}::text),clock_timestamp(),true,1,${section})`);
	await admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(${randomUUID()},${o.organization},${article},'published',${revision},1)`);
	const programId = randomUUID();
	ok(
		await programWriter.createProgram(runtime, await o.owner(), {
			programId,
			kind: "residency",
			name: "Church planting residency",
			directorSeatId: o.directorSeatId,
			plan: {
				rhythm: "weekly",
				expectedMonths: 18,
				stages: RESIDENCY_TEMPLATE.stages,
				milestones: RESIDENCY_TEMPLATE.milestones.map((title) => ({
					lineage: randomUUID(),
					title,
					description: null,
					handsOn: false,
				})),
				readings: [{ revisionId: revision }],
			},
		}),
	);
	const draft = ok(await readProgram(runtime, await o.director(), { programId }));
	ok(await programWriter.publishVersion(runtime, await o.director(), { programId, expectedRevision: draft.revision }));
	const v1 = ok(await readProgram(runtime, await o.owner(), { programId })).published!;
	const enrollmentId = randomUUID();
	const year = Number(v1.publishedOn!.slice(0, 4));
	ok(
		await programWriter.enroll(runtime, await o.owner(), {
			enrollmentId,
			programId,
			personId: o.enrollee,
			cohort: "Fall cohort",
			startedOn: v1.publishedOn!,
			expectedEndOn: `${year + 2}${v1.publishedOn!.slice(4)}`,
			stageId: v1.stages[0]!.id,
			nextMeetingAt: null,
		}),
	);
	ok(
		await programWriter.recordMilestone(runtime, await o.director(), {
			enrollmentId,
			milestoneId: v1.milestones[0]!.id,
			completedOn: v1.publishedOn!,
		}),
	);
	return { programId, enrollmentId };
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
	const authority = (who: PipelineName) =>
		RequestActor.resolve(runtime, sessionOf(who) as never) as Promise<RequestActor>;
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
	const add = async (
		who: PipelineName,
		personId: string,
		displayName: string,
		stageId: string,
		responsible: string | null,
	) =>
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
	const anaSeat = await seat("ana");
	const residency = await seedResidency(admin, runtime, {
		organization: GRACE_AUSTIN,
		directorSeatId: anaSeat,
		owner: () => authority("dana"),
		director: () => authority("ana"),
		enrollee: PEOPLE.casey,
	});
	return { grace, hill, anaSeat, residency };
}
