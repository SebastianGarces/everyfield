import type { ChurchBlock } from "@everyfield/contracts/documents";
import type { ReactNode } from "react";
import { H2, H3, Page } from "@formepdf/react";
import { FONT, SIZE, SP } from "../theme.ts";
import { SLOT_BLANK_NOTE, type ChurchTemplate } from "../templates/church.ts";
import { Cellfield, DataTable, Field, Footer, LogoSlot, SectionHead, T, Title, View, type Ctx } from "./blocks.tsx";
import { Doc, LETTER, LETTER_MARGIN } from "./shell.tsx";

function list(ctx: Ctx, block: Extract<ChurchBlock, { items: string[] }>, key: number) {
	const { p } = ctx;
	const ordered = block.kind === "numbered_list";
	return (
		<View key={key} style={{ marginBottom: SP[2], paddingLeft: SP[3] }}>
			{block.items.map((item, i) => (
				<View key={i} style={{ flexDirection: "row", marginBottom: 2 }}>
					<View style={{ width: 16 }}>
						{T(ctx, ordered ? `${i + 1}.` : "•", { size: SIZE.base, color: p.ink, use: "list marker", figures: true })}
					</View>
					<View style={{ flexGrow: 1, width: 480 }}>
						{T(ctx, item, { size: SIZE.base, color: p.ink, use: "list item" })}
					</View>
				</View>
			))}
		</View>
	);
}

/** An unfilled slot is a bordered, marked blank. A filled slot prints the church's own words in the same box. */
function slot(ctx: Ctx, template: ChurchTemplate, block: Extract<ChurchBlock, { kind: "slot" }>, key: number) {
	const { p } = ctx;
	const label = template.slots.find((s) => s.id === block.slotId)?.label ?? block.slotId;
	const lines = block.text.split("\n").filter((line) => line.trim());
	return (
		<View
			key={key}
			wrap={false}
			style={{ borderWidth: 1, borderColor: p.fieldBorder, padding: SP[3], marginVertical: SP[2], minHeight: 72 }}
		>
			{T(ctx, label, { size: SIZE.xs, weight: 700, color: p.mutedText, use: "doctrinal slot label", caps: true })}
			{lines.length
				? lines.map((line, i) => (
						<View key={i} style={{ marginTop: SP[1] }}>
							{T(ctx, line, { size: SIZE.base, color: p.ink, use: "doctrinal slot text" })}
						</View>
					))
				: T(ctx, SLOT_BLANK_NOTE, { size: SIZE.sm, color: p.mutedText, use: "doctrinal slot blank" })}
		</View>
	);
}

/** The editable body, block by block. Headings number themselves in a document and stay plain in a letter. */
function bodyBlocks(ctx: Ctx, template: ChurchTemplate, body: readonly ChurchBlock[]) {
	const { p } = ctx;
	const letter = template.style === "letter";
	let heading = 0;
	const nodes = body.map((block, i) => {
		switch (block.kind) {
			case "heading":
				if (!letter) {
					heading += 1;
					return (
						<View key={i} wrap={false} style={{ marginTop: SP[3] }}>
							{SectionHead(ctx, heading, block.text, "rule")}
						</View>
					);
				}
				return (
					<View key={i} wrap={false} style={{ marginTop: SP[2], marginBottom: SP[1] }}>
						<H2
							style={{
								fontFamily: FONT.body,
								fontWeight: 700,
								fontSize: SIZE.lg,
								lineHeight: 1.2,
								color: ctx.log.pair("letter heading", p.primaryText, p.white),
								margin: 0,
								marginTop: 0,
								marginBottom: 0,
								padding: 0,
							}}
						>
							{block.text}
						</H2>
					</View>
				);
			case "subheading":
				return (
					<View key={i} wrap={false} style={{ marginTop: SP[2], marginBottom: SP[1] }}>
						<H3
							style={{
								fontFamily: FONT.body,
								fontWeight: 700,
								fontSize: SIZE.base,
								lineHeight: 1.3,
								color: ctx.log.pair("subheading", p.ink, p.white),
								margin: 0,
								marginTop: 0,
								marginBottom: 0,
								padding: 0,
							}}
						>
							{block.text}
						</H3>
					</View>
				);
			case "paragraph": {
				// In a document the paragraphs before the first heading are its lead, set in the muted tone.
				const lead = !letter && body.findIndex((b) => b.kind === "heading") > i;
				return (
					<View key={i} style={{ marginBottom: lead ? SP[3] : SP[2] }}>
						{T(ctx, block.text, {
							size: SIZE.base,
							color: lead ? p.mutedText : p.ink,
							use: lead ? "document intro" : "body paragraph",
							style: { lineHeight: 1.5 },
						})}
					</View>
				);
			}
			case "quote":
				return (
					<View
						key={i}
						style={{
							marginBottom: SP[2],
							marginLeft: SP[3],
							paddingLeft: SP[3],
							borderLeftWidth: 3,
							borderColor: p.primary,
						}}
					>
						{T(ctx, block.text, {
							size: SIZE.base,
							weight: 500,
							color: p.ink,
							use: "quote",
							style: { lineHeight: 1.5 },
						})}
					</View>
				);
			case "bulleted_list":
			case "numbered_list":
				return list(ctx, block, i);
			case "slot":
				return slot(ctx, template, block, i);
		}
	});
	// A heading never ends a page: it travels with the short block that follows it.
	const size = (block: ChurchBlock) => ("items" in block ? block.items.join("").length : block.text.length);
	const out: ReactNode[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const block = body[i]!;
		const next = body[i + 1];
		if ((block.kind === "heading" || block.kind === "subheading") && next && next.kind !== "slot" && size(next) < 600) {
			out.push(
				<View key={i} wrap={false}>
					{nodes[i]}
					{nodes[i + 1]}
				</View>,
			);
			i += 1;
		} else out.push(nodes[i]);
	}
	return out;
}

