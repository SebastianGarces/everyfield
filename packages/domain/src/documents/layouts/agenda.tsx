import { Page } from "@formepdf/react";
import { SIZE, SP } from "../theme.ts";
import { BLANK_RUN_ROWS, MIN_ATTENDEE_ROWS, ACTION_ROWS, type AgendaSpec } from "../templates/agenda-content.ts";
import { durationText } from "../agenda-meeting.ts";
import {
	Box,
	Cellfield,
	Cellt,
	DataTable,
	Field,
	Footer,
	LogoSlot,
	SectionHead,
	T,
	Title,
	View,
	type Ctx,
} from "./blocks.tsx";
import { Doc, LETTER, LETTER_MARGIN } from "./shell.tsx";

const AGENDA_SLOT = { w: 150, h: 34 };

/** Rows of the attendee table: the people on the list, then blank write-in rows, at least the approved minimum. */
export function attendeeSlots(people: number) {
	const total = Math.max(MIN_ATTENDEE_ROWS, people + 2);
	return total + (total % 2);
}

/**
 * Operational Letter agenda: header, title, purpose, meta panel, run of show, attendees, actions. The run of show and the
 * attendees come from the meeting when ctx has one; otherwise the sheet is blank write-in rows. Pages grow as needed.
 */
export function agendaDocument(ctx: Ctx, spec: AgendaSpec) {
	const { p, theme, meeting } = ctx;
	const l = theme.letterhead;
	const foot = l?.legalName
		? [l.legalName, l.address, l.ein ? `EIN ${l.ein}` : ""].filter(Boolean).join("  |  ")
		: `${ctx.church}  |  ${spec.footer}`;
	const head = { headFill: p.muted, headText: p.ink, headRule: p.primary, use: "agenda" } as const;
	const sections = meeting?.sections ?? [];
	const seg =
		sections.length > 0
			? sections.map((s, i) => [
					<View key="t">
						{T(ctx, s.start, { size: SIZE.sm, weight: 700, color: p.ink, use: "agenda start time", figures: true })}
						{T(ctx, `${s.minutes} min`, {
							size: SIZE.xs - 1,
							color: p.mutedText,
							use: "agenda minutes",
							figures: true,
						})}
					</View>,
					Cellt(ctx, s.title, { bold: true, use: "agenda segment" }),
					Cellfield(`lead_${i + 1}`, 72, 15),
					Cellfield(`notes_${i + 1}`, 212, 15),
				])
			: Array.from({ length: BLANK_RUN_ROWS }, (_, i) => [
					Cellfield(`time_${i + 1}`, 52, 15),
					Cellfield(`segment_${i + 1}`, 138, 15),
					Cellfield(`lead_${i + 1}`, 72, 15),
					Cellfield(`notes_${i + 1}`, 212, 15),
				]);
	const people = meeting?.attendees ?? [];
	const slots = attendeeSlots(people.length);
	const side = (k: number) => {
		const who = people[k - 1];
		return [
			who ? Cellt(ctx, who.name, { use: "attendee name" }) : Cellfield(`attendee_${k}_name`, 112, 14),
			who?.role ? Cellt(ctx, who.role, { use: "attendee role" }) : Cellfield(`attendee_${k}_role`, 78, 14),
			<View key={`b${k}`} style={{ alignItems: "center" }}>
				{Box(ctx, `present_${k}`, 10, "ink")}
			</View>,
		];
	};
	const attendeeRows = Array.from({ length: slots / 2 }, (_, i) => [...side(2 * i + 1), ...side(2 * i + 2)]);
	const half = [
		{ label: "Name", w: 124 },
		{ label: "Role", w: 90 },
		{ label: "Here", w: 52, align: "center" as const },
	];
	const metaField = (label: string, name: string, w: number, value?: string) => (
		<View key={name} style={{ paddingRight: SP[2] }}>
			{Field(ctx, label, w, 17, { name, value, bg: p.muted })}
		</View>
	);
	const page = (
		<Page size={LETTER} margin={LETTER_MARGIN}>
			{Footer(ctx, foot, p.primary)}
			<View
				style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: AGENDA_SLOT.h }}
			>
				{LogoSlot(ctx, AGENDA_SLOT.w, AGENDA_SLOT.h, theme.logo)}
				{T(ctx, spec.kicker, {
					size: SIZE.xs,
					weight: 700,
					color: p.mutedText,
					use: "agenda kicker",
					caps: true,
					figures: true,
				})}
			</View>
			<View style={{ borderBottomWidth: 2, borderColor: p.primary, marginTop: SP[2], marginBottom: SP[3] }} />
			{Title(ctx, spec.title, p.primaryText, p.white, 30, "agenda title (primary)")}
			{meeting
				? T(ctx, meeting.title, {
						size: SIZE.lg,
						weight: 700,
						color: p.ink,
						use: "agenda meeting title",
						style: { marginTop: SP[2] },
					})
				: null}
			{T(ctx, spec.purpose(ctx.church), {
				size: SIZE.base,
				color: p.mutedText,
				use: "agenda purpose",
				style: { marginTop: SP[1], marginBottom: SP[3] },
			})}
			<View
				style={{
					backgroundColor: p.muted,
					flexDirection: "row",
					paddingVertical: SP[2],
					paddingHorizontal: SP[3],
					marginBottom: SP[4],
				}}
			>
				{metaField("Date", "meeting_date", 100, ctx.values.meeting_date ?? meeting?.date)}
				{metaField("Time", "meeting_time", 62, meeting?.time)}
				{metaField("Place", "meeting_place", 170, meeting?.place ?? undefined)}
				{metaField("Facilitator", "facilitator", 154, spec.facilitatorFromPastor ? ctx.values.pastor_name : undefined)}
			</View>
			{SectionHead(
				ctx,
				1,
				"Run of show",
				"rule",
				meeting && sections.length > 0 ? durationText(meeting.totalMinutes) : undefined,
			)}
			{DataTable(
				ctx,
				[
					{ label: "Time", w: 64 },
					{ label: "Segment", w: 150 },
					{ label: "Lead", w: 84 },
					{ label: "Notes", w: "auto" },
				],
				seg,
				head,
			)}
			<View style={{ height: SP[3] }} />
			{SectionHead(ctx, 2, "Attendees", "rule", "Tick when present")}
			{DataTable(ctx, [...half, ...half], attendeeRows, head)}
			{meeting && meeting.hiddenAttendees > 0
				? T(
						ctx,
						`This list shows the first ${meeting.attendees.length} people. ${meeting.hiddenAttendees} more are not shown.`,
						{
							size: SIZE.xs,
							color: p.mutedText,
							use: "attendee overflow note",
							style: { marginTop: SP[1] },
						},
					)
				: null}
			<View style={{ height: SP[3] }} />
			<View wrap={false}>
				{SectionHead(ctx, 3, "Follow-up actions", "rule")}
				{DataTable(
					ctx,
					[
						{ label: "Action", w: "auto" },
						{ label: "Owner", w: 100 },
						{ label: "Due", w: 60, align: "right" },
						{ label: "Done", w: 34, align: "center" },
					],
					Array.from({ length: ACTION_ROWS }, (_, i) => [
						Cellfield(`action_${i + 1}`, 250, 14),
						Cellfield(`owner_${i + 1}`, 86, 14),
						Cellfield(`due_${i + 1}`, 46, 14),
						<View key="b" style={{ alignItems: "center" }}>
							{Box(ctx, `done_${i + 1}`, 10, "ink")}
						</View>,
					]),
					head,
				)}
			</View>
		</Page>
	);
	return Doc(ctx, `${spec.title}, ${ctx.church}`, spec.subject, page);
}
