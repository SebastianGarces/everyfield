import * as f from "@everyfield/contracts/people";
import { and, eq, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import {
	authorize,
	deny,
	mutation,
	parse,
	readReply,
	reply,
	type Context,
	type Tx,
	type WriteContext,
} from "../core.ts";
import { expectRevision, livePerson, next, personFacts, plantId } from "../fields/shared.ts";

type Tag = z.infer<typeof f.tag>;
type Skill = z.infer<typeof f.skill>;

const tagRow = z.object({
	id: z.uuid(),
	name: z.string(),
	color: z.string().nullable(),
	revision: z.string(),
	linked: z.coerce.number(),
	links: z.coerce.number(),
});
/**
 * Tags with the live people who carry them, in name order, and each tag's count of all current links (retired people
 * included), which deletion removes. One query.
 */
async function readTags(tx: Tx, plant: string, id?: string): Promise<{ tag: Tag; links: number }[]> {
	const rows = await tx
		.select({
			id: tables.tag.id,
			name: tables.tag.name,
			color: tables.tag.color,
			revision: tables.tag.revision,
			linked: sql<number>`(SELECT count(*) FROM person_tag pt JOIN person p ON p.id=pt.person_id AND p.tenant_id=pt.plant_id
				WHERE pt.tag_id=tag.id AND pt.plant_id=tag.plant_id AND p.state='live')`,
			links: sql<number>`(SELECT count(*) FROM person_tag pt WHERE pt.tag_id=tag.id AND pt.plant_id=tag.plant_id)`,
		})
		.from(tables.tag)
		.where(and(eq(tables.tag.plant_id, plant), id ? eq(tables.tag.id, id) : undefined))
		.orderBy(tables.tag.normalized_name, tables.tag.id);
	return rows.map((row) => {
		const r = tagRow.parse(row);
		const tag = f.tag.parse({ id: r.id, name: r.name, color: r.color, revision: r.revision, linkedPeople: r.linked });
		return { tag, links: r.links };
	});
}
async function oneTag(tx: Tx, plant: string, id: string) {
	const [found] = await readTags(tx, plant, id);
	if (!found) deny();
	return found;
}
/** One Person's tags in name order, as a scalar subquery read with the Person row (it names the outer `person`). */
const personTagsJson = (plant: string) =>
	sql`coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name,'color',t.color) ORDER BY t.normalized_name,t.id)
 FROM person_tag pt JOIN tag t ON t.id=pt.tag_id AND t.plant_id=pt.plant_id WHERE pt.person_id=person.id AND pt.plant_id=${plant}::uuid),'[]')`;
const personTags = (raw: unknown) => z.array(f.personTag).parse(raw);
const tagFacts = (t: { revision: string; name: string; color: string | null }) => ({
	revision: t.revision,
	name: t.name,
	color: t.color,
});
const byName = (a: { name: string; id: string }, b: { name: string; id: string }) =>
	a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);

const skillRow = z.object({
	id: z.uuid(),
	person_id: z.uuid(),
	name: z.string(),
	category: f.skillCategory,
	proficiency: f.proficiency.nullable(),
	notes: z.string().nullable(),
	revision: z.string(),
});
const categoryOrder = f.skillCategory.options;
/** REQ-PPL-011 grouping: category order, then name. */
const skillOrder = (a: Skill, b: Skill) =>
	categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || byName(a, b);
const skillView = (r: z.infer<typeof skillRow>): Skill =>
	f.skill.parse({
		id: r.id,
		personId: r.person_id,
		name: r.name,
		category: r.category,
		proficiency: r.proficiency,
		notes: r.notes,
		revision: r.revision,
	});
