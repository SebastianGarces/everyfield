import type { Transaction } from "@everyfield/db/client";
import { meetingsReader } from "@everyfield/domain/meetings";
import { responsibilityReader, teamsReader, trainingReader } from "@everyfield/domain/teams";
import {
	getTeamRequest,
	listLeaderCandidatesRequest,
	listMembersRequest,
	listRolesRequest,
	listTeamsRequest,
	orgChartRequest,
	personAssignmentsRequest,
	personTeamCountsRequest,
	previewTemplateImportRequest,
	searchMembersRequest,
	teamHistoryRequest,
	type TeamsReply,
} from "@everyfield/contracts/teams";
import {
	listTrainingRequest,
	personTrainingRequest,
	previewRequiredTrainingRequest,
	requiredParticipantsRequest,
	staffingFactsRequest,
	trainingHistoryRequest,
	trainingMatrixRequest,
} from "@everyfield/contracts/teams";
import { listRequest as responsibilitiesRequest, previewRequest } from "@everyfield/contracts/teams/responsibilities";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { personRow } from "../../../catalog/person-row.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { verifyPeople } from "../../people/reads/index.ts";

// The Ministries reads (WP-069): each calls the native teams read the Ministries screens use, under the same domain
// authority, so an Owner, an Admin and a Member each get exactly what their screens show them. Ministry membership is
// the team roster, never a People tag. Counts are the domain's own: role slots and people are counted apart, a
// ministry's health is its measured facts with the meeting window they cover, and Unknown is never zero. Background
// checks and children's safety records are not part of the product and never appear.

const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
type Fields = SourceRow["fields"];
type Built = Partial<Omit<SourceResult, "operation" | "rows">> & { rows: SourceRow[] };

/**
 * One read: the domain reply becomes rows. A ministry, program or person this church doesn't have (or the actor may
 * not see) reads as not found, the same as one that never existed.
 */
function read<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	run(tx: Transaction, actor: EvryActor, input: I): Promise<TeamsReply<unknown>>;
	rows(value: never, actor: EvryActor, tx: Transaction, input: I): Built | Promise<Built>;
	exclusions?: string[];
}): ReadAdapter<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: inPlant,
		async invoke(tx, actor, input): Promise<SourceResult> {
			const reply = await spec.run(tx, actor, input);
			const empty = { rows: [], total: 0 };
			if (reply.status !== "ok" && reply.error.code === "invalid_input") throw new EvryRefusal("invalid_input");
			if (reply.status !== "ok" && !["unavailable", "access_denied", "invalid_subject"].includes(reply.error.code))
				throw new EvryRefusal("source_unavailable");
			const built = reply.status === "ok" ? await spec.rows(reply.value as never, actor, tx, input) : empty;
			return {
				operation: spec.operation,
				status: reply.status === "ok" ? "available" : "not_found",
				total: built.rows.length,
				page: 1,
				next: null,
				completeness: "complete",
				exclusions: spec.exclusions ?? [],
				...built,
			};
		},
	};
}

const pct = (rate: number | null) => (rate === null ? null : Math.round(rate * 100));
const team = (id: string, label: string, fields: Fields): SourceRow => ({ kind: "team", id, label, fields });
const role = (id: string, label: string, fields: Fields): SourceRow => ({ kind: "role", id, label, fields });
const program = (id: string, label: string, fields: Fields): SourceRow => ({ kind: "training", id, label, fields });
const teamId = z.uuid().describe("A ministry id from an earlier teams result");
const personId = z.uuid().describe("A person id from an earlier result");

type Listed = {
	id: string;
	name: string;
	state: string;
	archived: boolean;
	leaderName: string | null;
	leaderSource: string | null;
	activeCount: number;
};
const listedRow = (t: Listed) =>
	team(t.id, t.name, {
		state: t.state,
		archived: t.archived,
		leader: t.leaderName,
		leaderKind: t.leaderSource === "explicit" ? "appointed" : t.leaderSource ? "fallback" : null,
		people: t.activeCount,
	});
