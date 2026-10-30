import { Fixed, Page } from "@formepdf/react";
import { SIZE, SP } from "../theme.ts";
import { Box, Field, LogoSlot, PhotoSlot, T, Title, View, type Ctx } from "./blocks.tsx";
import { CARD, CARD_MARGIN, Doc } from "./shell.tsx";
import { type CardRow, type CardSpec } from "../templates/card-content.ts";

const CARD_SLOT = { w: 150, h: 44 };

const contactLine = (ctx: Ctx) => {
	const l = ctx.theme.letterhead;
	const parts = [l?.phone, l?.email, l?.web].filter(Boolean);
	if (parts.length) return [ctx.p.brand ? (l?.legalName ?? "") : "", ...parts].filter(Boolean).join("  ·  ");
	return ctx.values.pastor_name ? `Return this card to ${ctx.values.pastor_name}.` : "";
};

/** Outward-facing 4.25 x 5.5 in card: primary cover, 4 pt accent bar, rows with the checkbox on the left, then fields. */
export function cardDocument(ctx: Ctx, spec: CardSpec) {
	const { p, theme } = ctx;
	const W = CARD.width - 2 * CARD_MARGIN;
	const rowCount = spec.rows.length;
	const rows = spec.rows.map((c: CardRow, i: number) => (
		<View
			key={c.name}
			wrap={false}
			style={{
				flexDirection: "row",
				alignItems: "center",
				paddingVertical: rowCount > 3 ? 4 : 6,
				...(i ? { borderTopWidth: 0.5, borderColor: p.border } : {}),
			}}
		>
			<View style={{ marginRight: SP[2] }}>{Box(ctx, c.name, 13)}</View>
			{c.tile ? (
				<View
					style={{
						backgroundColor: p.accent,
						width: 36,
						height: 16,
						alignItems: "center",
						justifyContent: "center",
						marginRight: SP[2],
					}}
				>
					{T(ctx, c.tile, {
						size: SIZE.xs - 1,
						weight: 700,
						color: p.onAccent,
						bg: p.accent,
						use: "tile on accent fill",
						caps: true,
						style: { lineHeight: 1 },
					})}
				</View>
			) : null}
			<View style={{ width: W - 13 - (c.tile ? 36 + SP[2] : 0) - 2 * SP[2] }}>
				{T(ctx, c.text, { size: SIZE.xs - 0.5, color: p.ink, use: "card row text", style: { lineHeight: 1.25 } })}
			</View>
		</View>
	));
	const tagline = theme.tagline ?? spec.neutralTagline;
	const contact = contactLine(ctx);
	const second = spec.fields.slice(2);
	const page = (
		<Page size={CARD} margin={CARD_MARGIN}>
			<View style={{ backgroundColor: p.primary, padding: 12, flexDirection: "row", height: 96 }}>
				<View style={{ flexGrow: 1 }}>
					{LogoSlot(ctx, CARD_SLOT.w, CARD_SLOT.h, theme.logo, {
						nameColor: p.onPrimary,
						nameBg: p.primary,
						reversedOn: p.primary,
					})}
					{T(ctx, tagline, {
						size: SIZE.sm,
						weight: 500,
						color: p.onPrimary,
						bg: p.primary,
						use: "tagline on primary fill",
						style: { marginTop: SP[2], width: 150, lineHeight: 1.3 },
					})}
				</View>
				{theme.photo ? PhotoSlot(theme.photo, 72, 72) : null}
			</View>
			<View style={{ backgroundColor: p.accent, height: 4 }} />
			<View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginTop: SP[3] }}>
				{Title(ctx, spec.heading, p.ink, p.white, 20, "card title")}
				{T(ctx, spec.kicker, { size: SIZE.xs - 1, weight: 700, color: p.mutedText, use: "card kicker", caps: true })}
			</View>
			{T(ctx, spec.leadIn, {
				size: SIZE.xs,
				color: p.mutedText,
				use: "card lead-in",
				figures: true,
				style: { marginTop: 2, marginBottom: SP[1] },
			})}
			<View style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: p.ink }}>{rows}</View>
			<View style={{ flexDirection: "row", gap: SP[2], marginTop: SP[3] }}>
				{Field(ctx, spec.fields[0]!.label, 128, 17, { name: spec.fields[0]!.name })}
				{Field(ctx, spec.fields[1]!.label, W - 128 - SP[2], 17, { name: spec.fields[1]!.name })}
			</View>
			{second.length ? (
				<View style={{ flexDirection: "row", gap: SP[2], marginTop: SP[2] }}>
					{second.map((f, i) =>
						Field(ctx, f.label, i === 0 && second.length > 1 ? W - 80 - SP[2] : second.length > 1 ? 80 : W, 17, {
							name: f.name,
						}),
					)}
				</View>
			) : null}
			<Fixed position="footer">
				<View style={{ borderTopWidth: 1, borderColor: p.primary, paddingTop: 3 }}>
					{contact
						? T(ctx, contact, { size: SIZE.xs - 1, color: p.mutedText, use: "card contact line", figures: true })
						: null}
				</View>
			</Fixed>
		</Page>
	);
	return Doc(ctx, `${spec.title}, ${ctx.church}`, spec.subject, page, CARD_MARGIN);
}
