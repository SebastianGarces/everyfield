import type * as c from "@everyfield/contracts/teams";
import {
	Baby01Icon,
	Briefcase01Icon,
	Building03Icon,
	Coffee01Icon,
	ComputerDesk01Icon,
	CrownIcon,
	HandPrayerIcon,
	Megaphone01Icon,
	MusicNote01Icon,
	UserGroupIcon,
	UserMultipleIcon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { Tone } from "@everyfield/ui/controls";
import type { Status } from "@everyfield/ui/display";
import type { IconSvgElement } from "@everyfield/ui/foundations";
import type { z } from "zod";
import { MONTHS } from "../../components/dates.ts";

export type Team = z.infer<typeof c.team>;
export type Role = z.infer<typeof c.teamRole>;
export type Member = z.infer<typeof c.memberRow>;
export type ListedTeam = z.infer<typeof c.listedTeam>;
export type ChartNode = Pick<ListedTeam, "id" | "name" | "icon" | "templateKey" | "archived" | "leaderName"> & {
	parentId: ListedTeam["id"] | null;
};
export type HistoryEntry = z.infer<typeof c.historyEntry>;
export type Catalog = z.infer<typeof c.catalogPage>;
export type TeamState = Team["state"];

export const asPersonId = (id: string) => id as Member["personId"];
export const asRecordId = (id: string) => id as Role["id"];
export const asRevision = (revision: string) => revision as Role["revision"];
export const asDay = (day: string) => day as Member["startedOn"];

export const STATES = ["forming", "active", "paused"] as const satisfies readonly TeamState[];
export const STATE_LABEL: Record<TeamState, string> = { forming: "Forming", active: "Active", paused: "Paused" };
export const STATE_HINT: Record<TeamState, string> = {
	forming: "Still finding people and roles.",
	active: "Serving now.",
	paused: "Not serving for now. It stays on the list and the chart.",
};
const STATE_TONE: Record<TeamState, Status> = { forming: "measured", active: "positive", paused: "unknown" };

export function teamBadge(team: Pick<Team, "archived" | "state">): { status: Status; label: string } {
	if (team.archived) return { status: "unknown", label: "Archived" };
	return { status: STATE_TONE[team.state], label: STATE_LABEL[team.state] };
}

export const ICONS = {
	crown: { icon: CrownIcon, label: "Crown", tone: "ink" },
	music: { icon: MusicNote01Icon, label: "Music", tone: "green" },
	children: { icon: Baby01Icon, label: "Children", tone: "amber" },
	welcome: { icon: Coffee01Icon, label: "Welcome", tone: "blue" },
	groups: { icon: UserMultipleIcon, label: "Groups", tone: "violet" },
	building: { icon: Building03Icon, label: "Building", tone: "teal" },
	megaphone: { icon: Megaphone01Icon, label: "Megaphone", tone: "magenta" },
	technology: { icon: ComputerDesk01Icon, label: "Technology", tone: "violet" },
	prayer: { icon: HandPrayerIcon, label: "Prayer", tone: "teal" },
	office: { icon: Briefcase01Icon, label: "Office", tone: "teal" },
	tools: { icon: Wrench01Icon, label: "Tools", tone: "amber" },
	team: { icon: UserGroupIcon, label: "Team", tone: "ink" },
} as const satisfies Record<string, { icon: IconSvgElement; label: string; tone: Tone }>;
export type IconKey = keyof typeof ICONS;
export const ICON_KEYS = Object.keys(ICONS) as IconKey[];

const TEMPLATE_ICON: Record<string, IconKey> = {
	leadership: "crown",
	worship: "music",
	childrens_ministry: "children",
	assimilation: "welcome",
	small_groups: "groups",
	facilities: "building",
	promotion: "megaphone",
	technology: "technology",
	prayer: "prayer",
	administration: "office",
};
const isIcon = (key: string | null): key is IconKey => key !== null && key in ICONS;
export function iconKey(team: Pick<Team, "icon" | "templateKey">): IconKey {
	if (isIcon(team.icon)) return team.icon;
	return (team.templateKey && TEMPLATE_ICON[team.templateKey]) || "team";
}

export const isLeadership = (team: Pick<Team, "templateKey">) => team.templateKey === "leadership";

export type Person = {
	personId: string;
	name: string;
	roles: { roleId: string; roleName: string; startedOn: string }[];
};
export function people(members: readonly Member[]): Person[] {
	const byId = new Map<string, Person>();
	for (const m of members) {
		const p = byId.get(m.personId) ?? { personId: m.personId, name: m.name, roles: [] };
		p.roles.push({ roleId: m.roleId, roleName: m.roleName, startedOn: m.startedOn });
		byId.set(m.personId, p);
	}
	return [...byId.values()];
}

export function dayText(day: string): string {
	const [y, m, d] = day.split("-").map(Number);
	return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}
export function stampText(at: string): string {
	const date = new Date(at);
	return Number.isNaN(date.valueOf())
		? at
		: date.toLocaleString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				hour: "numeric",
				minute: "2-digit",
			});
}

