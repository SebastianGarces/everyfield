import * as c from "@everyfield/contracts/meetings";
import type { Transaction } from "@everyfield/db/client";
import { attendanceReader, meetingsReader, rosterReader, venuesReader } from "@everyfield/domain/meetings";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { personRow } from "../../../catalog/person-row.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { inPlant, localWhen, meetingId, meetingRow, ownerOrAdmin, RSVP, value, venueId } from "../shared.ts";

// The Meetings read tools (WP-065): each calls the native Meetings read the Meetings screens use, under the same domain
// authority, whose one statement carries the lock-free live access check (C13, C27). Members read meetings, guests,
// agendas, kits, cards and attendance; reports and the invitation context are Owner or Admin, as natively. An RSVP is
// the guest's answer, never attendance; a meeting with no attendance recorded is "not recorded", never zero. Prayer and
// question notes, email opens and venue contact details never reach the model.

type Row = SourceRow;
type Fields = Row["fields"];
const item = (id: string, label: string, fields: Fields): Row => ({ kind: "item", id, label, fields });
const result = (operation: string, rows: Row[], exclusions: string[] = [], total = rows.length): SourceResult => ({
	operation,
	status: rows.length ? "available" : "not_found",
	rows,
	total,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions,
});
const notFound = (operation: string) => result(operation, []);
/** A found read that has nothing to list is still found: "no upcoming meetings" is an answer, not a missing record. */
const found = (operation: string, rows: Row[], exclusions: string[] = []): SourceResult => ({
	...result(operation, rows, exclusions),
	status: "available",
});
const s = (n: number | null | undefined) => (n === null || n === undefined ? null : String(n));

/** One read tool: `run` calls the native read and shapes its answer into rows. */
function read<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	allowed?: (actor: EvryActor) => boolean;
	run(tx: Transaction, actor: EvryActor, input: I): Promise<SourceResult>;
}): ReadAdapter<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: spec.allowed ?? inPlant,
		invoke: spec.run,
	};
}

const one = z.strictObject({ meetingId });
const types = z.array(c.meetingType).max(4);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A report window: types default to Vision meetings, dates are church-local and inclusive, limit is the latest N. */
const report = z.strictObject({
	types: types.optional(),
	from: day.optional(),
	to: day.optional(),
	limit: z.int().min(1).max(100).optional(),
});
type Report = z.infer<typeof report>;
const reportRequest = (i: Report) =>
	c.reportRequest.parse({ types: i.types, from: i.from ?? null, to: i.to ?? null, limit: i.limit });

/** The meeting row for a meeting id, through the native get. */
async function meetingOf(tx: Transaction, actor: EvryActor, id: string) {
	const m = value(await meetingsReader.get(tx, actor.authority, { meetingId: id }));
	return m?.status === "available" ? m.meeting : null;
}

// --- Meetings ---------------------------------------------------------------------------------------------------

const listInput = z.strictObject({
	window: c.meetingWindow.optional(),
	types: types.optional(),
	statuses: z.array(c.meetingStatus).max(5).optional(),
	teamId: z.string().optional(),
	page: z.int().min(1).optional(),
	limit: z.int().min(1).max(50).optional(),
});
export const list = read({
	operation: "meetings.list",
	description:
		"This church's meetings: church-local date, time, venue, status (cancelled stays listed as cancelled). window upcoming is soonest first, past latest first. Same-title meetings: ask which one. Deleting or changing one needs an Owner or Admin.",
	input: listInput,
	async run(tx, actor, input) {
		const request = { ...input, limit: input.limit ?? 24, page: input.page ?? 1 };
		const page = value(await meetingsReader.list(tx, actor.authority, request));
		if (!page) return notFound("meetings.list");
		return {
			operation: "meetings.list",
			status: "available",
			rows: page.items.map((m) => meetingRow(m, { kit: m.preparation === "not_applicable" ? null : m.preparation })),
			total: page.total,
			page: page.page,
			next: page.next,
			completeness: page.next === null ? "complete" : "partial",
			exclusions: ["deleted meetings"],
		};
	},
});

