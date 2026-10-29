import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import {
	communicationWriter,
	withCommunicationWrite,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import "server-only";
import type { Outcome, PageData } from "./model.ts";
import { deliveryTransport, mailReady, type MailReady } from "./mail.ts";

// The Messages screens reach the communication writer here. Reads recheck the live seat. Writes recheck authority
// inside the write statement. A member may read drafts and templates. Audience, preview and writes need an Owner or Admin.

type Peopled = NonNullable<NonNullable<Awaited<ReturnType<typeof getViewer>>>["people"]>;
export type Viewer = Peopled;
export const canWrite = (viewer: Viewer) => viewer.role === "owner" || viewer.role === "admin";

/** The request's plant seat. Signed out, no plant seat, and a setup failure stay distinct. */
export async function communicationViewer() {
	try {
		const viewer = await getViewer();
		return {
			viewer: viewer?.people ?? null,
			email: viewer?.email ?? null,
			signedOut: !viewer || viewer.status === "unauthenticated",
			ok: viewer !== null,
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "communication", outcome: "viewer_failed", error: String(error) }));
		return { viewer: null, email: null, signedOut: false, ok: false };
	}
}

const outcome = <T>(reply: CommunicationReply<T>): Outcome<T> =>
	reply.status === "ok" ? { status: "ok", value: reply.value } : { status: "refused", code: reply.error.code };

/** One read transaction. A database failure reads as lost, never as an empty list. */
export async function read<T>(
	viewer: Viewer,
	run: (tx: Transaction) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await db.transaction((tx) => run(tx)));
	} catch (error) {
		console.error(JSON.stringify({ component: "communication", outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

/** One native write. The actor comes from the request, never from the browser. */
export async function write<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: CommunicationContext) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await withCommunicationWrite(db, viewer.authority, run));
	} catch (error) {
		console.error(JSON.stringify({ component: "communication", outcome: "write_failed", error: String(error) }));
		return { status: "lost" };
	}
}

/** One provider call. Mail setup is checked before the domain writes a send. A thrown provider error stays lost. */
export async function deliver<T>(
	run: (
		db: NonNullable<ReturnType<typeof requestDatabase>>,
		viewer: Viewer,
		mail: MailReady,
	) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const seat = await communicationViewer();
	if (!seat.viewer || !canWrite(seat.viewer)) return { status: "refused", code: "access_denied" };
	const mail = mailReady();
	if (!mail) return { status: "refused", code: "unavailable" };
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await run(db, seat.viewer, mail));
	} catch (error) {
		console.error(
			JSON.stringify({
				component: "communication",
				outcome: "delivery_failed",
				error: error instanceof Error ? error.name : "error",
			}),
		);
		return { status: "lost" };
	}
}

export { deliveryTransport };

/** The church name for the inbox chrome. A failed statement fails the whole page read. */
async function churchNameOf(tx: Transaction, viewer: Viewer): Promise<string> {
	const rows = (
		await tx.execute(sql`SELECT name FROM plant WHERE id = ${viewer.authority.actor.context.owner.id}::uuid LIMIT 1`)
	).rows as { name?: string }[];
	return rows[0]?.name?.trim() || "Your church";
}

/** Drafts, templates, teams and the church name for the page. A member skips the team read. */
export function loadCommunicationPage(viewer: Viewer): Promise<Outcome<PageData>> {
	const origin = process.env.IDENTITY_ORIGIN ?? "";
	return read(viewer, async (tx) => {
		const drafts = await communicationWriter.list(tx, viewer.authority);
		if (drafts.status !== "ok") return drafts;
		const templates = await communicationWriter.listTemplates(tx, viewer.authority);
		if (templates.status !== "ok") return templates;
		const churchName = await churchNameOf(tx, viewer);
		if (!canWrite(viewer)) {
			return {
				status: "ok",
				value: { drafts: drafts.value.drafts, templates: templates.value.templates, teams: [], churchName, origin },
			};
		}
		const teams = await communicationWriter.listAudienceTeams(tx, viewer.authority);
		if (teams.status !== "ok") return teams;
		return {
			status: "ok",
			value: {
				drafts: drafts.value.drafts,
				templates: templates.value.templates,
				teams: teams.value.teams,
				churchName,
				origin,
			},
		};
	});
}
