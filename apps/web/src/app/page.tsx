import type { Metadata } from "next";
import { AutoChapter } from "@/marketing/chapters/AutoChapter";
import { WeekChapter } from "@/marketing/chapters/WeekChapter";
import { COPY } from "@/marketing/copy";
import { HeroAnimation } from "@/marketing/hero/HeroAnimation";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { evryDemo, HERO, mondayDemo, phaseDemo } from "@/marketing/home/demo";
import { FocusPanel, ReadinessPanel } from "@/marketing/home/panels";
import { EvrySection, SendingGlimpse } from "@/marketing/home/sections";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { FactsPanel, SharePanel } from "@/marketing/panels/intelligence";
import { PhasesRail } from "@/marketing/rail/PhasesRail";
import { CtaSection } from "@/marketing/sections/CtaSection";
import { ProblemSection } from "@/marketing/sections/SectionHead";
import { VisionSection } from "@/marketing/sections/VisionSection";
import { Site } from "@/marketing/Site";
import { MondayOverview } from "@/marketing/visuals/MondayOverview";
import { ACCESS_PATH } from "@/site";

export const metadata: Metadata = pageMetadata(PAGES.home);

/** The home page, plan first: the vision, then this week's work, then what needs you, Evry and the sending church. */
export default function Home() {
  const J = COPY.journey, S = COPY.shared, P = S.panels;
  return (
    <Site path="/" footerHeadline={S.footer.headline_home_oversight}>
      <HeroPanel headline={J.hero.headline} subhead={J.hero.subhead} primary={{ label: J.hero.cta_primary, href: ACCESS_PATH }} secondary={J.hero.cta_secondary ? { label: J.hero.cta_secondary, href: "#vision" } : undefined}>
        <HeroAnimation demo={HERO} />
      </HeroPanel>
      <ProblemSection headline={J.problem.headline} body={J.problem.body} />
      <VisionSection headline={J.vision.headline} body={J.vision.body} bridge={J.vision.bridge} overview={<MondayOverview demo={mondayDemo(P)} />} />
      <PhasesRail id="features" headline={J.features.headline} items={J.features.items} vignettes="phases" demo={phaseDemo(P)} />
      <WeekChapter />
      <AutoChapter
        id="intelligence"
        panels={{ focus: <FocusPanel title={P.intelligence_focus_title} />, facts: <FactsPanel />, readiness: <ReadinessPanel />, share: <SharePanel unshared={P.share_unshared_status} /> }}
      />
      <EvrySection headline={J.evry.headline} body={J.evry.body} limits={J.evry.limits} demo={evryDemo(J.evry.example)} />
      <SendingGlimpse title={S.sending.title} body={S.sending.body} link={S.sending.link} />
      <CtaSection c={J.cta} />
    </Site>
  );
}