/** Every current skill of one Person, found by the Person or by one of its skills. One query. */
async function skillsOf(tx: Tx, plant: string, by: { personId: string } | { skillId: string }) {
	const person =
		"personId" in by
			? sql`${by.personId}::uuid`
			: sql`(SELECT person_id FROM person_skill WHERE id=${by.skillId}::uuid AND plant_id=${plant}::uuid)`;
	const rows = await tx
		.select()
		.from(tables.person_skill)
		.where(and(eq(tables.person_skill.plant_id, plant), sql`${tables.person_skill.person_id}=${person}`));
	return rows.map((row) => skillView(skillRow.parse(row))).sort(skillOrder);
}
const skillFacts = (s: Skill | null) =>
	s && { id: s.id, name: s.name, category: s.category, proficiency: s.proficiency, notes: s.notes };

export const tagsAndSkills = {
	async listTags(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			parse(f.listTagsRequest, raw);
			await authorize(tx, ctx);
			return f.tagsResult.parse({ items: (await readTags(tx, plant)).map((r) => r.tag) });
		});
	},
	async getPersonTags(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(f.personFieldsRequest, raw);
			await authorize(tx, ctx);
			const p = await personFacts(tx, plant, input.personId, personTagsJson(plant));
			return f.personTagsResult.parse({ personId: input.personId, tags: personTags(p.extra) });
		});
	},
	async createTag(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.createTagRequest, raw);
			return f.tagMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.createTag", input, async (_actor, receiptId, audit) => {
					// Names that differ only by case or surrounding spaces are the same tag (REQ-PPL-010).
					const [same] = await tx
						.select({ id: tables.tag.id })
						.from(tables.tag)
						.where(
							and(eq(tables.tag.plant_id, plant), sql`${tables.tag.normalized_name}=lower(btrim(${input.input.name}))`),
						);
					if (same) {
						const { tag } = await oneTag(tx, plant, same.id);
						const value = { tag, outcome: "noop" as const, receiptId };
						return { value, subject: tag.id, subjectType: "tag", action: "people.created", outcome: "noop" };
					}
					const tag = { id: randomUUID(), ...input.input, revision: "1", linkedPeople: 0 };
					audit.writes.push(
						tx.insert(tables.tag).values({
							id: tag.id,
							plant_id: plant,
							name: tag.name,
							normalized_name: sql`lower(btrim(${tag.name}))`,
							color: tag.color,
						}),
					);
					return {
						value: { tag, outcome: "changed" as const, receiptId },
						subject: tag.id,
						subjectType: "tag",
						action: "people.created",
						after: tagFacts(tag),
					};
				}),
			);
		});
	},
	async updateTag(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.updateTagRequest, raw);
			return f.tagMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.updateTag", input, async (_actor, receiptId, audit) => {
					const { tag: before } = await oneTag(tx, plant, input.input.tagId);
					expectRevision(before.revision, input.expectedRevision);
					const name = input.input.name ?? before.name,
						color = input.input.color === undefined ? before.color : input.input.color;
					if (name === before.name && color === before.color) {
						const value = { tag: before, outcome: "noop" as const, receiptId };
						return { value, subject: before.id, subjectType: "tag", action: "people.updated", outcome: "noop" };
					}
					if (name.toLowerCase() !== before.name.toLowerCase()) {
						const [taken] = await tx
							.select({ id: tables.tag.id })
							.from(tables.tag)
							.where(and(eq(tables.tag.plant_id, plant), sql`${tables.tag.normalized_name}=lower(btrim(${name}))`));
						if (taken && taken.id !== before.id) deny("conflict");
					}
					const after = { ...before, name, color, revision: next(before.revision) };
					audit.writes.push(
						tx
							.update(tables.tag)
							.set({
								name,
								normalized_name: sql`lower(btrim(${name}))`,
								color,
								revision: sql`${tables.tag.revision}+1`,
							})
							.where(
								and(
									eq(tables.tag.id, before.id),
									eq(tables.tag.plant_id, plant),
									eq(tables.tag.revision, before.revision),
								),
							),
					);
					return {
						value: { tag: after, outcome: "changed" as const, receiptId },
						subject: before.id,
						subjectType: "tag",
						action: "people.updated",
						before: tagFacts(before),
						after: tagFacts(after),
					};
				}),
			);
		});
	},
	async deleteTag(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.deleteTagRequest, raw);
			return f.deleteTagResult.parse(
				await mutation<unknown>(tx, ctx, "people.deleteTag", input, async (_actor, receiptId, audit) => {
					const { tag: before, links } = await oneTag(tx, plant, input.input.tagId);
					expectRevision(before.revision, input.expectedRevision);
					// The links, the tag and its audit row go in one statement; the church lock keeps the read count exact.
					// Each Person's history keeps its own link.
					audit.writes.push(
						tx
							.delete(tables.person_tag)
							.where(and(eq(tables.person_tag.plant_id, plant), eq(tables.person_tag.tag_id, before.id))),
						tx.delete(tables.tag).where(and(eq(tables.tag.id, before.id), eq(tables.tag.plant_id, plant))),
					);
					return {
						value: { tagId: before.id, removedLinks: links, receiptId },
						subject: before.id,
						subjectType: "tag",
						action: "people.retired",
						before: { ...tagFacts(before), links },
					};
				}),
			);
		});
	},
	assignTag: (tx: Tx, ctx: WriteContext, raw: unknown) => changeTagLink(tx, ctx, raw, "people.assignTag"),
	removeTag: (tx: Tx, ctx: WriteContext, raw: unknown) => changeTagLink(tx, ctx, raw, "people.removeTag"),

	async getPersonSkills(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const plant = plantId(ctx);
			const input = parse(f.personFieldsRequest, raw);
			await authorize(tx, ctx);
			await personFacts(tx, plant, input.personId);
			return f.personSkillsResult.parse({
				personId: input.personId,
				skills: await skillsOf(tx, plant, { personId: input.personId }),
			});
		});
	},
	async addSkill(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.addSkillRequest, raw);
			return f.skillMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.addSkill", input, async (_actor, receiptId, audit) => {
					const { personId, ...fields } = input.input;
					const p = await personFacts(tx, plant, personId);
					livePerson(p);
					const current = await skillsOf(tx, plant, { personId });
					const added = f.skill.parse({ id: randomUUID(), personId, ...fields, revision: "1" });
					audit.writes.push(
						tx.insert(tables.person_skill).values({ id: added.id, plant_id: plant, person_id: personId, ...fields }),
					);
					return {
						value: { personId, skills: [...current, added].sort(skillOrder), outcome: "changed" as const, receiptId },
						subject: personId,
						action: "people.updated",
						before: { revision: p.revision, skill: null },
						after: { revision: p.revision, skill: skillFacts(added) },
					};
				}),
			);
		});
	},
	async updateSkill(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.updateSkillRequest, raw);
			return f.skillMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.updateSkill", input, async (_actor, receiptId, audit) => {
					const { skills, before, p } = await currentSkill(tx, plant, input.input.skillId);
					expectRevision(before.revision, input.expectedRevision);
					const patch = Object.fromEntries(Object.entries(input.input.patch).filter(([, v]) => v !== undefined));
					const changed = Object.entries(patch).some(([k, v]) => before[k as keyof Skill] !== v);
					if (!changed) {
						const value = { personId: p.id, skills, outcome: "noop" as const, receiptId };
						return { value, subject: p.id, action: "people.updated", outcome: "noop" };
					}
					const after = f.skill.parse({ ...before, ...patch, revision: next(before.revision) });
					audit.writes.push(
						tx
							.update(tables.person_skill)
							.set({ ...patch, revision: sql`${tables.person_skill.revision}+1` })
							.where(
								and(
									eq(tables.person_skill.id, before.id),
									eq(tables.person_skill.plant_id, plant),
									eq(tables.person_skill.revision, before.revision),
								),
							),
					);
					return {
						value: {
							personId: p.id,
							skills: skills.map((s) => (s.id === after.id ? after : s)).sort(skillOrder),
							outcome: "changed" as const,
							receiptId,
						},
						subject: p.id,
						action: "people.updated",
						before: { revision: p.revision, skill: skillFacts(before) },
						after: { revision: p.revision, skill: skillFacts(after) },
					};
				}),
			);
		});
	},
	async removeSkill(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const plant = plantId(ctx);
			const input = parse(f.removeSkillRequest, raw);
			return f.skillMutationResult.parse(
				await mutation<unknown>(tx, ctx, "people.removeSkill", input, async (_actor, receiptId, audit) => {
					const { skills, before, p } = await currentSkill(tx, plant, input.input.skillId);
					expectRevision(before.revision, input.expectedRevision);
					audit.writes.push(
						tx
							.delete(tables.person_skill)
							.where(and(eq(tables.person_skill.id, before.id), eq(tables.person_skill.plant_id, plant))),
					);
					return {
						value: {
							personId: p.id,
							skills: skills.filter((s) => s.id !== before.id),
							outcome: "changed" as const,
							receiptId,
						},
						subject: p.id,
						action: "people.updated",
						before: { revision: p.revision, skill: skillFacts(before) },
						after: { revision: p.revision, skill: null },
					};
				}),
			);
		});
	},
};

