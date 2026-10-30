import { Page } from "@formepdf/react";
import { SIZE, SP } from "../theme.ts";
import { Cellfield, Cellt, DataTable, Field, Footer, LogoSlot, T, Title, View, type Ctx } from "./blocks.tsx";
import { Doc, LETTER } from "./shell.tsx";

export const SIGN_IN_ROWS = 18;

/** Operational Letter sheet: a table of fillable cells. The meeting date and number print when given. */
export function signInDocument(ctx: Ctx) {
	const { p, theme } = ctx;
	const head = { headFill: p.accent, headText: p.onAccent, zebra: true, rowMin: 25, use: "sign-in" } as const;
	const rows = Array.from({ length: SIGN_IN_ROWS }, (_, i) => [
		Cellt(ctx, String(i + 1), {
			figures: true,
			muted: true,
			bg: i % 2 ? p.muted : p.white,
			use: "row number",
			align: "center",
		}),
		Cellfield(`guest_${i + 1}_name`, 126, 17),
		Cellfield(`guest_${i + 1}_email`, 146, 17),
		Cellfield(`guest_${i + 1}_phone`, 88, 17),
		Cellfield(`guest_${i + 1}_invited_by`, 96, 17),
	]);
	const page = (
		<Page size={LETTER} margin={{ top: 40, right: 40, bottom: 56, left: 40 }}>
			{Footer(ctx, `${theme.letterhead?.legalName ?? ctx.church}  |  Guest sign-in sheet`, p.ink)}
			<View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 34 }}>
				{LogoSlot(ctx, 150, 34, theme.logo)}
				{T(ctx, "Vision meeting", { size: SIZE.xs, weight: 700, color: p.mutedText, use: "sheet kicker", caps: true })}
			</View>
			<View style={{ borderBottomWidth: 4, borderColor: p.accent, marginTop: SP[2], marginBottom: SP[3] }} />
			{Title(ctx, "Guest Sign-in Sheet", p.ink, p.white, 28, "sign-in title")}
			{T(ctx, `Welcome to ${ctx.church}. Please sign in so we can thank you and stay in touch.`, {
				size: SIZE.base,
				color: p.mutedText,
				use: "sign-in purpose",
				style: { marginTop: 2, marginBottom: SP[3] },
			})}
			<View style={{ flexDirection: "row", gap: SP[3], marginBottom: SP[3] }}>
				{Field(ctx, "Meeting date", 170, 17, { name: "meeting_date", value: ctx.values.meeting_date })}
				{Field(ctx, "Meeting number", 110, 17, { name: "meeting_number", value: ctx.values.meeting_number })}
			</View>
			{DataTable(
				ctx,
				[
					{ label: "#", w: 26, align: "center" },
					{ label: "Name", w: 142 },
					{ label: "Email", w: 162 },
					{ label: "Phone", w: 104 },
					{ label: "Who invited you?", w: "auto" },
				],
				rows,
				head,
			)}
		</Page>
	);
	return Doc(ctx, `Guest Sign-in Sheet, ${ctx.church}`, "Sign-in sheet for a vision meeting", page);
}