export function plural(n: number, one: string, many = `${one}s`) {
	return `${n} ${n === 1 ? one : many}`;
}

export function problemText(code: string): string {
	switch (code) {
		case "conflict":
			return "Someone else changed this ministry while you were working. The latest version is shown now. Check it and try again.";
		case "occupied":
			return "Someone else already fills that role. Choose another role, or remove them from the team first.";
		case "invalid_subject":
			return "That person cannot be chosen here. They may have been retired or merged, or the role belongs to another ministry.";
		case "invalid_input":
			return "Some details are not valid. Check them and try again.";
		case "stale_template_version":
			return "The ministry templates changed since you opened this. Close it and open it again to see the current list.";
		case "stale_review":
			return "What you chose changed after the review. Review your choices again before you add them.";
		case "required_write_failed":
			return "The server could not save this. Nothing changed. Try again in a moment.";
		case "unavailable":
			return "This is not available any more. It may have been archived, or your seat may have changed. Reload the page.";
		case "busy":
			return "Another change is still saving. Try again when it ends.";
		default:
			return "You cannot make this change. Only Owners, Admins and this ministry's leader can. Your seat may have changed.";
	}
}

export function historyTitle(e: HistoryEntry) {
	if (e.kind === "correct" && e.about) return "Role dates corrected";
	if (e.kind === "leader_change" && !e.after?.leaderPersonId) return "Leader removed";
	if (e.subject === "role") return ROLE_KIND[e.kind] ?? "Role changed";
	return HISTORY_KIND[e.kind] ?? "Changed";
}
const ROLE_KIND: Record<string, string> = {
	create: "Role added",
	edit: "Role edited",
	retire: "Role retired",
};
const HISTORY_KIND: Record<string, string> = {
	create: "Created",
	edit: "Edited",
	correct: "Corrected",
	archive: "Archived",
	restore: "Restored",
	leader_change: "Leader appointed",
	assign: "Role filled",
	remove: "Left the ministry",
	retire: "Role retired",
};
const FIELD_LABEL: Record<string, string> = {
	name: "Name",
	description: "Description",
	icon: "Icon",
	state: "State",
	archived: "Archived",
	occupantPersonId: "Person",
	desiredSkills: "Desired skills",
	retired: "Retired",
	startedOn: "Start date",
	endedOn: "End date",
};
export function changedFields(entry: HistoryEntry): string {
	const keys = new Set([...Object.keys(entry.before ?? {}), ...Object.keys(entry.after ?? {})]);
	return [...keys]
		.map((k) => FIELD_LABEL[k])
		.filter(Boolean)
		.join(", ");
}

const FIELD_ORDER = Object.keys(FIELD_LABEL);
const fieldRank = (k: string) => (FIELD_ORDER.includes(k) ? FIELD_ORDER.indexOf(k) : FIELD_ORDER.length);
export function diffLines(e: HistoryEntry): { label: string; from: string; to: string }[] {
	const keys = [...new Set([...Object.keys(e.before ?? {}), ...Object.keys(e.after ?? {})])].sort(
		(a, b) => fieldRank(a) - fieldRank(b),
	);
	return keys.flatMap((k) => {
		const from = shownValue(k, e.before?.[k]);
		const to = shownValue(k, e.after?.[k]);
		if (from === null && to === null) return [];
		const line = { label: FIELD_LABEL[k] ?? k, from: from ?? "None", to: to ?? "None" };
		return line.from === line.to ? [] : [line];
	});
}

export function shownValue(key: string, value: unknown): string | null {
	if (key === "state" && typeof value === "string" && value in STATE_LABEL) return STATE_LABEL[value as TeamState];
	if (key === "name" || key === "description")
		return typeof value === "string" ? value : value === null ? "None" : null;
	if (key === "archived") return value === true ? "Yes" : value === false ? "No" : null;
	if (key === "startedOn" || key === "endedOn")
		return typeof value === "string" ? dayText(value) : value === null ? "None" : null;
	return null;
}

type EditPlan = "send" | "close" | "close-and-say";
export function planTeamEdit(
	was: Pick<Team, "name" | "icon" | "state"> & { description: string },
	now: typeof was & { reason: string },
): EditPlan {
	const text = (s: string) => s.trim() || null;
	const same =
		now.name.trim() === was.name &&
		text(now.description) === text(was.description) &&
		now.icon === was.icon &&
		now.state === was.state;
	if (!same) return "send";
	return now.reason.trim() ? "close-and-say" : "close";
}

export type SetupForm = {
	opening: string;
	chosen: Record<string, string[]> | null;
	step: "choose" | "review";
	problem?: string;
};
export const newSetup = (): SetupForm => ({ opening: crypto.randomUUID(), chosen: null, step: "choose" });
