import * as tables from "@everyfield/db/tables";
import { and, eq, sql, getTableColumns, isNull, notExists, type SQLWrapper } from "@everyfield/db/query";
import { alias } from "@everyfield/db/query";
import "server-only";
import type { Transaction } from "@everyfield/db/client";
import { z } from "zod";
import {
	accountId,
	owner,
	recordId,
	revision,
	role,
	sessionId,
	tenantId,
	sameOwner,
} from "@everyfield/contracts/common";
import type { Owner } from "@everyfield/contracts/common";
import { currentActorResult } from "@everyfield/contracts/access";
const tenant_t = alias(tables.tenant, "t");
const organization_o = alias(tables.organization, "o");

const sessionRow = z.strictObject({
	account_id: accountId,
	registration_state: z.enum(["active", "pending_domain"]),
	expires_at: z.coerce.date(),
	now: z.coerce.date(),
	seats: z.array(z.unknown()),
	account_exists: z.boolean(),
	selected_exists: z.boolean(),
	selected_owner: owner,
	hidden: z.array(z.object({ kind: z.string(), opaque_subject_id: z.uuid(), seat_id: z.uuid().nullable() })),
	own_person: z.object({ id: z.uuid(), name: z.string() }).nullable(),
	discovery: z.boolean(),
});
type SessionRow = z.infer<typeof sessionRow>;
/** A pool or a transaction: the viewer read is one statement and needs no transaction. */
type Executor = Pick<Transaction, "execute">;
const seatRow = z.strictObject({
	id: recordId,
	plant_id: tenantId.nullable(),
	organization_id: tenantId.nullable(),
	role,
	revision,
	accepted_at: z.coerce.date(),
});
/** Whether an owner exists with that kind and no lifecycle witness hides it. A write locks the root; a read does not. */
export async function liveOwner(tx: Transaction, selected: Owner, lock = true): Promise<boolean> {
	if (selected.kind === "global") return false;
	const root =
		selected.kind === "plant" ? tables.plant : selected.kind === "account" ? tables.account : tables.organization;
	const hiddenBy = and(
		eq(tables.lifecycle_witness.opaque_subject_id, selected.id),
		eq(tables.lifecycle_witness.kind, sql`${selected.kind}`),
		sql<boolean>`(${tables.lifecycle_witness.state} NOT IN ('active', 'cancelled'))`,
	);
	const query = tx
		.select({ kind: tenant_t.kind, organization_kind: organization_o.kind })
		.from(root)
		.innerJoin(tenant_t, eq(tenant_t.id, root.id))
		.leftJoin(organization_o, eq(organization_o.id, tenant_t.id))
		.where(
			lock
				? eq(root.id, selected.id)
				: // A read checks the witness in the same statement.
					and(
						eq(root.id, selected.id),
						notExists(tx.select({ id: tables.lifecycle_witness.id }).from(tables.lifecycle_witness).where(hiddenBy)),
					),
		);
	const roots = await (lock ? query.for("share", { of: root }) : query);
	if (
		roots.length !== 1 ||
		roots[0]!.kind !== selected.kind ||
		(selected.kind === "organization" && roots[0]!.organization_kind !== selected.organizationKind)
	)
		return false;
	if (!lock) return true;
	// A write's second statement observes lifecycle changes committed while the root lock waited.
	const hidden = await tx
		.select({ id: tables.lifecycle_witness.id })
		.from(tables.lifecycle_witness)
		.where(hiddenBy)
		.limit(1)
		.for("share");
	return hidden.length === 0;
}
/**
 * One statement, no row locks: the session's account, its live seats, the selected owner, every lifecycle witness that
 * hides the account, the owner or the seat, the own Person of a plant seat and whether a seatless account still has a
 * Discovery profile. Authority for a write is re-checked by the write statement (D70), so a read observes only.
 */
