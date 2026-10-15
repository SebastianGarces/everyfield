import type { Metadata } from "next";
import { AutoChapter } from "@/marketing/chapters/AutoChapter";
import { COPY } from "@/marketing/copy";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { LensPanel, PipePanel, ScopePanel, TopPanel } from "@/marketing/panels/network";
import { HelpPanel, InvitePanel, PlantsPanel, SendersPanel } from "@/marketing/panels/oversight";
import { SendingPaths } from "@/marketing/paths/SendingPaths";
import { PhasesRail } from "@/marketing/rail/PhasesRail";
import { CtaSection } from "@/marketing/sections/CtaSection";
import { Faq } from "@/marketing/sections/Faq";
import { ProblemSection } from "@/marketing/sections/SectionHead";
import { Site } from "@/marketing/Site";
import { NetworkDash } from "@/marketing/visuals/NetworkDash";
import { ACCESS_PATH } from "@/site";

export const metadata: Metadata = pageMetadata(PAGES.oversight);

export default function Oversight() {
  const P = COPY.shared.oversight_page;
  return (
    <Site path="/oversight">
      <HeroPanel
        headline={P.hero.headline}
        subhead={P.hero.subhead}
        primary={{ label: P.hero.cta_primary, href: ACCESS_PATH }}
        secondary={P.hero.cta_secondary ? { label: P.hero.cta_secondary, href: "#every-plant" } : undefined}
        band="dashboard"
      >
        <div className="mx-auto max-w-[1200px]">
          <figure className="relative m-0 min-w-0">
            <NetworkDash />
          </figure>
        </div>
      </HeroPanel>
      <ProblemSection headline={P.problem.headline} body={P.problem.body} />
      <AutoChapter id="every-plant" panels={{ invite: <InvitePanel />, plants: <PlantsPanel />, senders: <SendersPanel />, help: <HelpPanel /> }} />
      <AutoChapter id="network-intelligence" panels={{ scope: <ScopePanel />, pipe: <PipePanel />, lens: <LensPanel />, top: <TopPanel /> }} />
      <PhasesRail id="plants" headline={P.plants.headline} items={P.plants.items} vignettes="plants" />
      <SendingPaths p={P.paths} />
      <Faq f={P.faq} />
      <CtaSection c={P.cta} />
    </Site>
  );
}
