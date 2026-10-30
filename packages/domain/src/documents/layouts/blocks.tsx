// Document building blocks on the pdfcn theme. pdfcn supplies PageNumber and the theme provider. Two things the
// pdfcn Forme base does not emit are rebuilt here from the same tokens: heading tags (the pdfcn Heading renders a
// plain Text) and table tags (the pdfcn Table is Views). Both feed the PDF structure tree (DOC accessibility).
import type { ReactNode } from "react";
import { Checkbox, Fixed, H1, H2, H3, Image, Cell, Row, Svg, Table, Text, TextField, View } from "@formepdf/react";
import type { Style } from "@formepdf/react";
import { ContrastLog, MIN_BODY, MIN_NONTEXT } from "../contrast.ts";
import { PageNumber } from "../pdfcn/page-number.tsx";
import { FONT, SIZE, SP, type DocumentTheme, type Palette, type ThemeImage } from "../theme.ts";

export type Ctx = {
	p: Palette;
	theme: DocumentTheme;
	church: string;
	/** Merge-field values by key. A key with no value is absent. */
	values: Record<string, string>;
	log: ContrastLog;
};

export const dataUri = (b: Uint8Array, mime: string) => `data:${mime};base64,${Buffer.from(b).toString("base64")}`;

type TextOpts = {
	size?: number;
	weight?: 400 | 500 | 700;
	color: string;
	bg?: string;
	use: string;
	figures?: boolean;
	caps?: boolean;
	style?: Style;
	min?: number;
};
/** Body text. The (use, color, background) triple is logged and must clear its contrast minimum. */
export const T = (ctx: Ctx, children: ReactNode, o: TextOpts) => (
	<Text
		style={{
			fontFamily: o.figures ? FONT.figures : FONT.body,
			fontSize: o.size ?? SIZE.base,
			fontWeight: o.weight ?? 400,
			color: ctx.log.pair(o.use, o.color, o.bg ?? ctx.p.white, o.min ?? MIN_BODY),
			lineHeight: 1.4,
			...(o.caps ? { textTransform: "uppercase", letterSpacing: 0.6 } : {}),
			...o.style,
		}}
	>
		{children}
	</Text>
);

/** Small-caps field label above a box. */
export const Label = (ctx: Ctx, text: string, bg?: string) =>
	T(ctx, text, {
		size: SIZE.xs,
		weight: 700,
		color: ctx.p.mutedText,
		bg,
		use: "field label",
		caps: true,
		style: { marginBottom: 2 },
	});

/** The document title: the only DM Serif Display text besides a church name in the logo slot. */
export const Title = (
	ctx: Ctx,
	text: string,
	color: string,
	bg: string,
	size: number = SIZE.h1,
	use = "document title",
) => (
	<H1
		style={{
			fontFamily: FONT.display,
			fontWeight: 400,
			fontSize: size,
			lineHeight: 1.1,
			letterSpacing: -0.02 * size,
			color: ctx.log.pair(use, color, bg, 3),
			margin: 0,
			marginTop: 0,
			marginBottom: 0,
		}}
	>
		{text}
	</H1>
);
export const H = (ctx: Ctx, level: 2 | 3, text: string, color: string, bg: string, use: string) => {
	const C = level === 2 ? H2 : H3;
	return (
		<C
			style={{
				fontFamily: FONT.body,
				fontWeight: 700,
				fontSize: level === 2 ? SIZE.lg : SIZE.base,
				lineHeight: 1.2,
				color: ctx.log.pair(use, color, bg),
				margin: 0,
				marginTop: 0,
				marginBottom: 0,
				padding: 0,
			}}
		>
			{text}
		</C>
	);
};

/** Inner markup and view box of an SVG logo. Null when the bytes are not an SVG with a view box. */
export function parseSvg(image: ThemeImage) {
	if (image.mediaType !== "image/svg+xml") return null;
	const source = Buffer.from(image.bytes).toString("utf8");
	const match = /<svg[^>]*\sviewBox="([\d.\s-]+)"[^>]*>([\s\S]*)<\/svg>/.exec(source);
	if (!match) return null;
	const [, , w, h] = (match[1] ?? "").trim().split(/\s+/).map(Number);
	if (!w || !h) return null;
	return { content: match[2] ?? "", w, h };
}

/** Fixed w x h box. The logo is fitted inside it (contain), so no logo shape moves anything outside the slot.
 *  No logo: the church name is set in type inside the same box. `onFill` draws a raster logo on a white plate. */
