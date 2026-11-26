import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
import type { DebriefAnswers, Plan } from "../../../packages/contracts/src/launch/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import { ok } from "../../support/fixture.mts";
import { church } from "../intelligence/assessment-church.mts";

export const NOW = "2026-10-13T16:00:00.000Z";
export const CLOCK = frozenClock(instant.parse(NOW));
export const BLANK: DebriefAnswers = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};
type Footprint = Record<
	| "people"
	| "guests"
	| "debriefs"
	| "summaries"
	| "tasks"
	| "meetings"
	| "obligations"
	| "contacts"
	| "attestations"
	| "attestation_revisions"
	| "seen"
	| "mail"
	| "notices"
	| "jobs"
	| "audits"
	| "phase",
	number
> & { revision: string };
export type Who = { id: string; session: string; actor: RequestActor };
type Draft = { draft: { id: string; revision: string } | null } | null;

export async function launchWorld(prefix: string) {
	const w = await church(prefix);
	const reader = createLaunchReader(CLOCK);
	const writer = createLaunchWriter({ notices: async () => undefined, clock: CLOCK });
	const key = () => randomUUID();
	const resolve = async (session: string) => (await RequestActor.resolve(w.db, session as never)) as RequestActor;
	async function seated(p: { kind: "plant"; id: string }, role: "owner" | "admin" | "member", name: string) {
		const a = await w.database.actor(p, role, { user: { name } });
		return { ...a, actor: await resolve(a.session) };
	}
	async function orgSeat(org: { kind: "organization"; id: string }) {
		const a = await w.database.actor(org as never, "owner");
		return resolve(a.session);
	}
	const plan = async (who: Pick<Who, "actor">): Promise<Plan> => ok(await reader.readPlan(w.db, who.actor)).plan;
	const journal = async (who: Pick<Who, "actor">) => ok(await reader.readJournal(w.db, who.actor)).entries;
	const record = (who: Pick<Who, "actor">, input: object, expectedRevision: string) =>
		writer.recordOutcome(w.db, who.actor, {
			requestKey: key(),
			expectedRevision,
			input: { attendance: null, decisions: null, note: null, ...input },
		});
	const correct = (who: Pick<Who, "actor">, input: object, expectedRevision: string) =>
		writer.correctOutcome(w.db, who.actor, { requestKey: key(), expectedRevision, input });
	const guest = (who: Pick<Who, "actor">, input: object) =>
		writer.addGuestAttendance(w.db, who.actor, { requestKey: key(), input });
	const debrief = (
		who: Pick<Who, "actor">,
		p: { debrief: Draft },
		answers: Partial<DebriefAnswers>,
		submit = false,
		requestKey = key(),
	) =>
		writer[submit ? "submitDebrief" : "saveDebriefDraft"](w.db, who.actor, {
			requestKey,
			expectedRevision: p.debrief?.draft?.revision ?? "0",
			input: { draftId: p.debrief?.draft?.id ?? null, answers: { ...BLANK, ...answers } },
		});
	const summary = (who: Pick<Who, "actor">, p: { summary: Draft }, body: string, publish = false) =>
		writer[publish ? "publishDebriefSummary" : "saveDebriefSummaryDraft"](w.db, who.actor, {
			requestKey: key(),
			expectedRevision: p.summary?.draft?.revision ?? "0",
			input: { draftId: p.summary?.draft?.id ?? null, body },
		});

	async function plantOf({
		planned = "2026-10-10",
		phase = 1,
		name = "Harvest Point",
		harvest = false,
		network,
	}: { planned?: string | null; phase?: number; name?: string; harvest?: boolean; network?: { id: string } } = {}) {
		const p = harvest ? await w.harvest(name, { network }) : await w.plant(name, { phase, network });
		if (harvest) await w.admin.execute(sql`UPDATE plant SET phase=${phase} WHERE id=${p.id}`);
		await w.admin.execute(
			sql`UPDATE auth_user SET name='Olivia Owner' WHERE id=(SELECT auth_user_id FROM account WHERE id=${p.owner.id})`,
		);
		const owner: Who = { ...p.owner, actor: p.actor };
		const admin = await seated(p, "admin", "Adam Admin");
		const member = await seated(p, "member", "Mia Member");
		if (planned)
			ok(
				await writer.schedule(w.db, owner.actor, {
					requestKey: key(),
					expectedRevision: "1",
					input: { date: planned, reason: null },
				}),
			);
		return { p, owner, admin, member };
	}
	async function launched(input: object = {}, options: Parameters<typeof plantOf>[0] = {}) {
		const c = await plantOf(options);
		const p = await plan(c.owner);
		ok(await record(c.owner, { actualDate: "2026-10-11", attendance: 40, decisions: 6, ...input }, p.revision));
		return c;
	}
	async function person(p: { id: string }, name: string, stage = "prospect") {
		const id = randomUUID();
		await w.admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at)
			VALUES(${id},${p.id},${p.id},${name},'other',${stage},'adult','unknown','1','live',clock_timestamp())`);
		return id;
	}
	async function link(plant: { id: string }, org: { id: string }, shares: Partial<Record<string, boolean>>) {
		const s = { people: false, meetings: false, findings: false, ...shares };
		return (
			await w.one<{ id: string }>(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,
			share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${plant.id},${org.id},clock_timestamp()-interval '1 day',${s.people},${s.meetings},false,false,false,false,
			${s.findings}) RETURNING id`)
		).id;
	}
	const footprint = (p: { id: string }) =>
		w.one<Footprint>(sql`SELECT
			(SELECT count(*)::int FROM person WHERE tenant_id=${p.id}) people,
			(SELECT count(*)::int FROM launch_guest WHERE plant_id=${p.id}) guests,
			(SELECT count(*)::int FROM launch_debrief WHERE plant_id=${p.id}) debriefs,
			(SELECT count(*)::int FROM launch_summary WHERE plant_id=${p.id}) summaries,
			(SELECT count(*)::int FROM task WHERE plant_id=${p.id}) tasks,
			(SELECT count(*)::int FROM meeting WHERE plant_id=${p.id}) meetings,
			(SELECT count(*)::int FROM obligation WHERE plant_id=${p.id}) obligations,
			(SELECT count(*)::int FROM contact_outcome WHERE plant_id=${p.id}) contacts,
			(SELECT count(*)::int FROM attestation WHERE plant_id=${p.id}) attestations,
			(SELECT count(*)::int FROM attestation_revision WHERE plant_id=${p.id}) attestation_revisions,
			(SELECT count(*)::int FROM assessment_seen WHERE plant_id=${p.id}) seen,
			(SELECT count(*)::int FROM mail WHERE tenant_id=${p.id}) mail,
			(SELECT count(*)::int FROM notice WHERE tenant_id=${p.id}) notices,
			(SELECT count(*)::int FROM job WHERE tenant_id=${p.id}) jobs,
			(SELECT count(*)::int FROM audit_event WHERE tenant_id=${p.id}) audits,
			(SELECT phase FROM plant WHERE id=${p.id}) phase,
			(SELECT revision::text FROM launch WHERE plant_id=${p.id}) revision`);
	const versions = (p: { id: string }) =>
		w.rows(sql`SELECT version,missing_names,missing_count,went_well,submitted_at IS NOT NULL AS submitted
			FROM launch_debrief WHERE plant_id=${p.id} ORDER BY version`);
	return {
		...w,
		reader,
		writer,
		key,
		resolve,
		seated,
		orgSeat,
		plan,
		journal,
		record,
		correct,
		guest,
		debrief,
		summary,
		plantOf,
		launched,
		person,
		link,
		footprint,
		versions,
	};
}
export type LaunchWorld = Awaited<ReturnType<typeof launchWorld>>;
