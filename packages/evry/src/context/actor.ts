import type { RequestActor } from "@everyfield/domain/access";
import type { Owner } from "@everyfield/contracts/common";

export type ContextKind = "account" | "plant" | "sending_church" | "sending_network";

export type EvryActor = {
	readonly authority: RequestActor;
	readonly accountId: string;
	readonly session: string;
	readonly owner: Exclude<Owner, { kind: "global" }>;
	readonly contextKind: ContextKind;
	readonly role: "owner" | "admin" | "member" | null;
	readonly seatId: string | null;
	readonly selfPersonId: string | null;
};

export function evryActor(authority: RequestActor): EvryActor {
	const { actor } = authority;
	const owner = actor.context.owner;
	return {
		authority,
		accountId: actor.accountId,
		session: authority.session,
		owner,
		contextKind: owner.kind === "organization" ? owner.organizationKind : owner.kind,
		role: actor.context.kind === "seat" ? actor.context.role : null,
		seatId: actor.context.kind === "seat" ? actor.context.seatId : null,
		selfPersonId: null,
	};
}

export function sameContext(a: EvryActor, b: EvryActor) {
	return a.accountId === b.accountId && a.owner.kind === b.owner.kind && a.owner.id === b.owner.id;
}
