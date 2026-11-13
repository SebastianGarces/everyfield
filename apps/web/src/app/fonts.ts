import { DM_Sans, DM_Serif_Display, DM_Serif_Text } from "next/font/google";

// The brand fonts (foundations.md, Type): DM Serif Display for headings and numbers at 24px and up, DM Serif Text below
// 24px, DM Sans for everything else. The serifs have one weight; font-synthesis-weight: none keeps the browser from faking bold.
// The root layout and global-error, which replaces it when it fails, both put these variables on <html>.
const display = DM_Serif_Display({
	weight: "400",
	subsets: ["latin"],
	variable: "--font-dm-serif-display",
	display: "swap",
});
const title = DM_Serif_Text({ weight: "400", subsets: ["latin"], variable: "--font-dm-serif-text", display: "swap" });
const body = DM_Sans({ subsets: ["latin"], axes: ["opsz"], variable: "--font-dm-sans", display: "swap" });

export const FONT_VARIABLES = `${display.variable} ${title.variable} ${body.variable}`;