async function readSession(db: Executor, session: z.infer<typeof sessionId>, requested?: Owner) {
	const r = await db.execute(sql`
		WITH identity AS MATERIALIZED (
			SELECT * FROM access_session(${sessionId.parse(session)}) LIMIT 1
		), seats AS MATERIALIZED (
			SELECT s.id, s.plant_id, s.organization_id, s.role, s.revision::text, s.accepted_at
			FROM seat s JOIN identity i ON i.account_id=s.account_id
			WHERE s.ended_at IS NULL ORDER BY s.id
		), selected AS MATERIALIZED (
			SELECT coalesce(${requested ? JSON.stringify(requested) : null}::jsonb,
				CASE WHEN s.plant_id IS NOT NULL THEN jsonb_build_object('kind','plant','id',s.plant_id)
					WHEN s.organization_id IS NOT NULL THEN jsonb_build_object('kind','organization','id',s.organization_id,'organizationKind',o.kind)
					ELSE jsonb_build_object('kind','account','id',i.account_id) END) AS owner
			FROM identity i LEFT JOIN (SELECT * FROM seats LIMIT 1) s ON true
			LEFT JOIN organization o ON o.id=s.organization_id
		)
		SELECT i.*, selected.owner AS selected_owner, clock_timestamp() AS now,
			(SELECT coalesce(jsonb_agg(s), '[]'::jsonb) FROM seats s) AS seats,
			EXISTS (SELECT 1 FROM tenant WHERE id=i.account_id AND kind='account') AS account_exists,
			EXISTS (
				SELECT 1 FROM tenant t LEFT JOIN organization o ON o.id=t.id
				WHERE t.id=(selected.owner->>'id')::uuid AND t.kind=selected.owner->>'kind'
					AND (t.kind<>'organization' OR o.kind=selected.owner->>'organizationKind')
			) AS selected_exists,
			(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',w.kind,'opaque_subject_id',w.opaque_subject_id,'seat_id',w.seat_id)), '[]'::jsonb)
				FROM lifecycle_witness w WHERE w.state NOT IN ('active', 'cancelled') AND (
					(w.kind='account' AND w.opaque_subject_id=i.account_id)
					OR (w.kind=selected.owner->>'kind' AND w.opaque_subject_id=(selected.owner->>'id')::uuid)
					OR w.seat_id IN (SELECT id FROM seats))) AS hidden,
			(SELECT jsonb_build_object('id',p.id,'name',p.display_name) FROM person p
				WHERE selected.owner->>'kind'='plant' AND p.tenant_id=(selected.owner->>'id')::uuid
					AND p.linked_account_id=i.account_id AND p.state='live' LIMIT 1) AS own_person,
			EXISTS (SELECT 1 FROM discovery d WHERE d.account_id=i.account_id AND d.converted_at IS NULL) AS discovery
		FROM identity i CROSS JOIN selected
	`);
	return r.rows.length === 1 ? sessionRow.parse(r.rows[0]!) : null;
}
function actorOf(row: SessionRow) {
	const { now, seats, selected_owner: selected, hidden } = row;
	if (row.expires_at <= now || !row.account_exists || seats.length > 1)
		return currentActorResult.parse({ status: "unavailable" });
	if (hidden.some((w) => w.kind === "account" && w.opaque_subject_id === row.account_id))
		return currentActorResult.parse({ status: "unavailable" });
	if (row.registration_state === "pending_domain")
		return currentActorResult.parse({ status: "pending_domain", accountId: row.account_id });
	if (!row.selected_exists || hidden.some((w) => w.kind === selected.kind && w.opaque_subject_id === selected.id))
		return currentActorResult.parse({ status: "unavailable" });
	if (selected.kind === "account")
		return currentActorResult.parse(
			selected.id === row.account_id
				? { status: "active", accountId: row.account_id, context: { kind: "account", owner: selected } }
				: { status: "unavailable" },
		);
	const seat = seats[0]! && seatRow.parse(seats[0]!);
	if (
		!seat ||
		seat.accepted_at > now ||
		(selected.kind === "plant"
			? seat.plant_id !== selected.id || seat.organization_id !== null
			: selected.kind !== "organization" || seat.organization_id !== selected.id || seat.plant_id !== null)
	)
		return currentActorResult.parse({ status: "unavailable" });
	if (hidden.some((w) => w.seat_id === seat.id)) return currentActorResult.parse({ status: "unavailable" });
	return currentActorResult.parse({
		status: "active",
		accountId: row.account_id,
		context: { kind: "seat", owner: selected, seatId: seat.id, role: seat.role, revision: seat.revision },
	});
}
async function resolveActor(tx: Executor, session: z.infer<typeof sessionId>, requested?: Owner) {
	const row = await readSession(tx, session, requested);
	return row ? actorOf(row) : currentActorResult.parse({ status: "unavailable" });
}

