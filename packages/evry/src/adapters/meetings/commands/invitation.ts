import * as c from "@everyfield/contracts/meetings";
import { renderBody } from "@everyfield/contracts/communication";
import { sql, type SQL } from "@everyfield/db/query";
import { audiencePeople, communicationWriter } from "@everyfield/domain/communication";
import {
	guestsWriter,
	meetingsReader,
	meetingsWriter,
	MeetingsRefusal,
	previewMeetingsWrite,
	venuesReader,
} from "@everyfield/domain/meetings";
import type { WriteTx } from "@everyfield/domain/access";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { localWhen } from "../../../catalog/labels.ts";
import type { EffectResult, ReviewContext, ReviewedWrite } from "../../../proposals/types.ts";
import {
	audienceFacts,
	checkSend,
	paragraphs,
	readable,
	readReceipt,
	scheduleNow,
	sendNow,
} from "../../communication/commands/index.ts";
import { classifiedPeople, leftOutIds, leftOutPeople, recipientNames } from "../../communication/audience.ts";
import { day, id, meeting, ownerOrAdmin, value } from "../shared.ts";

const GROUPS = ["core_group", "launch_team", "leaders", "prospects"] as const;
const audience = z.strictObject({
	groups: z.array(z.enum(GROUPS)).max(GROUPS.length).default([]).describe("Named groups of people"),
	householdIds: z.array(id).max(20).default([]).describe("Household ids from people.listHouseholds: every member"),
	personIds: z.array(id).max(200).default([]).describe("People ids from an earlier result"),
});
type Audience = z.infer<typeof audience>;
const newMeeting = z.strictObject({
	type: c.meetingType,
	date: day.describe("The church-local date"),
	time: z
		.string()
		.regex(/^\d{2}:\d{2}$/)
		.describe("24-hour church-local time"),
	venueId: id.describe("A saved venue id from venues.list; if several match, ask first"),
});
const text = {
	subject: z.string().trim().min(1).max(200).optional().describe("Leave it out for the standard invitation"),
	body: z
		.string()
		.trim()
		.min(1)
		.max(20_000)
		.optional()
		.describe("Plain text; {{name}} is each person's name. Leave it out for the standard invitation"),
};
const planInput = z.strictObject({
	meetingId: id.optional().describe("An existing meeting from meetings.list"),
	meeting: newMeeting.optional().describe("A meeting to create, when none exists yet"),
	audience,
	...text,
});
type Plan = z.infer<typeof planInput>;
const reuseInput = z.strictObject({
	meetingId: id.describe("This time's meeting from meetings.list"),
});

const savedPlan = z.object({
	meeting: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("existing"), meetingId: z.uuid(), revision: z.string() }),
		z.object({ kind: z.literal("new"), input: z.record(z.string(), z.unknown()) }),
	]),
	audience: z.object({ groups: z.array(z.string()), householdIds: z.array(z.uuid()), personIds: z.array(z.uuid()) }),
	custom: z.object({ subject: z.string().optional(), body: z.string().optional() }),
	guestIds: z.array(z.uuid()),
	newGuestIds: z.array(z.uuid()),
	fingerprint: z.string(),
	mail: z.object({
		subject: z.string(),
		bodyHtml: z.string(),
		leftOut: z.array(z.uuid()),
		held: z.int(),
		recipientsDigest: z.string(),
	}),
	recipe: z.uuid().nullable(),
});
type Saved = z.infer<typeof savedPlan>;
const person = z.object({ id: z.uuid(), email: z.string().nullable(), optedOutAt: z.string().nullable() });

