import * as tables from "@everyfield/db/tables";
import { and, eq, sql, getTableColumns, isNull, type SQLWrapper } from "@everyfield/db/query";
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
});
const seatRow = z.strictObject({
	id: recordId,
	plant_id: tenantId.nullable(),
	organization_id: tenantId.nullable(),
	role,
	revision,
	accepted_at: z.coerce.date(),
});
export async function liveOwner(tx: Transaction, selected: Owner): Promise<boolean> {
	const r = await tx
		.select({ kind: tenant_t.kind, organization_kind: organization_o.kind })
		.from(tenant_t)
		.leftJoin(organization_o, eq(organization_o.id, tenant_t.id))
		.where(eq(tenant_t.id, selected.id));
	if (
		r.length !== 1 ||
		r[0]!.kind !== selected.kind ||
		(selected.kind === "organization" && r[0]!.organization_kind !== selected.organizationKind)
	)
		return false;
	if (selected.kind === "global") return false;
	if (selected.kind === "plant") {
		const plant = await tx
			.select({ id: tables.plant.id })
			.from(tables.plant)
			.where(eq(tables.plant.id, selected.id))
			.for("share");
		if (plant.length !== 1) return false;
	}
	// The root exists even before its first witness. Lock it to close the absent-row
	// race with deletion; a witness-only read cannot serialize its first insertion.
	if (selected.kind === "account") {
		const root = await tx
			.select({ id: tables.account.id })
			.from(tables.account)
			.where(eq(tables.account.id, selected.id))
			.for("share");
		if (root.length !== 1) return false;
	}
	const hidden = await tx
		.select({ id: tables.lifecycle_witness.id })
		.from(tables.lifecycle_witness)
		.where(
			and(
				and(
					eq(tables.lifecycle_witness.opaque_subject_id, selected.id),
					eq(tables.lifecycle_witness.kind, sql`${selected.kind}`),
				),
				sql<boolean>`(${tables.lifecycle_witness.state} NOT IN ('active', 'cancelled'))`,
			),
		)
		.limit(1)
		.for("share");
	return hidden.length === 0;
}
async function resolveActor(tx: Transaction, session: z.infer<typeof sessionId>, requested?: Owner) {
	// access_session takes shared session/account locks first. Materialized seats
	// precede the selected root, preserving the account-before-seat/root order.
	// A session ID yields at most one row. Bound the function estimate so the
	// identity/selected join cannot trigger JIT compilation for a million rows.
	const r = await tx.execute(sql`
		WITH identity AS MATERIALIZED (
			SELECT * FROM access_session(${sessionId.parse(session)}) LIMIT 1
		), seats AS MATERIALIZED (
			SELECT s.id, s.plant_id, s.organization_id, s.role, s.revision::text, s.accepted_at
			FROM seat s JOIN identity i ON i.account_id=s.account_id
			WHERE s.ended_at IS NULL ORDER BY s.id FOR SHARE OF s
		), selected AS MATERIALIZED (
			SELECT coalesce(${requested ? JSON.stringify(requested) : null}::jsonb,
				CASE WHEN s.plant_id IS NOT NULL THEN jsonb_build_object('kind','plant','id',s.plant_id)
					WHEN s.organization_id IS NOT NULL THEN jsonb_build_object('kind','organization','id',s.organization_id,'organizationKind',o.kind)
					ELSE jsonb_build_object('kind','account','id',i.account_id) END) AS owner
			FROM identity i LEFT JOIN (SELECT * FROM seats LIMIT 1) s ON true
			LEFT JOIN organization o ON o.id=s.organization_id
		), selected_root AS MATERIALIZED (
			SELECT p.id FROM plant p
			WHERE (SELECT owner->>'kind' FROM selected)='plant' AND p.id=(SELECT (owner->>'id')::uuid FROM selected)
				AND EXISTS (SELECT 1 FROM identity WHERE registration_state='active')
				AND (SELECT count(*) FROM seats)<=1 FOR SHARE OF p
		), selected_account AS MATERIALIZED (
			SELECT a.id FROM account a
			WHERE (SELECT owner->>'kind' FROM selected)='account' AND a.id=(SELECT (owner->>'id')::uuid FROM selected)
				AND EXISTS (SELECT 1 FROM identity WHERE registration_state='active')
				AND (SELECT count(*) FROM seats)<=1 FOR SHARE OF a
		)
		SELECT i.*, selected.owner AS selected_owner, clock_timestamp() AS now,
			(SELECT coalesce(jsonb_agg(s), '[]'::jsonb) FROM seats s) AS seats,
			EXISTS (SELECT 1 FROM tenant WHERE id=i.account_id AND kind='account') AS account_exists,
			EXISTS (
				SELECT 1 FROM tenant t LEFT JOIN organization o ON o.id=t.id
				WHERE t.id=(selected.owner->>'id')::uuid AND t.kind=selected.owner->>'kind'
					AND CASE selected.owner->>'kind'
						WHEN 'plant' THEN EXISTS (SELECT 1 FROM selected_root)
						WHEN 'account' THEN EXISTS (SELECT 1 FROM selected_account)
						WHEN 'organization' THEN o.kind=selected.owner->>'organizationKind'
						ELSE false END
			) AS selected_exists
		FROM identity i CROSS JOIN selected
	`);
	if (r.rows.length !== 1) return currentActorResult.parse({ status: "unavailable" });
	const row = sessionRow.parse(r.rows[0]!);
	const { now, seats, selected_owner: selected } = row;
	if (row.expires_at <= now || !row.account_exists || seats.length > 1)
		return currentActorResult.parse({ status: "unavailable" });
	// A separate statement sees witnesses committed while a root/seat lock was
	// waiting. Combining this with the first snapshot can miss a new deletion.
	const witnesses = await tx.execute(sql`
		SELECT kind, opaque_subject_id, seat_id FROM lifecycle_witness
		WHERE state NOT IN ('active', 'cancelled') AND (
			(kind='account' AND opaque_subject_id=${row.account_id}::uuid)
			OR (kind=${selected.kind} AND opaque_subject_id=${selected.id}::uuid)
			OR seat_id IN (SELECT id FROM seat WHERE account_id=${row.account_id}::uuid AND ended_at IS NULL)
		) FOR SHARE
	`);
	const hidden = z
		.array(
			z.object({
				kind: z.string(),
				opaque_subject_id: z.uuid(),
				seat_id: z.uuid().nullable(),
			}),
		)
		.parse(witnesses.rows);
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

export async function currentActor(tx: Transaction, session: z.infer<typeof sessionId>, selected: Owner) {
	const bound = requestWrites.get(tx);
	if (bound && bound.authority.session === session && sameOwner(bound.selected, selected)) return bound.actor;
	const parsed = owner.safeParse(selected);
	if (!parsed.success) return currentActorResult.parse({ status: "unavailable" });
	return resolveActor(tx, session, parsed.data);
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
	ownerLocked: boolean;
	plant: typeof tables.plant.$inferSelect | null;
	organization: typeof tables.organization.$inferSelect | null;
	setup: typeof tables.onboarding_setup.$inferSelect | null;
};
const requestWrites = new WeakMap<Transaction, RequestWrite>();
/** An immutable observation held by the native command's outer transaction. */
export const requestWrite = (tx: Transaction) => requestWrites.get(tx);

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
	async bind(tx: Transaction, selected: Owner, ownerLocked = false): Promise<boolean> {
		const locked = await lockWriteAuthority(tx, this.session, selected, ownerLocked, this);
		if (!locked || locked.identity.status !== "active") return false;
		requestWrites.set(tx, {
			authority: this,
			selected,
			actor: locked.identity,
			account: locked.account,
			principal: locked.principal,
			ownerLocked,
			plant: locked.plant,
			organization: locked.organization,
			setup: locked.setup,
		});
		return true;
	}

	static async resolve(tx: Transaction, session: z.infer<typeof sessionId>) {
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
	ownerLocked = false,
	observed?: RequestActor,
) {
	if (selected.kind === "global") return null;
	const gate = tx.$with("write_gate").as(
		tx
			.select({
				handle: sql<string>`${session}::uuid`.as("handle"),
				locked: sql`CASE WHEN ${ownerLocked} THEN pg_advisory_xact_lock(hashtextextended(${selected.id},11011)) END`.as(
					"locked",
				),
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
