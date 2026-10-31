import * as c from "@everyfield/contracts/people";
import type { PeopleReply } from "@everyfield/contracts/people";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { plantTodaySql } from "./adult.ts";
import { assessmentsJson, assessmentsOf } from "./assessments/index.ts";
import { adminRead, history } from "./assessments/shared.ts";
import { commitmentsJson, commitmentsOf } from "./commitments/index.ts";
import {
	authorizeCachedRead,
	authorizeRead,
	canReadPerson,
	deny,
	evidenceJson,
	parse,
	PeopleReadContext,
	person,
	personRow,
	project,
	projectWith,
	readReply,
	Refusal,
	type Context,
	type Evidence,
	type Tx,
} from "./core.ts";
import { personDuplicates, personDuplicatesJson } from "./duplicates.ts";
import { personHousehold, personHouseholdJson } from "./households/index.ts";
import { interviewsJson, interviewsOf } from "./interviews/index.ts";
import { activitiesJson, activityFeed, peopleReader } from "./queries.ts";
import { personSkills, personSkillsJson, personTags, personTagsJson } from "./tags-skills/index.ts";

/**
 * The parts the person page reads with the person and its first Activity page. Each is null when not asked for.
 * `records` is the page size of the first 4 C's, interview and commitment page.
 */
export type PersonPageParts = { fields?: boolean; records?: number; duplicates?: boolean };

const ok = <T>(value: T): PeopleReply<T> => ({ status: "ok", value });
/** A part that its own read would refuse reads as null, so the rest of the page still shows. */
function part<T>(read: () => T): T | null {
	try {
		return read();
	} catch (error) {
		if (error instanceof Refusal) return null;
		throw error;
	}
}

/**
 * The person page: the person, its first Activity page, its account link and, for a merged person, its survivor. On
 * request it adds the person's tags, skills, household and photo, the 4 C's, interviews and commitments (an Owner or
 * Admin's page) and duplicate hints (a live person). The request's cached viewer of a church reads all of it in one
 * statement with the live access check (C13, C27) inside it, on the pool or in the caller's transaction. Any other
 * context resolves its actor first, in a transaction.
 */
export async function readPersonPage(
	db: Database | Tx,
	ctx: Context,
	raw: unknown,
	limit: number,
	parts: PersonPageParts = {},
) {
	return readReply(async () => {
		const { personId } = parse(c.personRequest, raw);
		const feed = parse(c.activityRequest, { personId, limit, page: 1 });
		if (ctx instanceof PeopleReadContext && ctx.selected.kind === "plant")
			return plantPage(db, ctx, feed, parts, authorizeCachedRead(ctx).gate);
		const run = async (tx: Tx) => {
			const authority = await authorizeRead(tx, ctx);
			if (ctx.selected.kind === "plant") return plantPage(tx, ctx, feed, parts, authority.gate);
			const p = await person(tx, ctx, personId, authority.gate);
			await canReadPerson(tx, ctx, p, authority.actor);
			const found = c.personResult.parse({ status: "available", person: await project(tx, ctx, p, authority.gate) });
			const survivor =
				p.state === "merged" && p.merged_into_person_id
					? await peopleReader.getPerson(tx, ctx, c.personRequest.parse({ personId: p.merged_into_person_id }))
					: null;
			return { found, activities: null, link: ok(link(p)), survivor, fields: null, records: null, duplicates: null };
		};
		return "rollback" in db ? run(db) : db.transaction(run);
	});
}

const personJson = (alias: SQL) =>
	sql`to_jsonb(${alias})||jsonb_build_object('revision',${alias}.revision::text,'pipeline_position',${alias}.pipeline_position::text,'plant_today',${plantTodaySql(sql`${alias}.plant_id`)})`;
/** The Person row with the field columns the page's photo and household read. */
const pagePerson = personRow.extend({ household_id: z.uuid().nullable(), photo_object_id: z.uuid().nullable() });
const pageRow = z.object({
	person: z.unknown(),
	evidence: z.unknown(),
	survivor: z.object({ person: z.unknown(), evidence: z.unknown() }).nullable(),
	activities: z.unknown(),
	tags: z.unknown(),
	skills: z.unknown(),
	household: z.unknown(),
	records: z.object({ assessments: z.unknown(), interviews: z.unknown(), commitments: z.unknown() }).nullable(),
	duplicates: z.unknown(),
});
const evidence = (raw: unknown): Evidence[] =>
	raw
		? [
				z
					.object({
						person_id: z.uuid(),
						id: z.uuid(),
						kind: z.enum(["core_group", "launch_team"]),
						signed_on: z.string(),
						revision: z.string(),
					})
					.parse(raw),
			]
		: [];
