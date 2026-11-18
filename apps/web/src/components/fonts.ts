import { DM_Sans, DM_Serif_Display, DM_Serif_Text } from "next/font/google";

const display = DM_Serif_Display({
	weight: "400",
	subsets: ["latin"],
	variable: "--font-dm-serif-display",
	display: "swap",
});
const title = DM_Serif_Text({ weight: "400", subsets: ["latin"], variable: "--font-dm-serif-text", display: "swap" });
const body = DM_Sans({ subsets: ["latin"], axes: ["opsz"], variable: "--font-dm-sans", display: "swap" });

export const FONT_VARIABLES = `${display.variable} ${title.variable} ${body.variable}`;