export const LogoSlot = (
	ctx: Ctx,
	w: number,
	h: number,
	logo: ThemeImage | undefined,
	o: { align?: "flex-start" | "center"; nameColor?: string; nameBg?: string; reversedOn?: string } = {},
) => {
	const align = o.align ?? "flex-start";
	if (logo) {
		const scale = Math.min(w / logo.aspect, h);
		const fw = +(scale * logo.aspect).toFixed(2);
		const fh = +scale.toFixed(2);
		const svg = parseSvg(logo);
		let inner: ReactNode;
		if (svg) {
			let content = svg.content;
			if (o.reversedOn) {
				const on = ctx.p.onPrimary;
				content = content
					.replaceAll('fill="#FFFFFF"', 'fill="__P__"')
					.replaceAll(`fill="${ctx.p.primary}"`, `fill="${on}"`)
					.replaceAll("__P__", ctx.p.primary);
			}
			inner = <Svg width={fw} height={fh} viewBox={`0 0 ${svg.w} ${svg.h}`} content={content} alt={logo.alt} />;
		} else {
			inner = (
				<View style={o.reversedOn ? { backgroundColor: ctx.p.white, padding: 3 } : {}}>
					<Image src={dataUri(logo.bytes, logo.mediaType)} alt={logo.alt} style={{ width: fw, height: fh }} />
				</View>
			);
		}
		return (
			<View style={{ width: w, height: h, overflow: "hidden", justifyContent: "center", alignItems: align }}>
				{inner}
			</View>
		);
	}
	const size = Math.min(h * 0.62, (w / Math.max(ctx.church.length, 1)) * 1.9);
	return (
		<View style={{ width: w, height: h, overflow: "hidden", justifyContent: "center", alignItems: align }}>
			<Text
				style={{
					fontFamily: FONT.display,
					fontWeight: 400,
					fontSize: +size.toFixed(1),
					letterSpacing: -0.02 * size,
					color: ctx.log.pair("church name in logo slot", o.nameColor ?? ctx.p.ink, o.nameBg ?? ctx.p.white, 3),
					lineHeight: 1.1,
				}}
			>
				{ctx.church}
			</Text>
		</View>
	);
};

/** Numbered section header. `fill`: number tile in the accent fill. `rule`: number and title as primary text on white. */
export const SectionHead = (ctx: Ctx, n: number, title: string, mode: "fill" | "rule", note?: string) => {
	const { p } = ctx;
	return (
		<View
			style={{
				flexDirection: "row",
				alignItems: "center",
				borderBottomWidth: 1.5,
				borderColor: mode === "fill" ? p.ink : p.primary,
				paddingBottom: 3,
				marginBottom: SP[2],
			}}
		>
			{mode === "fill" ? (
				<View
					style={{
						backgroundColor: p.accent,
						width: 20,
						height: 20,
						alignItems: "center",
						justifyContent: "center",
						marginRight: SP[2],
					}}
				>
					{T(ctx, String(n), {
						size: SIZE.sm,
						weight: 700,
						color: p.onAccent,
						bg: p.accent,
						use: "section number on accent tile",
						figures: true,
						style: { lineHeight: 1 },
					})}
				</View>
			) : (
				<Text
					style={{
						fontFamily: FONT.figures,
						fontWeight: 700,
						fontSize: SIZE.lg,
						color: ctx.log.pair("section number (rule mode)", p.primaryText, p.white),
						marginRight: SP[2],
						lineHeight: 1.1,
					}}
				>
					{String(n).padStart(2, "0")}
				</Text>
			)}
			<View style={{ flexGrow: 1 }}>
				{H(
					ctx,
					2,
					title,
					mode === "fill" ? p.ink : p.primaryText,
					p.white,
					mode === "fill" ? "section heading" : "section heading (primary)",
				)}
			</View>
			{note ? T(ctx, note, { size: SIZE.xs, color: p.mutedText, use: "section note", figures: true }) : null}
		</View>
	);
};

/** Labelled fillable field: the field draws its own box. A given value prints as text in a drawn box instead. */
export const Field = (
	ctx: Ctx,
	label: string,
	w: number,
	h: number,
	o: { name: string; value?: string; bg?: string },
) => (
	<View style={{ width: w }}>
		{Label(ctx, label, o.bg)}
		{o.value ? (
			<View
				style={{
					width: w,
					height: h,
					borderWidth: 1,
					borderColor: ctx.p.fieldBorder,
					justifyContent: "center",
					paddingHorizontal: SP[2],
				}}
			>
				{T(ctx, o.value, { size: SIZE.base, color: ctx.p.ink, use: "field value", figures: true })}
			</View>
		) : (
			<TextField name={o.name} width={w} height={h} fontSize={SIZE.base} />
		)}
	</View>
);

