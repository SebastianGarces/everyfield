import { requestDatabase } from "@/server/database";
import { read as readMeetings, type Viewer } from "../meetings/server.ts";
import { meetingsReader } from "@everyfield/domain/meetings";
import type { TeamsReply } from "@everyfield/contracts/teams";
import type { Database, Transaction } from "@everyfield/db/client";
import { teamsReader, withParents, withTeamsWrite } from "@everyfield/domain/teams";
import "server-only";
import type { ChartNode, ListedTeam, Member, Outcome, Role, Team } from "./model.ts";
import { logFailure } from "@everyfield/domain/log";

export type { Viewer };
export const isAdmin = (v: Viewer) => v.role === "owner" || v.role === "admin";

type Reply<T> = TeamsReply<T> | { status: "failed" };
type Authority = Viewer["authority"];

async function read<T>(viewer: Viewer, run: (db: Database, a: Authority) => Promise<TeamsReply<T>>): Promise<Reply<T>> {
	const db = requestDatabase();
	if (!db) return { status: "failed" };
	try {
		return await run(db, viewer.authority);
	} catch (error) {
		logFailure({ component: "teams", outcome: "read_failed" }, error);
		return { status: "failed" };
	}
}

export async function write<T>(
	viewer: Viewer,
	run: (tx: Transaction, context: Parameters<Parameters<typeof withTeamsWrite>[2]>[1]) => Promise<TeamsReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await withTeamsWrite(db, viewer.authority, run));
	} catch (error) {
		logFailure({ component: "teams", outcome: "write_failed" }, error);
		return { status: "lost" };
	}
}

export function outcome<T>(reply: Reply<T>): Outcome<T> {
	if (reply.status === "failed") return { status: "lost" };
	if (reply.status === "refused") return { status: "refused", code: reply.error.code };
	return { status: "ok", value: reply.value };
}
const value = <T>(r: Reply<T>): T | null => (r.status === "ok" ? r.value : null);

const chartOf = (teams: readonly ListedTeam[]): ChartNode[] =>
	withParents(
		teams.map(({ id, name, icon, templateKey, archived, leaderName }) => ({
			id,
			name,
			icon,
			templateKey,
			archived,
			leaderName,
		})),
	);
const canChange = (viewer: Viewer, team: Pick<Team, "leaderPersonId">) =>
	isAdmin(viewer) || (viewer.ownPersonId !== null && team.leaderPersonId === viewer.ownPersonId);

export type TeamsView = Awaited<ReturnType<typeof loadTeams>>;
export async function loadTeams(viewer: Viewer) {
	const list = value(await read(viewer, (db, a) => teamsReader.list(db, a, { includeArchived: true })));
	const teams = list?.items ?? null;
	return { teams, nodes: teams ? chartOf(teams) : [] };
}

export type TeamView = Extract<Awaited<ReturnType<typeof loadTeam>>, { status: "found" }>;
export async function loadTeam(viewer: Viewer, teamId: string) {
	const [list, roles, members, meetings] = await Promise.all([
		read(viewer, (db, a) => teamsReader.list(db, a, { includeArchived: true })),
		read(viewer, (db, a) => teamsReader.listRoles(db, a, { teamId })),
		read(viewer, (db, a) => teamsReader.listMembers(db, a, { teamId })),
		readMeetings(viewer, (db, a) => meetingsReader.list(db, a, { teamId, limit: 50 })),
	]);
	if (list.status === "failed") return { status: "failed" } as const;
	const teams = list.status === "ok" ? list.value.items : [];
	const team = teams.find((t) => t.id === teamId);
	if (!team) return { status: "missing" } as const;
	const page = value(members);
	return {
		status: "found",
		team,
		nodes: chartOf(teams),
		roles: (value(roles)?.roles ?? null) as Role[] | null,
		members: (page?.members ?? null) as Member[] | null,
		past: (page?.history ?? null) as Member[] | null,
		meetings: meetings.status === "ok" ? { items: meetings.value.items, total: meetings.value.total } : null,
		now: new Date().toISOString(),
		canChange: canChange(viewer, team),
		admin: isAdmin(viewer),
	} as const;
}

export const readMinistries = async (viewer: Viewer): Promise<Outcome<Pick<Team, "id" | "name">[]>> => {
	const r = outcome(await read(viewer, (db, a) => teamsReader.list(db, a, {})));
	return r.status === "ok" ? { status: "ok", value: r.value.items.map((t) => ({ id: t.id, name: t.name })) } : r;
};
export const readRevision = (viewer: Viewer, teamId: string) =>
	read(viewer, (db, a) => teamsReader.readRevision(db, a, { teamId }));
export const readHistory = (viewer: Viewer, teamId: string) =>
	read(viewer, (db, a) => teamsReader.listHistory(db, a, { teamId }));
export const readCatalog = (viewer: Viewer) => read(viewer, (db, a) => teamsReader.listImportTemplates(db, a, {}));
export const readExport = (viewer: Viewer, includeArchived: boolean) =>
	read(viewer, (db, a) => teamsReader.readOrgChartExport(db, a, { includeArchived }));
