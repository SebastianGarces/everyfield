import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createDatabase, type Database, type Transaction } from "@everyfield/db/client";
import { and, eq, inArray, isNull, sql } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import { owner, type Owner } from "@everyfield/contracts/common";
import { sessionResult } from "@everyfield/contracts/identity";
import * as C from "@everyfield/contracts/organizations";
import type { OrganizationOperations } from "@everyfield/contracts/organizations";
import { createSeatService } from "@everyfield/domain/identity";
import { createOrganizationAdapter, readSharingDisclosure } from "@everyfield/domain/organizations";
import { identityHandler } from "../identity";
import { createMailService } from "../jobs/mail";
import { enqueueJob } from "../jobs/queue";

// The organization mount (WP-007/ui ruling D11). Screens reach it only through features/organizations/actions.ts.
// The session comes from the identity mount and the workspace from the seat service; every command runs through the
// WP-007/api adapter in one transaction, which rechecks all authority. Mail and notices are enqueued only: WP-031
// dispatches them. The few direct reads below fill gaps the contract has no read for (ruling D2) and return names,
// waiting requests and residency links of this viewer's own scope only.

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_MAIL_FROM: z.email(),
});

type Ops = OrganizationOperations;
export type Operation = keyof Ops;
export type Reply = { status: "ok"; value: unknown } | { status: "refused"; code: string };

