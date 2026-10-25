import { asDay, asPersonId, type Member, type Role, type Team } from "./model.ts";
import type { TeamView } from "./server.ts";

// The ministry page's state after a change. No React and no server code. The same step draws a change at once
// (optimistic) and settles it from the write's own answer, so a write never reads the page again (patterns.md:
// a write answers with what changed). Each case mirrors what the WP-017 producer does in that write:
//   - a person taking a leadership role leads a ministry that has no leader (role-derived), which bumps its revision;
//     bringing a former member back never derives a leader;
//   - ending a membership or retiring a role ends the open tenures it covers, and clears a leader derived from them;
//   - the serving count follows the open tenures.
// A refused change reads the page again in its own request (reloadTeam).

export type Change =
	/** The ministry's own facts: what the form sent, then the saved row. */
	| { kind: "team"; patch: Partial<TeamView["team"]> }
	| { kind: "fill"; role: Role; person: { id: string; name: string }; today: string; derive: boolean }
	| { kind: "leave"; personId: string; today: string }
	/** A created, edited or retired role, as the form sent it or as the write saved it. */
	| { kind: "role"; role: Role; today: string };

const bump = (revision: Team["revision"]) => String(BigInt(revision) + 1n) as Team["revision"];

/** The open tenures that `ends` matches move to the past with today's date; a leader they derived is cleared. */
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

/** The organization view's node for this ministry, with its leader's name. */
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
					n.id === team.id ? { ...n, name: team.name, archived: team.archived, leaderName: team.leaderName } : n,
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

/** Today as the viewer's calendar shows it (YYYY-MM-DD). A reload shows the church's recorded date. */
export const today = () => new Date().toLocaleDateString("en-CA");
