import { AutoChapter } from "@/marketing/chapters/AutoChapter";
import { WeekChapter } from "@/marketing/chapters/WeekChapter";
import { COPY } from "@/marketing/copy";
import { HeroAnimation } from "@/marketing/hero/HeroAnimation";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { EvryPanel, FactsPanel, FocusPanel, SharePanel } from "@/marketing/panels/intelligence";
import { LensPanel, PipePanel, ScopePanel, TopPanel } from "@/marketing/panels/network";
import { PhasesRail } from "@/marketing/rail/PhasesRail";
import { CtaSection } from "@/marketing/sections/CtaSection";
import { ProofSection } from "@/marketing/sections/ProofSection";
import { ProblemSection } from "@/marketing/sections/SectionHead";
import { VisionSection } from "@/marketing/sections/VisionSection";
import { Site } from "@/marketing/Site";
import { ACCESS_PATH } from "@/site";
import { MondayPlanSection, VisionMondaySection } from "./merged";
import { ProtoBar } from "./ProtoBar";
import type { VariantId } from "./variants";

/** The home page in one of the R6 arrangements. Everything outside the vision and Monday sections is the same. */
export function HomePage({ variant }: { variant: VariantId }) {
  const J = COPY.journey, h = J.hero;
  const proof = <ProofSection headline={J.proof.headline} body={J.proof.body} caption={J.proof.caption} />;
  const vision = <VisionSection headline={J.vision.headline} body={J.vision.body} />;
  const middle = {
    current: <>{proof}{vision}</>,
    a: <>{vision}{proof}</>,
    b: <VisionMondaySection caption={J.proof.caption} />,
    c: <MondayPlanSection caption={J.proof.caption} />,
  }[variant];
  return (
    <Site path="/">
      <HeroPanel headline={h.headline} subhead={h.subhead} primary={{ label: h.cta_primary, href: ACCESS_PATH }} secondary={h.cta_secondary ? { label: h.cta_secondary, href: "/#week" } : undefined}>
        <HeroAnimation />
      </HeroPanel>
      <ProblemSection headline={J.problem.headline} body={J.problem.body} />
      <WeekChapter />
      {middle}
      <PhasesRail id="features" headline={J.features.headline} items={J.features.items} vignettes="phases" />
      <AutoChapter id="intelligence" panels={{ focus: <FocusPanel />, facts: <FactsPanel />, evry: <EvryPanel />, share: <SharePanel /> }} revealUp />
      <AutoChapter id="sending" panels={{ scope: <ScopePanel />, pipe: <PipePanel />, lens: <LensPanel />, top: <TopPanel /> }} />
      <CtaSection c={J.cta} />
      <ProtoBar current={variant} />
    </Site>
  );
}
