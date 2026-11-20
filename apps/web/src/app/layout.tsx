import { deploymentKind } from "@everyfield/db/deployment";
import { VercelToolbar } from "@vercel/toolbar/next";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../styles/marketing.css";
import { PageScroll } from "../components/frame/PageScroll";
import { JS_FLAG_SCRIPT, READER_INPUT_SCRIPT } from "../components/frame/reader-input";
import { ServerInsertedScript } from "../components/frame/ServerInsertedScript";
import { ONE_TIME_LINK_SCRIPT } from "../components/one-time-link";
import { PAGES, SITE_NAME, fullTitle } from "../marketing/meta";
import { SITE_URL } from "../site";
import { FONT_VARIABLES } from "../components/fonts";
import { THEME_VIEWPORT } from "../components/viewport";
import { serverEnv } from "../server/config";

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: { default: fullTitle(PAGES.home), template: `%s · ${SITE_NAME}` },
	description: PAGES.home.description,
	applicationName: SITE_NAME,
	openGraph: { siteName: SITE_NAME, type: "website", locale: "en_US" },
	twitter: { card: "summary_large_image" },
};
export const viewport: Viewport = THEME_VIEWPORT.light;

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en" className={FONT_VARIABLES} suppressHydrationWarning>
			<body>
				<ServerInsertedScript>
					<script
						dangerouslySetInnerHTML={{ __html: READER_INPUT_SCRIPT + ";" + JS_FLAG_SCRIPT + ";" + ONE_TIME_LINK_SCRIPT }}
					/>
				</ServerInsertedScript>
				{children}
				<PageScroll />
				{deploymentKind(serverEnv()) === "preview" ? <VercelToolbar /> : null}
			</body>
		</html>
	);
}
