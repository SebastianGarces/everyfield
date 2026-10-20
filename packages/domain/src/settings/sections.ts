import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import * as q from "@everyfield/contracts/settings";
import type { SettingsContext, SettingsProducer } from "@everyfield/contracts/settings/server";
import type { Transaction } from "@everyfield/db/client";
import { and, eq, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import "server-only";
import { active, choices, loadAffiliation, pairOf, type OrganizationEffects } from "../organizations/core.ts";
import { applyOrganizationProfile } from "../organizations/profile.ts";
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
	plantAdmin,
	preference,
	reply,
	revision,
	sameOwner,
	self,
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
	suppression(tx: Tx, email: string): Promise<"clear" | "suppressed" | "unavailable">;
}
export async function accountSection(tx: Tx, ctx: Context) {
	const a = await self(tx, ctx, "read");
	return accountValue(a);
}
function accountValue(a: Pick<Awaited<ReturnType<typeof actor>>, "account" | "principal">) {
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
	return plantValue(a.plant, p);
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
async function notifications(
	tx: Tx,
	ctx: Context,
	deps: SectionDependencies,
	snapshot?: Awaited<ReturnType<typeof actor>>,
) {
	const a = snapshot ?? (await self(tx, ctx, "read"));
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
	async function save(tx: Tx, ctx: WriteContext, raw: unknown, name: string = "settings.saveSection") {
		const v = parse(q.saveSectionRequest, raw);
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
		const c = await begin(tx, ctx, a.account.id, name, v);
		if (c.kind === "replay") {
			// Replay receipts never restore stale projections or bypass current scope.
			const old = q.savedSectionResult.parse(c.value);
			const current = await read(tx, ctx, requestFor(i));
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
				current = await notifications(tx, ctx, deps, a);
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
				// a.plant is the row as it was when this transaction bound the actor. A later change of the same church
				// save (one transaction) expects the revision the earlier change wrote, so read the row again then.
				const [row] =
					v.expectedRevision === a.plant.revision
						? [a.plant]
						: await tx.select().from(t.plant).where(eq(t.plant.id, a.plant.id));
				if (!row) deny();
				const p = { plant: row };
				revision(v.expectedRevision, p.plant.revision);
				const old = plantValue(p.plant, i.plant);
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
					current = plantValue(
						{
							...p.plant,
							...patch,
							revision: String(BigInt(p.plant.revision) + 1n),
							material_revision: String(BigInt(p.plant.material_revision) + 1n),
						},
						i.plant,
					);
					if (current.section === "plant" && old.section === "plant")
						diff = { before: plantFields(old), after: plantFields(current) };
					const next = String(BigInt(p.plant.revision) + 1n);
					await deps.effects.invalidate(tx, { owner: i.plant, revision: next, operationId: c.id });
					if (i.change.kind === "digest")
						await deps.effects.replan(tx, { owner: i.plant, revision: next, operationId: c.id, kind: "digest" });
				}
				if (!changed) current = old;
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
