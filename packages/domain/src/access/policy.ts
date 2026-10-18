import * as tables from "@everyfield/db/tables";
import { and, eq, isNull, sql } from "@everyfield/db/query";
import "server-only";
import type { Transaction } from "@everyfield/db/client";
import type { z } from "zod";
import { sameOwner, type Owner, type sessionId, type Subject } from "@everyfield/contracts/common";
import {
	sharedOperationCheckRequest,
	operationCheckResult,
	type CurrentActorResult,
} from "@everyfield/contracts/access";
import { currentActor } from "./session.ts";
import { operationRegistry } from "./operations.generated.ts";

type ActiveActor = Extract<CurrentActorResult, { status: "active" }>;
// Registered server producers own narrower duties, consent, exact subject and
// output projection. A positive observation never grants a durable invocation.
export interface OperationPolicy {
	operation: keyof typeof operationRegistry;
	subjectKinds: readonly Subject["kind"][];
	authorize(
		tx: Transaction,
		actor: ActiveActor,
		subject: Subject,
		purpose: "native" | "model" | "export" | "organization_aggregate",
	): Promise<boolean>;
}
export const isAdministrator = (actor: ActiveActor) =>
	actor.context.kind === "seat" && ["owner", "admin"].includes(actor.context.role);

export function accessPolicies(policies: readonly OperationPolicy[]) {
	const byName = new Map<string, OperationPolicy>(policies.map((policy) => [policy.operation, policy]));
	if (byName.size !== policies.length) throw Error("duplicate_access_policy");
	return {
		async checkOperation(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner, raw: unknown) {
			const parsed = sharedOperationCheckRequest.safeParse(raw);
			const denied = operationCheckResult.parse({ status: "unavailable" });
			if (!parsed.success) return denied;
			const input = parsed.data;
			// Resolve kind and model eligibility from the generated catalog, never
			// a caller tag. A missing producer policy always denies.
			const policy = byName.get(input.operation);
			if (!policy) return denied;
			const registered = operationRegistry[policy.operation];
			if (
				registered.kind !== input.kind ||
				!policy.subjectKinds.includes(input.subject.kind) ||
				!sameOwner(selected, input.subject.owner)
			)
				return denied;
			if (input.kind === "read" && input.purpose === "model" && !registered.model) return denied;
			const actor = await currentActor(tx, session, selected);
			if (actor.status !== "active") return denied;
			if (
				policy.operation === "churches.requestWorkspaceDeletion" &&
				(selected.kind !== "plant" || actor.context.kind !== "seat" || actor.context.role !== "owner")
			)
				return denied;
			if (["private_week", "private_week_revision"].includes(input.subject.kind)) return denied;
			const record = await tx
				.select({ kind: tables.record.kind, tenant_id: tables.record.tenant_id })
				.from(tables.record)
				.where(eq(tables.record.id, input.subject.id));
			if (record.length !== 1 || record[0]!.kind !== input.subject.kind || record[0]!.tenant_id !== selected.id)
				return denied;
			// Identifiers are chosen only from the closed producer subjectKinds plus
			// the canonical C0 subject parser. Values always remain SQL parameters.
			const resource = await tx.execute<{ revision: string | null }>(
				sql`SELECT to_jsonb(r)->>'revision' AS revision FROM ${sql.identifier(input.subject.kind)} r WHERE id=${input.subject.id} FOR SHARE`,
			);
			if (
				resource.rows.length !== 1 ||
				(input.kind === "write" && resource.rows[0]!.revision !== input.expectedRevision)
			)
				return denied;
			const purpose = input.kind === "read" ? input.purpose : "native";
			if (!(await policy.authorize(tx, actor, input.subject, purpose))) return denied;
			return operationCheckResult.parse({ status: "allowed" });
		},
	};
}

// These operations share C1 administration. Their producers still own exact
// effect review, receipts, launch revisions and atomic writes.
export function plantAdministration(
	operation:
		| "plant.updateProfile"
		| "churches.requestWorkspaceDeletion"
		| "launch.addGuestAttendance"
		| "launch.saveDebriefDraft"
		| "launch.publishDebriefSummary",
	subjectKinds: OperationPolicy["subjectKinds"],
): OperationPolicy {
	return {
		operation,
		subjectKinds,
		async authorize(_tx, actor, subject) {
			return subject.owner.kind === "plant" && isAdministrator(actor);
		},
	};
}
export const ordinarySeatAdministration: OperationPolicy = {
	operation: "seats.changeOrdinaryRole",
	subjectKinds: ["seat"],
	async authorize(tx, actor, subject) {
		if (!isAdministrator(actor)) return false;
		const target = await tx
			.select({ role: tables.seat.role })
			.from(tables.seat)
			.where(
				and(
					and(
						eq(tables.seat.id, subject.id),
						eq(sql<string>`coalesce(${tables.seat.plant_id}, ${tables.seat.organization_id})`, subject.owner.id),
					),
					isNull(tables.seat.ended_at),
				),
			)
			.for("share");
		return target.length === 1 && ["admin", "member"].includes(target[0]!.role);
	},
};
