import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import { revision as revisionValue, type Owner } from "@everyfield/contracts/common";
import * as q from "@everyfield/contracts/settings";
import type { SettingsProducer, SettingsReply } from "@everyfield/contracts/settings/server";
import type { Transaction } from "@everyfield/db/client";
import { and, eq, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import "server-only";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import {
	active,
	administrator,
	choices,
	loadAffiliation,
	loadAffiliations,
	pairOf,
	type Actor,
	type OrganizationEffects,
	type Reader,
} from "../organizations/core.ts";
import { applyOrganizationProfile, profileValue } from "../organizations/profile.ts";
import { applySharingMutation } from "../organizations/sharing.ts";
import {
	actor,
	appendEvent,
	auditChange,
	begin,
	canonical,
	deny,
	finish,
	parse,
	preference,
	recover,
	reply,
	revision,
	sameOwner,
	type Context,
	type Tx,
	type WriteContext,
} from "./core.ts";
export interface SettingsEffects {
	replan(
		tx: Tx,
		input: {
			owner: Context["selected"];
			revision: string;
			operationId: string;
			kind: "plant_timezone" | "personal_timezone" | "digest";
		},
	): Promise<string>;
	invalidate(tx: Tx, input: { owner: Context["selected"]; revision: string; operationId: string }): Promise<void>;
}
export interface SectionDependencies {
	organizations: OrganizationAdapter<Transaction>;
	organizationEffects: OrganizationEffects;
	effects: SettingsEffects;
	suppression(db: Reader, email: string): Promise<"clear" | "suppressed" | "unavailable">;
}
/** The account's own name, email and verification, as the request's Better Auth session lookup read them. */
export type Principal = { display_name: string; email: string; verified: boolean };
/** The request's verified viewer (D60): its actor and the user row its session lookup already read. */
export type SectionViewer = { authority: RequestActor; principal: Principal };
type Viewer = { actor: Actor; principal: Principal };
function accountValue(a: { account: typeof t.account.$inferSelect; principal: Principal }) {
	return q.sectionResult.parse({
		section: "account",
		accountId: a.account.id,
		revision: a.account.revision,
		name: a.principal.display_name,
		email: a.principal.email,
		avatar: a.account.avatar_object_id
			? { status: "available", avatar: { accountId: a.account.id, versionId: a.account.avatar_object_id } }
			: { status: "absent" },
		personalTimezone: preference(a.account),
	});
}
/** The viewer's own plant when its seat there is Owner or Admin; any other viewer is refused. */
function administeredPlant(v: Viewer, plant: Owner) {
	const c = v.actor.context;
	if (c.kind !== "seat" || c.role === "member" || c.owner.kind !== "plant" || !sameOwner(c.owner, plant)) deny();
	return plant.id;
}
function plantValue(r: typeof t.plant.$inferSelect, p: Extract<q.GetSectionRequest, { section: "plant" }>["plant"]) {
	return q.sectionResult.parse({
		section: "plant",
		plant: p,
		revision: r.revision,
		values: {
			profile: {
				name: r.name,
				street: r.street,
				description: r.description,
				city: r.city,
				stateProvince: r.state_province,
				country: r.country,
			},
			timeZone: r.timezone,
			inactivity: { warningDays: r.warning_days, alertDays: r.alert_days },
			digest:
				r.digest_cadence === "off"
					? { cadence: "off" }
					: r.digest_cadence === "daily"
						? { cadence: "daily", hour: r.digest_hour }
						: { cadence: "weekly", weekday: r.digest_weekday, hour: r.digest_hour },
		},
	});
}
const preferenceRows = z.array(
	z.object({ category: z.string(), channel: z.string(), enabled: z.boolean(), cadence: z.string().nullable() }),
);
/** The account's notification choices: one statement for its revision, stored choices and organization seat. */
async function notifications(db: Reader, deps: SectionDependencies, accountId: string, email: string) {
	const [account] = await db
		.select({
			id: t.account.id,
			revision: t.account.revision,
			rows: sql`(SELECT coalesce(json_agg(json_build_object('category',p.category,'channel',p.channel,'enabled',p.enabled,'cadence',p.cadence)),'[]') FROM ${t.notification_preference} p WHERE p.account_id=${t.account.id})`,
			organization: sql<boolean>`EXISTS(SELECT FROM ${t.seat} s WHERE s.account_id=${t.account.id} AND s.ended_at IS NULL AND s.organization_id IS NOT NULL)`,
		})
		.from(t.account)
		.where(eq(t.account.id, accountId));
	if (!account) deny();
	const rows = preferenceRows.parse(account.rows);
	const categories = q.notificationCategory.options.filter((c) => c !== "oversight_digest" || account.organization);
	const choices = categories.flatMap((category) =>
		(category === "wiki_upstream_review" ? (["in_app"] as const) : (["email", "in_app"] as const)).map((channel) => ({
			category,
			channel,
			enabled:
				rows.find((r) => r.category === category && r.channel === channel)?.enabled ??
				!(category === "planter_digest" && channel === "in_app"),
		})),
	);
	const suppression = await deps.suppression(db, email);
	return q.sectionResult.parse({
		section: "notifications",
		accountId: account.id,
		revision: account.revision,
		values: {
			choices,
			planterCadence: rows.find((r) => r.category === "planter_digest")?.cadence ?? "weekly",
			oversightCadence: account.organization
				? (rows.find((r) => r.category === "oversight_digest")?.cadence ?? "weekly")
				: null,
			suppression,
		},
	});
}
export function sectionOperations(deps: SectionDependencies): Operations {
	/**
	 * One section as this viewer may see it, in one statement; notifications add the suppression lookup. The
	 * account's own sections belong to its account, every other section to the plant or organization of its seat.
	 */
	async function read(db: Reader, v: Viewer, r: q.GetSectionRequest): Promise<q.SectionResult> {
		const owner = v.actor.context.owner;
		switch (r.section) {
			case "account": {
				const [account] = await db.select().from(t.account).where(eq(t.account.id, v.actor.accountId));
				if (!account) deny();
				return accountValue({ account, principal: v.principal });
			}
			case "notifications":
				return notifications(db, deps, v.actor.accountId, v.principal.email);
			case "plant": {
				const [row] = await db
					.select()
					.from(t.plant)
					.where(eq(t.plant.id, administeredPlant(v, r.plant)));
				if (!row) deny();
				return plantValue(row, r.plant);
			}
			case "teams": {
				const [team] = await db
					.select()
					.from(t.team)
					.where(and(eq(t.team.id, r.teamId), eq(t.team.plant_id, administeredPlant(v, r.plant))));
				if (!team) deny();
				return q.sectionResult.parse({
					section: "teams",
					plant: r.plant,
					teamId: team.id,
					revision: team.revision,
					name: team.name,
				});
			}
			case "organization": {
				if (!sameOwner(owner, r.organization)) deny();
				const [row] = await db.select().from(t.organization).where(eq(t.organization.id, r.organization.id));
				if (!row) deny();
				return {
					section: "organization",
					values: profileValue({ ...row, revision: revisionValue.parse(row.revision) }, r.organization),
				};
			}
			case "affiliations": {
				// The plant sees its own choices (Owner and Admin) or that they choose (Member); the organization sees
				// what the plant shares with it.
				const side = sameOwner(owner, r.organization) ? "organization" : sameOwner(owner, r.plant) ? "plant" : deny();
				const [a] = await loadAffiliations(
					db,
					and(eq(t.affiliation.plant_id, r.plant.id), eq(t.affiliation.organization_id, r.organization.id))!,
				);
				if (!a || !active(a) || !sameOwner(pairOf(a).organization, r.organization)) deny();
				const base = {
					plant: r.plant,
					organization: r.organization,
					organizationDisplayName: a.organization_name,
					activeAffiliation: true,
				};
				return q.sectionResult.parse({
					section: "affiliations",
					values:
						side === "organization"
							? { view: "organization", ...base, availability: choices(a) }
							: administrator(v.actor)
								? { view: "plant_administration", ...base, consentRevision: a.consent_revision, choices: choices(a) }
								: { view: "plant_member", ...base },
				});
			}
		}
	}
	/**
	 * One section save. A church submission (`church`) carries up to three plant changes and is still one command:
	 * one plant update, one audit row naming every changed field, one request key.
	 */
	async function save(
		tx: Tx,
		ctx: WriteContext,
		raw: unknown,
		name: string = "settings.saveSection",
		church?: z.infer<typeof q.saveChurchRequest>,
	) {
		const v: q.SaveSectionRequest = church
			? {
					requestKey: church.requestKey,
					expectedRevision: church.expectedRevision,
					input: { section: "plant", plant: church.input.plant, change: church.input.changes[0]! },
				}
			: parse(q.saveSectionRequest, raw);
		const a = await actor(tx, ctx, "command");
		const i = v.input;
		if (i.section === "account" || i.section === "notifications") {
			if (ctx.selected.kind !== "account" || ctx.selected.id !== a.account.id) deny();
		} else if (i.section === "organization") {
			if (
				!sameOwner(ctx.selected, i.organization) ||
				a.identity.context.kind !== "seat" ||
				a.identity.context.role === "member"
			)
				deny();
		} else if (
			!sameOwner(ctx.selected, i.plant) ||
			ctx.selected.kind !== "plant" ||
			a.identity.context.kind !== "seat" ||
			a.identity.context.role === "member" ||
			!a.plant
		)
			deny();
		const c = await begin(tx, ctx, a.account.id, name, church ?? v);
		if (c.kind === "replay") {
			// Replay receipts never restore stale projections or bypass current scope.
			const old = q.savedSectionResult.parse(c.value);
			const current = await read(tx, { actor: a.identity, principal: a.principal }, requestFor(i));
			return q.savedSectionResult.parse({ ...old, current });
		}
		let changed = false;
		let current: q.SectionResult;
		const events: string[] = [];
		// The section's fields before and after, so the audit row can name what changed.
		let diff: { before: Record<string, unknown>; after: Record<string, unknown> } | null = null;
		switch (i.section) {
			case "account": {
				revision(v.expectedRevision, a.account.revision);
				changed = i.name !== a.principal.display_name;
				if (changed) {
					c.writes.push(
						sql`WITH changed_name AS MATERIALIZED (SELECT settings_update_name(${ctx.session}::uuid,${i.name})) UPDATE account SET revision=revision+1 FROM changed_name WHERE id=${a.account.id}::uuid`,
					);
				}
				diff = { before: { name: a.principal.display_name }, after: { name: i.name } };
				current = accountValue({
					...a,
					account: { ...a.account, revision: changed ? String(BigInt(a.account.revision) + 1n) : a.account.revision },
					principal: { ...a.principal, display_name: i.name },
				});
				break;
			}
			case "notifications": {
				revision(v.expectedRevision, a.account.revision);
				current = await notifications(tx, deps, a.account.id, a.principal.email);
				if (current.section !== "notifications") deny();
				const patch = i.patch;
				const values = current.values;
				const category =
					patch.kind === "channel"
						? patch.choice.category
						: patch.kind === "planter_cadence"
							? "planter_digest"
							: "oversight_digest";
				if (!current.values.choices.some((c) => c.category === category)) deny();
				if (patch.kind === "channel") {
					const choice = patch.choice;
					changed =
						current.values.choices.find((r) => r.category === category && r.channel === choice.channel)?.enabled !==
						choice.enabled;
					if (changed)
						c.writes.push(
							tx
								.insert(t.notification_preference)
								.values({
									account_id: a.account.id,
									category,
									channel: choice.channel,
									enabled: choice.enabled,
									unsubscribe_revision: "1",
								})
								.onConflictDoUpdate({
									target: [
										t.notification_preference.account_id,
										t.notification_preference.category,
										t.notification_preference.channel,
									],
									set: { enabled: choice.enabled, revision: sql`${t.notification_preference.revision}+1` },
								}),
						);
				} else {
					changed =
						(patch.kind === "planter_cadence" ? current.values.planterCadence : current.values.oversightCadence) !==
						patch.cadence;
					if (changed)
						c.writes.push(
							tx
								.insert(t.notification_preference)
								.values(
									(["email", "in_app"] as const).map((channel) => ({
										account_id: a.account.id,
										category,
										channel,
										enabled: values.choices.find((r) => r.category === category && r.channel === channel)!.enabled,
										cadence: patch.cadence,
										weekday: 0,
										hour: 16,
										unsubscribe_revision: "1",
									})),
								)
								.onConflictDoUpdate({
									target: [
										t.notification_preference.account_id,
										t.notification_preference.category,
										t.notification_preference.channel,
									],
									set: { cadence: patch.cadence, revision: sql`${t.notification_preference.revision}+1` },
								}),
						);
				}
				if (changed)
					c.writes.push(
						tx
							.update(t.account)
							.set({ revision: sql`${t.account.revision}+1` })
							.where(eq(t.account.id, a.account.id)),
					);
				const field = patch.kind === "channel" ? `${category}.${patch.choice.channel}` : `${category}.cadence`;
				diff = { before: { [field]: false }, after: { [field]: changed } };
				current = q.sectionResult.parse({
					...current,
					revision: changed ? String(BigInt(a.account.revision) + 1n) : a.account.revision,
					values: {
						...values,
						choices:
							patch.kind === "channel"
								? values.choices.map((choice) =>
										choice.category === patch.choice.category && choice.channel === patch.choice.channel
											? patch.choice
											: choice,
									)
								: values.choices,
						planterCadence: patch.kind === "planter_cadence" ? patch.cadence : values.planterCadence,
						oversightCadence: patch.kind === "oversight_cadence" ? patch.cadence : values.oversightCadence,
					},
				});
				break;
			}
			case "plant": {
				if (!a.plant) deny();
				const p = { plant: a.plant };
				revision(v.expectedRevision, p.plant.revision);
				const old = plantValue(p.plant, i.plant);
				if (old.section !== "plant") deny();
				const patch: Partial<typeof t.plant.$inferInsert> = Object.assign(
					{},
					...(church ? church.input.changes : [i.change]).map(plantPatch),
				);
				const next = plantValue(
					{
						...p.plant,
						...patch,
						revision: String(BigInt(p.plant.revision) + 1n),
						material_revision: String(BigInt(p.plant.material_revision) + 1n),
					},
					i.plant,
				);
				if (next.section !== "plant") deny();
				diff = { before: plantFields(old), after: plantFields(next) };
				changed = canonical(diff.before) !== canonical(diff.after);
				if (changed) {
					c.writes.push(
						tx
							.update(t.plant)
							.set({
								...patch,
								revision: sql`${t.plant.revision}+1`,
								material_revision: sql`${t.plant.material_revision}+1`,
							})
							.where(eq(t.plant.id, i.plant.id)),
					);
					await deps.effects.invalidate(tx, { owner: i.plant, revision: next.revision, operationId: c.id });
					if (canonical(old.values.digest) !== canonical(next.values.digest))
						await deps.effects.replan(tx, {
							owner: i.plant,
							revision: next.revision,
							operationId: c.id,
							kind: "digest",
						});
				}
				current = changed ? next : old;
				break;
			}
			case "teams": {
				const [team] = await tx
					.select()
					.from(t.team)
					.where(and(eq(t.team.id, i.teamId), eq(t.team.plant_id, i.plant.id)))
					.for("update");
				if (!team) deny();
				revision(v.expectedRevision, team.revision);
				changed = team.name !== i.name;
				diff = { before: { name: team.name }, after: { name: i.name } };
				if (changed)
					c.writes.push(
						tx
							.update(t.team)
							.set({ name: i.name, revision: sql`${t.team.revision}+1` })
							.where(eq(t.team.id, i.teamId)),
					);
				current = q.sectionResult.parse({
					section: "teams",
					plant: i.plant,
					teamId: i.teamId,
					revision: changed ? String(BigInt(team.revision) + 1n) : team.revision,
					name: i.name,
				});
				break;
			}
			case "organization": {
				try {
					const effect = await applyOrganizationProfile(
						tx,
						c,
						i.organization.id,
						i.patch,
						v.expectedRevision,
						a.organization ?? undefined,
					);
					changed = effect.changed;
					current = { section: "organization", values: effect.current };
					events.push(...effect.events);
				} catch (e) {
					if (e instanceof Error && e.message === "stale_revision") deny("conflict");
					throw e;
				}
				break;
			}
			case "affiliations": {
				const row = await loadAffiliation(tx, i.relationshipId, true);
				if (!row || row.plant_id !== i.plant.id || !sameOwner(pairOf(row).organization, i.organization) || !active(row))
					deny();
				revision(v.expectedRevision, row.revision);
				revision(i.expectedConsentRevision, row.consent_revision);
				const effect = await applySharingMutation(
					tx,
					row,
					c,
					q.applyAffiliationPatch(choices(row), i.patch),
					deps.organizationEffects,
				);
				changed = effect.changed;
				current = q.sectionResult.parse({
					section: "affiliations",
					values: {
						view: "plant_administration",
						plant: i.plant,
						organization: i.organization,
						organizationDisplayName: row.organization_name,
						activeAffiliation: true,
						consentRevision: effect.current.consent_revision,
						choices: choices(effect.current),
					},
				});
				events.push(...effect.events);
				break;
			}
		}
		if (changed && diff) {
			const id = await appendEvent(
				tx,
				c,
				i.section === "teams" ? i.teamId : ctx.selected.id,
				"preference",
				i.section === "plant" ? "plant.profile_changed" : "settings.changed",
				v.expectedRevision,
				String(BigInt(v.expectedRevision) + 1n),
			);
			auditChange(c, id, i.section, diff.before, diff.after);
			events.push(id);
		}
		return finish(tx, c, q.savedSectionResult, () => ({ current }));
	}
	const operations: Operations = {
		getSection: (db, viewer, raw) =>
			recover(async () => {
				if (!viewer.principal.verified) deny();
				const value = await read(
					db,
					{ actor: viewer.authority.actor, principal: viewer.principal },
					parse(q.getSectionRequest, raw),
				);
				return { status: "ok", value };
			}),
		saveSection: (tx, ctx, raw) => reply(tx, (s) => save(s, ctx, raw)),
		saveChurch: (tx, ctx, raw) =>
			reply(tx, (s) => save(s, ctx, null, "settings.saveChurch", parse(q.saveChurchRequest, raw))),
		updatePlantProfile: (tx, ctx, raw) =>
			reply(tx, (s) => {
				const v = parse(q.updatePlantProfileRequest, raw);
				return save(
					s,
					ctx,
					{
						...v,
						input: { section: "plant", plant: v.input.plant, change: { kind: "profile", patch: v.input.patch } },
					},
					"plant.updateProfile",
				);
			}),
		setDigestSchedule: (tx, ctx, raw) =>
			reply(tx, (s) => {
				const v = parse(q.setDigestScheduleRequest, raw);
				return save(
					s,
					ctx,
					{
						...v,
						input: { section: "plant", plant: v.input.plant, change: { kind: "digest", value: v.input.schedule } },
					},
					"plant.setDigestSchedule",
				);
			}),
	};
	return operations;
}
type Operations = Pick<
	SettingsProducer<Tx>,
	"saveSection" | "saveChurch" | "updatePlantProfile" | "setDigestSchedule"
> & {
	/** A section read on the pool with the request's verified viewer: no transaction and no second actor lookup. */
	getSection(db: Reader, viewer: SectionViewer, raw: unknown): Promise<SettingsReply<q.SectionResult>>;
};
/** The plant columns one church change sets. Fields the change leaves out keep their stored value. */
function plantPatch(change: q.PlantChange): Partial<typeof t.plant.$inferInsert> {
	switch (change.kind) {
		case "profile": {
			const v = change.patch;
			return {
				...(v.name !== undefined ? { name: v.name } : {}),
				...(v.street !== undefined ? { street: v.street } : {}),
				...(v.description !== undefined ? { description: v.description } : {}),
				...(v.city !== undefined ? { city: v.city } : {}),
				...(v.stateProvince !== undefined ? { state_province: v.stateProvince } : {}),
				...(v.country !== undefined ? { country: v.country } : {}),
			};
		}
		case "inactivity":
			return { warning_days: change.value.warningDays, alert_days: change.value.alertDays };
		case "digest": {
			const s = change.value;
			return {
				digest_cadence: s.cadence,
				...(s.cadence !== "off" ? { digest_hour: s.hour } : {}),
				...(s.cadence === "weekly" ? { digest_weekday: s.weekday } : {}),
			};
		}
	}
}
/** A church section as flat audit fields: the profile fields, the inactivity days and the digest schedule. */
function plantFields(section: Extract<q.SectionResult, { section: "plant" }>): Record<string, unknown> {
	const v = section.values;
	return { ...v.profile, warningDays: v.inactivity.warningDays, alertDays: v.inactivity.alertDays, digest: v.digest };
}
function requestFor(i: q.SaveSectionRequest["input"]): q.GetSectionRequest {
	switch (i.section) {
		case "account":
			return { section: "account" };
		case "notifications":
			return { section: "notifications" };
		case "plant":
			return { section: "plant", plant: i.plant };
		case "teams":
			return { section: "teams", plant: i.plant, teamId: i.teamId };
		case "organization":
			return { section: "organization", organization: i.organization };
		case "affiliations":
			return { section: "affiliations", plant: i.plant, organization: i.organization };
	}
}
