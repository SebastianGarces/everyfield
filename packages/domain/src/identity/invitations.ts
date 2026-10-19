import "server-only";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import type { Database, Transaction } from "@everyfield/db/client";
import { and, asc, eq, gt, isNull, lte, or, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import type { Owner, Receipt } from "@everyfield/contracts/common";
import type { AccountPersonProducer } from "@everyfield/contracts/people";
import * as c from "@everyfield/contracts/identity";
import { z } from "zod";
import { transaction } from "./budget.ts";
import * as d from "./invitation-core.ts";
export interface InvitationMail {
	owner: Owner;
	invitationId: string;
	operationId: string;
	recipientEmail: string;
	recipientAccountId: string | null;
	purpose: "seat_invitation" | "relationship_invitation" | "relationship_receipt";
	logicalKey: string;
	subject: string;
	text: string;
}
export interface InvitationConfig {
	db: Database;
	origin: string;
	budgetSecret: string;
	enqueueMail(tx: Transaction, input: InvitationMail): Promise<string>;
	people: Pick<AccountPersonProducer<Transaction>, "ensureAccountPerson">;
}
export function createInvitationService(config: InvitationConfig) {
	const origin = new URL(config.origin).origin;
	if (origin !== config.origin) throw Error("canonical_origin_required");
	const addressHash = (s: string) => createHmac("sha256", config.budgetSecret).update(s).digest("hex");
	async function enqueue(tx: Transaction, cmd: d.Command, input: InvitationMail) {
		const mailId = await config.enqueueMail(tx, input),
			id = randomUUID();
		await tx.insert(t.effect).values({
			id,
			tenant_id: input.owner.id,
			operation_id: cmd.id,
			effect_key: input.logicalKey,
			kind: "mail.sendTransactional",
			target_record_id: input.invitationId,
			payload_hash: d.hash(input.logicalKey),
			state: "unstarted",
			result_record_id: mailId,
			arguments: { mailId },
		});
		return id;
	}
	async function description(tx: Transaction, i: d.Invitation) {
		const { selected, name } = await d.workspace(tx, i.tenant_id);
		return c.pendingInvitation.parse({
			status: "pending",
			invitationId: i.id,
			subject:
				i.purpose === "seat"
					? { purpose: "seat", workspace: selected, role: i.role }
					: { purpose: "residency_link", organization: selected, personId: i.resident_person_id },
			revision: i.revision,
			inviterDescription: i.inviter_description,
			workspaceName: name,
			expiresAt: d.expires(i).toISOString(),
			recipientEmail: i.recipient_email,
			resendAvailableAt: new Date((i.resent_at ?? i.created_at).getTime() + 60000).toISOString(),
		});
	}
	async function mail(tx: Transaction, i: d.Invitation, cmd: d.Command, proof: string) {
		const { selected, name } = await d.workspace(tx, i.tenant_id),
			url = new URL("/invitation", origin);
		// The proof travels in the fragment, which browsers never send, so no request address, log or trace holds it
		// (ruling D54).
		url.hash = new URLSearchParams({ proof }).toString();
		return enqueue(tx, cmd, {
			owner: selected,
			invitationId: i.id,
			operationId: cmd.id,
			recipientEmail: i.recipient_email,
			recipientAccountId: null,
			purpose: i.purpose === "seat" ? "seat_invitation" : "relationship_invitation",
			logicalKey: `invitation/${i.id}/${i.revision}`,
			subject: "Your EveryField invitation",
			text:
				i.purpose === "seat"
					? `${i.inviter_description} invited you to join ${name} as ${i.role === "admin" ? "an Admin" : "a Member"}.\n\nReview the invitation: ${url.href}\n\nExpires ${d.expires(i).toISOString()}.`
					: `${i.inviter_description} invited you to link your account to ${name}. You can accept or decline. This link does not add a workspace seat.\n\nReview the invitation: ${url.href}\n\nExpires ${d.expires(i).toISOString()}.`,
		});
	}
	async function activePerson(tx: Transaction, organization: string, id: string) {
		const [p] = await tx
			.select()
			.from(t.person)
			.where(
				and(
					eq(t.person.id, id),
					eq(t.person.tenant_id, organization),
					eq(t.person.organization_id, organization),
					isNull(t.person.plant_id),
					eq(t.person.state, "live"),
				),
			)
			.for("update");
		const removed = await tx
			.select({ id: t.organization_person_removal.id })
			.from(t.organization_person_removal)
			.where(
				and(
					eq(t.organization_person_removal.person_record_id, id),
					eq(t.organization_person_removal.organization_id, organization),
				),
			)
			.for("share");
		if (!p || removed.length) d.refuse();
		return p;
	}
	// Person lifecycle writers lock the Person before its invitation rows.
	async function lockSourcePerson(
		tx: Transaction,
		source: Pick<d.Invitation, "purpose" | "tenant_id" | "resident_person_id">,
	) {
		if (source.purpose === "residency_link" && source.resident_person_id)
			await tx
				.select({ id: t.person.id })
				.from(t.person)
				.where(and(eq(t.person.id, source.resident_person_id), eq(t.person.tenant_id, source.tenant_id)))
				.for("update");
	}
	async function charge(tx: Transaction, selected: Owner, email: string, kind: "seat_invite" | "relationship_invite") {
		const h = addressHash(email);
		await d.lock(tx, "invitation-budget/" + selected.id + "/" + h);
		await tx
			.update(t.invitation)
			.set({ state: "expired", revision: sql`${t.invitation.revision}+1` })
			.where(
				and(
					eq(t.invitation.tenant_id, selected.id),
					eq(t.invitation.recipient_email, email),
					eq(t.invitation.state, "pending"),
					lte(t.invitation.created_at, sql`clock_timestamp()-interval '720 hours'`),
				),
			);
		const [count] = await tx
			.select({
				n: sql<number>`count(*)::int`,
				retry: sql<Date>`min(${t.admission_attempt.reserved_at})+interval '720 hours'`.mapWith(
					(v: string) => new Date(v),
				),
			})
			.from(t.admission_attempt)
			.where(
				and(
					eq(t.admission_attempt.kind, kind),
					eq(t.admission_attempt.workspace_key, selected.id),
					eq(t.admission_attempt.identifier_hash, h),
					gt(t.admission_attempt.reserved_at, sql`clock_timestamp()-interval '720 hours'`),
				),
			);
		if (count && count.n >= 3) d.refuse("invitation_rate_limited", count.retry.toISOString());
		await tx.insert(t.admission_attempt).values({
			kind,
			identifier_hash: h,
			workspace_key: selected.id,
			reserved_at: sql`clock_timestamp()`,
			state: "counted",
			expires_at: sql`clock_timestamp()+interval '720 hours'`,
		});
	}
	async function invite(session: string, raw: unknown, resident = false) {
		const v = resident ? c.inviteResidentRequest.parse(raw) : c.inviteSeatRequest.parse(raw),
			selected = "workspace" in v.input ? v.input.workspace : v.input.organization;
		return transaction(config.db, async (tx) => {
			await d.lock(tx, "workspace-seats/" + selected.id);
			const inviter = await d.identity(tx, session),
				a = await d.administer(tx, session, selected),
				cmd = await d.begin(tx, selected, a.accountId, resident ? "residency.invite" : "seats.invite", v);
			if (cmd.kind === "replay") return c.invitationSentResult.parse(cmd.result);
			const [root] =
				selected.kind === "plant"
					? await tx
							.select({ revision: t.plant.revision })
							.from(t.plant)
							.where(eq(t.plant.id, selected.id))
							.for("update")
					: await tx
							.select({ revision: t.organization.revision })
							.from(t.organization)
							.where(eq(t.organization.id, selected.id))
							.for("update");
			if (root?.revision !== v.expectedRevision) d.refuse("conflict");
			if ("personId" in v.input && (await activePerson(tx, selected.id, v.input.personId)).linked_account_id)
				d.refuse();
			await charge(tx, selected, v.input.recipientEmail, resident ? "relationship_invite" : "seat_invite");
			const duplicate = await tx
				.select({ id: t.invitation.id })
				.from(t.invitation)
				.where(
					and(
						eq(t.invitation.tenant_id, selected.id),
						eq(t.invitation.recipient_email, v.input.recipientEmail),
						eq(t.invitation.state, "pending"),
					),
				);
			if (duplicate.length) d.refuse();
			const proof = randomBytes(32).toString("base64url"),
				id = randomUUID();
			await tx.insert(t.invitation).values({
				id,
				tenant_id: selected.id,
				purpose: resident ? "residency_link" : "seat",
				recipient_email: v.input.recipientEmail,
				inviter_id: a.accountId,
				role: "role" in v.input ? v.input.role : null,
				token_hash: d.hash(proof),
				state: "pending",
				created_at: sql`clock_timestamp()`,
				resident_person_id: "personId" in v.input ? v.input.personId : null,
				inviter_description: inviter.display_name.slice(0, 500),
			});
			const i = await d.load(tx, id),
				effect = await mail(tx, i, cmd, proof),
				event = await d.event(tx, cmd, id, "create", null, "0", "1"),
				invitation = await description(tx, i);
			return d.finish(tx, cmd, (r) => c.invitationSentResult.parse({ invitation, receipt: r }), [event], [effect]);
		});
	}
	async function list(session: string, raw: unknown) {
		const v = c.listInvitationsRequest.parse(raw);
		return transaction(config.db, async (tx) => {
			await d.administer(tx, session, v.workspace);
			const rows = await tx
				.select()
				.from(t.invitation)
				.where(
					and(
						eq(t.invitation.tenant_id, v.workspace.id),
						or(eq(t.invitation.purpose, "seat"), eq(t.invitation.purpose, "residency_link")),
						eq(t.invitation.state, "pending"),
						gt(t.invitation.created_at, sql`clock_timestamp()-interval '720 hours'`),
						v.after ? gt(t.invitation.id, v.after) : undefined,
					),
				)
				.orderBy(asc(t.invitation.id))
				.limit(101);
			const items = [];
			for (const i of rows.slice(0, 100)) items.push(await description(tx, i));
			return c.invitationListResult.parse({
				workspace: v.workspace,
				items,
				next: rows.length > 100 ? items.at(-1)!.invitationId : null,
				completeness: rows.length > 100 ? "partial" : "complete",
			});
		});
	}
	async function describe(raw: unknown) {
		const v = c.describeInvitationRequest.parse(raw);
		return transaction(config.db, async (tx) => {
			const [observed] = await tx
				.select()
				.from(t.invitation)
				.where(
					and(
						eq(t.invitation.token_hash, d.hash(v.proof)),
						or(eq(t.invitation.purpose, "seat"), eq(t.invitation.purpose, "residency_link")),
						eq(t.invitation.state, "pending"),
						gt(t.invitation.created_at, sql`clock_timestamp()-interval '720 hours'`),
					),
				);
			if (!observed) return c.invitationDescriptionResult.parse({ status: "unavailable" });
			await lockSourcePerson(tx, observed);
			const i = await d.load(tx, observed.id);
			await d.pending(tx, i);
			if (i.token_hash !== d.hash(v.proof) || i.resident_person_id !== observed.resident_person_id) d.refuse();
			if (i.purpose === "residency_link") await activePerson(tx, i.tenant_id, i.resident_person_id!);
			const p = await description(tx, i);
			return c.invitationDescriptionResult.parse({
				status: p.status,
				invitationId: p.invitationId,
				subject: p.subject,
				revision: p.revision,
				inviterDescription: p.inviterDescription,
				workspaceName: p.workspaceName,
				expiresAt: p.expiresAt,
			});
		}).catch((e) => {
			if (e instanceof d.InvitationRefusal) return c.invitationDescriptionResult.parse({ status: "unavailable" });
			throw e;
		});
	}
	async function change(session: string, raw: unknown, resend: boolean) {
		const v = (resend ? c.resendInvitationRequest : c.revokeInvitationRequest).parse(raw);
		return transaction(config.db, async (tx) => {
			// Read only the owner key first; the source is locked after current actor proof.
			const [source] = await tx
				.select({
					tenant_id: t.invitation.tenant_id,
					purpose: t.invitation.purpose,
					resident_person_id: t.invitation.resident_person_id,
				})
				.from(t.invitation)
				.where(eq(t.invitation.id, v.input.invitationId));
			if (!source) d.refuse();
			await d.lock(tx, "workspace-seats/" + source.tenant_id);
			const { selected } = await d.workspace(tx, source.tenant_id),
				a = await d.administer(tx, session, selected);
			await lockSourcePerson(tx, source);
			const i = await d.load(tx, v.input.invitationId),
				cmd = await d.begin(tx, selected, a.accountId, resend ? "seats.resendInvitation" : "seats.revokeInvitation", v);
			if (cmd.kind === "replay")
				return resend ? c.invitationSentResult.parse(cmd.result) : c.invitationRevokedResult.parse(cmd.result);
			await d.pending(tx, i, v.expectedRevision);
			if (resend && i.purpose === "residency_link") await activePerson(tx, i.tenant_id, i.resident_person_id!);
			const after = d.bump(i.revision);
			let effects: string[] = [];
			if (resend) {
				const retry = new Date((i.resent_at ?? i.created_at).getTime() + 60000);
				if (retry > (await d.now(tx))) d.refuse("invitation_cooldown", retry.toISOString());
				const proof = randomBytes(32).toString("base64url");
				await tx
					.update(t.invitation)
					.set({ token_hash: d.hash(proof), resent_at: sql`clock_timestamp()`, revision: after })
					.where(eq(t.invitation.id, i.id));
				effects = [await mail(tx, await d.load(tx, i.id), cmd, proof)];
			} else
				await tx
					.update(t.invitation)
					.set({ state: "revoked", acted_at: sql`clock_timestamp()`, revision: after })
					.where(eq(t.invitation.id, i.id));
			const e = await d.event(
					tx,
					cmd,
					i.id,
					resend ? "resend" : "revoke",
					resend ? null : "invitation.revoked",
					i.revision,
					after,
				),
				invitation = await description(tx, await d.load(tx, i.id));
			return d.finish(
				tx,
				cmd,
				(r) =>
					resend
						? c.invitationSentResult.parse({ invitation, receipt: r })
						: c.invitationRevokedResult.parse({ status: "revoked", invitationId: i.id, revision: after, receipt: r }),
				[e],
				effects,
			);
		});
	}
	async function accept(session: string, raw: unknown, resident = false) {
		const v = resident ? c.respondResidentInvitationRequest.parse(raw) : c.acceptSeatInvitationRequest.parse(raw);
		return transaction(config.db, async (tx) => {
			const [source] = await tx
				.select({
					tenant_id: t.invitation.tenant_id,
					purpose: t.invitation.purpose,
					resident_person_id: t.invitation.resident_person_id,
				})
				.from(t.invitation)
				.where(eq(t.invitation.id, v.input.invitationId));
			if (!source) d.refuse();
			await d.lock(tx, "workspace-seats/" + source.tenant_id);
			const a = await d.identity(tx, session);
			if (!a.verified) d.refuse();
			await lockSourcePerson(tx, source);
			const i = await d.load(tx, v.input.invitationId),
				{ selected } = await d.workspace(tx, i.tenant_id);
			if (
				i.resident_person_id !== source.resident_person_id ||
				i.purpose !== (resident ? "residency_link" : "seat") ||
				i.token_hash !== d.hash(v.input.proof) ||
				i.recipient_email !== a.email
			)
				d.refuse();
			if (resident && selected.kind !== "organization") d.refuse();
			const cmd = await d.begin(
				tx,
				selected,
				a.account_id,
				resident ? "residency.respondInvitation" : "seats.acceptInvitation",
				v,
			);
			if (cmd.kind === "replay")
				return resident
					? c.residentInvitationDecisionResult.parse(cmd.result)
					: c.seatInvitationAcceptedResult.parse(cmd.result);
			await d.pending(tx, i, v.expectedRevision);
			const events: string[] = [],
				effects: string[] = [],
				after = d.bump(i.revision);
			let result: (r: Receipt) => unknown;
			if (resident) {
				const p = await activePerson(tx, selected.id, i.resident_person_id!);
				if (p.linked_account_id !== null && p.linked_account_id !== a.account_id) d.refuse();
				const decision = c.respondResidentInvitationRequest.parse(raw).input;
				if (decision.decision === "decline") {
					await tx
						.update(t.invitation)
						.set({
							state: "declined",
							acted_at: sql`clock_timestamp()`,
							accepted_account_id: a.account_id,
							revision: after,
						})
						.where(eq(t.invitation.id, i.id));
					result = (r) =>
						c.residentInvitationDecisionResult.parse({ status: "declined", invitationId: i.id, receipt: r });
				} else {
					const competing = await tx
						.select({ id: t.residency_link.id })
						.from(t.residency_link)
						.where(
							and(
								eq(t.residency_link.organization_id, selected.id),
								or(eq(t.residency_link.account_id, a.account_id), eq(t.residency_link.person_id, p.id)),
								isNull(t.residency_link.ended_at),
							),
						);
					if (competing.length) d.refuse();
					let [affiliation] = await tx
						.select()
						.from(t.affiliation)
						.where(and(eq(t.affiliation.organization_id, selected.id), eq(t.affiliation.account_id, a.account_id)))
						.for("update", { noWait: true });
					if (affiliation?.ended_at) d.refuse();
					if (!affiliation) {
						[affiliation] = await tx
							.insert(t.affiliation)
							.values({
								account_id: a.account_id,
								organization_id: selected.id,
								accepted_at: sql`clock_timestamp()`,
								invitation_id: i.id,
								share_people: false,
								share_meetings: false,
								share_tasks: false,
								share_ministry_teams: false,
								share_wiki: false,
								share_activity: false,
								shared_findings: false,
							})
							.returning();
					}
					if (!affiliation) throw Error("affiliation_unavailable");
					const blocked = await tx
						.select({ id: t.lifecycle_witness.id })
						.from(t.lifecycle_witness)
						.where(
							and(
								eq(t.lifecycle_witness.affiliation_id, affiliation.id),
								sql`${t.lifecycle_witness.state} NOT IN ('active','cancelled')`,
							),
						)
						.for("share");
					if (blocked.length) d.refuse();
					const id = randomUUID(),
						choices = decision.choices;
					await tx
						.update(t.person)
						.set({ linked_account_id: a.account_id, revision: d.bump(p.revision) })
						.where(eq(t.person.id, p.id));
					await tx.insert(t.residency_link).values({
						id,
						organization_id: selected.id,
						person_id: p.id,
						account_id: a.account_id,
						affiliation_id: affiliation.id,
						invitation_id: i.id,
						accepted_at: sql`clock_timestamp()`,
						consent_revision: "1",
						share_foundations: choices.shareFoundations,
						share_milestones: choices.shareMilestones,
						revision: "1",
					});
					await tx
						.update(t.invitation)
						.set({
							state: "accepted",
							acted_at: sql`clock_timestamp()`,
							accepted_account_id: a.account_id,
							revision: after,
						})
						.where(eq(t.invitation.id, i.id));
					events.push(await d.event(tx, cmd, p.id, "edit", "people.updated", p.revision, d.bump(p.revision)));
					result = (r) =>
						c.residentInvitationDecisionResult.parse({
							status: "accepted",
							invitationId: i.id,
							linkId: id,
							organization: selected,
							personId: p.id,
							consentRevision: "1",
							choices,
							receipt: r,
						});
				}
			} else {
				if (!i.role || (selected.kind !== "plant" && selected.kind !== "organization")) d.refuse();
				const seats = await tx
					.select({ id: t.seat.id })
					.from(t.seat)
					.where(and(eq(t.seat.account_id, a.account_id), isNull(t.seat.ended_at)))
					.for("update");
				if (seats.length) d.refuse();
				const associations = await tx
					.select({ id: t.affiliation.id })
					.from(t.affiliation)
					.where(and(eq(t.affiliation.account_id, a.account_id), isNull(t.affiliation.ended_at)))
					.for("update");
				if (associations.length) d.refuse();
				const id = randomUUID();
				await tx.insert(t.seat).values({
					id,
					account_id: a.account_id,
					plant_id: selected.kind === "plant" ? selected.id : null,
					organization_id: selected.kind === "organization" ? selected.id : null,
					role: i.role,
					accepted_at: sql`clock_timestamp()`,
					invitation_id: i.id,
				});
				let seat: unknown = { kind: "organization", workspace: selected, seatId: id, role: i.role };
				if (selected.kind === "plant") {
					const linked = await config.people.ensureAccountPerson(tx, {
						accountId: a.account_id,
						owner: selected,
						selection: { kind: "create", displayName: a.display_name },
					});
					if (linked.status !== "ok" || linked.value.status !== "linked") d.refuse();
					seat = { kind: "plant", workspace: selected, seatId: id, role: i.role, personId: linked.value.personId };
				}
				await tx
					.update(t.invitation)
					.set({
						state: "accepted",
						acted_at: sql`clock_timestamp()`,
						accepted_account_id: a.account_id,
						revision: after,
					})
					.where(eq(t.invitation.id, i.id));
				events.push(await d.event(tx, cmd, id, "create", "membership.created", "0", "1"));
				result = (r) =>
					c.seatInvitationAcceptedResult.parse({
						status: "accepted",
						invitationId: i.id,
						accountId: a.account_id,
						registrationState: "active",
						seat,
						receipt: r,
					});
			}
			const declined = "decision" in v.input && v.input.decision === "decline";
			if (!declined) {
				await tx
					.update(t.account)
					.set({
						registration_state: "active",
						registration_digest: d.hash(i.id),
						revision: sql`${t.account.revision}+1`,
					})
					.where(eq(t.account.id, a.account_id));
				await tx.insert(t.event).values({
					tenant_id: a.account_id,
					target_record_id: a.account_id,
					actor_id: a.account_id,
					kind: "accept",
					action: "identity.domain_accepted",
					occurred_at: sql`clock_timestamp()`,
					recorded_at: sql`clock_timestamp()`,
					event_key: cmd.id,
				});
				effects.push(
					await enqueue(tx, cmd, {
						owner: selected,
						invitationId: i.id,
						operationId: cmd.id,
						recipientEmail: a.email,
						recipientAccountId: a.account_id,
						purpose: "relationship_receipt",
						logicalKey: `invitation-accepted/${i.id}`,
						subject: "Your invitation was accepted",
						text: resident
							? "You accepted an invitation to link your EveryField account. This link does not add a workspace seat. Sign in to review your sharing choices."
							: "You accepted an invitation to join an EveryField workspace. Sign in to review your membership. If this was not you, review your account security.",
					}),
				);
			}
			events.push(await d.event(tx, cmd, i.id, "accept", declined ? null : "invitation.claimed", i.revision, after));
			return d.finish(tx, cmd, result, events, effects);
		}).catch((error) => {
			// Organization relationship writers also own this existing affiliation. A
			// contended lock must refuse before grants rather than reverse their lock order.
			const storage = z.object({ cause: z.object({ code: z.string() }) }).safeParse(error);
			if (storage.success && storage.data.cause.code === "55P03") d.refuse("temporary");
			throw error;
		});
	}
	async function registrationEligible(proof: string, email: string) {
		const [i] = await config.db
			.select({ id: t.invitation.id })
			.from(t.invitation)
			.where(
				and(
					eq(t.invitation.token_hash, d.hash(proof)),
					eq(t.invitation.recipient_email, c.normalizedEmail.parse(email)),
					eq(t.invitation.state, "pending"),
					gt(t.invitation.created_at, sql`clock_timestamp()-interval '720 hours'`),
					or(eq(t.invitation.purpose, "seat"), eq(t.invitation.purpose, "residency_link")),
				),
			);
		return !!i && (await describe({ proof })).status === "pending";
	}
	async function resume(session: string, proof: string, requestKey: string) {
		const [i] = await config.db
			.select({ id: t.invitation.id, revision: t.invitation.revision, state: t.invitation.state })
			.from(t.invitation)
			.where(and(eq(t.invitation.token_hash, d.hash(proof)), eq(t.invitation.purpose, "seat")));
		if (!i) d.refuse();
		return accept(session, {
			requestKey,
			expectedRevision: i.state === "accepted" ? (BigInt(i.revision) - 1n).toString() : i.revision,
			input: { invitationId: i.id, proof },
		});
	}
	return {
		registrationEligible,
		resume,
		invite: (s: string, v: unknown) => invite(s, v),
		inviteResident: (s: string, v: unknown) => invite(s, v, true),
		list,
		describe,
		resend: (s: string, v: unknown) => change(s, v, true),
		revoke: (s: string, v: unknown) => change(s, v, false),
		accept: (s: string, v: unknown) => accept(s, v),
		respondResident: (s: string, v: unknown) => accept(s, v, true),
	};
}
