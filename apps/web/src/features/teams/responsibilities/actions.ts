"use server";

import { getViewer } from "@/server/request-context";
import { responsibilityWriter } from "@everyfield/domain/teams";
import { write, type Viewer } from "../server.ts";

const noSeat = { status: "refused", code: "unavailable" } as const;
type Seat = Viewer;

async function seat(): Promise<Seat | null> {
	return (await getViewer())?.people ?? null;
}

const command = (requestKey: string, expectedRevision: string, input: unknown) => ({
	requestKey,
	expectedRevision,
	input,
});

export async function offerResponsibilities(requestKey: string, expectedRevision: string, input: unknown) {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, (tx, ctx) =>
		responsibilityWriter.offerResponsibilities(tx, ctx, command(requestKey, expectedRevision, input)),
	);
}

export async function addResponsibility(requestKey: string, expectedRevision: string, teamId: string, text: string) {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, (tx, ctx) =>
		responsibilityWriter.addResponsibility(tx, ctx, command(requestKey, expectedRevision, { teamId, text })),
	);
}

export async function editResponsibility(
	requestKey: string,
	expectedRevision: string,
	responsibilityId: string,
	text: string,
) {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, (tx, ctx) =>
		responsibilityWriter.editResponsibility(tx, ctx, command(requestKey, expectedRevision, { responsibilityId, text })),
	);
}

export async function completeResponsibility(
	requestKey: string,
	expectedRevision: string,
	responsibilityId: string,
	done: boolean,
) {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, (tx, ctx) =>
		responsibilityWriter.completeResponsibility(
			tx,
			ctx,
			command(requestKey, expectedRevision, { responsibilityId, done }),
		),
	);
}

export async function deleteResponsibility(requestKey: string, expectedRevision: string, responsibilityId: string) {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, (tx, ctx) =>
		responsibilityWriter.deleteResponsibility(tx, ctx, command(requestKey, expectedRevision, { responsibilityId })),
	);
}
