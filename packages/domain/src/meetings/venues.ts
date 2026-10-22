import * as c from "@everyfield/contracts/meetings";
import { sql } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import {
	command,
	deny,
	next,
	one,
	parse,
	read,
	reply,
	type MeetingWrite,
	type MeetingsContext,
	type Reader,
	type Tx,
	type Writer,
} from "./core.ts";
import type { RequestActor } from "../access/session.ts";

const columns = sql`v.id, v.revision::text AS revision, v.name, v.address, v.contact_name, v.phone, v.email,
	v.cost_description, v.capacity, v.notes, v.archived_at IS NULL AS active`;
const venueRow = z.object({
	id: z.uuid(),
	revision: z.string(),
	name: z.string(),
	address: z.string(),
	contact_name: z.string().nullable(),
	phone: z.string().nullable(),
	email: z.string().nullable(),
	cost_description: z.string().nullable(),
	capacity: z.number().int().nullable(),
	notes: z.string().nullable(),
	active: z.boolean(),
});
type VenueRow = z.infer<typeof venueRow>;
const venue = (v: VenueRow) =>
	c.venue.parse({
		id: v.id,
		revision: v.revision,
		name: v.name,
		address: v.address,
		contactName: v.contact_name,
		phone: v.phone,
		email: v.email,
		costDescription: v.cost_description,
		capacity: v.capacity,
		notes: v.notes,
		active: v.active,
	});
/** The fields a venue change records before and after. */
const fields = (v: z.infer<typeof c.venue>) => ({
	name: v.name,
	address: v.address,
	contactName: v.contactName,
	phone: v.phone,
	email: v.email,
	costDescription: v.costDescription,
	capacity: v.capacity,
	notes: v.notes,
	active: v.active,
});
const historyColumns = sql`a.id, a.kind, a.occurred_at, a.actor_id, a.before_value, a.after_value, a.reason`;
const historyRow = z.object({
	id: z.uuid(),
	kind: z.string(),
	occurred_at: z.coerce.date(),
	actor_id: z.uuid().nullable(),
	before_value: z.record(z.string(), z.unknown()).nullable(),
	after_value: z.record(z.string(), z.unknown()).nullable(),
	reason: z.string().nullable(),
});
const entry = (h: z.infer<typeof historyRow>) =>
	c.venueHistoryEntry.parse({
		id: h.id,
		kind: h.kind,
		occurredAt: h.occurred_at.toISOString(),
		actorId: h.actor_id,
		before: h.before_value,
		after: h.after_value,
		reason: h.reason,
	});

async function lockVenue(tx: Tx, w: Writer, id: string) {
	const r = await tx.execute(
		sql`SELECT ${columns} FROM venue v WHERE v.id = ${id}::uuid AND v.plant_id = ${w.plant.id}::uuid FOR UPDATE`,
	);
	if (!r.rows[0]) deny();
	return venue(venueRow.parse(r.rows[0]));
}
type Venue = z.infer<typeof c.venue>;
/** What every venue change request carries after parsing. */
type VenueInput = { venueId: string; patch?: Partial<Omit<Venue, "id" | "revision" | "active">>; reason?: string };
const patched = (v: Venue, i: VenueInput) =>
	c.venue.parse({
		...v,
		...Object.fromEntries(Object.entries(i.patch ?? {}).filter(([, value]) => value !== undefined)),
	});
const update = (before: z.infer<typeof c.venue>, after: z.infer<typeof c.venue>) =>
	sql`UPDATE venue SET name = ${after.name}, address = ${after.address}, contact_name = ${after.contactName},
		phone = ${after.phone}, email = ${after.email}, cost_description = ${after.costDescription},
		capacity = ${after.capacity}::int, notes = ${after.notes},
		archived_at = CASE WHEN ${after.active} THEN NULL ELSE coalesce(archived_at, clock_timestamp()) END,
		revision = revision + 1
		WHERE id = ${before.id}::uuid AND revision = ${before.revision}::bigint`;

/** One venue change: the locked row, the expected revision, then the update and its history row together. */
function change(
	operation: MeetingWrite,
	schema: z.ZodType<{ requestKey: string; expectedRevision: string; input: VenueInput }>,
	apply: (v: Venue, input: VenueInput) => Venue,
	kind: "edit" | "correct" | "archive" | "restore",
) {
	return async (tx: Tx, ctx: MeetingsContext, raw: unknown) =>
		reply(tx, async () => {
			const input = parse(schema, raw);
			return command(tx, ctx, operation, input, async (w, audit) => {
				const before = await lockVenue(tx, w, input.input.venueId);
				if (before.revision !== input.expectedRevision) deny("conflict");
				const target = apply(before, input.input);
				const noop = JSON.stringify(fields(target)) === JSON.stringify(fields(before));
				const after = noop ? before : { ...target, revision: c.venue.shape.revision.parse(next(before.revision)) };
				if (!noop) audit.writes.push(update(before, after));
				return {
					value: c.venueMutationResult.parse({ receiptId: audit.id, outcome: noop ? "noop" : "changed", venue: after }),
					subject: before.id,
					subjectType: "venue",
					action: kind === "correct" ? "meetings.corrected" : "meetings.changed",
					kind,
					outcome: noop ? "noop" : "changed",
					before: fields(before),
					after: fields(after),
					reason: input.input.reason ?? null,
				};
			});
		});
}

