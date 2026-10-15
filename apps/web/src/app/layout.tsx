import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Instrument_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "../styles/marketing.css";
import { PAGES, SITE_NAME, fullTitle } from "../marketing/meta";
import { SITE_URL } from "../site";

const display = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz", "wdth"], variable: "--font-bricolage", display: "swap" });
const body = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument", display: "swap" });

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
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
