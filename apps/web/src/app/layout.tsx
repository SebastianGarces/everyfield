import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../styles/marketing.css";
import { PageScroll } from "../components/frame/PageScroll";
import { JS_FLAG_SCRIPT, READER_INPUT_SCRIPT } from "../components/frame/reader-input";
import { PAGES, SITE_NAME, fullTitle } from "../marketing/meta";
import { SITE_URL } from "../site";
import { FONT_VARIABLES } from "./fonts";

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
		<html lang="en" className={FONT_VARIABLES} suppressHydrationWarning>
			<body>
				{/* oxlint-disable-next-line react/no-danger -- Our own constant script sets the reader flags before the first paint; React gives an inline script its code only through this prop. */}
				<script dangerouslySetInnerHTML={{ __html: READER_INPUT_SCRIPT + ";" + JS_FLAG_SCRIPT }} />
				{children}
				<PageScroll />
			</body>
		</html>
	);
}