/**
 * The signed-in viewer for one request: the registration state, the actor when the account holds one live seat or
 * none, the own Person of a plant seat and whether a seatless account has a Discovery profile. Null when the session
 * has no live account or the account is being deleted. One statement; the page shares it through the request cache.
 */
export async function readViewer(db: Executor, session: z.infer<typeof sessionId>) {
	const row = await readSession(db, session);
	if (!row || row.hidden.some((w) => w.kind === "account" && w.opaque_subject_id === row.account_id)) return null;
	const actor = actorOf(row);
	return {
		accountId: row.account_id,
		registration: row.registration_state,
		authority: actor.status === "active" ? RequestActor.of(session, actor) : null,
		person: row.own_person,
		discovery: row.discovery,
	};
}

export async function currentActor(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner) {
	const bound = requestWrites.get(tx);
	if (bound && bound.authority.session === session && sameOwner(bound.selected, selected)) return bound.actor;
	const parsed = owner.safeParse(selected);
	if (!parsed.success) return currentActorResult.parse({ status: "unavailable" });
	// A read transaction that observed the request actor (D59) answers for that actor's own workspace or account.
	const observed = requestReads.get(tx);
	if (observed && observed.session === session) {
		const actor = observed.actor;
		if (sameOwner(actor.context.owner, parsed.data)) return actor;
		if (parsed.data.kind === "account" && parsed.data.id === actor.accountId)
			return currentActorResult.parse({
				status: "active",
				accountId: actor.accountId,
				context: { kind: "account", owner: parsed.data },
			});
	}
	return resolveActor(tx, session, parsed.data);
}
const requestReads = new WeakMap<Transaction, RequestActor>();
/** The actor a read transaction observed for this session, or null. */
export function observedActor(tx: Transaction, session: z.infer<typeof sessionId>) {
	const observed = requestReads.get(tx);
	return observed && observed.session === session ? observed.actor : null;
}

type ActiveActor = Extract<z.infer<typeof currentActorResult>, { status: "active" }>;
const principalRow = z.object({
	account_id: accountId,
	email: z.email(),
	display_name: z.string(),
	verified: z.boolean(),
	registration_state: z.enum(["active", "pending_domain"]),
});
type RequestWrite = {
	authority: RequestActor;
	selected: Owner;
	actor: ActiveActor;
	account: typeof tables.account.$inferSelect;
	principal: z.infer<typeof principalRow>;
	plant: typeof tables.plant.$inferSelect | null;
	organization: typeof tables.organization.$inferSelect | null;
	setup: typeof tables.onboarding_setup.$inferSelect | null;
};
const requestWrites = new WeakMap<Transaction, RequestWrite>();
/** An immutable observation held by the native command's outer transaction. */
export const requestWrite = (tx: Transaction) => requestWrites.get(tx);
export const clearRequestWrite = (tx: Transaction) => requestWrites.delete(tx);

/** Server-only authority for one request. Constructed from a live session, never from JSON. */
export class RequestActor {
	readonly status = "active";
	readonly actor: ActiveActor;
	readonly session: z.infer<typeof sessionId>;
	private constructor(session: z.infer<typeof sessionId>, actor: ActiveActor) {
		this.session = session;
		this.actor = actor;
	}

	/** Bind one verified actor to the transaction that owns this command's rollback. */
	async bind(tx: Transaction, selected: Owner): Promise<RequestWrite | null> {
		const locked = await lockWriteAuthority(tx, this.session, selected, this);
		if (!locked || locked.identity.status !== "active") return null;
		const write: RequestWrite = {
			authority: this,
			selected,
			actor: locked.identity,
			account: locked.account,
			principal: locked.principal,
			plant: locked.plant,
			organization: locked.organization,
			setup: locked.setup,
		};
		requestWrites.set(tx, write);
		return write;
	}

