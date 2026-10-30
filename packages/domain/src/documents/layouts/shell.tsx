import type { ReactNode } from "react";
import { Document } from "@formepdf/react";
import { PdfcnThemeProvider } from "../pdfcn/theme-provider.tsx";
import { defaultPrimitives } from "../pdfcn/themes/primitives.ts";
import type { PdfcnTheme } from "../pdfcn/types.ts";
import { documentFonts } from "../fonts.ts";
import { FONT, SIZE, SP, type Palette } from "../theme.ts";
import { T, View, type Ctx } from "./blocks.tsx";

export const LETTER = { width: 612, height: 792 } as const;
export const CARD = { width: 306, height: 396 } as const; // 4.25 x 5.5 in at 72 pt per inch
export const LETTER_MARGIN = { top: 40, right: 40, bottom: 56, left: 40 } as const;
export const CARD_MARGIN = 14;

function makeTheme(p: Palette, margin: number): PdfcnTheme {
	return {
		name: "everyfield-form",
		primitives: {
			...defaultPrimitives,
			typography: {
				xs: SIZE.xs,
				sm: SIZE.sm,
				base: SIZE.base,
				lg: SIZE.lg,
				xl: SIZE.h3,
				"2xl": SIZE.h2,
				"3xl": SIZE.h1,
			},
			spacing: {
				0: 0,
				0.5: 1.5,
				1: SP[1],
				2: SP[2],
				3: SP[3],
				4: SP[4],
				5: SP[5],
				6: SP[6],
				8: SP[8],
				10: SP[10],
				12: SP[10] + SP[2],
				16: SP[10] + SP[6],
			},
			borderRadius: { none: 0, sm: 0, md: 0, lg: 0, full: 0 },
			fontWeights: { regular: 400, medium: 500, semibold: 700, bold: 700 },
		},
		colors: {
			foreground: p.ink,
			background: p.white,
			muted: p.muted,
			mutedForeground: p.mutedText,
			primary: p.primary,
			primaryForeground: p.onPrimary,
			border: p.border,
			accent: p.accent,
			destructive: "#B02A4A",
			success: "#026B40",
			warning: "#9A4A0C",
			info: "#2A6296",
		},
		typography: {
			body: { fontFamily: FONT.body, fontSize: SIZE.base, lineHeight: 1.4 },
			heading: {
				fontFamily: FONT.body,
				fontWeight: 700,
				lineHeight: 1.15,
				fontSize: { h1: SIZE.h1, h2: SIZE.h2, h3: SIZE.h3, h4: SIZE.lg, h5: SIZE.base, h6: SIZE.sm },
			},
		},
		spacing: {
			page: { marginTop: margin, marginRight: margin, marginBottom: margin, marginLeft: margin },
			sectionGap: SP[6],
			paragraphGap: SP[2],
			componentGap: SP[3],
		},
		page: { size: "LETTER", orientation: "portrait" },
	};
}

/** The tagged, titled, language-set Document inside the pdfcn theme provider. */
export function Doc(ctx: Ctx, title: string, subject: string, pages: ReactNode, margin = 40) {
	const theme = makeTheme(ctx.p, margin);
	const Root = () => (
		<Document
			title={title}
			subject={subject}
			author={ctx.church}
			creator="Everyfield"
			lang="en-US"
			tagged
			pdfUa
			fonts={documentFonts() as never}
			style={{ fontFamily: FONT.body, fontSize: SIZE.base, color: ctx.p.ink }}
		>
			{pages}
		</Document>
	);
	return (
		<PdfcnThemeProvider theme={theme}>
			<Root />
		</PdfcnThemeProvider>
	);
}

/** A doctrinal section no one has filled in: a visible blank the network completes. */
export const DoctrineSlot = (ctx: Ctx, title: string) => (
	<View
		wrap={false}
		style={{ borderWidth: 1, borderColor: ctx.p.fieldBorder, padding: SP[3], marginVertical: SP[2], minHeight: 72 }}
	>
		{T(ctx, title, { size: SIZE.xs, weight: 700, color: ctx.p.mutedText, use: "doctrinal slot label", caps: true })}
		{T(ctx, "To be completed by the network. Leave blank until it is filled.", {
			size: SIZE.sm,
			color: ctx.p.mutedText,
			use: "doctrinal slot hint",
		})}
	</View>
);
