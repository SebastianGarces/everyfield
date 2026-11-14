import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { journeyAnswer } from "@everyfield/contracts/onboarding";
import { readOnboardingEntry } from "@everyfield/domain/onboarding";
import { z } from "zod";
import { phaseText, SHARING_CATEGORIES, type SharingCategory } from "../../../catalog/labels.ts";
import type { EvryActor } from "../../../context/actor.ts";
import { accountContext, change, nativeWrite, notes, plantOwner, settled, target } from "../../native.ts";

// The setup reviewed writes (T-345): the Owner setting up a church answers where it is, who leads it and finishes
// setup; a seatless account starts a church or a Discovery space; a Discovery account turns its space into a church.
// Each runs the onboarding producer command `/onboarding` runs, on the executor's transaction, so the change, its audit
// rows and any receipt email in the outbox commit with the proposal outcome. A step that is already settled for good
// (a declared phase, an assigned lead role, a finished setup, an existing church or Discovery space) has no review.

/** The church whose setup this Owner is doing, with its setup row and launch schedule, as `pl`, `os` and `l`. */
const setup = (actor: EvryActor) =>
	sql`FROM plant pl JOIN onboarding_setup os ON os.plant_id=pl.id LEFT JOIN launch l ON l.plant_id=pl.id
		WHERE pl.id=${actor.owner.id}::uuid AND os.account_id=${actor.accountId}::uuid`;
const church = target("church", sql`pl.id`, sql`pl.name`);
/** The signed-in account with its name, as `a` and `n`, while it holds no seat and no church setup. */
const seatless = (actor: EvryActor) =>
	sql`FROM account a CROSS JOIN LATERAL seat_identity(a.id) n WHERE a.id=${actor.accountId}::uuid
		AND NOT EXISTS(SELECT FROM seat s WHERE s.account_id=a.id AND s.ended_at IS NULL)
		AND NOT EXISTS(SELECT FROM onboarding_setup x WHERE x.account_id=a.id)`;
const you = sql`jsonb_build_object('kind','account','id',a.id,'label',n.display_name)`;

/** A saved journey answer (os.journey) as `/onboarding` words it, or null while it is open. */
const journeyText = sql`CASE WHEN os.journey->>'status'<>'saved' THEN NULL
	WHEN os.journey->'value'->>'answer'='unsure' THEN 'Not sure yet. Nothing declared.'
	WHEN os.journey->'value'->>'answer'='discerning' THEN 'Still discerning. Nothing declared.'
	WHEN os.journey->'value'->>'answer'='skip' THEN 'Skipped' END`;
const answerText = (j: z.infer<typeof journeyAnswer>) =>
	j.answer === "existing"
		? `Declared ${phaseText(j.phase)}`
		: { unsure: "Not sure yet. Nothing declared.", discerning: "Still discerning. Nothing declared.", skip: "Skipped" }[
				j.answer
			];
/**
 * The launch answer that saves with the journey answer (they are one native request). Evry takes no launch date, so a
 * saved answer is sent again as it is now (a planned date with the schedule's current revision) and an open one is
 * saved as skipped, which never clears a schedule.
 */
const launchArg = sql`CASE WHEN os.launch->>'status'<>'saved' THEN '{"answer":"skip"}'::jsonb
	WHEN os.launch->'value'->>'answer'='planned' AND l.target_date IS NOT NULL AND l.status<>'completed'
		THEN jsonb_build_object('answer','planned','date',l.target_date::text,'expectedScheduleRevision',l.revision::text)
	WHEN os.launch->'value'->>'answer'='planned' THEN '{"answer":"no_date"}'::jsonb
	ELSE os.launch->'value' END`;

export const declareJourney = nativeWrite({
	operation: "onboarding.declareJourney",
	description:
		"Propose the setup answer for where this church is today: an existing phase it was already in when it joined (declared once, it can't be changed in setup), or not sure yet, still discerning, or skip. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ journey: journeyAnswer }),
	allowed: plantOwner,
	review(actor, value) {
		const lines =
			value.journey.answer === "existing"
				? [
						`This records ${phaseText(value.journey.phase)} as where the church already was when it joined Everyfield. It can't be changed in setup afterwards.`,
					]
				: ["The church stays in the phase it is in now. Nothing is declared."];
		return sql`SELECT jsonb_build_object('target',${church},'changes',jsonb_build_array(
				jsonb_build_object('field','whereYouAre','before',to_jsonb(${journeyText}),'after',${answerText(value.journey)}::text))
				||CASE WHEN os.launch->>'status'<>'saved' THEN jsonb_build_array(${change("launchDate", sql`'null'::jsonb`, "Skipped")}) ELSE '[]'::jsonb END,
				'notes',${notes(lines)}||CASE WHEN os.launch->>'status'<>'saved'
					THEN '["Your launch date is saved as skipped. Add a date in the launch plan when you have one."]'::jsonb
					ELSE '["Your launch date stays as it is."]'::jsonb END) AS review,
			jsonb_build_object('expectedRevision',pl.revision::text,'input',jsonb_build_object('journey',${JSON.stringify(value.journey)}::jsonb,'launch',${launchArg})) AS args
			${setup(actor)} AND coalesce(os.journey->'value'->>'answer','')<>'existing'`;
	},
	async run(tx, context, request, { ports }) {
		const r = settled(await ports.onboarding.declareJourney(tx, context as never, request as never));
		return { revision: r.revision };
	},
});

