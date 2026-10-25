"use server";

import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { TeamsReply } from "@everyfield/contracts/teams";
import type { Database } from "@everyfield/db/client";
import { responsibilityReader, responsibilityWriter } from "@everyfield/domain/teams";
import type { Outcome } from "../model.ts";
import { outcome, write, type Viewer } from "../server.ts";

// Browser boundary for responsibilities (REQ-TEAM-007). The producer parses every value. A read writes nothing.
// A lost answer may be retried with the same request key; the producer replays a write that did commit.

const noSeat = { status: "refused", code: "unavailable" } as const;
type Seat = Viewer;

async function seat(): Promise<Seat | null> {
	return (await getViewer())?.people ?? null;
}

async function read<T>(
	viewer: Seat,
	run: (db: Database, authority: Seat["authority"]) => Promise<TeamsReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await run(db, viewer.authority));
	} catch (error) {
		console.error(JSON.stringify({ component: "responsibilities", outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

/** The ministry's responsibilities for one page. Reading creates nothing. */
export async function listResponsibilities(teamId: string, page: number) {
	const v = await seat();
	if (!v) return noSeat;
	return read(v, (db, authority) => responsibilityReader.listResponsibilities(db, authority, { teamId, page }));
}

/** Playbook lines this ministry has not accepted. Reading creates nothing. */
export async function previewResponsibilities(teamId: string) {
	const v = await seat();
	if (!v) return noSeat;
	return read(v, (db, authority) => responsibilityReader.previewResponsibilities(db, authority, { teamId }));
}

const command = (requestKey: string, expectedRevision: string, input: unknown) => ({
	requestKey,
	expectedRevision,
	input,
});

/** Accepts the reviewed lines, or declines the playbook offer. The digest is the preview the person saw. */
export async function offerResponsibilities(
	requestKey: string,
	expectedRevision: string,
	input: {
		teamId: string;
		decision: "accept" | "decline";
		selected: string[];
		expectedVersion: string;
		reviewDigest: string;
	},
) {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, (tx, ctx) =>
		responsibilityWriter.offerResponsibilities(tx, ctx, command(requestKey, expectedRevision, input)),
	);
}

/** Adds one responsibility this ministry wrote itself. */
export async function addResponsibility(requestKey: string, expectedRevision: string, teamId: string, text: string) {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, (tx, ctx) =>
		responsibilityWriter.addResponsibility(tx, ctx, command(requestKey, expectedRevision, { teamId, text })),
	);
}

/** Changes the words of one responsibility. */
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

/** Checks a responsibility off, or clears that check. The date is the church's day. It does not move a phase. */
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

/** Removes one responsibility. A playbook line removed this way does not come back. */
export async function deleteResponsibility(requestKey: string, expectedRevision: string, responsibilityId: string) {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, (tx, ctx) =>
		responsibilityWriter.deleteResponsibility(tx, ctx, command(requestKey, expectedRevision, { responsibilityId })),
	);
}