	/** A tool ingress that has not supplied a request actor verifies and locks it once. */
	static async claimWrite(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner) {
		const locked = await lockWriteAuthority(tx, session, selected);
		if (!locked || locked.identity.status !== "active") return null;
		const authority = new RequestActor(session, locked.identity);
		const write: RequestWrite = {
			authority,
			selected,
			actor: locked.identity,
			account: locked.account,
			principal: locked.principal,
			plant: locked.plant,
			organization: locked.organization,
			setup: locked.setup,
		};
		requestWrites.set(tx, write);
		return write;
	}

	/** Let a read transaction answer currentActor from this observation instead of a second statement. */
	observe(tx: Transaction) {
		requestReads.set(tx, this);
	}

	/** @internal readViewer builds the authority from the same statement that observed the actor. */
	static of(session: z.infer<typeof sessionId>, actor: ActiveActor) {
		return new RequestActor(session, actor);
	}

	static async resolve(tx: Executor, session: z.infer<typeof sessionId>) {
		const actor = await resolveActor(tx, session);
		return actor.status === "active" ? new RequestActor(session, actor) : actor;
	}
}

/** One locked snapshot. A command's admission checks lifecycle again after any lock wait. */
export function writeVisibility(actor: string | SQLWrapper, selected: Owner) {
	return sql<boolean>`NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.state NOT IN ('active','cancelled') AND (
  (w.kind='account' AND w.opaque_subject_id=${actor}::uuid) OR (w.kind=${selected.kind} AND w.opaque_subject_id=${selected.id}::uuid) OR
  (${selected.kind}<>'account' AND w.seat_id IN (SELECT id FROM seat WHERE account_id=${actor}::uuid
   AND coalesce(plant_id,organization_id)=${selected.id}::uuid AND ended_at IS NULL))))`;
}
export async function currentWriteAllowed(tx: Transaction, actor: string, selected: Owner) {
	const result = await tx.execute(sql`SELECT ${writeVisibility(actor, selected)} AS allowed`);
	return z.boolean().parse(result.rows[0]?.allowed);
}

