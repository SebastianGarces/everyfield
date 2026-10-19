import "server-only";
import { createDatabase, type Database, type Transaction } from "@everyfield/db/client";
import { sessionResult, currentMembershipResult } from "@everyfield/contracts/identity";
import { listPeopleRequest } from "@everyfield/contracts/people";
import type * as people from "@everyfield/contracts/people";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import { createSeatService, InvitationRefusal } from "@everyfield/domain/identity";
import { peopleReader } from "@everyfield/domain/people";
import { headers } from "next/headers";
import { cache } from "react";
import type { z } from "zod";
import { identityHandler } from "@/server/identity";
import { isFiltered, listRequest, type PeopleQuery } from "./model.ts";

// The People server boundary (R2). It reads the real session through the mounted identity handler and the current
// seat through the seat service, then runs WP-011/api operations inside one transaction each. The browser never sends
// an owner, account, origin or authority; every call rebuilds them from the request.

export type Role = "owner" | "admin" | "member";
export type Viewer = {
	session: PeopleContext["session"];
	accountId: string;
	selected: PeopleContext["selected"];
	role: Role;
};
/** Why a screen cannot open: signed out goes to sign-in; the rest see the no-access state. */
export type ViewerResult =
	{ status: "viewer"; viewer: Viewer } | { status: "signed_out" } | { status: "no_access" } | { status: "unavailable" };

let db: Database | undefined;
function database(): Database | null {
	// The same runtime role connection the identity mount uses. Never the operator DATABASE_URL.
	const url = process.env.IDENTITY_DATABASE_URL;
	if (!url) return null;
	db ??= createDatabase({ connectionString: url, max: 5 });
	return db;
}

async function readSession() {
	const origin = process.env.IDENTITY_ORIGIN;
	if (!origin) return null;
	const cookie = (await headers()).get("cookie");
	const response = await identityHandler(
		new Request(new URL("/api/auth/get-session", origin), {
			headers: { host: new URL(origin).host, ...(cookie ? { cookie } : {}) },
		}),
	);
	if (!response.ok) return null;
	const parsed = sessionResult.safeParse(await response.json().catch(() => null));
	return parsed.success ? parsed.data : null;
}

/** The viewer of this request, read once per request (layout and page share it). */
export const resolveViewer = cache(async (): Promise<ViewerResult> => {
	const store = database();
	const session = await readSession();
	if (!store || !session) return { status: "unavailable" };
	if (session.status === "unauthenticated") return { status: "signed_out" };
	if (session.status !== "active") return { status: "no_access" };
	const membership = currentMembershipResult.safeParse(
		await createSeatService(store)
			.readCurrentMembership(session.sessionId)
			.catch((error: unknown) => {
				if (error instanceof InvitationRefusal && error.value.code === "temporary") return { status: "unavailable" };
				throw error;
			}),
	);
	if (!membership.success) return { status: "unavailable" };
	const m = membership.data;
	if (m.status === "unavailable") return { status: "unavailable" };
	// People is a plant workspace screen. An organization seat, no seat or an ended seat cannot open it.
	if (m.status !== "active" || m.workspace.kind !== "plant") return { status: "no_access" };
	return {
		status: "viewer",
		viewer: { session: session.sessionId, accountId: session.accountId, selected: m.workspace, role: m.role },
	};
});

export const canWrite = (v: Viewer) => v.role === "owner" || v.role === "admin";

/** Runs one read in its own transaction. A thrown database error reads as unavailable, never as a crash. */
export async function read<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: PeopleContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	const store = database();
	if (!store) return { status: "failed" };
	try {
		return await store.transaction((tx) =>
			run(tx, { session: viewer.session, selected: viewer.selected, purpose: "native" }),
		);
	} catch (error) {
		console.error(JSON.stringify({ component: "people", outcome: "read_failed", error: String(error) }));
		return { status: "failed" };
	}
}

/** Runs one native write in its own transaction. Origin is built here, never taken from the browser. */
export async function write<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: PeopleWriteContext) => Promise<PeopleReply<T>>,
): Promise<PeopleReply<T> | { status: "failed" }> {
	const store = database();
	if (!store) return { status: "failed" };
	try {
		return await store.transaction((tx) =>
			run(tx, {
				session: viewer.session,
				selected: viewer.selected,
				purpose: "native",
				origin: { kind: "native" },
			}),
		);
	} catch (error) {
		console.error(JSON.stringify({ component: "people", outcome: "write_failed", error: String(error) }));
		return { status: "failed" };
	}
}

export type PeopleData =
	| { kind: "list"; page: z.infer<typeof people.peoplePage>; expired: boolean }
	| { kind: "pipeline"; pipeline: z.infer<typeof people.pipelineResult> }
	| { kind: "failed" };
/** One loaded People view: the query it answers (an expired cursor resets its page), its data and whether the church has no people at all. */
export type PeopleView = { query: PeopleQuery; data: PeopleData; workspaceEmpty: boolean };

/** Loads the list rows (list and cards) or the pipeline for a query. The page load and a client view switch both use it. */
export async function loadPeople(viewer: Viewer, query: PeopleQuery): Promise<PeopleView> {
	// The address is browser input: parse it into the contract request at this boundary.
	const request = (q: PeopleQuery) => listPeopleRequest.parse(listRequest(q));
	if (query.view === "pipeline") {
		const r = await read(viewer, (tx, ctx) => peopleReader.getPipelineData(tx, ctx, request(query)));
		return {
			query,
			data: r.status === "ok" ? { kind: "pipeline", pipeline: r.value } : { kind: "failed" },
			workspaceEmpty: r.status === "ok" && !isFiltered(query) && r.value.groups.every((g) => g.total === 0),
		};
	}
	let r = await read(viewer, (tx, ctx) => peopleReader.listPeople(tx, ctx, request(query)));
	// A cursor from an old link (another session or a restarted server) is refused; show the first page instead.
	const expired = r.status === "refused" && r.error.code === "invalid_input" && query.trail.length > 0;
	if (expired) {
		const first = { ...query, trail: [], page: 1 };
		r = await read(viewer, (tx, ctx) => peopleReader.listPeople(tx, ctx, request(first)));
		query = first;
	}
	return {
		query,
		data: r.status === "ok" ? { kind: "list", page: r.value, expired } : { kind: "failed" },
		workspaceEmpty: r.status === "ok" && !isFiltered(query) && r.value.total === 0,
	};
}