const DEFAULT_LEAD = { roleName: "Lead pastor", teamName: "Leadership" } as const;
const name = z.string().trim().min(1).max(200);
const LEAD_TEXT = { yes: "You hold the lead role", no: "Someone else leads", skip: "Skipped" } as const;
const leadText = sql`CASE os.lead->>'answer' WHEN 'no' THEN 'Someone else leads' WHEN 'skip' THEN 'Skipped' END`;

export const answerLead = nativeWrite({
	operation: "identity.answerLeadOnboarding",
	description:
		"Propose the setup answer to whether the user leads this church: yes (a lead role, Lead pastor by default, in a new team, Leadership by default, assigned to them), no (someone else leads) or skip. Once a lead role is assigned it can't be answered again. Nothing changes until the user approves the exact review.",
	input: z.discriminatedUnion("answer", [
		z.strictObject({ answer: z.literal("yes"), roleName: name.optional(), teamName: name.optional() }),
		z.strictObject({ answer: z.literal("no") }),
		z.strictObject({ answer: z.literal("skip") }),
	]),
	allowed: plantOwner,
	review(actor, value) {
		const role = value.answer === "yes" ? (value.roleName ?? DEFAULT_LEAD.roleName) : null;
		const team = value.answer === "yes" ? (value.teamName ?? DEFAULT_LEAD.teamName) : null;
		const input =
			value.answer === "yes"
				? {
						answer: "yes",
						assignment: { kind: "minimal_role", roleName: role, container: { kind: "minimal", name: team } },
						seniorPastor: false,
					}
				: { answer: value.answer };
		const lines =
			value.answer === "yes"
				? [
						`We create the ${role} role in a new ${team} team and assign it to you. Nothing else is added, and no one gets new access.`,
						"You stay the Owner either way.",
					]
				: [
						value.answer === "no"
							? "No role is assigned. Add your lead from your team list later."
							: "No role is assigned. You can answer this later in setup.",
					];
		const extra = role
			? sql`,${change("role", sql`'null'::jsonb`, role)},${change("team", sql`'null'::jsonb`, team)}`
			: sql``;
		return sql`SELECT jsonb_build_object('target',${church},'changes',jsonb_build_array(
				jsonb_build_object('field','lead','before',to_jsonb(${leadText}),'after',${LEAD_TEXT[value.answer]}::text)${extra}),
				'notes',${notes(lines)}) AS review,
			jsonb_build_object('expectedRevision',pl.revision::text,'input',${JSON.stringify(input)}::jsonb) AS args
			${setup(actor)} AND os.lead->>'answer'<>'yes'`;
	},
	async run(tx, context, request, { ports }) {
		const r = settled(await ports.onboarding.answerLead(tx, context as never, request as never));
		return { revision: r.revision };
	},
});

export const complete = nativeWrite({
	operation: "onboarding.complete",
	description:
		"Propose finishing setup of this church. It saves where setup ended and fills in nothing that is missing; afterwards Home opens the church. Setup finishes once. Nothing changes until the user approves the exact review.",
	input: z.strictObject({}),
	allowed: plantOwner,
	review(actor) {
		return sql`SELECT jsonb_build_object('target',${church},'changes',jsonb_build_array(${change("setup", sql`'"Not finished"'::jsonb`, "Finished")}),
				'notes',${notes([
					"Finishing saves where setup ended. Nothing missing is filled in for you, and you can add it at any time.",
					"After this, Home opens your church instead of setup.",
				])}) AS review,
			jsonb_build_object('expectedRevision',pl.revision::text,'input','{}'::jsonb) AS args
			${setup(actor)} AND pl.onboarding_completed_at IS NULL`;
	},
	async run(tx, context, request, { ports }) {
		const r = settled(await ports.onboarding.complete(tx, context as never, request as never));
		return { revision: r.revision };
	},
});

