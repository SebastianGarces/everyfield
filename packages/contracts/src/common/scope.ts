// Server adapter contract. Never hydrate authority from an HTTP/model body or saved receipt.
import { z } from "zod";
import { accountId, owner, role, sessionId, sameOwner, operationId } from "./values.ts";
import type { Owner } from "./values.ts";
import { instant } from "./time.ts";
import type { Instant } from "./time.ts";

const authority = z.strictObject({
	accountId,
	sessionId,
	sessionExpiresAt: instant,
	accountActive: z.literal(true),
	context: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("account"), owner, active: z.literal(true) }),
		z.strictObject({ kind: z.literal("seat"), owner, role, active: z.literal(true) }),
	]),
});
export type CurrentAuthority = z.input<typeof authority>;
export type HumanAttribution = Readonly<{ kind: "human"; accountId: z.infer<typeof accountId> }>;
export type ServiceAttribution = Readonly<{
	kind: "service";
	cause: "job" | "provider_callback" | "recovery";
	operationId: z.infer<typeof operationId>;
}>;
export type Attribution = HumanAttribution | ServiceAttribution;

// A loader is supplied by the session/access producer and reads inside the owning
// transaction. This type is an adapter boundary, not a replacement authorization policy.
export type AuthorityReader<Tx> = (tx: Tx, session: z.infer<typeof sessionId>, selected: Owner) => Promise<unknown>;
export class CommandScope {
	readonly #current: z.infer<typeof authority>;
	private constructor(current: z.infer<typeof authority>) {
		Object.freeze(current.context.owner);
		Object.freeze(current.context);
		this.#current = Object.freeze(current);
	}
	get actor(): HumanAttribution {
		return { kind: "human", accountId: this.#current.accountId };
	}
	get owner(): Owner {
		return this.#current.context.owner;
	}
	get role(): z.infer<typeof role> | null {
		return this.#current.context.kind === "seat" ? this.#current.context.role : null;
	}
	// The caller passes a validated session handle, never caller-supplied actor/role fields.
	static async load<Tx>(
		tx: Tx,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		asOf: Instant,
		read: AuthorityReader<Tx>,
	): Promise<CommandScope | null> {
		const parsed = authority.safeParse(await read(tx, session, selected));
		if (!parsed.success) return null;
		const current = parsed.data;
		if (
			current.sessionId !== session ||
			current.sessionExpiresAt <= asOf ||
			!sameOwner(current.context.owner, selected)
		)
			return null;
		if (current.context.kind === "account") {
			if (selected.kind !== "account" || selected.id !== current.accountId) return null;
		} else if (selected.kind !== "plant" && selected.kind !== "organization") return null;
		return new CommandScope(current);
	}
}
