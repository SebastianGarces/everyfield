import type { ReactNode } from "react";
import { Document } from "@formepdf/react";
import { documentFonts } from "../fonts.ts";
import { FONT, SIZE } from "../theme.ts";
import type { Ctx } from "./blocks.tsx";

export const LETTER = { width: 612, height: 792 } as const;
export const CARD = { width: 306, height: 396 } as const; // 4.25 x 5.5 in at 72 pt per inch
export const LETTER_MARGIN = { top: 40, right: 40, bottom: 56, left: 40 } as const;
export const CARD_MARGIN = 14;

/** The tagged, titled, language-set Document. */
export function Doc(ctx: Ctx, title: string, subject: string, pages: ReactNode) {
	return (
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
}