type Reader = ReviewContext["db"] | WriteTx;
async function members(db: Reader, plant: string, households: string[]) {
	if (!households.length) return [];
	const r =
		await db.execute(sql`SELECT p.id::text FROM person p WHERE p.plant_id=${plant}::uuid AND p.tenant_id=${plant}::uuid
		AND p.state='live' AND p.household_id=ANY(${sql.param(households)}::uuid[]) ORDER BY p.id`);
	return z
		.array(z.object({ id: z.uuid() }))
		.parse(r.rows)
		.map((p) => p.id);
}
async function resolve(db: Reader, plant: string, a: Saved["audience"]) {
	const personIds = [...new Set([...a.personIds, ...(await members(db, plant, a.householdIds))])];
	const value = { groups: a.groups as Audience["groups"], teamIds: [], personIds };
	const [row] = (await db.execute(sql`SELECT ${audiencePeople(plant, value)} AS people`)).rows;
	const people = z.array(person).parse(row?.people ?? []);
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify(
				[...people]
					.sort((x, y) => (x.id < y.id ? -1 : 1))
					.map((p) => [p.id, Boolean(p.email?.trim()), p.optedOutAt !== null]),
			),
		)
		.digest("hex");
	return { value, fingerprint };
}

type Shown = { title: string; when: string; venue: string | null; isNew: boolean };
type Facts = { target: { kind: "meeting"; id: string; label: string } | null; shown: Shown; on: Set<string> };
async function meetingFacts(actor: EvryActor, plan: Plan, context: ReviewContext) {
	const db = context.db;
	if (plan.meetingId) {
		const m = await meeting(db, actor, plan.meetingId);
		const list = m && value(await meetingsReader.listGuests(db, actor.authority, { meetingId: m.id }));
		if (!m || !list) return null;
		const facts: Facts = {
			target: { kind: "meeting", id: m.id, label: m.displayTitle },
			shown: { title: m.displayTitle, when: localWhen(m.startsAt, m.zone), venue: m.venue?.name ?? null, isNew: false },
			on: new Set(list.guests.map((g) => g.person.personId)),
		};
		return { facts, saved: { kind: "existing" as const, meetingId: m.id, revision: m.revision } };
	}
	const want = plan.meeting;
	if (!want) throw new EvryRefusal("invalid_input");
	const venue = value(await venuesReader.get(db, actor.authority, { venueId: want.venueId }));
	if (venue?.status !== "available") return null;
	const input = {
		type: want.type,
		date: want.date,
		time: want.time,
		venue: { kind: "existing", venueId: want.venueId },
		guests: [],
	};
	const reply = await previewMeetingsWrite(db, actor.authority, (tx, ctx) =>
		meetingsWriter.schedule(tx, ctx, { requestKey: randomUUID(), input }),
	);
	if (reply.status !== "ok")
		throw new EvryRefusal(reply.error.code === "invalid_input" ? "invalid_input" : "access_denied");
	const m = reply.value.meeting;
	const facts: Facts = {
		target: null,
		shown: { title: m.displayTitle, when: localWhen(m.startsAt, m.zone), venue: venue.venue.name, isNew: true },
		on: new Set(),
	};
	return { facts, saved: { kind: "new" as const, input } };
}

const standardBody = (s: Shown) =>
	`Hi {{name}},\n\nYou're invited to ${s.title} on ${s.when}${s.venue ? ` at ${s.venue}` : ""}. We'd love to see you there.`;

const classifiedRow = z.object({
	guests: z.array(z.object({ id: z.uuid(), name: z.string() })),
	recipients: z.array(z.object({ name: z.string() })),
	left_out: z.array(z.object({ name: z.string(), reason: z.string() })),
	left_out_ids: z.array(z.uuid()),
	held: z.int(),
	first_name: z.string(),
});

