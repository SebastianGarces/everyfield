import type { Outcome } from "@everyfield/contracts/common";
import { requestDatabase } from "@/server/database";
import { getViewer, seatOf, type PlantSeat } from "@/server/request-context";
import { outcomeOf } from "@everyfield/contracts/common";
import {
	communicationWriter,
	withCommunicationWrite,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import "server-only";
import type { PageData } from "./model.ts";
import { appOrigin, mailReady, type MailReady } from "../../server/mail/transport.ts";
import { canWrite } from "../../components/seat-role.ts";
import { LOST, transient } from "../../server/platform/transient.ts";
import { readTx, guardedWrite } from "../../server/platform/tx.ts";
import type { WriteTx } from "@everyfield/domain/access";

export type Viewer = PlantSeat;

export async function communicationViewer() {
	return transient(
		{ component: "communication", outcome: "viewer_failed" },
		async () => {
			const viewer = await getViewer();
			return {
				viewer: seatOf(viewer),
				email: viewer.email ?? null,
				signedOut: viewer.status === "unauthenticated",
				ok: true,
			};
		},
		{ viewer: null, email: null, signedOut: false, ok: false },
	);
}

export async function read<T>(
	viewer: Viewer,
	run: (tx: WriteTx) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	return readTx("communication", async (tx) => outcomeOf(await run(tx)));
}

export async function write<T>(
	viewer: Viewer,
	run: (tx: WriteTx, context: CommunicationContext) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	return guardedWrite("communication", async () =>
		outcomeOf(await withCommunicationWrite(requestDatabase(), viewer.authority, run)),
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
		async () => outcomeOf(await run(db, viewer, mail)),
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
		const { churchName, mailingAddress } = church.value;
		if (!canWrite(viewer)) {
			return {
				status: "ok",
				value: { templates: templates.value.templates, teams: [], churchName, mailingAddress, origin },
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
				mailingAddress,
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