type Health = {
	teamId: string;
	name: string;
	filledSlots: number;
	openSlots: number;
	distinctPeople: number;
	memberAttendance: number;
	guestCount: number;
	rosterDenominator: number;
	trainingRate: number | null;
	staffingRate: number | null;
	attendanceRate: number | null;
	composite: number | null;
	window: { meetings: number; from: string | null; to: string | null };
	staffingBand: string;
	attendanceBand: string;
};
const healthRow = (h: Health) =>
	team(h.teamId, h.name, {
		staffingPercent: pct(h.staffingRate),
		trainingPercent: pct(h.trainingRate),
		attendancePercent: pct(h.attendanceRate),
		composite: h.composite === null ? "Unknown" : Math.round(h.composite),
		filledRoles: h.filledSlots,
		openRoles: h.openSlots,
		people: h.distinctPeople,
		membersAttended: h.memberAttendance,
		rosterMembers: h.rosterDenominator,
		guests: h.guestCount,
		meetingsMeasured: h.window.meetings,
		windowFrom: h.window.from,
		windowTo: h.window.to,
		staffingBand: h.staffingBand,
		attendanceBand: h.attendanceBand,
	});
const HEALTH_NOTE =
	"Measured facts only: staffing is filled role slots over role slots, attendance is distinct roster members who attended the last 4 completed team meetings, training is required people with a current completion. The composite weighs staffing 35, training 40 and attendance 25, and is Unknown when any part is missing.";

const participant =
	(actor: EvryActor, programName: string) => (p: { personId: string; name: string; complete: boolean }) =>
		personRow(actor, p.personId, p.name, { program: programName, complete: p.complete ? "yes" : "no" });