export const get = read({
	operation: "meetings.get",
	description: "One meeting: date, time, venue, status, notes, kit progress, whether held.",
	input: one,
	async run(tx, actor, input) {
		const m = await meetingOf(tx, actor, input.meetingId);
		if (!m) return notFound("meetings.get");
		return result("meetings.get", [
			meetingRow(m, {
				notes: m.notes,
				subtype: m.subtype,
				agendaMinutes: String(m.agenda.totalMinutes),
				kitChecked: m.kit ? `${m.kit.checked} of ${m.kit.total}` : null,
				held: m.occurrence.heldAt ? localWhen(m.occurrence.heldAt, m.zone) : null,
				voided: m.occurrence.voidedAt !== null,
			}),
		]);
	},
});

export const hasHistory = read({
	operation: "meetings.hasHistory",
	description: "Whether any meeting of these types was ever recorded.",
	input: z.strictObject({ types: types.optional() }),
	async run(tx, actor, input) {
		const h = value(await meetingsReader.hasHistory(tx, actor.authority, input));
		if (!h) return notFound("meetings.hasHistory");
		return result("meetings.hasHistory", [item("history", "Meeting history", { hasHistory: h.hasHistory })]);
	},
});

export const readAgenda = read({
	operation: "meetings.readAgenda",
	description:
		"A meeting's saved agenda in order, with its print link in the app when it has one. Never write one yourself.",
	input: one,
	async run(tx, actor, input) {
		const m = await meetingOf(tx, actor, input.meetingId);
		const agenda = m && value(await meetingsReader.readAgenda(tx, actor.authority, input));
		if (!m || !agenda) return notFound("meetings.readAgenda");
		const [h, min] = m.localTime.split(":").map(Number) as [number, number];
		let at = h * 60 + min;
		const sections = agenda.sections.map((section, n) => {
			const starts = `${String(Math.floor(at / 60) % 24).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
			at += section.minutes;
			return item(section.id, section.title, { order: String(n + 1), minutes: String(section.minutes), starts });
		});
		return {
			...result("meetings.readAgenda", [
				// The app prints a Vision meeting's agenda (its agenda template); other meetings have no print view.
				meetingRow(m, {
					print: m.type === "vision_meeting" ? `/meetings/${m.id}/agenda` : null,
					agendaMinutes: String(agenda.totalMinutes),
				}),
				...sections,
			]),
			total: sections.length,
		};
	},
});

export const listKit = read({
	operation: "meetings.listKit",
	description:
		"A Vision meeting's kit checklist. only=unchecked: what is still needed.",
	input: z.strictObject({ meetingId, only: z.enum(["unchecked", "checked"]).optional() }),
	async run(tx, actor, input) {
		const kit = value(await meetingsReader.listKit(tx, actor.authority, { meetingId: input.meetingId }));
		if (!kit) return notFound("meetings.listKit");
		const items = kit.items.filter((k) => !input.only || k.checked === (input.only === "checked"));
		return {
			...found(
				"meetings.listKit",
				items.map((k) =>
					item(k.id, k.text, {
						category: k.category,
						checked: k.checked,
						assignee: k.assignee?.displayName ?? null,
						notes: k.notes,
					}),
				),
				input.only ? [`${input.only === "unchecked" ? "checked" : "unchecked"} items`] : [],
			),
			total: items.length,
			...(kit.version === null ? { status: "not_found" as const } : {}),
		};
	},
});

const rsvpOrder = ["confirmed", "declined", "pending"];
export const listGuests = read({
	operation: "meetings.listGuests",
	description:
		"A meeting's guests by RSVP (yes, no, no answer). An RSVP is not attendance.",
	input: one,
	async run(tx, actor, input) {
		const list = value(await meetingsReader.listGuests(tx, actor.authority, input));
		if (!list) return notFound("meetings.listGuests");
		const guests = [...list.guests].sort(
			(a, b) =>
				rsvpOrder.indexOf(a.rsvp) - rsvpOrder.indexOf(b.rsvp) || a.person.displayName.localeCompare(b.person.displayName),
		);
		return found(
			"meetings.listGuests",
			guests.map((g) =>
				personRow(actor, g.person.personId, g.person.displayName, {
					rsvp: RSVP[g.rsvp] ?? g.rsvp,
					invitedBy: g.inviter?.displayName ?? null,
				}),
			),
			["attendance (see meetings.listAttendance)", "email opens"],
		);
	},
});

const CARD: Record<string, string> = {
	ready_commit: "ready to commit",
	interested: "interested",
	prayer_request: "prayer request",
	stay_informed: "stay informed",
	not_interested: "not interested",
};
export const listCards = read({
	operation: "meetings.listCards",
	description: "Response cards recorded at a Vision meeting.",
	input: one,
	async run(tx, actor, input) {
		const [cards, guests] = await Promise.all([
			meetingsReader.listCards(tx, actor.authority, input).then(value),
			meetingsReader.listGuests(tx, actor.authority, input).then(value),
		]);
		if (!cards || !guests) return notFound("meetings.listCards");
		const names = new Map(guests.guests.map((g) => [g.person.personId as string, g.person.displayName]));
		return found(
			"meetings.listCards",
			cards.cards.map((k) =>
				personRow(actor, k.personId, names.get(k.personId) ?? "Guest", {
					card: CARD[k.response] ?? k.response,
					attended: k.attended ? "yes" : "no",
				}),
			),
			["card notes"],
		);
	},
});

export const cardBreakdown = read({
	operation: "meetings.cardBreakdown",
	description:
		"Card responses counted over attended guests; no card is unknown.",
	input: one,
	async run(tx, actor, input) {
		const b = value(await meetingsReader.cardBreakdown(tx, actor.authority, input));
		if (!b) return notFound("meetings.cardBreakdown");
		const tally = (r: Record<string, number>) =>
			Object.entries(r)
				.map(([k, n]) => `${CARD[k] ?? k}: ${n}`)
				.join(", ");
		return result("meetings.cardBreakdown", [
			item(b.meetingId, "Cards from attended guests", {
				attended: s(b.attended.total),
				withCard: s(b.attended.withCard),
				noCard: s(b.attended.unknown),
				responses: tally(b.attended.responses),
			}),
			item(`${b.meetingId}:absent`, "Cards from guests who did not attend", {
				total: s(b.absentWithCard.total),
				responses: tally(b.absentWithCard.responses),
			}),
		]);
	},
});

export const invitationAttribution = read({
	operation: "meetings.invitationAttribution",
	description: "Who invited each guest of a meeting.",
	input: one,
	async run(tx, actor, input) {
		const a = value(await meetingsReader.invitationAttribution(tx, actor.authority, input));
		if (!a) return notFound("meetings.invitationAttribution");
		return found(
			"meetings.invitationAttribution",
			a.guests.map((g) =>
				personRow(actor, g.person.personId, g.person.displayName, {
					invitedBy: g.inviter?.displayName ?? null,
					rsvp: RSVP[g.rsvp] ?? g.rsvp,
				}),
			),
		);
	},
});

export const communicationContext = read({
	operation: "meetings.communicationContext",
	description:
		"What an invitation would use: the meeting, agenda and guests with or without an email.",
	input: one,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const x = value(await meetingsReader.communicationContext(tx, actor.authority, input));
		if (!x) return notFound("meetings.communicationContext");
		return found(
			"meetings.communicationContext",
			[
				meetingRow(x.meeting, { agenda: x.agenda.map((a) => a.title).join(", ") || null }),
				...x.guests.map((g) =>
					personRow(actor, g.personId, g.displayName, { hasEmail: g.hasEmail ? "yes" : "no", rsvp: RSVP[g.rsvp] ?? g.rsvp }),
				),
			],
			["email addresses"],
		);
	},
});

export const listCompletedPreLaunchPractices = read({
	operation: "meetings.listCompletedPreLaunchPractices",
	description:
		"How many pre-launch practices were actually held; three meet the Launch criterion.",
	input: z.strictObject({}),
	async run(tx, actor) {
		const p = value(await meetingsReader.listCompletedPreLaunchPractices(tx, actor.authority));
		if (!p) return notFound("meetings.listCompletedPreLaunchPractices");
		return result("meetings.listCompletedPreLaunchPractices", [
			item("practices", "Pre-launch practices held", { held: s(p.count), criterion: p.criterion }),
		]);
	},
});

export const getOwnRsvp = read({
	operation: "meetings.getOwnRsvp",
	description: "The user's own RSVP for a meeting.",
	input: one,
	async run(tx, actor, input) {
		const r = value(await meetingsReader.getOwnRsvp(tx, actor.authority, input));
		if (!r) return notFound("meetings.getOwnRsvp");
		return result("meetings.getOwnRsvp", [
			item(r.guestId, "Your RSVP", { rsvp: RSVP[r.rsvp] ?? r.rsvp, canAnswer: r.responseAllowed }),
		]);
	},
});

// --- Attendance, evaluations and reports --------------------------------------------------------------------------

const CLASS: Record<string, string> = { first_time: "first time", returning: "returning", core_group: "core group" };
export const listAttendance = read({
	operation: "meetings.listAttendance",
	description:
		"A meeting's recorded attendance per guest, and whether it is finalized.",
	input: one,
	async run(tx, actor, input) {
		const a = value(await attendanceReader.listAttendance(tx, actor.authority, { ...input, limit: 500 }));
		if (!a) return notFound("meetings.listAttendance");
		return {
			...found(
				"meetings.listAttendance",
				[
					item(a.meetingId, "Attendance", {
						finalized: a.finalized !== null,
						canMark: a.viewerCanMarkAttendance,
					}),
					...a.items.map((g) =>
						personRow(actor, g.person.personId, g.person.displayName, {
							presence: g.presence,
							rsvp: RSVP[g.rsvp] ?? g.rsvp,
							visit: g.classification ? (CLASS[g.classification] ?? g.classification) : null,
						}),
					),
				],
				[],
			),
			total: a.matched,
		};
	},
});

export const attendanceSummary = read({
	operation: "meetings.attendanceSummary",
	description: "Attendance counts of one meeting.",
	input: one,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const a = value(await attendanceReader.attendanceSummary(tx, actor.authority, input));
		if (!a) return notFound("meetings.attendanceSummary");
		return result("meetings.attendanceSummary", [
			item(a.meetingId, "Attendance summary", {
				finalized: a.finalized !== null,
				guests: s(a.guests),
				attended: s(a.attended),
				absent: s(a.absent),
				excused: s(a.excused),
				firstTime: s(a.classifications.first_time),
				returning: s(a.classifications.returning),
				coreGroup: s(a.classifications.core_group),
			}),
		]);
	},
});

const scoreFields = (scores: Record<string, number>) =>
	Object.fromEntries(c.evaluationFactors.map((f) => [f.replace(/Score$/, ""), s(scores[f])]));
export const getEvaluation = read({
	operation: "meetings.getEvaluation",
	description: "The planter's recorded evaluation scores of a Vision meeting.",
	input: one,
	async run(tx, actor, input) {
		const e = value(await attendanceReader.getEvaluation(tx, actor.authority, input));
		if (!e) return notFound("meetings.getEvaluation");
		if (e.status === "none")
			return found("meetings.getEvaluation", [item(input.meetingId, "Evaluation", { recorded: false })]);
		const v = e.evaluation;
		return result(
			"meetings.getEvaluation",
			[
				item(v.evaluationId, "Evaluation", {
					recorded: true,
					...scoreFields(v.scores),
					average: String(v.average),
					evaluatedOn: v.evaluatedOn,
					corrections: s(v.corrections.count),
				}),
			],
			["evaluation notes"],
		);
	},
});

export const evaluationHistory = read({
	operation: "meetings.evaluationHistory",
	description: "An evaluation and its corrections.",
	input: one,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const h = value(await attendanceReader.evaluationHistory(tx, actor.authority, input));
		if (!h) return notFound("meetings.evaluationHistory");
		return found(
			"meetings.evaluationHistory",
			h.entries.map((e, n) =>
				item(`${h.meetingId}:${n + 1}`, e.kind === "recorded" ? "Recorded" : "Corrected", {
					at: e.at,
					averageBefore: s(e.average.before),
					average: String(e.average.after),
					reason: e.reason,
				}),
			),
		);
	},
});

const point = (p: { meetingId: string; displayTitle: string; localDate: string }, fields: Fields) =>
	item(p.meetingId, p.displayTitle, { date: p.localDate, ...fields });
export const evaluationTrend = read({
	operation: "meetings.evaluationTrend",
	description: "Evaluation averages over recent meetings.",
	input: report,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const t = value(await attendanceReader.evaluationTrend(tx, actor.authority, reportRequest(input)));
		if (!t) return notFound("meetings.evaluationTrend");
		return found(
			"meetings.evaluationTrend",
			t.points.map((p) => point(p, { average: String(p.average), corrected: p.corrected })),
			["meetings with no evaluation"],
		);
	},
});

export const compareEvaluation = read({
	operation: "meetings.compareEvaluation",
	description: "A meeting's evaluation against earlier ones.",
	input: one,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const x = value(await attendanceReader.compareEvaluation(tx, actor.authority, input));
		if (!x) return notFound("meetings.compareEvaluation");
		const known = (k: { status: string; value?: number }) => (k.status === "known" ? String(k.value) : "not recorded");
		return result("meetings.compareEvaluation", [
			item(x.meetingId, "Evaluation compared", {
				current: known(x.current),
				baseline: known(x.baseline),
				earlierCount: x.baseline.status === "known" ? String(x.baseline.count) : null,
				difference: known(x.delta),
			}),
		]);
	},
});

const NOT_RECORDED = "not recorded";
export const attendanceTrend = read({
	operation: "meetings.attendanceTrend",
	description:
		'Attendance of the latest held meetings (default Vision), oldest first. "not recorded" is never 0.',
	input: report,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const request = reportRequest(input);
		// The report counts finalized meetings only; the held meetings around it come from the same list the Meetings page
		// shows, so a held meeting whose attendance nobody recorded is named as not recorded instead of dropping out.
		const [trend, held] = await Promise.all([
			attendanceReader.attendanceTrend(tx, actor.authority, request).then(value),
			meetingsReader
				.list(tx, actor.authority, {
					window: "past",
					types: request.types,
					statuses: ["planning", "ready", "in_progress", "completed"],
					limit: request.limit,
				})
				.then(value),
		]);
		if (!trend || !held) return notFound("meetings.attendanceTrend");
		const points = new Map(trend.points.map((p) => [p.meetingId as string, p]));
		const inWindow = held.items.filter(
			(m) => (!request.from || m.localDate >= request.from) && (!request.to || m.localDate <= request.to),
		);
		const rows = [...inWindow].reverse().map((m) => {
			const p = points.get(m.id);
			return point(
				{ meetingId: m.id, displayTitle: m.displayTitle, localDate: m.localDate },
				p
					? {
							attended: String(p.attended),
							firstTime: s(p.classifications.first_time),
							returning: s(p.classifications.returning),
						}
					: { attended: NOT_RECORDED },
			);
		});
		return found("meetings.attendanceTrend", rows, ["cancelled meetings"]);
	},
});

export const summaryStats = read({
	operation: "meetings.summaryStats",
	description:
		"Totals over held meetings in a window.",
	input: report,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const x = value(await attendanceReader.summaryStats(tx, actor.authority, reportRequest(input)));
		if (!x) return notFound("meetings.summaryStats");
		const known = (k: { status: string; value?: number }) => (k.status === "known" ? String(k.value) : NOT_RECORDED);
		return result("meetings.summaryStats", [
			item("summary", "Meetings summary", {
				held: s(x.held),
				finalized: s(x.finalized),
				attendances: s(x.attendances),
				uniqueAttendees: s(x.uniqueAttendees),
				averageAttendance: known(x.averageAttendance),
				firstTime: s(x.firstTime),
				returning: s(x.returning),
				averageEvaluation: known(x.averageEvaluation),
			}),
		]);
	},
});

export const linkedTaskProgress = read({
	operation: "meetings.linkedTaskProgress",
	description: "The tasks a meeting's finalization created, by state.",
	input: one,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const p = value(await attendanceReader.linkedTaskProgress(tx, actor.authority, input));
		if (!p) return notFound("meetings.linkedTaskProgress");
		return result("meetings.linkedTaskProgress", [
			item(p.meetingId, "Meeting tasks", {
				followUps: s(p.followUps.total),
				open: s(p.followUps.open),
				complete: s(p.followUps.complete),
				needsOwner: s(p.followUps.needsOwner),
				evaluationTask: p.evaluation?.status ?? null,
			}),
		]);
	},
});

export const readAnalytics = read({
	operation: "meetings.readAnalytics",
	description: "One meeting's report: attendance, growth, evaluation, tasks.",
	input: one,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const a = value(await attendanceReader.readAnalytics(tx, actor.authority, input));
		if (!a) return notFound("meetings.readAnalytics");
		return result("meetings.readAnalytics", [
			item(a.meetingId, "Meeting report", {
				attended: a.attended.status === "known" ? String(a.attended.value) : NOT_RECORDED,
				firstTime: s(a.classifications?.first_time),
				returning: s(a.classifications?.returning),
				growth: a.growth.status === "unknown" ? null : String(a.growth.difference),
				evaluation:
					a.evaluation?.current.status === "known" ? String(a.evaluation.current.value) : a.evaluation ? NOT_RECORDED : null,
				followUpsOpen: s(a.tasks.followUps.open),
			}),
		]);
	},
});

export const previewRosterImport = read({
	operation: "meetings.previewRosterImport",
	description: "What updating a team meeting's guests from its ministry would change.",
	input: one,
	allowed: ownerOrAdmin,
	async run(tx, actor, input) {
		const p = value(await rosterReader.previewRosterImport(tx, actor.authority, input));
		if (!p) return notFound("meetings.previewRosterImport");
		const rows = (list: typeof p.add, change: string) =>
			list.map((r) => personRow(actor, r.personId, r.displayName, { change }));
		return found("meetings.previewRosterImport", [
			...rows(p.add, "add"),
			...rows(p.remove, "remove"),
			...rows(p.kept, "keep"),
		]);
	},
});

// --- Venues -------------------------------------------------------------------------------------------------------

const venueRow = (v: z.infer<typeof c.venue>): Row => ({
	kind: "venue",
	id: v.id,
	label: v.name,
	fields: { address: v.address, capacity: s(v.capacity), active: v.active },
});
export const venuesList = read({
	operation: "venues.list",
	description:
		"Saved venues. Search a named place; if several or none match, ask, never pick.",
	input: z.strictObject({
		search: z.string().trim().min(1).max(120).optional(),
		archived: z.enum(["exclude", "include", "only"]).optional(),
	}),
	async run(tx, actor, input) {
		const page = value(await venuesReader.list(tx, actor.authority, { ...input, limit: 50 }));
		if (!page) return notFound("venues.list");
		return {
			...found("venues.list", page.items.map(venueRow), ["venue contact details"]),
			total: page.total,
			completeness: page.next === null ? "complete" : "partial",
			next: page.next,
		};
	},
});
export const venuesGet = read({
	operation: "venues.get",
	description: "One saved venue.",
	input: z.strictObject({ venueId }),
	async run(tx, actor, input) {
		const v = value(await venuesReader.get(tx, actor.authority, input));
		if (!v || v.status !== "available") return notFound("venues.get");
		const row = venueRow(v.venue);
		return result(
			"venues.get",
			[{ ...row, fields: { ...row.fields, cost: v.venue.costDescription, notes: v.venue.notes } }],
			["venue contact details"],
		);
	},
});
export const venuesHistory = read({
	operation: "venues.history",
	description: "A venue's change history.",
	input: z.strictObject({ venueId }),
	async run(tx, actor, input) {
		const h = value(await venuesReader.history(tx, actor.authority, { ...input, limit: 50 }));
		if (!h) return notFound("venues.history");
		return found(
			"venues.history",
			h.items.map((e) =>
				item(e.id, e.kind, {
					at: e.occurredAt,
					fields: Object.keys(e.after ?? e.before ?? {}).join(", ") || null,
					reason: e.reason,
				}),
			),
		);
	},
});

/** The installed Meetings read tools, in catalog order. */
export const MEETINGS_READS = [
	list,
	get,
	hasHistory,
	readAgenda,
	listKit,
	listGuests,
	listCards,
	cardBreakdown,
	invitationAttribution,
	communicationContext,
	listCompletedPreLaunchPractices,
	getOwnRsvp,
	listAttendance,
	attendanceSummary,
	getEvaluation,
	evaluationHistory,
	evaluationTrend,
	compareEvaluation,
	attendanceTrend,
	summaryStats,
	linkedTaskProgress,
	readAnalytics,
	previewRosterImport,
	venuesList,
	venuesGet,
	venuesHistory,
] as const;