/** The domain refuses by throwing a short code (`refuse()` in core.ts); anything else is not a refusal. */
const REFUSAL_CODE = /^[a-z_]{3,40}$/;

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = createDatabase({ connectionString: v.IDENTITY_DATABASE_URL, max: 3 });
	const mail = createMailService({
		db,
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
		from: v.IDENTITY_MAIL_FROM,
		// A relationship invitation goes to the typed address only; nothing else is sent from this mount.
		authorize: async (_tx, m) => m.purpose === "relationship_invitation" && m.recipient === null,
		transport: {
			async send() {
				return { kind: "refused", retryable: true };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const adapter = createOrganizationAdapter(
		{
			async invitation(tx, input) {
				if (input.owner.kind === "global") throw new Error("unavailable");
				const link = `${v.IDENTITY_ORIGIN}/connections/respond?invitation=${input.invitationId}#${input.proof}`;
				await mail.enqueue(tx, {
					owner: input.owner,
					purpose: "relationship_invitation",
					logicalKey: `relationship/${input.invitationId}/${input.operationId}`,
					recipient: null,
					address: input.recipientEmail,
					content: {
						subject: `${input.inviterDescription} asks to connect on EveryField`,
						text: `${input.inviterDescription} asks to connect on EveryField. Open this link to accept or decline. It works for 30 days.\n\n${link}`,
					},
					operation: input.operationId,
					notice: null,
					eligibleAt: new Date().toISOString(),
				});
			},
			async notice(tx, input) {
				// The coarse notice goes to the plant (REQ-NTF-009); the notification job reads only the event.
				const tenant = input.pair.kind === "plant" ? input.pair.subject.id : input.pair.organization.id;
				await enqueueJob(tx, {
					tenant,
					kind: "notification",
					subject: input.relationshipId,
					key: `${input.kind}/${input.eventId}`,
					revision: input.revision,
					eligibleAt: new Date().toISOString(),
				});
			},
			async invalidate(tx, input) {
				// Ending or changing a link stops queued work that read the old grant (REQ-IDN-021).
				await tx.execute(
					sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${input.sourceId} AND kind IN ('assessment','digest') AND state IN ('ready','retry_wait','claimed')`,
				);
			},
		},
		// No reporting-location screen here; the plant settings owner supplies the reference (WP-010).
		{ candidates: async () => [] },
	);
	return { db, adapter, seats: createSeatService(db), origin: v.IDENTITY_ORIGIN };
}
function current() {
	const v = env.safeParse(process.env);
	if (!v.success) return null;
	mount ??= create(v.data);
	return mount;
}
type Mount = NonNullable<ReturnType<typeof current>>;

async function readSession(m: Mount, headers: Headers) {
	const h = new Headers({ host: new URL(m.origin).host });
	const cookie = headers.get("cookie");
	if (cookie) h.set("cookie", cookie);
	const response = await identityHandler(new Request(`${m.origin}/api/auth/get-session`, { headers: h }));
	if (!response.ok) return null;
	const parsed = sessionResult.safeParse(await response.json().catch(() => null));
	return parsed.success ? parsed.data : null;
}

export type Kind = "plant" | "sending_church" | "sending_network" | "discovery";
export type Viewer = {
	kind: Kind;
	session: Extract<z.infer<typeof sessionResult>, { status: "active" }>["sessionId"];
	accountId: string;
	/** The exact workspace (or own account for Discovery) every command is checked against. */
	selected: Owner;
	canManage: boolean;
};

/** Who is asking, from the session and the one current seat. Seatless accounts count only with a Discovery profile. */
export async function viewerOf(
	headers: Headers,
): Promise<{ kind: "signed_out" } | { kind: "unavailable" } | { kind: "viewer"; viewer: Viewer; mount: Mount }> {
	const m = current();
	if (!m) return { kind: "unavailable" };
	const s = await readSession(m, headers);
	if (!s) return { kind: "unavailable" };
	if (s.status === "unauthenticated") return { kind: "signed_out" };
	if (s.status !== "active") return { kind: "unavailable" };
	const membership = await m.seats.readCurrentMembership(s.sessionId);
	if (membership.status === "active") {
		const w = membership.workspace;
		const kind: Kind = w.kind === "plant" ? "plant" : w.organizationKind;
		return {
			kind: "viewer",
			mount: m,
			viewer: {
				kind,
				session: s.sessionId,
				accountId: s.accountId,
				selected: w,
				canManage: membership.role !== "member",
			},
		};
	}
	if (membership.status !== "seatless") return { kind: "unavailable" };
	const [d] = await m.db
		.select({ id: t.discovery.id })
		.from(t.discovery)
		.where(and(eq(t.discovery.account_id, s.accountId), isNull(t.discovery.converted_at)));
	if (!d) return { kind: "unavailable" };
	return {
		kind: "viewer",
		mount: m,
		viewer: {
			kind: "discovery",
			session: s.sessionId,
			accountId: s.accountId,
			selected: owner.parse({ kind: "account", id: s.accountId }),
			canManage: true,
		},
	};
}

/** Run one operation for this viewer. Residency consent is the resident's own, so it runs as the account. */
export async function runOperation(m: Mount, viewer: Viewer, op: Operation, input: unknown): Promise<Reply> {
	const selected = op.startsWith("residency.")
		? owner.parse({ kind: "account", id: viewer.accountId })
		: viewer.selected;
	const call = m.adapter[op] as (tx: Transaction, s: Viewer["session"], o: Owner, i: unknown) => Promise<unknown>;
	try {
		const value = await m.db.transaction((tx) => call(tx, viewer.session, selected, input));
		return { status: "ok", value };
	} catch (e) {
		if (e instanceof z.ZodError) return { status: "refused", code: "invalid_input" };
		const code = e instanceof Error && REFUSAL_CODE.test(e.message) ? e.message : null;
		if (code) return { status: "refused", code };
		throw e;
	}
}

/** The history scope of this viewer: its plant, its organization, or its own Discovery account. */
export function scopeOf(viewer: Viewer) {
	const s = viewer.selected;
	if (s.kind === "plant") return C.relationshipHistoryScope.parse({ plant: s });
	if (s.kind === "organization") return C.relationshipHistoryScope.parse({ organization: s });
	return C.relationshipHistoryScope.parse({ discoveryAccountId: viewer.accountId });
}

/**
 * Display names for the IDs a page shows. Plants and organizations by name. Accounts only when they hold a seat in
 * this viewer's own workspace or are the viewer; anyone else stays unnamed.
 */
export async function namesFor(m: Mount, viewer: Viewer, ids: string[]): Promise<Record<string, string>> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return {};
	const [plants, orgs] = await Promise.all([
		m.db.select({ id: t.plant.id, name: t.plant.name }).from(t.plant).where(inArray(t.plant.id, unique)),
		m.db
			.select({ id: t.organization.id, name: t.organization.name })
			.from(t.organization)
			.where(inArray(t.organization.id, unique)),
	]);
	const workspace = viewer.selected.kind === "account" ? null : viewer.selected;
	const visible = await m.db
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
	const people = await Promise.all(
		visible.map(async ({ id }) => {
			const r = await m.db.execute<{ display_name: string | null }>(
				sql`SELECT display_name FROM seat_identity(${id}::uuid)`,
			);
			return { id, name: r.rows[0]?.display_name ?? "" };
		}),
	);
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
} as const;

/** This subject's own requests still waiting for an answer (ruling D2: the contract has no read for them). */
export async function pendingFor(m: Mount, viewer: Viewer) {
	const column = SUBJECT_COLUMN[viewer.kind];
	if (!column) return [];
	const subject = viewer.kind === "discovery" ? viewer.accountId : viewer.selected.id;
	const rows = await m.db.execute<{
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
		C.invitationResult.omit({ receipt: true }).parse({
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
export async function targetsFor(m: Mount, viewer: Viewer, active: Set<string>) {
	if (viewer.kind === "sending_network") return [];
	const rows = await m.db
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
export async function subjectFacts(m: Mount, viewer: Viewer) {
	if (viewer.kind === "discovery") {
		const [a] = await m.db
			.select({ revision: t.account.revision })
			.from(t.account)
			.where(eq(t.account.id, viewer.accountId));
		return { revision: String(a?.revision ?? "0"), zone: "UTC" };
	}
	if (viewer.kind === "plant") {
		const [p] = await m.db
			.select({ revision: t.plant.revision, zone: t.plant.timezone })
			.from(t.plant)
			.where(eq(t.plant.id, viewer.selected.id));
		return { revision: String(p?.revision ?? "0"), zone: p?.zone ?? "UTC" };
	}
	const [o] = await m.db
		.select({ revision: t.organization.revision, zone: t.organization.timezone })
		.from(t.organization)
		.where(eq(t.organization.id, viewer.selected.id));
	return { revision: String(o?.revision ?? "0"), zone: o?.zone ?? "UTC" };
}

/** This account's own residency links, newest first, with the organization name. */
export async function residencyLinks(m: Mount, viewer: Viewer) {
	return m.db
		.select({ linkId: t.residency_link.id, organizationName: t.organization.name })
		.from(t.residency_link)
		.innerJoin(t.organization, eq(t.organization.id, t.residency_link.organization_id))
		.where(eq(t.residency_link.account_id, viewer.accountId))
		.orderBy(sql`${t.residency_link.accepted_at} DESC`)
		.limit(20);
}

export async function disclosureFor(m: Mount, viewer: Viewer, pair: unknown) {
	const reply = await m.db.transaction((tx) => readSharingDisclosure(tx, viewer.session, viewer.selected, pair));
	return "status" in reply ? null : reply;
}

/**
 * The request behind an emailed link (ruling D10). It answers only when the link's proof matches this pending,
 * unexpired request; anything else is the same `null`, so the page never says which check failed. The proof is
 * hashed here and never stored. The answer itself is still authorized by associations.respondInvitation.
 */
export async function invitationFor(m: Mount, invitationId: string, proof: string) {
	if (!z.uuid().safeParse(invitationId).success || proof.length < 1 || proof.length > 4096) return null;
	const rows = await m.db.execute<{
		token_hash: string;
		state: string;
		revision: string;
		created_at: string;
		plant_id: string | null;
		account_id: string | null;
		sending_church_id: string | null;
		organization_id: string;
		organization_kind: "sending_church" | "sending_network";
		inviter_description: string;
	}>(
		sql`SELECT i.token_hash, i.state, i.revision::text AS revision, to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, r.plant_id, r.account_id, r.sending_church_id, r.organization_id, o.kind AS organization_kind, r.inviter_description
		FROM invitation i JOIN relationship_invitation r ON r.invitation_id = i.id JOIN organization o ON o.id = r.organization_id
		WHERE i.id = ${invitationId}`,
	);
	const r = rows.rows[0];
	if (!r || r.state !== "pending") return null;
	if (createHash("sha256").update(proof).digest("hex") !== r.token_hash) return null;
	const expiresAt = new Date(new Date(r.created_at).getTime() + 30 * 86_400_000);
	if (expiresAt.getTime() <= Date.now()) return null;
	const organization = { kind: "organization", id: r.organization_id, organizationKind: r.organization_kind } as const;
	const pair = r.plant_id
		? { kind: "plant", subject: { kind: "plant", id: r.plant_id }, organization }
		: r.sending_church_id
			? {
					kind: "sending_church",
					subject: { kind: "organization", id: r.sending_church_id, organizationKind: "sending_church" },
					organization,
				}
			: { kind: "discovery", accountId: r.account_id, organization };
	return C.invitationResult.omit({ receipt: true }).parse({
		status: "pending",
		invitationId,
		pair,
		revision: r.revision,
		expiresAt: expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
		inviterDescription: r.inviter_description,
	});
}