async function currentSkill(tx: Tx, plant: string, skillId: string) {
	const skills = await skillsOf(tx, plant, { skillId });
	const before = skills.find((s) => s.id === skillId);
	if (!before) deny();
	const p = await personFacts(tx, plant, before.personId);
	livePerson(p);
	return { skills, before, p };
}

async function changeTagLink(tx: Tx, ctx: WriteContext, raw: unknown, name: "people.assignTag" | "people.removeTag") {
	return reply(tx, async () => {
		const plant = plantId(ctx);
		const input = parse(f.tagAssignmentRequest, raw);
		return f.tagAssignmentResult.parse(
			await mutation<unknown>(tx, ctx, name, input, async (_actor, receiptId, audit) => {
				const { personId, tagId } = input.input;
				// The Person, its tags and the target tag in one read.
				const p = await personFacts(
					tx,
					plant,
					personId,
					sql`jsonb_build_object('tags',${personTagsJson(plant)},'tag',(SELECT jsonb_build_object('id',t.id,'name',t.name,'color',t.color)
 FROM tag t WHERE t.id=${tagId}::uuid AND t.plant_id=${plant}::uuid))`,
				);
				livePerson(p);
				const facts = z.object({ tags: z.unknown(), tag: f.personTag.nullable() }).parse(p.extra);
				if (!facts.tag) deny();
				const tag = facts.tag,
					before = personTags(facts.tags);
				const linked = before.some((t) => t.id === tagId);
				const assign = name === "people.assignTag";
				// A repeated assign or remove changes nothing and records no activity (REQ-PPL-010).
				if (linked === assign) {
					const value = { personId, tags: before, outcome: "noop" as const, receiptId };
					return { value, subject: personId, action: "people.updated", outcome: "noop" };
				}
				const after = assign
					? [...before, { id: tag.id, name: tag.name, color: tag.color }].sort(byName)
					: before.filter((t) => t.id !== tagId);
				audit.writes.push(
					assign
						? tx.insert(tables.person_tag).values({ plant_id: plant, person_id: personId, tag_id: tagId })
						: tx
								.delete(tables.person_tag)
								.where(
									and(
										eq(tables.person_tag.plant_id, plant),
										eq(tables.person_tag.person_id, personId),
										eq(tables.person_tag.tag_id, tagId),
									),
								),
				);
				return {
					value: { personId, tags: after, outcome: "changed" as const, receiptId },
					subject: personId,
					action: "people.updated",
					before: { revision: p.revision, tags: before.map((t) => t.name) },
					after: { revision: p.revision, tags: after.map((t) => t.name) },
				};
			}),
		);
	});
}
