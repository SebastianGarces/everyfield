import type { Outcome } from "@everyfield/contracts/common";
import { requestDatabase } from "@/server/database";
import { outcomeOf, type Lost } from "@everyfield/contracts/common";
import { read as readMeetings, type Viewer } from "../meetings/server.ts";
import { meetingsReader } from "@everyfield/domain/meetings";
import type { TeamsReply } from "@everyfield/contracts/teams";
import type { Database } from "@everyfield/db/client";
import { teamsReader, withParents, withTeamsWrite } from "@everyfield/domain/teams";
import "server-only";
import type { ChartNode, ListedTeam, Member, Role, Team } from "./model.ts";
import { readDb, writeTx } from "../../server/platform/tx.ts";
import type { WriteTx } from "@everyfield/domain/access";

export type { Viewer };
export const isAdmin = (v: Viewer) => v.role === "owner" || v.role === "admin";

type Reply<T> = TeamsReply<T> | Lost;
type Authority = Viewer["authority"];

async function read<T>(viewer: Viewer, run: (db: Database, a: Authority) => Promise<TeamsReply<T>>): Promise<Reply<T>> {
	return readDb("teams", (db) => run(db, viewer.authority));
}

export async function write<T>(
	viewer: Viewer,
	run: (tx: WriteTx, context: Parameters<Parameters<typeof withTeamsWrite>[2]>[1]) => Promise<TeamsReply<T>>,
): Promise<Outcome<T>> {
	return writeTx("teams", async () => outcomeOf(await withTeamsWrite(requestDatabase(), viewer.authority, run)));
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
	if (list.status === "lost") return { status: "failed" } as const;
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
	const r = outcomeOf(await read(viewer, (db, a) => teamsReader.list(db, a, {})));
	return r.status === "ok" ? { status: "ok", value: r.value.items.map((t) => ({ id: t.id, name: t.name })) } : r;
};
export const readRevision = (viewer: Viewer, teamId: string) =>
	read(viewer, (db, a) => teamsReader.readRevision(db, a, { teamId }));
export const readHistory = (viewer: Viewer, teamId: string) =>
	read(viewer, (db, a) => teamsReader.listHistory(db, a, { teamId }));
export const readCatalog = (viewer: Viewer) => read(viewer, (db, a) => teamsReader.listImportTemplates(db, a, {}));
export const readExport = (viewer: Viewer, includeArchived: boolean) =>
	read(viewer, (db, a) => teamsReader.readOrgChartExport(db, a, { includeArchived }));
