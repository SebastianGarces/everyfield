import { owner, requestIdentity, sameOwner, type Owner } from "@everyfield/contracts/common";
import { wikiError, type WikiError, type WikiReply } from "@everyfield/contracts/wiki";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, RequestActor } from "../access/session.ts";
import { hash } from "../operations/canonical.ts";
import {
	declareWrite,
	finishAudit,
	lockedWrite,
	nativeWrite,
	prepareWrite,
	WriteUnavailable,
	type AuditWrite,
} from "../operations/writes.ts";

export const GLOBAL = "00000000-0000-0000-0000-000000000000";
export const PAGE = 20;
export class WikiRefusal extends Error {
	readonly code: WikiError["code"];
	constructor(code: WikiError["code"]) {
		super(code);
		this.code = code;
	}
}
export class WikiOutcome extends Error {
	readonly value: unknown;
	constructor(value: unknown) {
		super("wiki_outcome");
		this.value = value;
	}
}
export function deny(code: WikiError["code"] = "access_denied"): never {
	throw new WikiRefusal(code);
}
const retry: Record<WikiError["code"], WikiError["retry"]> = {
	invalid_input: "never",
	access_denied: "never",
	unavailable: "never",
	invalid_subject: "never",
	conflict: "refresh",
	temporary: "same_request",
	unknown: "reconcile",
};
function refused(error: WikiRefusal): WikiReply<never> {
	return {
		status: "refused",
		error: wikiError.parse({
			code: error.code,
			details: {},
			correlationId: randomUUID(),
			retry: retry[error.code],
		}),
	};
}
export function refusal(error: unknown): WikiReply<never> {
	if (error instanceof WriteUnavailable) return refused(new WikiRefusal("unavailable"));
	if (error instanceof WikiRefusal) return refused(error);
	throw error;
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const result = schema.safeParse(raw);
	if (!result.success) deny("invalid_input");
	return result.data;
}
export function accountOwner(accountId: string): Owner {
	return owner.parse({ kind: "account", id: accountId });
}
export function selectedOwner(authority: RequestActor): Owner {
	const context = authority.actor.context;
	return context.kind === "seat" ? context.owner : accountOwner(authority.actor.accountId);
}
/** Session account, live seat and role in one condition (C13). */
export function meSql(authority: RequestActor, selected: Owner, admin = false): SQL {
	const context = authority.actor.context;
	const aligned = context.kind === "seat" && sameOwner(context.owner, selected);
	return sql`me AS (
		SELECT i.account_id FROM live_session(${authority.session}::uuid) i
		WHERE i.registration_state = 'active'
			AND i.account_id = ${authority.actor.accountId}::uuid
			AND ${liveRead(
				{
					session: authority.session,
					owner: selected,
					seatId: aligned ? context.seatId : undefined,
					role: aligned && !admin ? context.role : undefined,
				},
				admin,
			)}
	)`;
}
export function pgCode(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}
export type Command = AuditWrite & { actorId: string; selected: Owner };
export async function runRead<T>(body: () => Promise<T>): Promise<WikiReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof WikiOutcome) throw error;
		return refusal(error);
	}
}
export async function runWrite<T>(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	operation: string,
	input: { requestKey: string },
	result: z.ZodType<T>,
	body: (tx: Transaction, command: Command, input: { requestKey: string }) => Promise<T>,
): Promise<WikiReply<T>> {
	try {
		const value = await nativeWrite(db, authority, selected, async (tx) => {
			// declareWrite starts the gate. lockedWrite repeats that lock and ends a stored-answer run.
			// The locked row lives on the actor the gate checked. Do not read it back through requestWrite:
			// a production bundle can load that map from a second copy of the session module, so the read
			// is empty after a successful lock and the write refuses a live actor.
			await declareWrite(tx, "established");
			await lockedWrite(tx);
			const actorId = authority.actor.accountId;
			const identity = requestIdentity.parse({
				owner: selected,
				actorId,
				operation,
				requestKey: input.requestKey,
				digest: hash({ operation, input }),
			});
			const claim = await prepareWrite(tx, identity);
			if (claim.kind === "conflict") deny("conflict");
			if (claim.kind === "unavailable") deny();
			if (claim.kind === "replay") return result.parse(claim.value);
			const produced = result.parse(await body(tx, { ...claim, actorId, selected }, input));
			await finishAudit(tx, claim, identity, produced);
			return produced;
		});
		return { status: "ok", value: result.parse(value) };
	} catch (error) {
		if (error instanceof WikiOutcome) return { status: "ok", value: result.parse(error.value) };
		return refusal(error);
	}
}
export { hash, RequestActor };