export async function lockWriteAuthority(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	observed?: RequestActor,
) {
	if (selected.kind === "global") return null;
	const gate = tx.$with("write_gate").as(
		tx
			.select({
				handle: sql<string>`${session}::uuid`.as("handle"),
				locked: sql`set_config('statement_timeout','10s',true)||set_config('lock_timeout','5s',true)`.as("locked"),
			})
			.from(sql`(SELECT 1) seed`),
	);
	const principal = tx.$with("write_principal").as(
		tx
			.select({
				account_id: sql<string>`i.account_id`.as("account_id"),
				email: sql<string>`i.email`.as("email"),
				display_name: sql<string>`i.display_name`.as("display_name"),
				verified: sql<boolean>`i.verified`.as("verified"),
				registration_state: sql<string>`i.registration_state`.as("registration_state"),
			})
			.from(sql`${gate} g CROSS JOIN LATERAL invitation_identity(g.handle) i`)
			.limit(1),
	);
	const account = tx
		.$with("write_account")
		.as(
			tx
				.select(getTableColumns(tables.account))
				.from(tables.account)
				.innerJoin(principal, eq(tables.account.id, principal.account_id))
				.for("update", { of: tables.account }),
		);
	const seats = tx.$with("write_seats").as(
		tx
			.select({
				id: tables.seat.id,
				plant_id: tables.seat.plant_id,
				organization_id: tables.seat.organization_id,
				role: tables.seat.role,
				revision: sql<string>`${tables.seat.revision}::text`.as("revision"),
				accepted_at: tables.seat.accepted_at,
			})
			.from(tables.seat)
			.innerJoin(account, eq(tables.seat.account_id, account.id))
			.where(isNull(tables.seat.ended_at))
			.orderBy(tables.seat.id)
			.for("share", { of: tables.seat }),
	);
	const plant = tx.$with("write_plant").as(
		tx
			.select(getTableColumns(tables.plant))
			.from(tables.plant)
			.where(
				and(
					sql`${selected.kind}='plant'`,
					eq(tables.plant.id, selected.id),
					sql`EXISTS(SELECT FROM ${account}) AND (SELECT count(*) FROM ${seats})<=1`,
				),
			)
			.for("update"),
	);
	const organization = tx.$with("write_organization").as(
		tx
			.select(getTableColumns(tables.organization))
			.from(tables.organization)
			.where(
				and(
					sql`${selected.kind}='organization'`,
					eq(tables.organization.id, selected.id),
					sql`EXISTS(SELECT FROM ${account}) AND (SELECT count(*) FROM ${seats})<=1`,
				),
			)
			.for("update"),
	);
	const setup = tx
		.$with("write_setup")
		.as(
			tx
				.select(getTableColumns(tables.onboarding_setup))
				.from(tables.onboarding_setup)
				.innerJoin(plant, eq(tables.onboarding_setup.plant_id, plant.id))
				.for("update", { of: tables.onboarding_setup }),
		);
	const a = alias(tables.account, "write_account"),
		p = alias(tables.plant, "write_plant"),
		o = alias(tables.organization, "write_organization"),
		s = alias(tables.onboarding_setup, "write_setup");
	const [row] = await tx
		.with(gate, principal, account, seats, plant, organization, setup)
		.select({
			account: a,
			plant: p,
			organization: o,
			setup: s,
			principal: sql<unknown>`(SELECT row_to_json(i) FROM ${principal} i)`,
			seats: sql<unknown>`(SELECT coalesce(jsonb_agg(s),'[]'::jsonb) FROM ${seats} s)`,
			now: sql<Date>`clock_timestamp()`.mapWith((v: string) => new Date(v)),
			root: sql<boolean>`EXISTS(SELECT FROM tenant t WHERE t.id=${selected.id}::uuid AND t.kind=${selected.kind})`,
			visible: writeVisibility(account.id, selected),
		})
		.from(account)
		.leftJoin(plant, sql`true`)
		.leftJoin(organization, sql`true`)
		.leftJoin(setup, sql`true`);
	if (!row || !row.root || !row.visible) return null;
	const identity = principalRow.safeParse(row.principal),
		currentSeats = z.array(seatRow).parse(row.seats);
	if (
		!identity.success ||
		!identity.data.verified ||
		identity.data.account_id !== row.account.id ||
		currentSeats.length > 1
	)
		return null;
	if (selected.kind === "account" && selected.id !== row.account.id) return null;
	let actor: Exclude<z.infer<typeof currentActorResult>, { status: "unavailable" }>;
	if (row.account.registration_state === "pending_domain") {
		if (selected.kind !== "account") return null;
		actor = { status: "pending_domain", accountId: identity.data.account_id };
	} else if (selected.kind === "account")
		actor = { status: "active", accountId: identity.data.account_id, context: { kind: "account", owner: selected } };
	else {
		const seat = currentSeats[0];
		if (
			!seat ||
			seat.accepted_at > row.now ||
			(selected.kind === "plant"
				? !row.plant || seat.plant_id !== selected.id || seat.organization_id !== null
				: !row.organization ||
					row.organization.kind !== selected.organizationKind ||
					seat.organization_id !== selected.id ||
					seat.plant_id !== null)
		)
			return null;
		if (
			observed &&
			(observed.actor.accountId !== row.account.id ||
				observed.actor.context.kind !== "seat" ||
				!sameOwner(observed.actor.context.owner, selected) ||
				seat.id !== observed.actor.context.seatId ||
				seat.role !== observed.actor.context.role ||
				seat.revision !== observed.actor.context.revision)
		)
			return null;
		actor = {
			status: "active",
			accountId: identity.data.account_id,
			context: { kind: "seat", owner: selected, seatId: seat.id, role: seat.role, revision: seat.revision },
		};
	}
	if (observed && observed.actor.accountId !== row.account.id) return null;
	return {
		identity: actor,
		account: row.account,
		principal: identity.data,
		plant: row.plant,
		organization: row.organization,
		setup: row.setup,
	};
}