export const TEAMS_READS = [
	read({
		operation: "teams.list",
		description:
			"List this church's ministries (teams) with their state, leader and how many people serve now. Use it to find a ministry's id by name.",
		input: listTeamsRequest,
		run: (tx, actor, input) => teamsReader.list(tx, actor.authority, input),
		rows: (value: { items: Listed[] }) => ({ rows: value.items.map(listedRow) }),
		exclusions: ["archived ministries unless asked"],
	}),
	read({
		operation: "teams.get",
		description:
			"Read one ministry's official roster: its leader, its roles with who fills each, and its current people. This is team membership; a People tag is not.",
		input: getTeamRequest.extend({ teamId }),
		run: (tx, actor, input) => teamsReader.get(tx, actor.authority, input),
		rows: (
			value: {
				team: Listed;
				roles: { id: string; name: string; leadership: boolean; occupantName: string | null }[];
				members: { personId: string; name: string; roleName: string; startedOn: string }[];
			},
			actor,
		) => ({
			rows: [
				listedRow(value.team),
				...value.roles.map((r) =>
					role(r.id, r.name, {
						team: value.team.name,
						leadership: r.leadership,
						filledBy: r.occupantName,
						open: !r.occupantName,
					}),
				),
				...value.members.map((m) =>
					personRow(actor, m.personId, m.name, { team: value.team.name, role: m.roleName, since: m.startedOn }),
				),
			],
			total: value.members.length,
		}),
		exclusions: ["people whose role ended", "retired roles"],
	}),
	read({
		operation: "teams.searchMembers",
		description:
			"Find people serving in ministries now, by name and/or one ministry, with the role each holds. One row per role held.",
		input: searchMembersRequest.extend({ teamId: teamId.optional() }),
		run: (tx, actor, input) => teamsReader.searchMembers(tx, actor.authority, input),
		rows: (
			value: {
				items: { personId: string; name: string; teamName: string; roleName: string; startedOn: string }[];
				completeness: "complete" | "partial";
			},
			actor,
		) => ({
			rows: value.items.map((m) =>
				personRow(actor, m.personId, m.name, { team: m.teamName, role: m.roleName, since: m.startedOn }),
			),
			total: value.completeness === "complete" ? value.items.length : null,
			completeness: value.completeness,
		}),
		exclusions: ["people whose role ended", "archived ministries"],
	}),
	read({
		operation: "teams.staffingSummary",
		description:
			"Every current ministry's staffing and leader: role slots, filled and open roles, distinct people serving, and whether it has an appointed leader, a fallback leader from a leadership role, none, or a leader whose record is unavailable. Facts give the church's totals, counting each person once.",
		input: z.strictObject({}),
		run: (tx, actor) => teamsReader.staffingSummary(tx, actor.authority, {}),
		rows: (value: {
			teams: {
				teamId: string;
				name: string;
				state: string;
				leaderStatus: string;
				leaderName: string | null;
				roles: number;
				filledRoles: number;
				openRoles: number;
				people: number;
			}[];
			roles: number;
			filledRoles: number;
			openRoles: number;
			people: number;
		}) => ({
			rows: value.teams.map((t) =>
				team(t.teamId, t.name, {
					state: t.state,
					leaderStatus: t.leaderStatus,
					leader: t.leaderName,
					roles: t.roles,
					filledRoles: t.filledRoles,
					openRoles: t.openRoles,
					people: t.people,
				}),
			),
			facts: {
				roles: value.roles,
				filledRoles: value.filledRoles,
				openRoles: value.openRoles,
				peopleServing: value.people,
			},
		}),
		exclusions: ["archived ministries", "retired roles", "ended memberships"],
	}),
	read({
		operation: "teams.personTeamCounts",
		description:
			"People serving on at least minTeams distinct current ministries (default 2), with the count and the ministries. An advisory count to look at, never a judgment of the person.",
		input: personTeamCountsRequest,
		run: (tx, actor, input) => teamsReader.personTeamCounts(tx, actor.authority, input),
		rows: (
			value: { minTeams: number; people: { personId: string; name: string; teams: number; teamNames: string[] }[] },
			actor,
		) => ({
			rows: value.people.map((p) =>
				personRow(actor, p.personId, p.name, { ministries: p.teams, names: p.teamNames.join(", ") }),
			),
			facts: { minTeams: value.minTeams },
		}),
		exclusions: ["ended memberships", "archived ministries"],
	}),
	read({
		operation: "teams.staffingFacts",
		description: "One ministry's raw staffing, attendance and training measures, without the window or bands.",
		input: staffingFactsRequest.extend({ teamId }),
		run: (tx, actor, input) => trainingReader.readStaffingFacts(tx, actor.authority, input),
		rows: (value: Omit<Health, "name" | "window" | "staffingBand" | "attendanceBand">) => ({
			rows: [
				healthRow({
					...value,
					name: "Staffing facts",
					window: { meetings: 0, from: null, to: null },
					staffingBand: "unknown",
					attendanceBand: "unknown",
				}),
			],
			facts: { note: HEALTH_NOTE },
		}),
	}),
	read({
		operation: "teams.health",
		description:
			"One ministry's measured health: staffing, training and attendance rates, the composite or Unknown, and the dates of the team meetings it covers. Report these facts, never an opinion.",
		input: staffingFactsRequest.extend({ teamId }),
		run: (tx, actor, input) => trainingReader.readHealth(tx, actor.authority, input),
		rows: (value: Health) => ({ rows: [healthRow(value)], facts: { note: HEALTH_NOTE } }),
	}),
	read({
		operation: "teams.aggregateHealth",
		description:
			"Every current ministry's measured health, and the church's composite averaged over measured ministries only, with how many were measured.",
		input: z.strictObject({}),
		run: (tx, actor) => trainingReader.readAggregateHealth(tx, actor.authority, {}),
		rows: (value: { teams: Health[]; measuredTeams: number; totalTeams: number; composite: number | null }) => ({
			rows: value.teams.map(healthRow),
			facts: {
				measuredMinistries: value.measuredTeams,
				ministries: value.totalTeams,
				composite: value.composite === null ? "Unknown" : Math.round(value.composite),
				note: HEALTH_NOTE,
			},
		}),
		exclusions: ["archived ministries"],
	}),
	read({
		operation: "teams.trainingMatrix",
		description:
			"Training programs (optionally one ministry's and the church-wide ones) with each saved required person and whether they have finished. Only the saved required list counts.",
		input: trainingMatrixRequest.extend({ teamId: teamId.optional() }),
		run: (tx, actor, input) => trainingReader.readTrainingMatrix(tx, actor.authority, input),
		rows: (
			value: {
				programs: {
					id: string;
					name: string;
					required: boolean;
					people: { personId: string; name: string; complete: boolean }[];
				}[];
			},
			actor,
		) => ({
			rows: value.programs.flatMap((g) => [
				program(g.id, g.name, {
					required: g.required,
					complete: g.people.filter((p) => p.complete).length,
					of: g.people.length,
				}),
				...g.people.map(participant(actor, g.name)),
			]),
		}),
		exclusions: ["people added to a ministry after its required list was saved", "revoked completions"],
	}),
	read({
		operation: "teams.readRequiredTrainingParticipants",
		description:
			"One program's saved required people and who of them has finished it (complete of total). Someone who joined since the list was saved is not on it.",
		input: requiredParticipantsRequest.extend({ programId: z.uuid() }),
		run: (tx, actor, input) => trainingReader.readRequiredTrainingParticipants(tx, actor.authority, input),
		rows: (
			value: {
				programId: string;
				name: string;
				required: boolean;
				people: { personId: string; name: string; complete: boolean }[];
				complete: number;
				total: number;
			},
			actor,
		) => ({
			rows: [
				program(value.programId, value.name, { required: value.required, complete: value.complete, of: value.total }),
				...value.people.map(participant(actor, value.name)),
			],
			facts: { complete: value.complete, of: value.total },
		}),
		exclusions: ["people not on the saved list", "revoked completions"],
	}),
	read({
		operation: "teams.previewRequiredTrainingParticipants",
		description:
			"Check a proposed required list for one program before it is saved: which of these people are live in this church. Saves nothing.",
		input: previewRequiredTrainingRequest.extend({ programId: z.uuid(), personIds: z.array(z.uuid()).min(1).max(100) }),
		run: (tx, actor, input) => trainingReader.readRequiredTrainingPreview(tx, actor.authority, input),
		rows: async (value: { programId: string; personIds: string[] }, actor, tx) => ({
			rows: [
				program(value.programId, "Proposed required list", { people: value.personIds.length }),
				...(await verifyPeople(tx, actor, value.personIds)),
			],
		}),
	}),
	read({
		operation: "teams.listTraining",
		description:
			"List training programs (optionally one ministry's and the church-wide ones): required or optional, how many people are required and how many have finished.",
		input: listTrainingRequest.extend({ teamId: teamId.optional() }),
		run: (tx, actor, input) => trainingReader.listTraining(tx, actor.authority, input),
		rows: (value: {
			programs: {
				id: string;
				name: string;
				teamId: string | null;
				required: boolean;
				archived: boolean;
				requiredPeople: number;
				compatibleCredits: number;
			}[];
		}) => ({
			rows: value.programs.map((g) =>
				program(g.id, g.name, {
					required: g.required,
					churchWide: g.teamId === null,
					archived: g.archived,
					requiredPeople: g.requiredPeople,
					finished: g.compatibleCredits,
				}),
			),
		}),
	}),
	read({
		operation: "teams.personTraining",
		description:
			"One person's ministries now and before, how many roles they hold, and whether their required training is complete.",
		input: personTrainingRequest.extend({ personId }),
		run: (tx, actor, input) => trainingReader.readPersonTraining(tx, actor.authority, input),
		rows: async (
			value: {
				personId: string;
				currentTeams: string[];
				formerTeams: string[];
				concurrentAssignments: number;
				currentTrainingComplete: boolean;
			},
			actor,
			tx,
		) => {
			const [found] = await verifyPeople(tx, actor, [value.personId]);
			return {
				rows: found
					? [
							{
								...found,
								fields: {
									...found.fields,
									currentMinistries: value.currentTeams.join(", ") || null,
									formerMinistries: value.formerTeams.join(", ") || null,
									rolesHeld: value.concurrentAssignments,
									requiredTrainingComplete: value.currentTrainingComplete,
								},
							},
						]
					: [],
			};
		},
	}),
	read({
		operation: "teams.trainingHistory",
		description: "One person's recorded training completions, revocations and corrections, oldest first.",
		input: trainingHistoryRequest.extend({ personId }),
		run: (tx, actor, input) => trainingReader.readTrainingHistory(tx, actor.authority, input),
		rows: async (
			value: {
				credits: {
					id: string;
					programId: string | null;
					kind: string;
					earnedOn: string | null;
					version: number | null;
				}[];
			},
			actor,
			tx,
		) => {
			const programs = await trainingReader.listTraining(tx, actor.authority, {});
			const names = new Map<string, string>(
				programs.status === "ok" ? programs.value.programs.map((g) => [g.id, g.name]) : [],
			);
			return {
				rows: value.credits.map((c): SourceRow => ({
					kind: "activity",
					id: c.id,
					label: (c.programId && names.get(c.programId)) || "Service",
					fields: { entry: c.kind, on: c.earnedOn, version: c.version },
				})),
			};
		},
	}),
	read({
		operation: "teams.personAssignments",
		description: "Every ministry role one person holds or held, current ones first, with start and end dates.",
		input: personAssignmentsRequest.extend({ personId }),
		run: (tx, actor, input) => teamsReader.listPersonAssignments(tx, actor.authority, input),
		rows: (value: {
			assignments: {
				roleId: string;
				roleName: string;
				teamName: string;
				startedOn: string;
				endedOn: string | null;
				active: boolean;
			}[];
		}) => ({
			rows: value.assignments.map((a) =>
				role(a.roleId, a.roleName, { team: a.teamName, current: a.active, since: a.startedOn, ended: a.endedOn }),
			),
		}),
	}),
	read({
		operation: "teams.membershipHistory",
		description: "One ministry's past members: each role a person held there and when it started and ended.",
		input: listMembersRequest.extend({ teamId }),
		run: (tx, actor, input) => teamsReader.listMembers(tx, actor.authority, input),
		rows: (
			value: {
				history: { personId: string; name: string; roleName: string; startedOn: string; endedOn: string | null }[];
			},
			actor,
		) => ({
			rows: value.history.map((m) =>
				personRow(actor, m.personId, m.name, { role: m.roleName, since: m.startedOn, ended: m.endedOn }),
			),
		}),
	}),
	read({
		operation: "teams.history",
		description:
			"One ministry's change history: edits, roles added or retired, people placed or leaving, newest first.",
		input: teamHistoryRequest.extend({ teamId }),
		run: (tx, actor, input) => teamsReader.listHistory(tx, actor.authority, input),
		rows: (value: {
			entries: {
				id: string;
				kind: string;
				occurredAt: string;
				actorName: string | null;
				about: { personName: string | null; roleName: string } | null;
			}[];
		}) => ({
			rows: value.entries.map((e): SourceRow => ({
				kind: "activity",
				id: e.id,
				label: e.kind,
				fields: {
					at: e.occurredAt,
					by: e.actorName,
					person: e.about?.personName ?? null,
					role: e.about?.roleName ?? null,
				},
			})),
		}),
	}),
	read({
		operation: "teams.listRoles",
		description:
			"One ministry's roles: who fills each or whether it is open, leadership roles, time commitment and desired skills.",
		input: listRolesRequest.extend({ teamId }),
		run: (tx, actor, input) => teamsReader.listRoles(tx, actor.authority, input),
		rows: (value: {
			roles: {
				id: string;
				name: string;
				leadership: boolean;
				occupantName: string | null;
				retired: boolean;
				timeCommitment: string | null;
				desiredSkills: string | null;
			}[];
		}) => ({
			rows: value.roles.map((r) =>
				role(r.id, r.name, {
					filledBy: r.occupantName,
					open: !r.occupantName && !r.retired,
					leadership: r.leadership,
					retired: r.retired,
					timeCommitment: r.timeCommitment,
					desiredSkills: r.desiredSkills,
				}),
			),
		}),
	}),
	read({
		operation: "teams.leaderCandidates",
		description:
			"Search live people in this church by name who could be appointed a ministry leader. A name match only.",
		input: listLeaderCandidatesRequest,
		run: (tx, actor, input) => teamsReader.listLeaderCandidates(tx, actor.authority, input),
		rows: (value: { people: { personId: string; name: string; stage: string }[] }, actor) => ({
			rows: value.people.map((p) => personRow(actor, p.personId, p.name, { stage: p.stage })),
		}),
	}),
	read({
		operation: "teams.orgChart",
		description: "The organization view: every ministry under the Leadership ministry, with its leader.",
		input: orgChartRequest,
		run: (tx, actor, input) => teamsReader.readOrgChart(tx, actor.authority, input),
		rows: (value: {
			nodes: { id: string; name: string; parentId: string | null; leaderName: string | null; archived: boolean }[];
		}) => {
			const names = new Map(value.nodes.map((n) => [n.id, n.name]));
			return {
				rows: value.nodes.map((n) =>
					team(n.id, n.name, {
						under: n.parentId ? (names.get(n.parentId) ?? null) : null,
						leader: n.leaderName,
						archived: n.archived,
					}),
				),
			};
		},
	}),
	read({
		operation: "teams.exportOrgChart",
		description: "Prepare the organization view as a PDF. The user downloads it from the Ministries page.",
		input: orgChartRequest,
		run: (tx, actor, input) => teamsReader.readOrgChartExport(tx, actor.authority, input),
		rows: (value: { nodes: unknown[]; lines: string[] }) => ({
			rows: [
				{
					kind: "file",
					id: "organization-view.pdf",
					label: "Organization view (PDF)",
					fields: { ministries: value.nodes.length },
				},
			],
		}),
		exclusions: ["the file itself"],
	}),
	read({
		operation: "teams.listImportTemplates",
		description:
			"The optional ministry templates this church can import, with their starter roles. Reading creates nothing.",
		input: z.strictObject({}),
		run: (tx, actor) => teamsReader.listImportTemplates(tx, actor.authority, {}),
		rows: (value: { teams: { key: string; name: string; roles: { name: string }[] }[] }) => ({
			rows: value.teams.map((t): SourceRow => ({
				kind: "template",
				id: t.key,
				label: t.name,
				fields: { roles: t.roles.map((r) => r.name).join(", ") || null },
			})),
		}),
	}),
	read({
		operation: "teams.previewTemplateImport",
		description:
			"Preview importing chosen ministry templates and their roles: what is new and what this church already has. Creates nothing.",
		input: previewTemplateImportRequest,
		run: (tx, actor, input) => teamsReader.previewTemplateImport(tx, actor.authority, input),
		rows: (value: {
			teams: {
				key: string;
				name: string;
				exists: boolean;
				newRoles: { name: string }[];
				existingRoles: { name: string }[];
			}[];
			newTeams: number;
			newRoles: number;
		}) => ({
			rows: value.teams.map((t): SourceRow => ({
				kind: "template",
				id: t.key,
				label: t.name,
				fields: {
					alreadyHere: t.exists,
					newRoles: t.newRoles.map((r) => r.name).join(", ") || null,
					existingRoles: t.existingRoles.map((r) => r.name).join(", ") || null,
				},
			})),
			facts: { newMinistries: value.newTeams, newRoles: value.newRoles },
		}),
	}),
	read({
		operation: "teams.listResponsibilities",
		description: "One ministry's responsibilities checklist and which are done, 24 per page.",
		input: responsibilitiesRequest.extend({ teamId }),
		run: (tx, actor, input) => responsibilityReader.listResponsibilities(tx, actor.authority, input),
		rows: (value: { page: number; items: { id: string; text: string; completedOn: string | null }[] }) => ({
			rows: value.items.map((r): SourceRow => ({
				kind: "responsibility",
				id: r.id,
				label: r.text,
				fields: { done: r.completedOn !== null, doneOn: r.completedOn },
			})),
			page: value.page,
			next: value.items.length === 24 ? value.page + 1 : null,
			completeness: value.items.length === 24 ? "partial" : "complete",
			total: value.items.length === 24 ? null : value.items.length,
		}),
	}),
	read({
		operation: "teams.previewResponsibilities",
		description:
			"Preview the suggested Playbook responsibilities a ministry may accept, and whether it already accepted or declined them. Creates nothing.",
		input: previewRequest.extend({ teamId }),
		run: (tx, actor, input) => responsibilityReader.previewResponsibilities(tx, actor.authority, input),
		rows: (value: { offer: string | null; lines: { key: string; text: string }[] }) => ({
			rows: value.lines.map((l): SourceRow => ({
				kind: "template",
				id: l.key,
				label: l.text,
				fields: { offer: value.offer },
			})),
			facts: { offer: value.offer ?? "not decided" },
		}),
	}),
	read({
		operation: "teams.listMeetings",
		description: "One ministry's team meetings, latest first, with date, time and status.",
		input: z.strictObject({ teamId, window: z.enum(["upcoming", "past", "all"]).optional() }),
		run: (tx, actor, input) =>
			meetingsReader.list(tx, actor.authority, {
				teamId: input.teamId,
				types: ["team_meeting"],
				window: input.window ?? "all",
				limit: 24,
			}) as Promise<TeamsReply<unknown>>,
		rows: (value: {
			items: { id: string; displayTitle: string; status: string; localDate: string; localTime: string }[];
			total: number;
			next: number | null;
		}) => ({
			rows: value.items.map((m): SourceRow => ({
				kind: "meeting",
				id: m.id,
				label: m.displayTitle,
				fields: { date: m.localDate, time: m.localTime, status: m.status },
			})),
			total: value.total,
			next: value.next,
			completeness: value.next ? "partial" : "complete",
		}),
	}),
];
