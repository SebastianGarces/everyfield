import type { RequestActor } from "@everyfield/domain/access";
import type { Owner } from "@everyfield/contracts/common";

/** The four exact contexts a conversation can belong to. */
export type ContextKind = "account" | "plant" | "sending_church" | "sending_network";

/**
 * The verified conversation owner for one request or one turn: the account, its session, the exact context and the
 * current role. Built only from a RequestActor, which the domain builds from a live session.
 */
export type EvryActor = {
	readonly authority: RequestActor;
	readonly accountId: string;
	readonly session: string;
	readonly owner: Exclude<Owner, { kind: "global" }>;
	readonly contextKind: ContextKind;
	readonly role: "owner" | "admin" | "member" | null;
	/** The seat that grants the context; null in the account context. */
	readonly seatId: string | null;
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
	};
}

/** The same account still holds the same exact context. A different context needs an explicit choice, never a fallback. */
export function sameContext(a: EvryActor, b: EvryActor) {
	return a.accountId === b.accountId && a.owner.kind === b.owner.kind && a.owner.id === b.owner.id;
}
