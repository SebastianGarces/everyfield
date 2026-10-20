import { owner, type Owner } from "@everyfield/contracts/common";
import type { OrganizationOperations } from "@everyfield/contracts/organizations";
import * as C from "@everyfield/contracts/organizations";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import type { RequestActor } from "@everyfield/domain/access";
import { createSeatService } from "@everyfield/domain/identity";
import { auditTransaction } from "@everyfield/domain/operations";
import {
	createOrganizationAdapter,
	readAnswerableInvitation,
	readSharingDisclosure,
	type Kind,
	type Viewer,
} from "@everyfield/domain/organizations";
import "server-only";
import { z } from "zod";
import { database } from "../database";
import { createMailService } from "../jobs/mail";
import { enqueueJob } from "../jobs/queue";
import { getViewer } from "../request-context";

// The organization mount (WP-007/ui ruling D11). Screens reach it only through features/organizations/actions.ts.
// The session comes from the identity mount and the workspace from the seat service; every command runs through the
// WP-007/api adapter in one transaction, which rechecks all authority. Mail and notices are enqueued only: WP-031
// dispatches them. Domain reads supply names, waiting requests and residency links for the viewer's scope.

const env = z.object({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_MAIL_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_ADDRESS_KEY: z.string().regex(/^[a-f0-9]{64}$/),
	IDENTITY_MAIL_FROM: z.email(),
});

export type Operation = keyof OrganizationOperations;
export type Reply<T = unknown> = { status: "ok"; value: T } | { status: "refused"; code: string };
export type Mount = NonNullable<ReturnType<typeof current>>;
export /** The domain refuses by throwing a short code (`refuse()` in core.ts); anything else is not a refusal. */
const REFUSAL_CODE = /^[a-z_]{3,40}$/;

let mount: ReturnType<typeof create> | undefined;
function create(v: z.infer<typeof env>) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const mail = createMailService({
		db,
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
		from: v.IDENTITY_MAIL_FROM,
		// A relationship invitation goes to the typed address only; nothing else is sent from this mount.
		authorize: async (_tx, mail) =>
			new Set(mail.filter((m) => m.purpose === "relationship_invitation" && m.recipient === null).map((m) => m.id)),
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

export type { Kind, Viewer } from "@everyfield/domain/organizations";
/** Who is asking, from the session and the one current seat. Seatless accounts count only with a Discovery profile. */
export async function viewerOf(): Promise<
	| { kind: "signed_out" }
	| { kind: "unavailable" }
	| { kind: "viewer"; viewer: Viewer; mount: Mount; authority: RequestActor }
> {
	const m = current();
	if (!m) return { kind: "unavailable" };
	const s = await getViewer();
	if (!s) return { kind: "unavailable" };
	if (s.status === "unauthenticated") return { kind: "signed_out" };
	if (s.status !== "active") return { kind: "unavailable" };
	const authority = s.authority;
	if (!authority) return { kind: "unavailable" };
	const actor = authority.actor;
	if (!actor) return { kind: "unavailable" };
	const context = actor.context;
	const selected = context.owner;
	const kind: Kind =
		selected.kind === "plant"
			? "plant"
			: selected.kind === "organization"
				? selected.organizationKind
				: s.discovery
					? "discovery"
					: "account";
	return {
		kind: "viewer",
		mount: m,
		authority,
		viewer: {
			kind,
			session: s.sessionId,
			accountId: s.accountId,
			selected,
			canManage: context.kind === "seat" ? context.role !== "member" : s.discovery,
		},
	};
}

/** The owner a residency operation runs as: the resident's own account. */
export const residentOwner = (viewer: Viewer) => owner.parse({ kind: "account", id: viewer.accountId });

/** The domain's refusal code, or rethrow. */
function refusalOf(e: unknown): Reply<never> {
	if (e instanceof z.ZodError) return { status: "refused", code: "invalid_input" };
	const code = e instanceof Error && REFUSAL_CODE.test(e.message) ? e.message : null;
	if (code) return { status: "refused", code };
	throw e;
}

/**
 * One command in one transaction with the request actor bound to it (D70). The caller names the concrete adapter
 * method, so the input and output types are the operation's own.
 */
export async function command<T>(
	m: Mount,
	authority: RequestActor,
	selected: Owner,
	body: (tx: Transaction, session: Viewer["session"], selected: Owner) => Promise<T>,
): Promise<Reply<T>> {
	try {
		const value = await auditTransaction(m.db, async (tx) => {
			if (!(await authority.bind(tx, selected))) throw new Error("unavailable");
			return body(tx, authority.session, selected);
		});
		return { status: "ok", value };
	} catch (e) {
		return refusalOf(e);
	}
}

/** One read in one short transaction without write binding or locks (D59). */
export async function query<T>(
	m: Mount,
	authority: RequestActor,
	selected: Owner,
	body: (tx: Transaction, session: Viewer["session"], selected: Owner) => Promise<T>,
): Promise<Reply<T>> {
	try {
		return { status: "ok", value: await m.db.transaction((tx) => body(tx, authority.session, selected)) };
	} catch (e) {
		return refusalOf(e);
	}
}

/** The history scope of this viewer: its plant, its organization, or its own Discovery account. */
export function scopeOf(viewer: Viewer) {
	const s = viewer.selected;
	if (s.kind === "plant") return C.relationshipHistoryScope.parse({ plant: s });
	if (s.kind === "organization") return C.relationshipHistoryScope.parse({ organization: s });
	return C.relationshipHistoryScope.parse({ discoveryAccountId: viewer.accountId });
}

export async function disclosureFor(m: Mount, viewer: Viewer, pair: unknown) {
	const reply = await m.db.transaction((tx) => readSharingDisclosure(tx, viewer.session, viewer.selected, pair));
	return "status" in reply ? null : reply;
}

/**
 * The request behind an emailed link (rulings D10, D48). The domain's readAnswerableInvitation applies the shipped
 * authorizedReceiver rule and every answer check before any detail leaves; this mount adds none of its own. Anything
 * else is `null`, the one shared refusal.
 */
export async function invitationFor(m: Mount, viewer: Viewer, invitationId: string, proof: string) {
	const reply = await m.db.transaction((tx) =>
		readAnswerableInvitation(tx, viewer.session, viewer.selected, { invitationId, proof }),
	);
	return reply.status === "pending" ? reply : null;
}

export {
	connectionRevision,
	idsIn,
	namesFor,
	pairOf,
	pendingFor,
	readHistory,
	readPlantSharing,
	residencyLinks,
	residencyRevision,
	subjectFacts,
	targetsFor,
} from "@everyfield/domain/organizations";
