import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Instrument_Sans } from "next/font/google";
import type { ReactNode } from "react";
import "../styles/prototype.css";
import "../styles/site.css";
import { SITE_URL } from "../site";

const display = Bricolage_Grotesque({ subsets: ["latin"], axes: ["opsz", "wdth"], variable: "--font-bricolage", display: "swap" });
const body = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument", display: "swap" });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "EveryField · Church planting software, from calling to launch Sunday", template: "%s · EveryField" },
  description: "EveryField helps church planters, sending churches and networks run a church plant from calling to launch Sunday.",
  icons: { icon: "/icon.svg" },
  openGraph: { siteName: "EveryField", type: "website", locale: "en_US" },
};
export const viewport: Viewport = { themeColor: "#FCFBF8" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="mk-signal">{children}</body>
    </html>
  );
}
