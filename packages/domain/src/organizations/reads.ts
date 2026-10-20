import type { Owner } from "@everyfield/contracts/common";
import { sessionResult } from "@everyfield/contracts/identity";
import * as C from "@everyfield/contracts/organizations";
import type { Database } from "@everyfield/db/client";
import { and, eq, inArray, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import "server-only";
import { z } from "zod";

/** `account`: a seatless account without a Discovery profile, for example a resident. It sees only its own residency
 * links. */
export type Kind = "plant" | "sending_church" | "sending_network" | "discovery" | "account";
export type Viewer = {
	kind: Kind;
	session: Extract<z.infer<typeof sessionResult>, { status: "active" }>["sessionId"];
	accountId: string;
	/** The exact workspace (or own account for Discovery) every command is checked against. */
	selected: Owner;
	canManage: boolean;
};

/**
 * Display names for the IDs a page shows. Plants and organizations by name. Accounts only when they hold a seat in
 * this viewer's own workspace or are the viewer; anyone else stays unnamed.
 */
export async function namesFor(db: Database, viewer: Viewer, ids: string[]): Promise<Record<string, string>> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return {};
	const plants = await db
		.select({ id: t.plant.id, name: t.plant.name })
		.from(t.plant)
		.where(inArray(t.plant.id, unique));
	const orgs = await db
		.select({ id: t.organization.id, name: t.organization.name })
		.from(t.organization)
		.where(inArray(t.organization.id, unique));
	const workspace = viewer.selected.kind === "account" ? null : viewer.selected;
	const visible = await db
		.select({ id: t.account.id })
		.from(t.account)
		.where(
			and(
				inArray(t.account.id, unique),
				workspace
					? sql`(${t.account.id} = ${viewer.accountId} OR EXISTS (SELECT 1 FROM seat s WHERE s.account_id = ${t.account.id} AND s.ended_at IS NULL AND (s.plant_id = ${workspace.id} OR s.organization_id = ${workspace.id})))`
					: eq(t.account.id, viewer.accountId),
			),
		);
	// The name comes through seat_identity, the reviewed definer function the seat service uses (auth_user is not
	// readable by the runtime role).
	const people = visible.length
		? (
				await db.execute<{ id: string; name: string | null }>(sql`
		SELECT a.id, identity.display_name AS name
		FROM unnest(${sql.param(visible.map((row) => row.id))}::uuid[]) WITH ORDINALITY AS a(id, position)
		CROSS JOIN LATERAL seat_identity(a.id) identity ORDER BY a.position
	`)
			).rows.map((row) => ({ id: row.id, name: row.name ?? "" }))
		: [];
	return Object.fromEntries([...plants, ...orgs, ...people.filter((p) => p.name)].map((r) => [r.id, r.name]));
}

/** IDs of every endpoint and actor a history page names. */
export function idsIn(page: {
	items: { pair: C.RelationshipPair; actor: { kind: string; accountId?: string } }[];
	activeRelationships: { pair: C.RelationshipPair }[];
}) {
	const pairIds = (p: C.RelationshipPair) => [p.organization.id, p.kind === "discovery" ? p.accountId : p.subject.id];
	return [
		...page.activeRelationships.flatMap((r) => pairIds(r.pair)),
		...page.items.flatMap((i) => [
			...pairIds(i.pair),
			...(i.actor.kind === "account" && i.actor.accountId ? [i.actor.accountId] : []),
		]),
	];
}

const SUBJECT_COLUMN = {
	plant: "plant_id",
	sending_church: "sending_church_id",
	sending_network: null,
	discovery: "account_id",
	account: null,
} as const;