/** The signature, adoption or sign-off block. It belongs to the template frame, never to the body. */
function frameBlock(ctx: Ctx, template: ChurchTemplate) {
	const { p } = ctx;
	const { frame } = template;
	const fill = (text: string) => text.replaceAll("{church_name}", ctx.church);
	if (frame.kind === "letter") {
		return (
			<View wrap={false} style={{ marginTop: SP[2] }}>
				{T(ctx, frame.signOff, { size: SIZE.base, color: p.ink, use: "sign-off", style: { marginBottom: SP[6] } })}
				{ctx.values.pastor_name
					? T(ctx, ctx.values.pastor_name, { size: SIZE.base, weight: 700, color: p.ink, use: "pastor name" })
					: Field(ctx, "Pastor name", 220, 17, { name: "pastor_name" })}
				{T(ctx, ctx.church, { size: SIZE.sm, color: p.mutedText, use: "sign-off church" })}
			</View>
		);
	}
	const closing = frame.closing
		? T(ctx, fill(frame.closing), {
				size: SIZE.base,
				weight: 500,
				color: p.ink,
				use: "closing statement",
				style: { marginBottom: SP[3] },
			})
		: null;
	if (frame.kind === "sign")
		return (
			<View wrap={false} style={{ marginTop: SP[3] }}>
				{closing}
				<View style={{ flexDirection: "row", gap: SP[3] }}>
					{frame.slots.map((s) => Field(ctx, s.label, s.width, 24, { name: s.name }))}
				</View>
			</View>
		);
	const head = { headFill: p.muted, headText: p.ink, headRule: p.primary, rowMin: 30, use: "adoption" } as const;
	const rows = Array.from({ length: frame.signers }, (_, i) => i + 1).map((n) => [
		Cellfield(`adopt_${n}_name`, 130, 20),
		Cellfield(`adopt_${n}_role`, 90, 20),
		Cellfield(`adopt_${n}_signature`, 130, 20),
		Cellfield(`adopt_${n}_date`, 70, 20),
	]);
	return (
		<View wrap={false} style={{ marginTop: SP[3] }}>
			{closing}
			{DataTable(
				ctx,
				[
					{ label: "Board member", w: 150 },
					{ label: "Role", w: 110 },
					{ label: "Signature", w: 150 },
					{ label: "Date", w: 90 },
				],
				rows,
				head,
			)}
		</View>
	);
}

/**
 * The one render path of a Church Document: the template preview and every export call it. The frame (letterhead,
 * kicker, title, legal notice, signature or adoption block) comes from the template; only the body is the church's.
 */
export function churchDocument(ctx: Ctx, template: ChurchTemplate, body: readonly ChurchBlock[]) {
	const { p, theme } = ctx;
	const letter = template.style === "letter";
	const l = theme.letterhead;
	const foot = l?.legalName
		? [l.legalName, l.address, l.ein ? `EIN ${l.ein}` : ""].filter(Boolean).join("  |  ")
		: `${ctx.church}  |  ${template.title}`;
	const page = (
		<Page size={LETTER} margin={LETTER_MARGIN}>
			{Footer(ctx, foot, p.primary)}
			<View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", height: 34 }}>
				{LogoSlot(ctx, 150, 34, theme.logo)}
				{T(ctx, template.kicker, {
					size: SIZE.xs,
					weight: 700,
					color: p.mutedText,
					use: "document kicker",
					caps: true,
				})}
			</View>
			<View style={{ borderBottomWidth: 2, borderColor: p.primary, marginTop: SP[2], marginBottom: SP[3] }} />
			{Title(ctx, template.title, p.primaryText, p.white, letter ? 26 : 30, "document title (primary)")}
			{letter ? (
				<View style={{ marginTop: SP[3], marginBottom: SP[4] }}>
					<View style={{ width: 200 }}>{Field(ctx, "Date", 200, 17, { name: "letter_date" })}</View>
				</View>
			) : (
				<View style={{ height: SP[1] }} />
			)}
			{bodyBlocks(ctx, template, body)}
			{frameBlock(ctx, template)}
		</Page>
	);
	return Doc(ctx, `${template.title}, ${ctx.church}`, template.subject.replaceAll("{church_name}", ctx.church), page);
}
