import { Page } from "@formepdf/react";
import { SIZE, SP } from "../theme.ts";
import type { Block, TextDocumentSpec } from "../templates/text-content.ts";
import { Field, Footer, LogoSlot, SectionHead, T, Title, View, type Ctx } from "./blocks.tsx";
import { Doc, LETTER } from "./shell.tsx";

/** Fill `{church_name}` and `{pastor_name}`. Without a pastor name the text says "your pastor". */
export const fillText = (ctx: Ctx, text: string) =>
	text.replaceAll("{church_name}", ctx.church).replaceAll("{pastor_name}", ctx.values.pastor_name ?? "your pastor");

function renderBlock(ctx: Ctx, block: Block, key: number) {
	const { p } = ctx;
	if (block.kind === "p")
		return (
			<View key={key} style={{ marginBottom: SP[2] }}>
				{T(ctx, fillText(ctx, block.text), {
					size: SIZE.base,
					color: p.ink,
					use: "body paragraph",
					style: { lineHeight: 1.5 },
				})}
			</View>
		);
	return (
		<View key={key} style={{ marginBottom: SP[2], paddingLeft: SP[3] }}>
			{block.items.map((item, i) => (
				<View key={i} style={{ flexDirection: "row", marginBottom: 2 }}>
					<View style={{ width: 16 }}>
						{T(ctx, block.ordered ? `${i + 1}.` : "•", {
							size: SIZE.base,
							color: p.ink,
							use: "list marker",
							figures: true,
						})}
					</View>
					<View style={{ flexGrow: 1, width: 480 }}>
						{T(ctx, fillText(ctx, item), { size: SIZE.base, color: p.ink, use: "list item" })}
					</View>
				</View>
			))}
		</View>
	);
}

/** Operational Letter page for a text-heavy template, drawn from its structured section data. */
export function textDocument(ctx: Ctx, spec: TextDocumentSpec) {
	const { p, theme } = ctx;
	const letter = spec.style === "letter";
	const l = theme.letterhead;
	const foot = l?.legalName
		? [l.legalName, l.address, l.ein ? `EIN ${l.ein}` : ""].filter(Boolean).join("  |  ")
		: `${ctx.church}  |  ${spec.title}`;
	const body = spec.sections.map((section, i) => (
		<View key={i} style={{ marginBottom: letter ? 0 : SP[3] }}>
			{letter ? null : <View wrap={false}>{SectionHead(ctx, i + 1, section.heading, "rule")}</View>}
			{section.blocks.map((block, j) => renderBlock(ctx, block, j))}
		</View>
	));
	const signatureRow = spec.signatures.length ? (
		<View wrap={false} style={{ marginTop: SP[3] }}>
			{spec.closing
				? T(ctx, fillText(ctx, spec.closing), {
						size: SIZE.base,
						weight: 500,
						color: p.ink,
						use: "closing statement",
						style: { marginBottom: SP[3] },
					})
				: null}
			<View style={{ flexDirection: "row", gap: SP[3] }}>
				{spec.signatures.map((slot) => Field(ctx, slot.label, slot.width, 24, { name: slot.name }))}
			</View>
		</View>
	) : null;
	const signOff = letter ? (
		<View wrap={false} style={{ marginTop: SP[2] }}>
			{T(ctx, spec.signOff ?? "", { size: SIZE.base, color: p.ink, use: "sign-off", style: { marginBottom: SP[6] } })}
			{ctx.values.pastor_name
				? T(ctx, ctx.values.pastor_name, { size: SIZE.base, weight: 700, color: p.ink, use: "pastor name" })
				: Field(ctx, "Pastor name", 220, 17, { name: "pastor_name" })}
			{T(ctx, ctx.church, { size: SIZE.sm, color: p.mutedText, use: "sign-off church" })}
		</View>
	) : null;
	const page = (
		<Page size={LETTER} margin={{ top: 40, right: 40, bottom: 56, left: 40 }}>
			{Footer(ctx, foot, p.primary)}
			<View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 34 }}>
				{LogoSlot(ctx, 150, 34, theme.logo)}
				{T(ctx, spec.kicker, { size: SIZE.xs, weight: 700, color: p.mutedText, use: "document kicker", caps: true })}
			</View>
			<View style={{ borderBottomWidth: 2, borderColor: p.primary, marginTop: SP[2], marginBottom: SP[3] }} />
			{Title(ctx, spec.title, p.primaryText, p.white, letter ? 26 : 30, "document title (primary)")}
			{letter ? (
				<View style={{ marginTop: SP[3], marginBottom: SP[4] }}>
					<View style={{ width: 200 }}>{Field(ctx, "Date", 200, 17, { name: "letter_date" })}</View>
				</View>
			) : (
				T(ctx, fillText(ctx, spec.intro), {
					size: SIZE.base,
					color: p.mutedText,
					use: "document intro",
					style: { marginTop: SP[1], marginBottom: SP[4] },
				})
			)}
			{letter
				? T(ctx, spec.greeting ?? "", {
						size: SIZE.base,
						color: p.ink,
						use: "greeting",
						style: { marginBottom: SP[2] },
					})
				: null}
			{body}
			{signatureRow}
			{signOff}
		</Page>
	);
	return Doc(ctx, `${spec.title}, ${ctx.church}`, fillText(ctx, spec.subject), page);
}