export const venuesWriter = {
	async create(tx: Tx, ctx: MeetingsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.createVenueRequest, raw);
			return command(tx, ctx, "venues.create", input, async (w, audit) => {
				const v = input.input,
					id = randomUUID();
				const after = c.venue.parse({ id, revision: "1", ...v, active: true });
				audit.writes
					.push(sql`INSERT INTO venue (id, plant_id, name, address, contact_name, phone, email, cost_description, capacity, notes)
					VALUES (${id}::uuid, ${w.plant.id}::uuid, ${v.name}, ${v.address}, ${v.contactName}, ${v.phone}, ${v.email},
						${v.costDescription}, ${v.capacity}::int, ${v.notes})`);
				return {
					value: c.venueMutationResult.parse({ receiptId: audit.id, outcome: "changed", venue: after }),
					subject: id,
					subjectType: "venue",
					action: "meetings.changed",
					kind: "create",
					before: null,
					after: fields(after),
				};
			});
		});
	},
	edit: change("venues.edit", c.editVenueRequest, patched, "edit"),
	/** A reviewed correction of the current facts with a reason; old meeting snapshots keep their copies. */
	correct: change("venues.correct", c.correctVenueRequest, patched, "correct"),
	archive: change("venues.archive", c.archiveVenueRequest, (v) => ({ ...v, active: false }), "archive"),
	restore: change("venues.restore", c.restoreVenueRequest, (v) => ({ ...v, active: true }), "restore"),
};

const pageRow = z.object({ total: z.number().int(), items: z.array(venueRow).nullable() });
export const venuesReader = {
	/** Current venues by name; archived ones only on request. Page numbers in a stable order (name, id). */
	async list(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.listVenuesRequest, raw);
			const search = input.search ? "%" + input.search.replace(/[\\%_]/g, (ch) => "\\" + ch) + "%" : null;
			const { row } = await one(
				db,
				viewer,
				sql`WITH f AS (
					SELECT ${columns} FROM venue v WHERE v.plant_id = ${viewer.plantId}::uuid
					AND (${input.archived} = 'include' OR (v.archived_at IS NULL) = (${input.archived} = 'exclude'))
					AND (${search}::text IS NULL OR v.name ILIKE ${search} OR v.address ILIKE ${search})
					AND (${input.minCapacity ?? null}::int IS NULL OR v.capacity >= ${input.minCapacity ?? null}::int)
				)
				SELECT (SELECT count(*) FROM f)::int AS total,
					(SELECT json_agg(p) FROM (SELECT * FROM f ORDER BY lower(name), id LIMIT ${input.limit}
						OFFSET ${(input.page - 1) * input.limit}) p) AS items`,
			);
			const page = pageRow.parse(row);
			return c.venuePage.parse({
				items: (page.items ?? []).map(venue),
				page: input.page,
				total: page.total,
				next: input.page * input.limit < page.total ? input.page + 1 : null,
			});
		});
	},
	/** One venue, archived or not, with its latest history. */
	async get(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.venueRequest, raw);
			const { row: found } = await one(
				db,
				viewer,
				sql`SELECT ${columns},
					(SELECT json_agg(h ORDER BY h.occurred_at DESC, h.id DESC) FROM (SELECT ${historyColumns} FROM audit_event a
						WHERE a.tenant_id = v.plant_id AND a.subject_id = v.id ORDER BY a.occurred_at DESC, a.id DESC LIMIT 100) h) AS history
				FROM venue v WHERE v.id = ${input.venueId}::uuid AND v.plant_id = ${viewer.plantId}::uuid`,
			);
			if (!found) return c.venueResult.parse({ status: "unavailable" });
			const row = venueRow.extend({ history: z.array(historyRow).nullable() }).parse(found);
			return c.venueResult.parse({ status: "available", venue: venue(row), history: (row.history ?? []).map(entry) });
		});
	},
	async history(db: Reader, authority: RequestActor, raw: unknown) {
		return read(authority, async (viewer) => {
			const input = parse(c.venueHistoryRequest, raw);
			const { row } = await one(
				db,
				viewer,
				sql`SELECT coalesce(json_agg(h ORDER BY h.occurred_at DESC, h.id DESC), '[]') AS items FROM (
					SELECT ${historyColumns} FROM audit_event a
					WHERE a.tenant_id = ${viewer.plantId}::uuid AND a.subject_id = ${input.venueId}::uuid
					AND EXISTS (SELECT FROM venue v WHERE v.id = a.subject_id AND v.plant_id = a.tenant_id)
					ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${input.limit + 1} OFFSET ${(input.page - 1) * input.limit}) h`,
			);
			const rows = z.array(historyRow).parse(row?.items);
			return c.venueHistory.parse({
				venueId: input.venueId,
				items: rows.slice(0, input.limit).map(entry),
				page: input.page,
				next: rows.length > input.limit ? input.page + 1 : null,
			});
		});
	},
};
