import type { Metadata } from "next";
import { MotionProvider } from "@/components/MotionProvider";
import { HeroAnimation } from "@/marketing/hero/HeroAnimation";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { COPY } from "@/marketing/copy";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { homeHTML } from "@/marketing/markup";
import { Html, Site } from "@/marketing/Site";
import { ACCESS_PATH } from "@/site";

export const metadata: Metadata = pageMetadata(PAGES.home);

export default function Home() {
  const h = COPY.journey.hero;
  return (
    <Site path="/" provider={MotionProvider}>
      <HeroPanel headline={h.headline} subhead={h.subhead} primary={{ label: h.cta_primary, href: ACCESS_PATH }} secondary={h.cta_secondary ? { label: h.cta_secondary, href: "/#week" } : undefined}>
        <HeroAnimation />
      </HeroPanel>
      <Html html={homeHTML()} />
    </Site>
  );
}