const link = (p: { id: string; linked_account_id: string | null }) =>
	c.accountLinkResult.parse(p.linked_account_id ? { status: "linked", personId: p.id } : { status: "unlinked" });

/**
 * The church person page in one statement. The live access check guards the Person row, so every part comes from a
 * Person this reader may read in the same snapshot; the 4 C's, interviews and commitments also need a live Owner or
 * Admin. A missing, removed or unreadable Person returns no row and reads as unavailable.
 */
async function plantPage(
	db: Database | Tx,
	ctx: Context,
	feed: z.infer<typeof c.activityRequest>,
	parts: PersonPageParts,
	gate: SQL,
) {
	const plant = ctx.selected.id;
	const records = { page: 1, limit: parts.records ?? 1 };
	const own = sql`person.plant_id=${plant}::uuid`;
	const result = await db.execute(sql`SELECT ${personJson(sql`person`)} AS person,
 ${evidenceJson(plant, sql`person.id`)} AS evidence,
 (SELECT jsonb_build_object('person',${personJson(sql`s`)},'evidence',${evidenceJson(plant, sql`s.id`)}) FROM person s
   WHERE person.state='merged' AND s.id=person.merged_into_person_id AND s.tenant_id=${plant}::uuid
   AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=s.id AND w.organization_id=s.tenant_id)) AS survivor,
 ${activitiesJson(ctx, sql`person.id`, feed, sql`true`)} AS activities,
 ${parts.fields ? sql`CASE WHEN ${own} THEN ${personTagsJson(plant)} END` : sql`NULL`} AS tags,
 ${parts.fields ? sql`CASE WHEN ${own} THEN ${personSkillsJson(plant)} END` : sql`NULL`} AS skills,
 ${parts.fields ? sql`CASE WHEN ${own} THEN ${personHouseholdJson(plant)} END` : sql`NULL`} AS household,
 ${
		parts.records
			? sql`(SELECT jsonb_build_object('assessments',${assessmentsJson(plant, records)},'interviews',${interviewsJson(plant, records)},
   'commitments',${commitmentsJson(plant, records)}) FROM person p WHERE ${adminRead(ctx)} AND p.id=person.id AND p.plant_id=${plant}::uuid)`
			: sql`NULL`
 } AS records,
 ${parts.duplicates ? sql`CASE WHEN person.state='live' THEN ${personDuplicatesJson(plant)} END` : sql`NULL`} AS duplicates
 FROM person WHERE person.id=${feed.personId}::uuid AND person.tenant_id=${plant}::uuid AND ${gate}
 AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=person.id AND w.organization_id=person.tenant_id)`);
	if (!result.rows[0]) deny();
	const row = pageRow.parse(result.rows[0]);
	const p = pagePerson.parse(row.person);
	const found = c.personResult.parse({ status: "available", person: projectWith(ctx, [p], evidence(row.evidence))[0] });
	const survivor =
		p.state === "merged" && p.merged_into_person_id
			? await readReply(async () => {
					if (!row.survivor) deny();
					const s = personRow.parse(row.survivor.person);
					return c.personResult.parse({
						status: "available",
						person: projectWith(ctx, [s], evidence(row.survivor.evidence))[0],
					});
				})
			: null;
	const fields = parts.fields
		? {
				tags: part(() => (p.plant_id === plant ? personTags(row.tags) : deny())),
				skills: part(() => (p.plant_id === plant ? personSkills(row.skills) : deny())),
				household: part(() => (p.plant_id === plant ? personHousehold(p.household_id, row.household) : deny())),
				// A retired or merged Person's photo is unavailable (REQ-PPL-005); the page then shows the initials.
				photo: c.personPhotoResult.parse(
					p.plant_id === plant && p.state === "live" && p.photo_object_id
						? { status: "available", personId: p.id, versionId: p.photo_object_id }
						: { status: "absent" },
				),
			}
		: null;
	const page = (raw: unknown) => history(plant, records, raw);
	const recordParts =
		parts.records && row.records
			? {
					assessments: part(() => assessmentsOf(p.id, page(row.records!.assessments))),
					interviews: part(() => interviewsOf(p.id, page(row.records!.interviews))),
					commitments: part(() => commitmentsOf(p.id, page(row.records!.commitments))),
				}
			: parts.records
				? { assessments: null, interviews: null, commitments: null }
				: null;
	return {
		found,
		activities: ok(activityFeed(ctx, p.id, feed, row.activities)),
		link: ok(link(p)),
		survivor,
		fields,
		records: recordParts,
		duplicates: parts.duplicates && p.state === "live" ? part(() => personDuplicates(row.duplicates)) : null,
	};
}