/** This subject's own requests still waiting for an answer (ruling D2: the contract has no read for them). */
export async function pendingFor(db: Database, viewer: Viewer) {
	const column = SUBJECT_COLUMN[viewer.kind];
	if (!column) return [];
	const subject = viewer.kind === "discovery" ? viewer.accountId : viewer.selected.id;
	const rows = await db.execute<{
		invitation_id: string;
		organization_id: string;
		organization_kind: "sending_church" | "sending_network";
		revision: string;
		created_at: string;
		inviter_description: string;
	}>(
		sql`SELECT r.invitation_id, r.organization_id, o.kind AS organization_kind, i.revision::text AS revision, to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, r.inviter_description
		FROM relationship_invitation r JOIN invitation i ON i.id = r.invitation_id JOIN organization o ON o.id = r.organization_id
		WHERE r.${sql.raw(column)} = ${subject} AND i.state = 'pending' AND i.created_at > clock_timestamp() - interval '30 days'
		ORDER BY i.created_at DESC LIMIT 50`,
	);
	return rows.rows.map((r) =>
		C.invitationResult.omit({}).parse({
			status: "pending",
			invitationId: r.invitation_id,
			pair: pairOf(viewer, { kind: "organization", id: r.organization_id, organizationKind: r.organization_kind }),
			revision: r.revision,
			expiresAt: new Date(new Date(r.created_at).getTime() + 30 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
			inviterDescription: r.inviter_description,
		}),
	);
}

/** The exact pair this subject would form with one organization. */
export function pairOf(
	viewer: Viewer,
	organization: { kind: "organization"; id: string; organizationKind: "sending_church" | "sending_network" },
) {
	if (viewer.kind === "discovery")
		return C.relationshipPair.parse({ kind: "discovery", accountId: viewer.accountId, organization });
	if (viewer.kind === "plant")
		return C.relationshipPair.parse({ kind: "plant", subject: viewer.selected, organization });
	return C.relationshipPair.parse({ kind: "sending_church", subject: viewer.selected, organization });
}

/**
 * Organizations this subject may ask (ruling D3): every sending church and network by name and kind, the basic
 * directory a plant already sees in the product, minus itself and its active links. A sending church asks networks
 * only; a network asks no one.
 */
export async function targetsFor(db: Database, viewer: Viewer, active: Set<string>) {
	if (viewer.kind === "sending_network") return [];
	const rows = await db
		.select({ id: t.organization.id, kind: t.organization.kind, name: t.organization.name })
		.from(t.organization)
		.where(viewer.kind === "sending_church" ? eq(t.organization.kind, "sending_network") : sql`true`)
		.orderBy(t.organization.name)
		.limit(500);
	return rows
		.filter((r) => r.id !== viewer.selected.id && !active.has(r.id))
		.map((r) => ({
			pair: pairOf(viewer, { kind: "organization", id: r.id, organizationKind: r.kind }),
			name: r.name,
		}));
}

/** The subject's current revision, which an invitation must carry, and its time zone for dates. */
export async function subjectFacts(db: Database, viewer: Viewer) {
	if (viewer.kind === "discovery" || viewer.kind === "account") {
		const [a] = await db
			.select({ revision: t.account.revision })
			.from(t.account)
			.where(eq(t.account.id, viewer.accountId));
		return { revision: String(a?.revision ?? "0"), zone: "UTC" };
	}
	if (viewer.kind === "plant") {
		const [p] = await db
			.select({ revision: t.plant.revision, zone: t.plant.timezone })
			.from(t.plant)
			.where(eq(t.plant.id, viewer.selected.id));
		return { revision: String(p?.revision ?? "0"), zone: p?.zone ?? "UTC" };
	}
	const [o] = await db
		.select({ revision: t.organization.revision, zone: t.organization.timezone })
		.from(t.organization)
		.where(eq(t.organization.id, viewer.selected.id));
	return { revision: String(o?.revision ?? "0"), zone: o?.zone ?? "UTC" };
}

/** This account's own residency links, newest first, with the organization name. */
export async function residencyLinks(db: Database, viewer: Viewer) {
	return db
		.select({ linkId: t.residency_link.id, organizationName: t.organization.name })
		.from(t.residency_link)
		.innerJoin(t.organization, eq(t.organization.id, t.residency_link.organization_id))
		.where(eq(t.residency_link.account_id, viewer.accountId))
		.orderBy(sql`${t.residency_link.accepted_at} DESC`)
		.limit(20);
}

/** The revision of one of this account's own residency links; null for any other link (ruling D16). */
export async function residencyRevision(db: Database, viewer: Viewer, linkId: string) {
	if (!z.uuid().safeParse(linkId).success) return null;
	const [r] = await db
		.select({ revision: t.residency_link.revision })
		.from(t.residency_link)
		.where(and(eq(t.residency_link.id, linkId), eq(t.residency_link.account_id, viewer.accountId)));
	return r ? String(r.revision) : null;
}

/** The revision of one of this plant's own connections; null for anything else (ruling D17). */
export async function connectionRevision(db: Database, viewer: Viewer, relationshipId: string) {
	if (viewer.selected.kind !== "plant" || !z.uuid().safeParse(relationshipId).success) return null;
	const [r] = await db
		.select({ revision: t.affiliation.revision })
		.from(t.affiliation)
		.where(and(eq(t.affiliation.id, relationshipId), eq(t.affiliation.plant_id, viewer.selected.id)));
	return r ? String(r.revision) : null;
}

export async function hasDiscoveryProfile(db: Database, accountId: string) {
	const rows = await db
		.select({ id: t.discovery.id })
		.from(t.discovery)
		.where(and(eq(t.discovery.account_id, accountId), isNull(t.discovery.converted_at)));
	return rows.length > 0;
}
