import type { Metadata } from "next";
import { AutoChapter } from "@/marketing/chapters/AutoChapter";
import { COPY } from "@/marketing/copy";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { dashDemo } from "@/marketing/oversight/demo";
import { DigestPanel, GoalsPanel, ProgramPanel, StagesPanel, TalksPanel } from "@/marketing/oversight/panels";
import { TrustSection } from "@/marketing/oversight/sections";
import { LensPanel, PipePanel, ScopePanel, TopPanel } from "@/marketing/panels/network";
import { HelpPanel, InvitePanel, PlantsPanel } from "@/marketing/panels/oversight";
import { SendingPaths } from "@/marketing/paths/SendingPaths";
import { PhasesRail } from "@/marketing/rail/PhasesRail";
import { CtaSection } from "@/marketing/sections/CtaSection";
import { Faq } from "@/marketing/sections/Faq";
import { ProblemSection } from "@/marketing/sections/SectionHead";
import { Site } from "@/marketing/Site";
import { NetworkDash } from "@/marketing/visuals/NetworkDash";
import { ACCESS_PATH } from "@/site";

export const metadata: Metadata = pageMetadata(PAGES.oversight);

/** /oversight, mission first: your plants and your future planters, then why the numbers are true. */
export default function Oversight() {
  const S = COPY.shared, O = S.oversight_page;
  return (
    <Site path="/oversight" footerHeadline={S.footer.headline_home_oversight}>
      <HeroPanel
        headline={O.hero.headline}
        subhead={O.hero.subhead}
        primary={{ label: O.hero.cta_primary, href: ACCESS_PATH }}
        secondary={O.hero.cta_secondary ? { label: O.hero.cta_secondary, href: "#every-plant" } : undefined}
        band="dashboard"
      >
        <div className="mx-auto max-w-[1200px]">
          <figure className="relative m-0 min-w-0">
            <NetworkDash demo={dashDemo(S.panels)} />
          </figure>
        </div>
      </HeroPanel>
      <ProblemSection headline={O.problem.headline} body={O.problem.body} />
      <AutoChapter id="every-plant" panels={{ invite: <InvitePanel />, plants: <PlantsPanel />, digest: <DigestPanel />, help: <HelpPanel /> }} />
      <AutoChapter id="leaders" panels={{ stages: <StagesPanel />, goals: <GoalsPanel />, talks: <TalksPanel />, program: <ProgramPanel /> }} />
      <AutoChapter id="network-intelligence" panels={{ scope: <ScopePanel />, pipe: <PipePanel />, lens: <LensPanel />, top: <TopPanel /> }} />
      <TrustSection headline={O.trust.headline} items={O.trust.items} />
      <PhasesRail id="plants" headline={O.plants.headline} items={O.plants.items} vignettes="plants" />
      <SendingPaths p={O.paths} />
      <Faq f={O.faq} />
      <CtaSection c={O.cta} />
    </Site>
  );
}
