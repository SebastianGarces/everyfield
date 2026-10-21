import type { Metadata, Viewport } from "next";
import { DM_Sans, DM_Serif_Display, DM_Serif_Text } from "next/font/google";
import type { ReactNode } from "react";
import "../styles/marketing.css";
import { PageScroll } from "../components/frame/PageScroll";
import { JS_FLAG_SCRIPT, READER_INPUT_SCRIPT } from "../components/frame/reader-input";
import { PAGES, SITE_NAME, fullTitle } from "../marketing/meta";
import { SITE_URL } from "../site";

// The brand fonts (foundations.md, Type): DM Serif Display for headings and numbers at 24px and up, DM Serif Text below
// 24px, DM Sans for everything else. The serifs have one weight; font-synthesis-weight: none keeps the browser from faking bold.
const display = DM_Serif_Display({
	weight: "400",
	subsets: ["latin"],
	variable: "--font-dm-serif-display",
	display: "swap",
});
const title = DM_Serif_Text({ weight: "400", subsets: ["latin"], variable: "--font-dm-serif-text", display: "swap" });
const body = DM_Sans({ subsets: ["latin"], axes: ["opsz"], variable: "--font-dm-sans", display: "swap" });

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: { default: fullTitle(PAGES.home), template: `%s · ${SITE_NAME}` },
	description: PAGES.home.description,
	applicationName: SITE_NAME,
	openGraph: { siteName: SITE_NAME, type: "website", locale: "en_US" },
	twitter: { card: "summary_large_image" },
};
// Marketing pages are light only, in every browser and system setting (Phase 5 rule): a color-scheme meta and the root style.
export const viewport: Viewport = { themeColor: "#FCFBF8", colorScheme: "light" };

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className={`${display.variable} ${title.variable} ${body.variable}`} suppressHydrationWarning>
			<body>
				<script dangerouslySetInnerHTML={{ __html: READER_INPUT_SCRIPT + ";" + JS_FLAG_SCRIPT }} />
				{children}
				<PageScroll />
			</body>
		</html>
	);
}
