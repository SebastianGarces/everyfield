import "server-only";
import * as t from "@everyfield/db/tables";
import { and, eq, isNull, sql } from "@everyfield/db/query";
import * as q from "@everyfield/contracts/settings";
import type { SettingsContext, SettingsProducer } from "@everyfield/contracts/settings/server";
import type { Transaction } from "@everyfield/db/client";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import {
	actor,
	self,
	plantAdmin,
	deny,
	parse,
	reply,
	revision,
	begin,
	finish,
	preference,
	sameOwner,
	canonical,
	appendEvent,
	type Tx,
	type Context,
	type WriteContext,
} from "./core.ts";
import { loadAffiliation, pairOf, choices, active, type OrganizationEffects } from "../organizations/core.ts";
import { applyOrganizationProfile } from "../organizations/profile.ts";
import { applySharingMutation } from "../organizations/sharing.ts";
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
	suppression(tx: Tx, email: string): Promise<"clear" | "suppressed" | "unavailable">;
}
export async function accountSection(tx: Tx, ctx: Context) {
	const a = await self(tx, ctx, "read");
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
export async function plantSection(
	tx: Tx,
	ctx: Context,
	p: Extract<q.GetSectionRequest, { section: "plant" }>["plant"],
) {
	const a = await plantAdmin(tx, ctx, p);
	const r = a.plant;
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
async function notifications(tx: Tx, ctx: Context, deps: SectionDependencies) {
	const a = await self(tx, ctx, "read");
	const rows = await tx
		.select()
		.from(t.notification_preference)
		.where(eq(t.notification_preference.account_id, a.account.id));
	const organization = await tx
		.select({ id: t.seat.id })
		.from(t.seat)
		.where(
			and(eq(t.seat.account_id, a.account.id), isNull(t.seat.ended_at), sql`${t.seat.organization_id} IS NOT NULL`),
		);
	const categories = q.notificationCategory.options.filter((c) => c !== "oversight_digest" || organization.length > 0);
	const choices = categories.flatMap((category) =>
		(category === "wiki_upstream_review" ? (["in_app"] as const) : (["email", "in_app"] as const)).map((channel) => ({
			category,
			channel,
			enabled:
				rows.find((r) => r.category === category && r.channel === channel)?.enabled ??
				!(category === "planter_digest" && channel === "in_app"),
		})),
	);
	const suppression = await deps.suppression(tx, a.principal.email);
	return q.sectionResult.parse({
		section: "notifications",
		accountId: a.account.id,
		revision: a.account.revision,
		values: {
			choices,
			planterCadence: rows.find((r) => r.category === "planter_digest")?.cadence ?? "weekly",
			oversightCadence: organization.length
				? (rows.find((r) => r.category === "oversight_digest")?.cadence ?? "weekly")
				: null,
			suppression,
		},
	});
}
export function sectionOperations(
	deps: SectionDependencies,
): Pick<SettingsProducer<Tx>, "getSection" | "saveSection" | "updatePlantProfile" | "setDigestSchedule"> {
	async function read(tx: Tx, ctx: SettingsContext, v: q.GetSectionRequest): Promise<q.SectionResult> {
		switch (v.section) {
			case "account":
				return accountSection(tx, ctx);
			case "notifications":
				return notifications(tx, ctx, deps);
			case "plant":
				return plantSection(tx, ctx, v.plant);
			case "teams": {
				await plantAdmin(tx, ctx, v.plant);
				const [team] = await tx
					.select()
					.from(t.team)
					.where(and(eq(t.team.id, v.teamId), eq(t.team.plant_id, v.plant.id)));
				if (!team) deny();
				return q.sectionResult.parse({
					section: "teams",
					plant: v.plant,
					teamId: team.id,
					revision: team.revision,
					name: team.name,
				});
			}
			case "organization": {
				await actor(tx, ctx);
				if (!sameOwner(ctx.selected, v.organization)) deny();
				const values = await deps.organizations["organizations.getProfile"](tx, ctx.session, ctx.selected, {
					organization: v.organization,
				});
				if (values.status !== "available") deny();
				return { section: "organization", values };
			}
			case "affiliations": {
				await actor(tx, ctx);
				const values = await deps.organizations["privacy.getSharing"](tx, ctx.session, ctx.selected, {
					plant: v.plant,
					organization: v.organization,
				});
				if ("status" in values) deny();
				return { section: "affiliations", values };
			}
		}
	}
	async function save(
		tx: Tx,
		ctx: WriteContext,
		raw: unknown,
		name: typeof t.effect.$inferInsert.kind = "settings.saveSection",
	) {
		const v = parse(q.saveSectionRequest, raw);
		const a = await actor(tx, ctx, "command");
		const i = v.input;
		if (i.section === "account" || i.section === "notifications") await self(tx, ctx);
		else if (i.section === "organization") {
			if (
				!sameOwner(ctx.selected, i.organization) ||
				a.identity.context.kind !== "seat" ||
				a.identity.context.role === "member"
			)
				deny();
		} else await plantAdmin(tx, ctx, i.plant, "command");
		const c = await begin(tx, ctx, a.account.id, name, v);
		if (c.kind === "replay") {
			// Replay receipts never restore stale projections or bypass current scope.
			const old = q.savedSectionResult.parse(c.value);
			const current = await read(tx, ctx, requestFor(i));
			return q.savedSectionResult.parse({ ...old, current });
		}
		let changed = false;
		const events: string[] = [];
		switch (i.section) {
			case "account": {
				revision(v.expectedRevision, a.account.revision);
				changed = i.name !== a.principal.display_name;
				if (changed) {
					await tx.execute(sql`SELECT settings_update_name(${ctx.session}::uuid,${i.name})`);
					await tx
						.update(t.account)
						.set({ revision: sql`${t.account.revision}+1` })
						.where(eq(t.account.id, a.account.id));
				}
				break;
			}
			case "notifications": {
				revision(v.expectedRevision, a.account.revision);
				const current = await notifications(tx, ctx, deps);
				if (current.section !== "notifications") deny();
				const patch = i.patch;
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
						await tx
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
							});
				} else {
					changed =
						(patch.kind === "planter_cadence" ? current.values.planterCadence : current.values.oversightCadence) !==
						patch.cadence;
					if (changed)
						for (const channel of ["email", "in_app"] as const)
							await tx
								.insert(t.notification_preference)
								.values({
									account_id: a.account.id,
									category,
									channel,
									enabled: current.values.choices.find((r) => r.category === category && r.channel === channel)!
										.enabled,
									cadence: patch.cadence,
									weekday: 0,
									hour: 16,
									unsubscribe_revision: "1",
								})
								.onConflictDoUpdate({
									target: [
										t.notification_preference.account_id,
										t.notification_preference.category,
										t.notification_preference.channel,
									],
									set: { cadence: patch.cadence, revision: sql`${t.notification_preference.revision}+1` },
								});
				}
				if (changed)
					await tx
						.update(t.account)
						.set({ revision: sql`${t.account.revision}+1` })
						.where(eq(t.account.id, a.account.id));
				break;
			}
			case "plant": {
				const p = await plantAdmin(tx, ctx, i.plant, "command");
				revision(v.expectedRevision, p.plant.revision);
				const old = await plantSection(tx, ctx, i.plant);
				if (old.section !== "plant") deny();
				let patch: Partial<typeof t.plant.$inferInsert> = {};
				if (i.change.kind === "profile") {
					const v = i.change.patch;
					patch = {
						...(v.name !== undefined ? { name: v.name } : {}),
						...(v.street !== undefined ? { street: v.street } : {}),
						...(v.description !== undefined ? { description: v.description } : {}),
						...(v.city !== undefined ? { city: v.city } : {}),
						...(v.stateProvince !== undefined ? { state_province: v.stateProvince } : {}),
						...(v.country !== undefined ? { country: v.country } : {}),
					};
					changed = Object.entries(v).some(([k, value]) => Reflect.get(old.values.profile, k) !== value);
				} else if (i.change.kind === "inactivity") {
					patch = { warning_days: i.change.value.warningDays, alert_days: i.change.value.alertDays };
					changed = canonical(old.values.inactivity) !== canonical(i.change.value);
				} else {
					const s = i.change.value;
					patch = {
						digest_cadence: s.cadence,
						...(s.cadence !== "off" ? { digest_hour: s.hour } : {}),
						...(s.cadence === "weekly" ? { digest_weekday: s.weekday } : {}),
					};
					changed = canonical(old.values.digest) !== canonical(s);
				}
				if (changed) {
					await tx
						.update(t.plant)
						.set({
							...patch,
							revision: sql`${t.plant.revision}+1`,
							material_revision: sql`${t.plant.material_revision}+1`,
						})
						.where(eq(t.plant.id, i.plant.id));
					const next = String(BigInt(p.plant.revision) + 1n);
					await deps.effects.invalidate(tx, { owner: i.plant, revision: next, operationId: c.id });
					if (i.change.kind === "digest")
						await deps.effects.replan(tx, { owner: i.plant, revision: next, operationId: c.id, kind: "digest" });
				}
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
				if (changed)
					await tx
						.update(t.team)
						.set({ name: i.name, revision: sql`${t.team.revision}+1` })
						.where(eq(t.team.id, i.teamId));
				break;
			}
			case "organization": {
				try {
					const effect = await applyOrganizationProfile(tx, c, i.organization.id, i.patch, v.expectedRevision);
					changed = effect.changed;
					events.push(...effect.events);
				} catch (e) {
					if (e instanceof Error && e.message === "stale_revision") deny("conflict");
					throw e;
				}
				break;
			}
			case "affiliations": {
				const row = await loadAffiliation(tx, i.relationshipId, true);
				if (
					!row ||
					row.plant_id !== i.plant.id ||
					!sameOwner(pairOf(row).organization, i.organization) ||
					!(await active(tx, row))
				)
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
				events.push(...effect.events);
				break;
			}
		}
		if (changed && i.section !== "affiliations" && i.section !== "organization")
			events.push(
				await appendEvent(
					tx,
					c,
					i.section === "teams" ? i.teamId : ctx.selected.id,
					"preference",
					"settings.changed",
					v.expectedRevision,
					String(BigInt(v.expectedRevision) + 1n),
				),
			);
		const current = await read(tx, ctx, requestFor(i));
		return finish(tx, c, q.savedSectionResult, events, (r) => ({ receipt: r, current }), changed);
	}
	const operations: Pick<
		SettingsProducer<Tx>,
		"getSection" | "saveSection" | "updatePlantProfile" | "setDigestSchedule"
	> = {
		getSection: (tx, ctx, raw) => reply(tx, (s) => read(s, ctx, parse(q.getSectionRequest, raw))),
		saveSection: (tx, ctx, raw) => reply(tx, (s) => save(s, ctx, raw)),
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
