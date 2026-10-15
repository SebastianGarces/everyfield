import type { Metadata } from "next";
import { AutoChapter } from "@/marketing/chapters/AutoChapter";
import { WeekChapter } from "@/marketing/chapters/WeekChapter";
import { COPY } from "@/marketing/copy";
import { HeroAnimation } from "@/marketing/hero/HeroAnimation";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { EvryPanel, FactsPanel, FocusPanel, SharePanel } from "@/marketing/panels/intelligence";
import { LensPanel, PipePanel, ScopePanel, TopPanel } from "@/marketing/panels/network";
import { PhasesRail } from "@/marketing/rail/PhasesRail";
import { CtaSection } from "@/marketing/sections/CtaSection";
import { ProofSection } from "@/marketing/sections/ProofSection";
import { ProblemSection } from "@/marketing/sections/SectionHead";
import { Site } from "@/marketing/Site";
import { ACCESS_PATH } from "@/site";

export const metadata: Metadata = pageMetadata(PAGES.home);

export default function Home() {
  const J = COPY.journey, h = J.hero;
  return (
    <Site path="/">
      <HeroPanel headline={h.headline} subhead={h.subhead} primary={{ label: h.cta_primary, href: ACCESS_PATH }} secondary={h.cta_secondary ? { label: h.cta_secondary, href: "/#week" } : undefined}>
        <HeroAnimation />
      </HeroPanel>
      <ProblemSection headline={J.problem.headline} body={J.problem.body} />
      <WeekChapter />
      <ProofSection headline={J.proof.headline} body={J.proof.body} caption={J.proof.caption} />
      <PhasesRail id="features" headline={J.features.headline} items={J.features.items} vignettes="phases" />
      <AutoChapter id="intelligence" panels={{ focus: <FocusPanel />, facts: <FactsPanel />, evry: <EvryPanel />, share: <SharePanel /> }} revealUp />
      <AutoChapter id="sending" panels={{ scope: <ScopePanel />, pipe: <PipePanel />, lens: <LensPanel />, top: <TopPanel /> }} />
      <CtaSection c={J.cta} />
    </Site>
  );
}
