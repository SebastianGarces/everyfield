import { Page } from "@formepdf/react";
import { SIZE, SP } from "../theme.ts";
import type { AgendaSpec } from "../templates/agenda-content.ts";
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
import { Doc, LETTER } from "./shell.tsx";

export const AGENDA_SLOT = { w: 150, h: 34 };

/** Operational Letter agenda on one page: header, title, purpose, meta panel, run of show, attendees, actions. */
export function agendaDocument(ctx: Ctx, spec: AgendaSpec) {
	const { p, theme } = ctx;
	const l = theme.letterhead;
	const foot = l?.legalName
		? [l.legalName, l.address, l.ein ? `EIN ${l.ein}` : ""].filter(Boolean).join("  |  ")
		: `${ctx.church}  |  ${spec.footer}`;
	const head = { headFill: p.muted, headText: p.ink, headRule: p.primary, use: "agenda" } as const;
	const total = spec.segments.reduce((sum, s) => sum + s.mins, 0);
	const seg = spec.segments.map((s, i) => [
		<View key="t">
			{Cellfield(`time_${i + 1}`, 52, 15)}
			{T(ctx, `${s.mins} min`, {
				size: SIZE.xs - 1,
				color: p.mutedText,
				use: "agenda minutes",
				figures: true,
				style: { marginTop: 1 },
			})}
		</View>,
		Cellt(ctx, s.name, { bold: true, use: "agenda segment" }),
		Cellfield(`lead_${i + 1}`, 76, 15),
		T(ctx, s.note, { size: SIZE.xs, color: p.ink, use: "agenda note", style: { lineHeight: 1.35 } }),
	]);
	const people = (offset: number) =>
		DataTable(
			ctx,
			[
				{ label: "Name", w: 118 },
				{ label: "Role", w: 78 },
				{ label: "Here", w: 34, align: "center" },
			],
			Array.from({ length: spec.attendeeRows }, (_, i) => [
				Cellfield(`attendee_${offset + i + 1}_name`, 118, 14),
				Cellfield(`attendee_${offset + i + 1}_role`, 74, 14),
				<View key="b" style={{ alignItems: "center" }}>
					{Box(ctx, `present_${offset + i + 1}`, 10, "ink")}
				</View>,
			]),
			head,
		);
	const metaField = (label: string, name: string, w: number, value?: string) => (
		<View key={name} style={{ paddingRight: SP[2] }}>
			{Field(ctx, label, w, 17, { name, value, bg: p.muted })}
		</View>
	);
	const page = (
		<Page size={LETTER} margin={{ top: 40, right: 40, bottom: 56, left: 40 }}>
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
				{metaField("Date", "meeting_date", 112, ctx.values.meeting_date)}
				{metaField("Time", "meeting_time", 84)}
				{metaField("Place", "meeting_place", 186)}
				{metaField("Facilitator", "facilitator", 104, spec.facilitatorFromPastor ? ctx.values.pastor_name : undefined)}
			</View>
			{SectionHead(ctx, 1, "Run of show", "rule", `${total} minutes`)}
			{DataTable(
				ctx,
				[
					{ label: "Time", w: 64 },
					{ label: "Segment", w: 112 },
					{ label: "Lead", w: 88 },
					{ label: "Notes", w: "auto" },
				],
				seg,
				head,
			)}
			<View style={{ height: SP[3] }} />
			{SectionHead(ctx, 2, "Attendees", "rule", "Tick when present")}
			<View style={{ flexDirection: "row", gap: SP[4] }}>
				<View style={{ width: 260 }}>{people(0)}</View>
				<View style={{ width: 260 }}>{people(spec.attendeeRows)}</View>
			</View>
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
					Array.from({ length: spec.actionRows }, (_, i) => [
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
