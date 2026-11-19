import { owner, type Owner } from "@everyfield/contracts/common";
import * as C from "@everyfield/contracts/organizations";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveAccess, type RequestActor } from "@everyfield/domain/access";
import { createSeatService } from "@everyfield/domain/identity";
import { auditTransaction } from "@everyfield/domain/operations";
import {
	createOrganizationAdapter,
	geographyReference,
	readAnswerableInvitation,
	residencyLinks,
	readSharingDisclosure,
	type Kind,
	type OrganizationEffects,
	type Viewer,
} from "@everyfield/domain/organizations";
import { cache } from "react";
import "server-only";
import { z } from "zod";
import { serverConfig, type ServerConfig } from "../../server/config.ts";
import { database } from "../../server/database";
import { createMailService, MAIL_PASSES, runDueMail, type MailPass, type MailTransport } from "../../server/jobs/mail";
import { getViewer } from "../../server/request-context";
import { invitationLink } from "../../server/invitations";

export type Reply<T = unknown> = { status: "ok"; value: T } | { status: "refused"; code: string };
export type Mount = ReturnType<typeof current>;
const REFUSAL_CODE = /^[a-z_]{3,40}$/;

const expiryDay = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });

function organizationMail(v: ServerConfig, transport?: MailTransport) {
	return createMailService({
		db: database(v.IDENTITY_DATABASE_URL),
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey: Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex"),
		from: v.IDENTITY_MAIL_FROM,
		authorize: async (_tx, mail) =>
			new Set(mail.filter((m) => m.purpose === "relationship_invitation" && m.recipient === null).map((m) => m.id)),
		transport,
	});
}

export function organizationMailPass(transport: MailTransport): MailPass {
	const v = serverConfig();
	const db = database(v.IDENTITY_DATABASE_URL),
		mail = organizationMail(v, transport);
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.organization, limit, until);
}

let mount: ReturnType<typeof create> | undefined;
function create(v: ServerConfig) {
	const db: Database = database(v.IDENTITY_DATABASE_URL);
	const mail = organizationMail(v);
	const effects: OrganizationEffects = {
		async invitation(tx, input, writes) {
			if (input.owner.kind === "global") throw new Error("unavailable");
			const link = invitationLink(v.IDENTITY_ORIGIN, "/connections/respond", input.invitationId, input.proof);
			await mail.append(
				tx,
				{
					owner: input.owner,
					purpose: "relationship_invitation",
					logicalKey: `relationship/${input.invitationId}/${input.operationId}`,
					recipient: null,
					address: input.recipientEmail,
					content: {
						subject: `${input.inviterDescription} asks to connect on Everyfield`,
						text: `${input.inviterDescription} asks to connect on Everyfield. Open this link to accept or decline. It works until ${expiryDay.format(new Date(input.expiresAt))} (UTC).\n\n${link}`,
					},
					operation: input.operationId,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				writes,
			);
		},
		invalidate(_tx, input) {
			return sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${input.sourceId} AND kind='digest' AND state IN ('ready','retry_wait','claimed')`;
		},
	};
	const adapter = createOrganizationAdapter(effects, geographyReference);
	return { db, adapter, effects, seats: createSeatService(db), origin: v.IDENTITY_ORIGIN };
}
export function current() {
	mount ??= create(serverConfig());
	return mount;
}

export type { Viewer } from "@everyfield/domain/organizations";
export async function viewerOf(): Promise<
	| { kind: "signed_out" }
	| { kind: "unavailable" }
	| { kind: "viewer"; viewer: Viewer; mount: Mount; authority: RequestActor }
> {
	const s = await getViewer();
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
		mount: current(),
		authority,
		viewer: {
			kind,
			session: s.sessionId,
			accountId: s.accountId,
			selected,
			canManage: context.kind === "seat" ? context.role !== "member" : s.discovery,
			access: liveAccess(authority),
		},
	};
}

export const ownResidencyLinks = cache(async () => {
	const who = await viewerOf();
	return who.kind === "viewer" ? residencyLinks(who.mount.db, who.viewer) : [];
});

export const residentOwner = (viewer: Viewer) => owner.parse({ kind: "account", id: viewer.accountId });

function refusalOf(e: unknown): Reply<never> {
	if (e instanceof z.ZodError) return { status: "refused", code: "invalid_input" };
	const code = e instanceof Error && REFUSAL_CODE.test(e.message) ? e.message : null;
	if (code) return { status: "refused", code };
	throw e;
}

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

export async function query<T>(
	m: Mount,
	authority: RequestActor,
	selected: Owner,
	body: (tx: Transaction, session: Viewer["session"], selected: Owner) => Promise<T>,
): Promise<Reply<T>> {
	try {
		return {
			status: "ok",
			value: await m.db.transaction((tx) => {
				authority.observe(tx);
				return body(tx, authority.session, selected);
			}),
		};
	} catch (e) {
		return refusalOf(e);
	}
}

export function scopeOf(viewer: Viewer) {
	const s = viewer.selected;
	if (s.kind === "plant") return C.relationshipHistoryScope.parse({ plant: s });
	if (s.kind === "organization") return C.relationshipHistoryScope.parse({ organization: s });
	return C.relationshipHistoryScope.parse({ discoveryAccountId: viewer.accountId });
}

export async function disclosureFor(m: Mount, authority: RequestActor, viewer: Viewer, pair: unknown) {
	const reply = await query(m, authority, viewer.selected, (tx, s, o) => readSharingDisclosure(tx, s, o, pair));
	return reply.status === "ok" && !("status" in reply.value) ? reply.value : null;
}

export async function invitationFor(
	m: Mount,
	authority: RequestActor,
	viewer: Viewer,
	invitationId: string,
	proof: string,
) {
	const reply = await query(m, authority, viewer.selected, (tx, s, o) =>
		readAnswerableInvitation(tx, s, o, { invitationId, proof }),
	);
	return reply.status === "ok" && reply.value.status === "pending" ? reply.value : null;
}

export {
	idsIn,
	namesFor,
	pendingFor,
	readHistory,
	readPipelineConsents,
	readPlantSharing,
	residencyLinks,
	subjectFacts,
	targetsFor,
} from "@everyfield/domain/organizations";