/** A new church's basics as the model names them; the account owner confirms them by approving. */
const place = name.optional();
const basics = { name, city: place, stateProvince: place, country: place };
type Basics = { name: string; city?: string; stateProvince?: string; country?: string };
/** The basics as the native request takes them, and each one as a reviewed change. */
function plantBasics(value: Basics) {
	const place = {
		city: value.city ?? null,
		stateProvince: value.stateProvince ?? null,
		country: value.country ?? null,
	};
	const any = place.city || place.stateProvince || place.country;
	const changes: SQL[] = [change("church", sql`'null'::jsonb`, value.name)];
	for (const field of ["city", "stateProvince", "country"] as const)
		if (value[field]) changes.push(change(field, sql`'null'::jsonb`, value[field]));
	return {
		input: { name: value.name, ...(any ? { locality: place } : {}), confirmed: true },
		changes: sql`jsonb_build_array(${sql.join(changes, sql`,`)})`,
	};
}
const NEXT_STEPS =
	"Setup then goes on with: where you are, your launch date and your team. Ask me where you are in setup, or open setup.";

export const createPlant = nativeWrite({
	operation: "onboarding.createPlant",
	description:
		"Propose starting a new church in Everyfield with the user as its Owner: its name and, if given, its city, state or province and country. Only an account with no church seat can start one. Nothing changes until the user approves the exact review.",
	input: z.strictObject(basics),
	allowed: accountContext,
	review(actor, value) {
		const b = plantBasics(value);
		const discovery =
			"You have a Discovery space, so it becomes your church instead. Ask me to turn your Discovery space into a church.";
		return sql`SELECT jsonb_build_object('target',${you},'changes',${b.changes},
				'notes',${notes([`You become the Owner of ${value.name}. It starts in ${phaseText(1)}, from today.`, NEXT_STEPS])})
				||CASE WHEN EXISTS(SELECT FROM discovery d WHERE d.account_id=a.id AND d.converted_at IS NULL)
					THEN jsonb_build_object('refusal',${discovery}::text) ELSE '{}'::jsonb END AS review,
			jsonb_build_object('expectedRevision',a.revision::text,'input',${JSON.stringify(b.input)}::jsonb) AS args
			${seatless(actor)}`;
	},
	async run(tx, context, request, { ports }) {
		const r = settled(await ports.onboarding.createPlant(tx, context as never, request as never));
		return { receiptId: r.plant.id, revision: r.revision };
	},
});

export const createDiscovery = nativeWrite({
	operation: "discovery.create",
	description:
		"Propose a private Discovery space for the user to explore church planting first: the foundation articles at their own pace, with no church and nothing shared. Everyfield emails a receipt. Nothing changes until the user approves the exact review.",
	input: z.strictObject({}),
	allowed: accountContext,
	review(actor) {
		return sql`SELECT jsonb_build_object('target',${you},'changes',jsonb_build_array(${change("discovery", sql`'null'::jsonb`, "Discovery space")}),
				'notes',${notes([
					"A private space to read the foundations at your own pace. No church is created and nothing is shared.",
					"Everyfield emails you a receipt. You can turn it into a church whenever you are ready.",
				])}) AS review,
			jsonb_build_object('expectedRevision',a.revision::text,'input','{}'::jsonb) AS args
			${seatless(actor)} AND NOT EXISTS(SELECT FROM discovery d WHERE d.account_id=a.id)`;
	},
	async run(tx, context, request, { ports }) {
		const r = settled(await ports.onboarding.createDiscovery(tx, context as never, request as never));
		return { receiptId: r.profile.discoveryId, revision: r.profile.revision };
	},
});

/** One link the Discovery owner keeps when the space becomes a church, and what the church's link shares. */
const carryOver = z.strictObject({ organizationId: z.uuid(), share: z.array(z.enum(SHARING_CATEGORIES)).max(7) });
type Choices = Record<SharingCategory, boolean>;
const sharedNow = (choices: Choices) => SHARING_CATEGORIES.filter((k) => choices[k]);

