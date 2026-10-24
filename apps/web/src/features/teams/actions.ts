"use server";

import { getViewer } from "@/server/request-context";
import { reviewDigest, teamsWriter } from "@everyfield/domain/teams";
import type { Transaction } from "@everyfield/db/client";
import type { TeamsReply } from "@everyfield/contracts/teams";
import { redirect } from "next/navigation";
import type { Outcome } from "./model.ts";
import {
	loadTeam,
	loadTeams,
	outcome,
	readCatalog,
	readExport,
	readHistory,
	write,
	type TeamView,
	type TeamsView,
	type Viewer,
} from "./server.ts";

// Server actions behind the teams screens: the browser boundary. Each one rebuilds the viewer from the request and
// hands the browser's values to the producer, which parses them with the WP-017 contract (strict objects: no owner,
// actor or authority can be sent). A lost answer may be retried with the same request key; the producer replays a
// write that did commit instead of acting twice.
//
// A write answers with its own result, never with the page read again (patterns.md, Writes): the page draws the
// change from that answer (page-state.ts). After a refusal as out of date, the page reads itself in its own request.

const noSeat = { status: "refused", code: "unavailable" } as const;
type Context = Parameters<typeof teamsWriter.create>[1];
type Run<T> = (tx: Transaction, ctx: Context) => Promise<TeamsReply<T>>;

async function seat() {
	return (await getViewer())?.people ?? null;
}
/** One write in its own transaction. */
async function change<T>(run: Run<T>): Promise<Outcome<T>> {
	const v = await seat();
	if (!v) return noSeat;
	return write(v, run);
}
const command = (requestKey: string, expectedRevision: string, input: unknown) => ({
	requestKey,
	expectedRevision,
	input,
});

// Teams ---------------------------------------------------------------------------------------------------------

/** Creates a ministry and opens its page in the same response. A refusal comes back as an Outcome. */
export async function createTeam(requestKey: string, input: unknown) {
	const v = await seat();
	if (!v) return noSeat;
	const r = await write(v, (tx, ctx) => teamsWriter.create(tx, ctx, { requestKey, input }));
	if (r.status === "ok") redirect(`/ministries/${r.value.team.id}`);
	return r;
}

/** Edit, correct (with a reason), archive or restore one ministry, at the revision the page last saw. */
export async function changeTeam(
	op: "edit" | "correct" | "archive" | "restore",
	requestKey: string,
	expectedRevision: string,
	teamId: string,
	patch: Record<string, unknown> = {},
) {
	if (!["edit", "correct", "archive", "restore"].includes(op))
		return { status: "refused", code: "invalid_input" } as const;
	return change((tx, ctx) => teamsWriter[op](tx, ctx, command(requestKey, expectedRevision, { ...patch, teamId })));
}

/** Appoints a leader explicitly. It outranks a leader that comes from a leadership role (REQ-TEAM-004). */
export async function appointLeader(requestKey: string, expectedRevision: string, teamId: string, personId: string) {
	return change((tx, ctx) =>
		teamsWriter.appointLeader(tx, ctx, command(requestKey, expectedRevision, { teamId, personId })),
	);
}

// Roles and people ----------------------------------------------------------------------------------------------

export async function createRole(requestKey: string, teamId: string, input: Record<string, unknown>) {
	return change((tx, ctx) => teamsWriter.createRole(tx, ctx, { requestKey, input: { ...input, teamId } }));
}
export async function editRole(
	requestKey: string,
	expectedRevision: string,
	roleId: string,
	patch: Record<string, unknown>,
) {
	return change((tx, ctx) =>
		teamsWriter.editRole(tx, ctx, command(requestKey, expectedRevision, { ...patch, roleId })),
	);
}
/** Takes a role out of the current structure. Its holder's tenure ends; past tenure stays in the history. */
export async function retireRole(requestKey: string, expectedRevision: string, roleId: string) {
	return change((tx, ctx) => teamsWriter.retireRole(tx, ctx, command(requestKey, expectedRevision, { roleId })));
}
/** Puts one live person in one open role. The answer says when they now serve on two or more teams. */
export async function assignRole(
	requestKey: string,
	expectedRevision: string,
	teamId: string,
	roleId: string,
	personId: string,
) {
	return change((tx, ctx) =>
		teamsWriter.assignRole(tx, ctx, command(requestKey, expectedRevision, { roleId, teamId, personId })),
	);
}
/** Ends every role the person holds on this ministry. Stage, commitments and training stay as they are. */
export async function endMembership(requestKey: string, expectedRevision: string, teamId: string, personId: string) {
	return change((tx, ctx) =>
		teamsWriter.endMembership(tx, ctx, command(requestKey, expectedRevision, { teamId, personId })),
	);
}
/** A former member back in their old role, as a new tenure that keeps the old dates. */
export async function reactivateMembership(
	requestKey: string,
	expectedRevision: string,
	roleId: string,
	personId: string,
) {
	return change((tx, ctx) =>
		teamsWriter.reactivateMembership(tx, ctx, command(requestKey, expectedRevision, { roleId, personId })),
	);
}

/** The ministry page's data again, after a change was refused as out of date. */
export async function reloadTeam(teamId: string): Promise<Outcome<TeamView | null>> {
	const v = await seat();
	if (!v) return noSeat;
	const view = await loadTeam(v, teamId);
	if (view.status === "failed") return { status: "lost" };
	return { status: "ok", value: view.status === "found" ? view : null };
}
export async function teamHistory(teamId: string) {
	const v = await seat();
	if (!v) return noSeat;
	return outcome(await readHistory(v, teamId));
}

// Setup from templates (REQ-TEAM-003) ---------------------------------------------------------------------------

export async function templateCatalog() {
	const v = await seat();
	if (!v) return noSeat;
	return outcome(await readCatalog(v));
}

type Selection = { teamKey: string; roleKeys: string[] };
/**
 * Adds the templates the person just reviewed. The digest is computed here from those choices, so the browser never
 * computes it and cannot send a review for a different choice. The answer says how many ministries and roles are new.
 */
export async function importTemplates(
	requestKey: string,
	version: string,
	selections: Selection[],
): Promise<Outcome<{ newTeams: number; newRoles: number }>> {
	const v = await seat();
	if (!v) return noSeat;
	const digest = reviewDigest({ expectedVersion: version, mode: "import", selections, lines: [] });
	const done = await write(v, (tx, ctx) =>
		teamsWriter.initialize(tx, ctx, {
			requestKey,
			input: { expectedVersion: version, reviewDigest: digest, mode: "import", selections },
		}),
	);
	if (done.status !== "ok") return done;
	return { status: "ok", value: { newTeams: done.value.newTeams, newRoles: done.value.newSelectedRoles } };
}
/**
 * The ministries list and chart again, after an import created ministries whose ids only the server knows. A read in
 * its own request, so the import's write request stays within its statement budget.
 */
export async function reloadTeams(): Promise<Outcome<TeamsView>> {
	const v = await seat();
	if (!v) return noSeat;
	return { status: "ok", value: await loadTeams(v) };
}
// Organization view (REQ-TEAM-012) ------------------------------------------------------------------------------

/** The drawing as SVG text and PDF text, drawn from the same lines. Reading it again reauthorizes the current seat. */
export async function exportChart(includeArchived: boolean) {
	const v: Viewer | null = await seat();
	if (!v) return noSeat;
	const r = outcome(await readExport(v, includeArchived === true));
	return r.status === "ok" ? ({ status: "ok", value: { svg: r.value.svg, pdf: r.value.pdf } } as const) : r;
}