type Recipe = { id: string; approvedAt: string; title: string };
async function review(
	actor: EvryActor,
	plan: Plan,
	context: ReviewContext,
	recipe: Recipe | null,
	custom: Saved["custom"],
): Promise<SQL | null> {
	const plant = actor.owner.id;
	const found = await meetingFacts(actor, plan, context);
	if (!found) return null;
	const { facts } = found;
	const resolved = await resolve(context.db, plant, plan.audience);
	const mail = await audienceFacts(context, plant, resolved.value);
	if (!mail) return null;
	const [raw] = (
		await context.db.execute(sql`WITH ${classifiedPeople(plant, resolved.value, mail.hashes)}
			SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',"displayName") ORDER BY lower("displayName") COLLATE "C",id) FROM people),'[]'::jsonb) AS guests,
				${recipientNames} AS recipients, ${leftOutPeople} AS left_out, ${leftOutIds} AS left_out_ids,
				(SELECT count(*)::int FROM classified WHERE reason IS NOT NULL AND reason NOT IN ('no_address','duplicate_address')) AS held,
				coalesce((SELECT name FROM classified WHERE reason IS NULL ORDER BY lower(name) COLLATE "C",id LIMIT 1),'') AS first_name`)
	).rows;
	const r = classifiedRow.parse(raw);
	const subject = custom.subject ?? `You're invited: ${facts.shown.title}`;
	const bodyHtml = paragraphs(custom.body ?? standardBody(facts.shown));
	const refusal = !r.guests.length
		? "Nobody in People matches that audience."
		: !r.recipients.length
			? "Nobody in this audience can get this email."
			: null;
	const change = (field: string, after: unknown) => ({ field, before: null, after });
	const reviewed = {
		target: facts.target,
		changes: [
			change("meeting", facts.shown),
			change(
				"guests",
				r.guests.map((g) =>
					facts.on.has(g.id) ? { name: g.name, note: "Already on the guest list" } : { name: g.name },
				),
			),
			change("subject", subject),
			change("recipients", r.recipients),
			change("leftOut", r.left_out),
			change("content", readable(renderBody(bodyHtml, { name: r.first_name, rsvp_link: "" }))),
		],
		...(recipe
			? {
					notes: [
						`Same invitation as the one you approved on ${recipe.approvedAt} for ${recipe.title}. The meeting and the people are worked out again from today's records, and it needs your approval again.`,
					],
				}
			: {}),
		...(refusal ? { refusal } : {}),
	};
	const args: Saved = {
		meeting: found.saved,
		audience: plan.audience,
		custom,
		guestIds: r.guests.map((g) => g.id),
		newGuestIds: r.guests.filter((g) => !facts.on.has(g.id)).map((g) => g.id),
		fingerprint: resolved.fingerprint,
		mail: { subject, bodyHtml, leftOut: r.left_out_ids, held: r.held, recipientsDigest: mail.digest },
		recipe: recipe?.id ?? null,
	};
	const live = facts.target
		? sql`WHERE EXISTS(SELECT FROM meeting m WHERE m.id=${facts.target.id}::uuid AND m.plant_id=${plant}::uuid AND m.retired_at IS NULL)`
		: sql``;
	return sql`SELECT ${JSON.stringify(reviewed)}::jsonb AS review, ${JSON.stringify(args)}::jsonb AS args ${live}`;
}

async function recheck(tx: WriteTx, context: { selected: { id: string } }, args: unknown) {
	const a = savedPlan.parse(args);
	const plant = context.selected.id;
	if (a.meeting.kind === "existing") {
		const r = await tx.execute(
			sql`SELECT revision::text AS revision FROM meeting WHERE id=${a.meeting.meetingId}::uuid AND plant_id=${plant}::uuid AND retired_at IS NULL`,
		);
		if (r.rows[0]?.revision !== a.meeting.revision) return "stale_review";
	}
	const now = await resolve(tx, plant, a.audience);
	return now.fingerprint === a.fingerprint ? null : "stale_review";
}

async function execute(
	tx: WriteTx,
	context: Parameters<ReviewedWrite<unknown>["execute"]>[1],
	args: unknown,
	effectKey: string,
): Promise<EffectResult> {
	const a = savedPlan.parse(args);
	try {
		let meetingId: string;
		if (a.meeting.kind === "new") {
			const made = await meetingsWriter.schedule(tx, context, {
				requestKey: `${effectKey}:meeting`,
				input: { ...a.meeting.input, guests: a.guestIds },
			});
			if (made.status !== "ok") return { refused: made.error.code };
			meetingId = made.value.meeting.id;
		} else {
			meetingId = a.meeting.meetingId;
			for (const personId of a.newGuestIds) {
				const added = await guestsWriter.inviteGuest(tx, context, {
					requestKey: `${effectKey}:guest:${personId}`,
					input: { meetingId, personId, inviterPersonId: null },
				});
				if (added.status !== "ok") return { refused: added.error.code };
			}
		}
		const draft = await communicationWriter.saveDraft(tx, context, {
			requestKey: `${effectKey}:draft`,
			input: {
				subject: a.mail.subject,
				bodyHtml: a.mail.bodyHtml,
				audience: { groups: [], teamIds: [], personIds: a.guestIds },
				meetingId,
			},
		});
		if (draft.status !== "ok") return { refused: draft.error.code };
		const scheduled = await scheduleNow(
			tx,
			context,
			draft.value.communicationId,
			draft.value.revision,
			`${effectKey}:schedule`,
			a.mail.recipientsDigest,
		);
		return "refused" in scheduled ? scheduled : { ...scheduled, meetingId };
	} catch (error) {
		if (error instanceof MeetingsRefusal) return { refused: error.code };
		throw error;
	}
}