export const convertToPlant = nativeWrite({
	operation: "discovery.convertToPlant",
	description: `Propose turning the user's Discovery space into a church with the user as its Owner: its name and, if given, its city, state or province and country. Without carryOver, every sending church or network the space is linked to (discovery.getProfile) stays linked, sharing what it shares today. With carryOver, only the listed links stay, each sharing exactly the listed categories from the church (${SHARING_CATEGORIES.join(", ")}); the other links end. The user can also pick on the review card. Nothing changes until the user approves the exact review.`,
	input: z.strictObject({ ...basics, carryOver: z.array(carryOver).max(100).optional() }),
	allowed: accountContext,
	async review(actor, value, { db, native }) {
		if (!native) return null;
		// The profile `/onboarding` reads, so the relationships carried over are the ones it shows, at their revisions.
		const session = { status: "active", accountId: actor.accountId, sessionId: actor.session };
		const entry = await readOnboardingEntry(db as Database, native.onboarding, session as never, actor.authority, true);
		if (entry.kind !== "discovery") return null;
		const profile = entry.profile as {
			discoveryId: string;
			revision: string;
			relationships: {
				relationshipId: string;
				organization: { id: string; organizationKind: string };
				revision: string;
				consentRevision: string;
				choices: Choices;
			}[];
		};
		// Each link as it is now, and what carries over: every link sharing what it shares today, or only the picked links
		// sharing the picked categories. A Discovery link itself shares nothing (affiliation_ck_2): sharing starts with the church.
		const links = profile.relationships.map((r) => {
			const pick = value.carryOver ? value.carryOver.find((c) => c.organizationId === r.organization.id) : null;
			const choices = Object.fromEntries(
				SHARING_CATEGORIES.map((k) => [k, pick ? pick.share.includes(k) : pick === null && r.choices[k]]),
			) as Choices;
			return { r, carries: pick !== undefined, choices };
		});
		const unknown = (value.carryOver ?? []).some(
			(c) => !profile.relationships.some((r) => r.organization.id === c.organizationId),
		);
		const relationships = links
			.filter((l) => l.carries)
			.map(({ r, choices }) => ({
				relationshipId: r.relationshipId,
				organization: r.organization,
				expectedRelationshipRevision: r.revision,
				expectedConsentRevision: r.consentRevision,
				choices,
			}));
		const b = plantBasics(value);
		const rows = JSON.stringify(
			links.map((l) => ({
				id: l.r.organization.id,
				kind: l.r.organization.organizationKind === "sending_network" ? "Network" : "Sending church",
				now: sharedNow(l.r.choices),
				carries: l.carries,
				share: l.carries ? sharedNow(l.choices) : [],
			})),
		);
		// One reviewed row per link: the organization and what it shares now, then whether it carries over and with what.
		const linkChanges = sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('field','link:'||x.id,
				'before',jsonb_build_object('organization',o.name,'kind',x.kind,'share',x.now),
				'after',jsonb_build_object('carries',x.carries,'share',x.share)) ORDER BY o.name,o.id),'[]'::jsonb)
			FROM jsonb_to_recordset(${rows}::jsonb) x(id uuid,kind text,now jsonb,carries boolean,share jsonb) JOIN organization o ON o.id=x.id)`;
		const refusal = unknown
			? sql`jsonb_build_object('refusal','That organization is not linked to your Discovery space, so it can''t carry over. Nothing changes.'::text)`
			: sql`'{}'::jsonb`;
		return sql`SELECT jsonb_build_object('target',${you},'changes',${b.changes}||${linkChanges},
				'notes',${notes([
					`Your Discovery space becomes ${value.name}, in ${phaseText(1)}. You become its Owner, and your reading stays with you.`,
					...(links.length
						? [
								"Only the links marked to carry over stay with the church, sharing only what is listed. Every other link ends, and your Discovery space closes.",
								"Revise this review to pick which links carry over and what each one shares.",
							]
						: []),
					NEXT_STEPS,
				])})||${refusal} AS review,
			jsonb_build_object('expectedRevision',d.revision::text,'input',${JSON.stringify({ ...b.input, discoveryId: profile.discoveryId, relationships })}::jsonb) AS args
			FROM discovery d JOIN account a ON a.id=d.account_id CROSS JOIN LATERAL seat_identity(a.id) n
			WHERE d.id=${profile.discoveryId}::uuid AND a.id=${actor.accountId}::uuid AND d.converted_at IS NULL
				AND d.revision=${profile.revision}::bigint AND NOT EXISTS(SELECT FROM seat s WHERE s.account_id=a.id AND s.ended_at IS NULL)`;
	},
	async run(tx, context, request, { ports }) {
		const r = settled(await ports.onboarding.convertDiscovery(tx, context as never, request as never));
		return { receiptId: r.plant.id, revision: r.revision };
	},
});

/** The installed setup reviewed writes, keyed by operation. */
export const ONBOARDING_COMMANDS = {
	"onboarding.declareJourney": declareJourney,
	"identity.answerLeadOnboarding": answerLead,
	"onboarding.complete": complete,
	"onboarding.createPlant": createPlant,
	"discovery.create": createDiscovery,
	"discovery.convertToPlant": convertToPlant,
} as const;