/** A bare fillable box, for a table cell. */
export const Cellfield = (name: string, w: number, h = 16) => (
	<TextField name={name} width={w} height={h} fontSize={SIZE.sm} />
);

/** Checkbox: a drawn square in the accent line color (3:1 on white) with the Forme fillable checkbox on top. */
export const Box = (ctx: Ctx, name: string, size = 12, tone: "accent" | "ink" = "accent") => {
	const line = tone === "accent" && ctx.p.brand ? ctx.p.accentLine : ctx.p.ink;
	ctx.log.pair(`checkbox outline (${tone}) vs page`, line, ctx.p.white, MIN_NONTEXT);
	return (
		<View style={{ width: size, height: size, borderWidth: 1.5, borderColor: line }}>
			<Checkbox name={name} width={size - 3} height={size - 3} />
		</View>
	);
};

export type Col = { label: string; w: number | "auto"; align?: "left" | "right" | "center" };
const cellStyle: Style = { paddingVertical: 3, paddingHorizontal: SP[2], justifyContent: "center" };

/** A real Forme table (tagged Table, TR, TH, TD). The header fill and text color are parameters. */
export const DataTable = (
	ctx: Ctx,
	cols: Col[],
	rows: ReactNode[][],
	o: { headFill: string; headText: string; zebra?: boolean; rowMin?: number; use: string; headRule?: string },
) => {
	const { p } = ctx;
	return (
		<Table
			columns={cols.map((c) => ({ width: c.w === "auto" ? ("auto" as const) : { fixed: c.w } }))}
			style={{ width: "100%" }}
		>
			<Row
				header
				style={{
					backgroundColor: o.headFill,
					borderBottomWidth: o.headRule ? 1.5 : 0,
					borderColor: o.headRule ?? o.headFill,
				}}
			>
				{cols.map((c) => (
					<Cell key={c.label} style={cellStyle}>
						{T(ctx, c.label, {
							size: SIZE.xs,
							weight: 700,
							color: o.headText,
							bg: o.headFill,
							use: `${o.use} table header`,
							caps: true,
							style: { textAlign: c.align ?? "left" },
						})}
					</Cell>
				))}
			</Row>
			{rows.map((r, i) => (
				<Row
					key={i}
					style={{
						backgroundColor: o.zebra && i % 2 === 1 ? p.muted : p.white,
						borderBottomWidth: 0.5,
						borderColor: p.border,
						minHeight: o.rowMin ?? 0,
					}}
				>
					{r.map((v, j) => (
						<Cell key={j} style={cellStyle}>
							{v}
						</Cell>
					))}
				</Row>
			))}
		</Table>
	);
};
export const Cellt = (
	ctx: Ctx,
	text: string,
	o: {
		bold?: boolean;
		figures?: boolean;
		align?: "left" | "right" | "center";
		muted?: boolean;
		bg?: string;
		use: string;
	},
) =>
	T(ctx, text, {
		size: SIZE.sm,
		weight: o.bold ? 700 : 400,
		figures: o.figures,
		color: o.muted ? ctx.p.mutedText : ctx.p.ink,
		bg: o.bg ?? ctx.p.white,
		use: o.use,
		style: { textAlign: o.align ?? "left" },
	});

/** Letterhead footer: the left text and the pdfcn page number. */
export const Footer = (ctx: Ctx, left: string, rule: string, notice?: string) => (
	<Fixed position="footer">
		<View
			style={{
				borderTopWidth: 1,
				borderColor: rule,
				paddingTop: SP[2],
				flexDirection: "row",
				justifyContent: "space-between",
				alignItems: "flex-start",
			}}
		>
			<View style={{ flexGrow: 1 }}>
				{T(ctx, left, { size: SIZE.xs, color: ctx.p.mutedText, use: "footer text" })}
				{notice ? T(ctx, notice, { size: SIZE.xs, weight: 700, color: ctx.p.ink, use: "legal notice" }) : null}
			</View>
			<View style={{ width: 90 }}>
				<PageNumber align="right" size="xs" format="Page {page} of {total}" />
			</View>
		</View>
	</Fixed>
);

/** A photo cropped to a w x h box (cover): the image is scaled to fill and centered, the box clips the rest. */
export const PhotoSlot = (photo: ThemeImage, w: number, h: number) => {
	const scale = Math.max(w / photo.aspect, h);
	return (
		<View style={{ width: w, height: h, overflow: "hidden", justifyContent: "center", alignItems: "center" }}>
			<Image
				src={dataUri(photo.bytes, photo.mediaType)}
				alt={photo.alt}
				style={{ width: +(scale * photo.aspect).toFixed(2), height: +scale.toFixed(2) }}
			/>
		</View>
	);
};

export { Image, View, Text };
