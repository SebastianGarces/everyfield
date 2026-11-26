import { randomUUID } from "node:crypto";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer, RequestActor } from "../../../packages/domain/src/access/session.ts";
import { pipelineWriter } from "../../../packages/domain/src/organizations/pipeline.ts";
import { programWriter, readProgram } from "../../../packages/domain/src/organizations/programs.ts";
import { createAssessments } from "../../../packages/domain/src/intelligence/index.ts";
import { evryActor, type EvryActor } from "../../../packages/evry/src/context/actor.ts";
import { ok } from "../../support/fixture.mts";
import { NOW } from "./golden-church.mts";
import { intelligenceChurch } from "./intelligence-church.mts";
import { linkResident, markMilestone, PEOPLE, seedPipeline, sessionOf, type PipelineName } from "./pipeline-church.mts";

async function actorOf(db: Database, session: string): Promise<EvryActor> {
	const viewer = await readViewer(db, session as never);
	if (!viewer?.authority) throw Error("No live authority for the network church actor");
	return evryActor(viewer.authority, viewer.discovery);
}
async function actorsOf<K extends string>(db: Database, sessions: Record<K, string>) {
	const actors = {} as Record<K, EvryActor>;
	for (const who of Object.keys(sessions) as K[]) actors[who] = await actorOf(db, sessions[who]);
	return actors;
}

export async function seedNetwork(admin: Database, db: Database) {
	const { residency } = await seedPipeline(admin, db);
	const authority = (who: PipelineName) => RequestActor.resolve(db, sessionOf(who) as never) as Promise<RequestActor>;
	const dana = await authority("dana");
	const ana = await authority("ana");
	ok(
		await pipelineWriter.saveGoal(db, dana, {
			goalId: randomUUID(),
			expectedRevision: null,
			leaderTarget: 6,
			plantTarget: 2,
			targetYear: 2028,
			rationale: "Two campuses are full.",
			countingFrom: "2026-01-01",
			counts: [],
		}),
	);
	for (const occurredOn of ["2026-10-06", "2026-10-20", "2026-11-03"])
		ok(
			await pipelineWriter.logConversation(db, ana, {
				conversationId: randomUUID(),
				personId: PEOPLE.casey,
				occurredOn,
				note: null,
			}),
		);
	const { programId, enrollmentId } = residency;
	const v1 = ok(await readProgram(db, dana, { programId }));
	ok(
		await programWriter.enroll(db, dana, {
			enrollmentId: randomUUID(),
			programId,
			personId: PEOPLE.sam,
			cohort: "Fall cohort",
			startedOn: v1.published!.publishedOn!,
			expectedEndOn: "2028-05-31",
			stageId: v1.published!.stages[0]!.id,
			nextMeetingAt: null,
		}),
	);
	const plan = v1.published!;
	ok(
		await programWriter.savePlan(db, ana, {
			programId,
			expectedRevision: (await readProgram(db, ana, { programId }).then(ok)).revision,
			plan: {
				rhythm: plan.rhythm,
				expectedMonths: plan.expectedMonths,
				stages: plan.stages.map(({ label, minMonths, maxMonths }) => ({ label, minMonths, maxMonths })),
				milestones: [
					...plan.milestones.map(({ lineage, title, description, handsOn }) => ({
						lineage,
						title,
						description,
						handsOn,
					})),
					{ lineage: randomUUID(), title: "Lead a vision night", description: null, handsOn: false },
				],
				readings: plan.readings.map(({ revisionId }) => ({ revisionId })),
			},
		}),
	);
	const draft = ok(await readProgram(db, ana, { programId }));
	ok(await programWriter.publishVersion(db, ana, { programId, expectedRevision: draft.revision }));
	const account = await linkResident(admin, PEOPLE.casey, "Casey Lee");
	await markMilestone(admin, enrollmentId, "Write a church planting prospectus", account, "2026-10-01");
	return actorsOf(db, {
		dana: sessionOf("dana"),
		luis: sessionOf("luis"),
		ana: sessionOf("ana"),
		ben: sessionOf("ben"),
	});
}

export async function assessedChurch() {
	const ch = await intelligenceChurch("evrynet", undefined, NOW);
	await ch.classify();
	const { current } = await ch.publish();
	await ch.churchLinked();
	const starter = await ch.plant("New Life Church");
	const admin = (await RequestActor.resolve(ch.db, ch.seats.admin.session as never)) as RequestActor;
	ok(
		await createAssessments().submitFeedback(ch.db, admin, {
			runId: current!.runId,
			ordinal: 0,
			rating: "not_useful",
			comment: "",
		}),
	);
	const actors = await actorsOf(ch.db, {
		owner: ch.seats.owner.session,
		admin: ch.seats.admin.session,
		member: ch.seats.member.session,
		director: ch.seats.director.session,
		networkMember: ch.seats.networkMember.session,
		otherDirector: ch.seats.otherDirector.session,
		starter: starter.owner.session,
	});
	return { db: ch.db, actors, close: () => ch.database.close() };
}
