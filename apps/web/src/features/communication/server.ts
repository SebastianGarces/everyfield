import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { Transaction } from "@everyfield/db/client";
import {
	communicationWriter,
	withCommunicationWrite,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import "server-only";
import type { Outcome, PageData } from "./model.ts";

// The Messages screens reach the WP-027 writer here. Reads recheck the live seat. Writes recheck authority inside
// the write statement. A member may read drafts and templates. Audience, preview and writes need an Owner or Admin.

type Peopled = NonNullable<NonNullable<Awaited<ReturnType<typeof getViewer>>>["people"]>;
export type Viewer = Peopled;
export const canWrite = (viewer: Viewer) => viewer.role === "owner" || viewer.role === "admin";

/** The request's plant seat. Signed out, no plant seat, and a setup failure stay distinct. */
export async function communicationViewer() {
	try {
		const viewer = await getViewer();
		return {
			viewer: viewer?.people ?? null,
			signedOut: !viewer || viewer.status === "unauthenticated",
			ok: viewer !== null,
		};
	} catch (error) {
		console.error(JSON.stringify({ component: "communication", outcome: "viewer_failed", error: String(error) }));
		return { viewer: null, signedOut: false, ok: false };
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

/** Drafts, templates and teams for the page. Three statements for an Owner or Admin. A member skips the team read. */
export function loadCommunicationPage(viewer: Viewer): Promise<Outcome<PageData>> {
	return read(viewer, async (tx) => {
		const drafts = await communicationWriter.list(tx, viewer.authority);
		if (drafts.status !== "ok") return drafts;
		const templates = await communicationWriter.listTemplates(tx, viewer.authority);
		if (templates.status !== "ok") return templates;
		if (!canWrite(viewer)) {
			return { status: "ok", value: { drafts: drafts.value.drafts, templates: templates.value.templates, teams: [] } };
		}
		const teams = await communicationWriter.listAudienceTeams(tx, viewer.authority);
		if (teams.status !== "ok") return teams;
		return {
			status: "ok",
			value: { drafts: drafts.value.drafts, templates: templates.value.templates, teams: teams.value.teams },
		};
	});
}
