import { asDay, asPersonId, type Member, type Role, type Team } from "./model.ts";
import type { TeamView } from "./server.ts";

export type Change =
	| { kind: "team"; patch: Partial<TeamView["team"]> }
	| { kind: "fill"; role: Role; person: { id: string; name: string }; today: string; derive: boolean }
	| { kind: "leave"; personId: string; today: string }
	| { kind: "role"; role: Role; today: string };

const bump = (revision: Team["revision"]) => String(BigInt(revision) + 1n) as Team["revision"];

function end(v: TeamView, ends: (m: Member) => boolean, today: string): TeamView {
	const closing = v.members?.filter(ends) ?? [];
	const t = v.team;
	const derived =
		t.leaderSource === "role_derived" &&
		closing.some((m) => m.personId === t.leaderPersonId && m.roleId === t.leaderRoleId);
	return {
		...v,
		team: {
			...t,
			activeCount: Math.max(0, t.activeCount - closing.length),
			...(derived
				? { leaderPersonId: null, leaderSource: null, leaderRoleId: null, leaderName: null, revision: bump(t.revision) }
				: {}),
		},
		nodes: derived ? chartLeader(v, null) : v.nodes,
		roles:
			v.roles?.map((r) =>
				closing.some((m) => m.roleId === r.id) ? { ...r, occupantPersonId: null, occupantName: null } : r,
			) ?? null,
		members: v.members?.filter((m) => !ends(m)) ?? null,
		past: v.past ? [...closing.map((m) => ({ ...m, endedOn: asDay(today), active: false })), ...v.past] : null,
	};
}

function chartLeader(v: TeamView, name: string | null) {
	return v.nodes.map((n) => (n.id === v.team.id ? { ...n, leaderName: name } : n));
}

export function apply(v: TeamView, c: Change): TeamView {
	switch (c.kind) {
		case "team": {
			const team = { ...v.team, ...c.patch };
			return {
				...v,
				team,
				nodes: v.nodes.map((n) =>
					n.id === team.id
						? { ...n, name: team.name, icon: team.icon, archived: team.archived, leaderName: team.leaderName }
						: n,
				),
			};
		}
		case "fill": {
			const row: Member = {
				personId: asPersonId(c.person.id),
				name: c.person.name,
				roleId: c.role.id,
				roleName: c.role.name,
				startedOn: asDay(c.today),
				endedOn: null,
				active: true,
				live: true,
			};
			const t = v.team;
			const leads = c.derive && c.role.leadership && !t.leaderPersonId;
			return {
				...v,
				team: {
					...t,
					activeCount: t.activeCount + 1,
					...(leads
						? {
								leaderPersonId: row.personId,
								leaderSource: "role_derived" as const,
								leaderRoleId: c.role.id,
								leaderName: c.person.name,
								revision: bump(t.revision),
							}
						: {}),
				},
				nodes: leads ? chartLeader(v, c.person.name) : v.nodes,
				roles:
					v.roles?.map((r) =>
						r.id === c.role.id ? { ...r, occupantPersonId: row.personId, occupantName: c.person.name } : r,
					) ?? null,
				members: v.members ? [...v.members, row] : null,
			};
		}
		case "leave":
			return end(v, (m) => m.personId === c.personId, c.today);
		case "role": {
			const after = c.role.retired ? end(v, (m) => m.roleId === c.role.id, c.today) : v;
			const role = c.role.retired ? { ...c.role, occupantPersonId: null, occupantName: null } : c.role;
			return {
				...after,
				roles: after.roles?.some((r) => r.id === role.id)
					? after.roles.map((r) => (r.id === role.id ? role : r))
					: [...(after.roles ?? []), role],
			};
		}
	}
}
