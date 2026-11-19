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
import { appOrigin, mailReady, type MailReady } from "../../server/mail/transport.ts";
import { canWrite } from "../../components/seat-role.ts";
import { LOST, transient } from "../../server/platform/transient.ts";

type Peopled = NonNullable<Awaited<ReturnType<typeof getViewer>>["people"]>;
export type Viewer = Peopled;

export async function communicationViewer() {
	return transient(
		{ component: "communication", outcome: "viewer_failed" },
		async () => {
			const viewer = await getViewer();
			return {
				viewer: viewer.people ?? null,
				email: viewer.email ?? null,
				signedOut: viewer.status === "unauthenticated",
				ok: true,
			};
		},
		{ viewer: null, email: null, signedOut: false, ok: false },
	);
}

const outcome = <T>(reply: CommunicationReply<T>): Outcome<T> =>
	reply.status === "ok" ? { status: "ok", value: reply.value } : { status: "refused", code: reply.error.code };

export async function read<T>(
	viewer: Viewer,
	run: (tx: Transaction) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	return transient(
		{ component: "communication", outcome: "read_failed" },
		async () => {
			return outcome(await db.transaction((tx) => run(tx)));
		},
		LOST,
	);
}

export async function write<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: CommunicationContext) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	return transient(
		{ component: "communication", outcome: "write_failed" },
		async () => {
			return outcome(await withCommunicationWrite(db, viewer.authority, run));
		},
		LOST,
	);
}

export async function deliver<T>(
	run: (
		db: NonNullable<ReturnType<typeof requestDatabase>>,
		viewer: Viewer,
		mail: MailReady,
	) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	return deliverAs(await communicationViewer(), run);
}

export async function deliverAs<T>(
	seat: Awaited<ReturnType<typeof communicationViewer>>,
	run: Parameters<typeof deliver<T>>[0],
): Promise<Outcome<T>> {
	const viewer = seat.viewer;
	if (!viewer || !canWrite(viewer)) return { status: "refused", code: "access_denied" };
	const mail = mailReady();
	if (!mail) return { status: "refused", code: "unavailable" };
	const db = requestDatabase();
	return transient(
		{ component: "communication", outcome: "delivery_failed" },
		async () => outcome(await run(db, viewer, mail)),
		LOST,
	);
}

export function loadCommunicationPage(viewer: Viewer): Promise<Outcome<PageData>> {
	const origin = appOrigin();
	if (origin === null) return Promise.resolve({ status: "refused", code: "unavailable" });
	return read(viewer, async (tx) => {
		const templates = await communicationWriter.listTemplates(tx, viewer.authority);
		if (templates.status !== "ok") return templates;
		const church = await communicationWriter.readChurchName(tx, viewer.authority);
		if (church.status !== "ok") return church;
		const churchName = church.value.churchName;
		if (!canWrite(viewer)) {
			return {
				status: "ok",
				value: { templates: templates.value.templates, teams: [], churchName, origin },
			};
		}
		const teams = await communicationWriter.listAudienceTeams(tx, viewer.authority);
		if (teams.status !== "ok") return teams;
		return {
			status: "ok",
			value: {
				templates: templates.value.templates,
				teams: teams.value.teams,
				churchName,
				origin,
			},
		};
	});
}

export async function isReviewedFollowUp(viewer: Viewer, communicationId: string): Promise<boolean> {
	const detail = await read(viewer, (tx) =>
		communicationWriter.getDetail(tx, viewer.authority, { id: communicationId }),
	);
	return detail.status === "ok" && detail.value.state === "reviewed";
}
