import type { Metadata } from "next";
import { AutoChapter } from "@/marketing/chapters/AutoChapter";
import { oversightParts } from "@/marketing/markup";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { LensPanel, PipePanel, ScopePanel, TopPanel } from "@/marketing/panels/network";
import { HelpPanel, InvitePanel, PlantsPanel, SendersPanel } from "@/marketing/panels/oversight";
import { COPY } from "@/marketing/copy";
import { SendingPaths } from "@/marketing/paths/SendingPaths";
import { PhasesRail } from "@/marketing/rail/PhasesRail";
import { Html, Site } from "@/marketing/Site";

export const metadata: Metadata = pageMetadata(PAGES.oversight);

export default function Oversight() {
  const s = oversightParts();
  return (
    <Site path="/oversight">
      <Html html={s.hero + s.problem} />
      <AutoChapter id="every-plant" panels={{ invite: <InvitePanel />, plants: <PlantsPanel />, senders: <SendersPanel />, help: <HelpPanel /> }} />
      <AutoChapter id="network-intelligence" panels={{ scope: <ScopePanel />, pipe: <PipePanel />, lens: <LensPanel />, top: <TopPanel /> }} />
      <PhasesRail id="plants" headline={COPY.shared.oversight_page.plants.headline} items={COPY.shared.oversight_page.plants.items} vignettes="plants" />
      <SendingPaths p={COPY.shared.oversight_page.paths} />
      <Html html={s.faq + s.cta} />
    </Site>
  );
}