const sends: Pick<ReviewedWrite<unknown>, "allowed" | "recheck" | "execute" | "reach" | "check"> = {
	allowed: ownerOrAdmin,
	recheck,
	execute,
	reach: (db, authority, args, effectKey, first, mail) => {
		const a = savedPlan.parse(args);
		return sendNow(db, authority, first, `${effectKey}:send`, a.mail.leftOut, a.mail.held, mail);
	},
	check: async (db, authority, args, keys, mail) => {
		const a = savedPlan.parse(args);
		const id = await readReceipt(db, authority, keys);
		return id ? checkSend(db, authority, id, keys, a.mail.leftOut.length, a.mail.held, mail) : { refused: "not_found" };
	},
};

export const prepareMeetingInvitation: ReviewedWrite<Plan> = {
	operation: "evry.prepareMeetingInvitation",
	description:
		"Invite people to a meeting in one review: the meeting (an existing one, or a new one when none exists yet), every guest added to it, and the invitation email with who gets it and who is left out and why. Give either meetingId or meeting. Ask which venue first when several match. Nothing is created, added or sent until the user approves.",
	input: planInput.refine(
		(p) => (p.meetingId === undefined) !== (p.meeting === undefined),
		"Give meetingId or meeting",
	),
	...sends,
	review: (actor, plan, context) =>
		review(actor, plan, context, null, {
			...(plan.subject ? { subject: plan.subject } : {}),
			...(plan.body ? { body: plan.body } : {}),
		}),
};

const recipeRow = z.object({ id: z.uuid(), input: z.unknown(), approved: z.string(), title: z.string() });
export const reuseRecipe: ReviewedWrite<z.infer<typeof reuseInput>> = {
	operation: "evry.reuseRecipe",
	description:
		"Do an invitation the user approved through Evry again for another meeting: the same audience and wording, with the meeting, guests and recipients worked out again from today's records. It is a new review that needs its own approval; the earlier approval never carries over.",
	input: reuseInput,
	...sends,
	async review(actor, input, context) {
		const r = await context.db.execute(sql`
			SELECT p.id::text, p.input, to_char(p.approved_at AT TIME ZONE pl.timezone,'Mon FMDD') AS approved,
				coalesce(p.review->'changes'->0->'after'->>'title','a meeting') AS title
			FROM proposal p JOIN plant pl ON pl.id=p.tenant_id
				JOIN meeting old ON old.id=(p.receipt->>'meetingId')::uuid AND old.plant_id=p.tenant_id
				JOIN meeting t ON t.id=${input.meetingId}::uuid AND t.plant_id=p.tenant_id
			WHERE p.tenant_id=${actor.owner.id}::uuid AND p.account_id=${actor.accountId}::uuid AND p.outcome='completed'
				AND p.operation IN ('evry.prepareMeetingInvitation','evry.reuseRecipe')
				AND old.id<>t.id AND old.type=t.type AND old.starts_at<t.starts_at
			ORDER BY old.starts_at DESC, p.approved_at DESC, p.id LIMIT 1`);
		if (!r.rows.length) return null;
		const row = recipeRow.parse(r.rows[0]);
		const old = savedPlan.pick({ audience: true, custom: true }).parse(row.input);
		const plan: Plan = { meetingId: input.meetingId, audience: old.audience as Audience };
		return review(actor, plan, context, { id: row.id, approvedAt: row.approved, title: row.title }, old.custom);
	},
};

export const INVITATION_COMMANDS = {
	"evry.prepareMeetingInvitation": prepareMeetingInvitation,
	"evry.reuseRecipe": reuseRecipe,
} as const;
