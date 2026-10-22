import * as tables from "@everyfield/db/tables";
import { and, eq, sql, getTableColumns, isNull, notExists, type SQL, type SQLWrapper } from "@everyfield/db/query";
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
 * One statement: the session's account, its live seats, the selected owner, every lifecycle witness that hides the
 * account, the owner or the seat, the own Person of a plant seat and whether a seatless account still has a Discovery
 * profile. With `lock`, access_session share-locks the session and account until COMMIT, so a revoke waits for an
 * authority transaction (INV-revocation). A read passes `lock` false and takes no row lock (C22).
 */
async function readSession(db: Executor, session: z.infer<typeof sessionId>, requested?: Owner, lock = true) {
	const handle = sessionId.parse(session);
	const row = await viewerRow(db, lock ? sql`access_session(${handle})` : sql`live_session(${handle})`, requested);
	return row ? sessionRow.parse(row) : null;
}
/** The viewer statement over one identity source: a function that returns the session's account row. */
async function viewerRow(db: Executor, identity: SQL, requested?: Owner) {
	const r = await db.execute(sql`
		WITH identity AS MATERIALIZED (
			SELECT * FROM ${identity} LIMIT 1
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
	return r.rows.length === 1 ? r.rows[0]! : null;
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
async function resolveActor(tx: Executor, session: z.infer<typeof sessionId>, requested?: Owner, lock = true) {
	const row = await readSession(tx, session, requested, lock);
	return row ? actorOf(row) : currentActorResult.parse({ status: "unavailable" });
}

/**
 * The signed-in viewer for one request: the registration state, the actor when the account holds one live seat or
 * none, the own Person of a plant seat and whether a seatless account has a Discovery profile. Null when the session
 * has no live account or the account is being deleted. One statement; the page shares it through the request cache.
 */
export async function readViewer(db: Executor, session: z.infer<typeof sessionId>) {
	const row = await readSession(db, session);
	return row && viewerOf(row, session);
}
function viewerOf(row: SessionRow, session: z.infer<typeof sessionId>) {
	if (row.hidden.some((w) => w.kind === "account" && w.opaque_subject_id === row.account_id)) return null;
	const actor = actorOf(row);
	return {
		accountId: row.account_id,
		registration: row.registration_state,
		authority: actor.status === "active" ? RequestActor.of(session, actor) : null,
		person: row.own_person,
		discovery: row.discovery,
	};
}

const requestRow = sessionRow.extend({
	session_id: sessionId,
	name: z.string(),
	email: z.email(),
	email_verified: z.boolean(),
});
/**
 * The request's session, its user and its viewer in one statement, keyed by the token of a session cookie whose
 * signature the server has verified (RT-1). It replaces Better Auth's session and user reads and readViewer. No row
 * locks (C27); every tenant read still checks live access itself (C13). Null when no live session with an account
 * has this token. `viewer` is null, as from readViewer, when a deletion hold hides the account.
 */
export async function readRequestViewer(db: Executor, token: string) {
	const raw = await viewerRow(db, sql`request_session(${token})`);
	if (!raw) return null;
	const row = requestRow.parse(raw);
	return {
		session: { id: row.session_id, expiresAt: row.expires_at },
		user: { name: row.name, email: row.email, emailVerified: row.email_verified },
		viewer: viewerOf(row, row.session_id),
	};
}

/** The actor for this transaction. A read passes `lock` false, so resolving it takes no session lock (C22). */
export async function currentActor(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner, lock = true) {
	const bound = boundWrite(tx);
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
	return resolveActor(tx, session, parsed.data, lock);
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
/** An immutable observation held by the native command's outer transaction: the gate's locked rows. */
export const requestWrite = (tx: Transaction) => requestWrites.get(tx);
/**
 * A native write that has not run the gate: the request's verified actor, checked again with its locks by the final
 * write statement (D70), or by the gate once the command needs a transaction.
 */
type DeferredWrite = Pick<RequestWrite, "authority" | "selected" | "actor">;
const deferredWrites = new WeakMap<Transaction, DeferredWrite>();
/** The command's actor, locked by the gate or deferred to the final write. */
export const boundWrite = (tx: Transaction): DeferredWrite | undefined =>
	requestWrites.get(tx) ?? deferredWrites.get(tx);
export const clearRequestWrite = (tx: Transaction) => {
	requestWrites.delete(tx);
	deferredWrites.delete(tx);
};
/** The request actor's authority over `selected`, or null when only the gate can decide it. */
export function deferWrite(tx: Transaction, authority: RequestActor, selected: Owner): DeferredWrite | null {
	const actor = authority.actor;
	const own =
		actor.context.kind === "seat" && sameOwner(actor.context.owner, selected)
			? actor
			: selected.kind === "account" && selected.id === actor.accountId
				? { ...actor, context: { kind: "account" as const, owner: selected } }
				: null;
	if (!own) return null;
	const write = { authority, selected, actor: own };
	deferredWrites.set(tx, write);
	return write;
}
/**
 * The gate's checks and locks for one final write statement (D70): the WITH entries, ending in `evf_auth(allowed)`.
 * The same lock order as lockWriteAuthority: session and account, seats, then the owner root. The observed seat must
 * still be the actor's one live seat with the same role and revision. The statement never waits for a lock: its
 * snapshot is taken before its locks, so after a wait it could miss what the lock holder committed. A held lock fails
 * the statement at once, and the command runs the established way, which waits. A writer that changed the account or
 * the root and committed between the snapshot and the lock leaves a newer version than the snapshot sees: the locked
 * row's `xmin` then differs from the snapshot's, and the statement refuses too.
 */
export function writeAuthority(write: DeferredWrite): SQL {
	const { authority, selected, actor } = write;
	const root = selected.kind === "plant" ? sql`plant` : selected.kind === "organization" ? sql`organization` : null;
	const seat =
		actor.context.kind === "seat"
			? sql`EXISTS(SELECT FROM evf_seats s WHERE s.id=${actor.context.seatId}::uuid AND s.role=${actor.context.role}
 AND s.revision=${actor.context.revision} AND s.accepted_at<=clock_timestamp() AND ${
		selected.kind === "plant"
			? sql`s.plant_id=${selected.id}::uuid AND s.organization_id IS NULL`
			: sql`s.organization_id=${selected.id}::uuid AND s.plant_id IS NULL`
 }) AND EXISTS(SELECT FROM evf_root r ${
		selected.kind === "organization"
			? sql`JOIN organization o ON o.id=r.id WHERE o.kind=${selected.organizationKind}`
			: sql``
 })`
			: sql`${selected.id}::uuid=${actor.accountId}::uuid`;
	return sql`evf_principal AS MATERIALIZED (
 SELECT i.account_id, i.verified FROM (SELECT set_config('lock_timeout','1ms',true)) g
 CROSS JOIN LATERAL invitation_identity(${authority.session}::uuid) i LIMIT 1
), evf_account AS MATERIALIZED (
 SELECT a.id, a.registration_state, a.xmin::text AS version FROM account a JOIN evf_principal p ON a.id=p.account_id
 FOR UPDATE OF a NOWAIT
), evf_seats AS MATERIALIZED (
 SELECT s.id, s.plant_id, s.organization_id, s.role, s.revision::text AS revision, s.accepted_at
 FROM seat s JOIN evf_account a ON s.account_id=a.id WHERE s.ended_at IS NULL ORDER BY s.id FOR SHARE OF s NOWAIT
), evf_root AS MATERIALIZED (${
		root
			? sql`SELECT r.id, r.xmin::text AS version FROM ${root} r WHERE r.id=${selected.id}::uuid AND EXISTS(SELECT FROM evf_account)
 AND (SELECT count(*) FROM evf_seats)<=1 FOR UPDATE OF r NOWAIT`
			: sql`SELECT NULL::uuid AS id, NULL::text AS version WHERE false`
	}), evf_auth AS MATERIALIZED (SELECT (
 EXISTS(SELECT FROM evf_principal p JOIN evf_account a ON a.id=p.account_id
  WHERE p.verified AND a.id=${actor.accountId}::uuid AND a.registration_state='active')
 AND (SELECT count(*) FROM evf_seats)<=1
 AND EXISTS(SELECT FROM tenant t WHERE t.id=${selected.id}::uuid AND t.kind=${selected.kind})
 AND ${seat} AND ${writeVisibility(actor.accountId, selected)}
 AND (SELECT version FROM evf_account)=(SELECT xmin::text FROM account WHERE id=${actor.accountId}::uuid)
 ${
		root
			? sql`AND (SELECT version FROM evf_root)=(SELECT xmin::text FROM ${root} WHERE id=${selected.id}::uuid)`
			: sql``
 }) AS allowed)`;
}

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
/**
 * C13 and C22: access as it is now, as one condition for each statement of a tenant read. The session is live and its
 * account active; for a plant or organization the account still holds an accepted seat there, not ended, Owner or Admin
 * when `admin`, exactly `role` when it is named, and the same seat as the request's actor when `seatId` names it; no
 * lifecycle witness hides the account, the owner or the seat. live_session takes no row lock, so a sign-out never waits
 * for a running read. A write locks its authority instead (lockWriteAuthority, access_session).
 */
export function liveRead(
	access: { session: string; owner: Owner; seatId?: string; role?: z.infer<typeof role> },
	admin = false,
): SQL {
	const { owner } = access;
	const seat =
		owner.kind === "account"
			? sql`i.account_id=${owner.id}::uuid`
			: sql`EXISTS(SELECT FROM seat s WHERE s.account_id=i.account_id
 AND ${owner.kind === "organization" ? sql`s.organization_id` : sql`s.plant_id`}=${owner.id}::uuid
 AND s.ended_at IS NULL AND s.accepted_at<=clock_timestamp() ${access.seatId ? sql`AND s.id=${access.seatId}::uuid` : sql``}
 ${access.role ? sql`AND s.role=${access.role}` : admin ? sql`AND s.role<>'member'` : sql``})`;
	return sql`EXISTS(SELECT FROM live_session(${access.session}::uuid) i WHERE i.registration_state='active'
 AND ${seat} AND ${writeVisibility(sql`i.account_id`, owner)})`;
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
