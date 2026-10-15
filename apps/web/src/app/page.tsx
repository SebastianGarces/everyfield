import type { Metadata } from "next";
import { MotionProvider } from "@/components/MotionProvider";
import { AutoChapter } from "@/marketing/chapters/AutoChapter";
import { WeekChapter } from "@/marketing/chapters/WeekChapter";
import { COPY } from "@/marketing/copy";
import { HeroAnimation } from "@/marketing/hero/HeroAnimation";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { homeParts } from "@/marketing/markup";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { EvryPanel, FactsPanel, FocusPanel, SharePanel } from "@/marketing/panels/intelligence";
import { LensPanel, PipePanel, ScopePanel, TopPanel } from "@/marketing/panels/network";
import { PhasesRail } from "@/marketing/rail/PhasesRail";
import { Html, Site } from "@/marketing/Site";
import { ACCESS_PATH } from "@/site";

export const metadata: Metadata = pageMetadata(PAGES.home);

const network = { scope: <ScopePanel />, pipe: <PipePanel />, lens: <LensPanel />, top: <TopPanel /> };

export default function Home() {
  const h = COPY.journey.hero;
  const s = homeParts();
  return (
    <Site path="/" provider={MotionProvider}>
      <HeroPanel headline={h.headline} subhead={h.subhead} primary={{ label: h.cta_primary, href: ACCESS_PATH }} secondary={h.cta_secondary ? { label: h.cta_secondary, href: "/#week" } : undefined}>
        <HeroAnimation />
      </HeroPanel>
      <Html html={s.problem} />
      <WeekChapter />
      <Html html={s.proof} />
      <PhasesRail id="features" headline={COPY.journey.features.headline} items={COPY.journey.features.items} vignettes="phases" />
      <AutoChapter id="intelligence" panels={{ focus: <FocusPanel />, facts: <FactsPanel />, evry: <EvryPanel />, share: <SharePanel /> }} revealUp />
      <AutoChapter id="sending" panels={network} />
      <Html html={s.cta} />
    </Site>
  );
}
