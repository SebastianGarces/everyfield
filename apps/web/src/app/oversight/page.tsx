import type { Metadata } from "next";
import { MotionProvider } from "@/components/MotionProvider";
import { AutoChapter } from "@/marketing/chapters/AutoChapter";
import { oversightParts } from "@/marketing/markup";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { LensPanel, PipePanel, ScopePanel, TopPanel } from "@/marketing/panels/network";
import { HelpPanel, InvitePanel, PlantsPanel, SendersPanel } from "@/marketing/panels/oversight";
import { Html, Site } from "@/marketing/Site";

export const metadata: Metadata = pageMetadata(PAGES.oversight);

export default function Oversight() {
  const s = oversightParts();
  return (
    <Site path="/oversight" provider={MotionProvider}>
      <Html html={s.hero + s.problem} />
      <AutoChapter id="every-plant" panels={{ invite: <InvitePanel />, plants: <PlantsPanel />, senders: <SendersPanel />, help: <HelpPanel /> }} />
      <AutoChapter id="network-intelligence" panels={{ scope: <ScopePanel />, pipe: <PipePanel />, lens: <LensPanel />, top: <TopPanel /> }} />
      <Html html={s.plants + s.paths + s.faq + s.cta} />
    </Site>
  );
}
