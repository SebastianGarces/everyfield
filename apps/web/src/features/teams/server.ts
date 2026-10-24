import { requestDatabase } from "@/server/database";
import type { Viewer } from "../meetings/server.ts";
import type { TeamsReply } from "@everyfield/contracts/teams";
import type { Database, Transaction } from "@everyfield/db/client";
import { teamsReader, withTeamsWrite } from "@everyfield/domain/teams";
import "server-only";
import type { ChartNode, Member, Outcome, Role, Team } from "./model.ts";

// The teams screens' data access. Every producer read is one statement without locks, so a page sends its reads side
// by side on the request's pool: the page waits for one round trip, not four. Writes run in their own transaction
// through the producer's native write, which checks the seat and the team leader inside it.

export type { Viewer };
export const isAdmin = (v: Viewer) => v.role === "owner" || v.role === "admin";

type Reply<T> = TeamsReply<T> | { status: "failed" };
type Authority = Viewer["authority"];

/** One producer read. A thrown database error reads as failed, never as a crash or as an empty list. */
async function read<T>(viewer: Viewer, run: (db: Database, a: Authority) => Promise<TeamsReply<T>>): Promise<Reply<T>> {
	const db = requestDatabase();
	if (!db) return { status: "failed" };
	try {
		return await run(db, viewer.authority);
	} catch (error) {
		console.error(JSON.stringify({ component: "teams", outcome: "read_failed", error: String(error) }));
		return { status: "failed" };
	}
}

/** One native write in its own transaction. The actor comes from the request, never from the browser. */
export async function write<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: Parameters<Parameters<typeof withTeamsWrite>[2]>[1]) => Promise<TeamsReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await withTeamsWrite(db, viewer.authority, run));
	} catch (error) {
		console.error(JSON.stringify({ component: "teams", outcome: "write_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export function outcome<T>(reply: Reply<T>): Outcome<T> {
	if (reply.status === "failed") return { status: "lost" };
	if (reply.status === "refused") return { status: "refused", code: reply.error.code };
	return { status: "ok", value: reply.value };
}
const value = <T>(r: Reply<T>): T | null => (r.status === "ok" ? r.value : null);

/** A team as the screens show it: the team, its leader's name, and whether this viewer may change it. */
export type TeamCard = Team & { leaderName: string | null };
function cards(teams: readonly Team[], nodes: readonly ChartNode[]): TeamCard[] {
	const leader = new Map(nodes.map((n) => [n.id, n.leaderName]));
	return teams.map((t) => ({ ...t, leaderName: leader.get(t.id) ?? null }));
}
/** Owners and Admins change every ministry; the linked leader changes their own (the producer decides again). */
export const canChange = (viewer: Viewer, team: Pick<Team, "leaderPersonId">) =>
	isAdmin(viewer) || (viewer.ownPersonId !== null && team.leaderPersonId === viewer.ownPersonId);

export type TeamsView = Awaited<ReturnType<typeof loadTeams>>;
/**
 * The ministries list and the organization view: every team (archived ones too, so the switch to show them sends no
 * read) and the chart's nodes, which carry each leader's name. Two reads side by side.
 */
export async function loadTeams(viewer: Viewer) {
	const [list, chart] = await Promise.all([
		read(viewer, (db, a) => teamsReader.list(db, a, { includeArchived: true })),
		read(viewer, (db, a) => teamsReader.readOrgChart(db, a, { includeArchived: true })),
	]);
	const teams = value(list);
	const nodes = value(chart)?.nodes ?? [];
	return { teams: teams ? cards(teams.items, nodes) : null, nodes };
}

export type TeamView = Extract<Awaited<ReturnType<typeof loadTeam>>, { status: "found" }>;
/**
 * One ministry: the team, its roles, its people (current and past) and the chart around it, read side by side. Only
 * the team itself decides found or not found; a part that fails shows its own error in place.
 */
export async function loadTeam(viewer: Viewer, teamId: string) {
	const [list, chart, roles, members] = await Promise.all([
		read(viewer, (db, a) => teamsReader.list(db, a, { includeArchived: true })),
		read(viewer, (db, a) => teamsReader.readOrgChart(db, a, { includeArchived: true })),
		read(viewer, (db, a) => teamsReader.listRoles(db, a, { teamId })),
		read(viewer, (db, a) => teamsReader.listMembers(db, a, { teamId })),
	]);
	if (list.status === "failed") return { status: "failed" } as const;
	const team = list.status === "ok" ? list.value.items.find((t) => t.id === teamId) : undefined;
	if (!team) return { status: "missing" } as const;
	const nodes = value(chart)?.nodes ?? [];
	const page = value(members);
	return {
		status: "found",
		team: cards([team], nodes)[0]!,
		nodes,
		roles: (value(roles)?.roles ?? null) as Role[] | null,
		members: (page?.members ?? null) as Member[] | null,
		past: (page?.history ?? null) as Member[] | null,
		canChange: canChange(viewer, team),
		admin: isAdmin(viewer),
	} as const;
}

/** The ministry's history, read when the person opens it. */
export const readHistory = (viewer: Viewer, teamId: string) =>
	read(viewer, (db, a) => teamsReader.listHistory(db, a, { teamId }));
/** The template catalog, read when the person opens the setup dialog. Reading it creates nothing. */
export const readCatalog = (viewer: Viewer) => read(viewer, (db, a) => teamsReader.listImportTemplates(db, a, {}));
/** The organization view drawn as SVG and PDF from the same lines (REQ-TEAM-012). */
export const readExport = (viewer: Viewer, includeArchived: boolean) =>
	read(viewer, (db, a) => teamsReader.readOrgChartExport(db, a, { includeArchived }));
