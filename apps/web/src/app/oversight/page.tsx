import type { Metadata } from "next";
import { COPY } from "@/marketing/copy";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { EveryPlant, Leaders, TrustCards } from "@/marketing/oversight/sections";
import { SendingPaths } from "@/marketing/paths/SendingPaths";
import { PhasesRail } from "@/marketing/rail/PhasesRail";
import { CtaSection } from "@/marketing/sections/CtaSection";
import { Faq } from "@/marketing/sections/Faq";
import { ProblemSection } from "@/marketing/sections/SectionHead";
import { Site } from "@/marketing/Site";
import { NetworkDash } from "@/marketing/visuals/NetworkDash";
import { accessFor } from "@/site";

export const metadata: Metadata = pageMetadata(PAGES.oversight);

/** /oversight (OPS-82 prototype): the hero dashboard, the problem, every church plant at once, each one up close, the
 *  future planters, the sending paths, why the numbers are true, the questions, then the call to action. Below the hero
 *  dashboard the only product views are the sending-paths cards. No Evry. */
export default function Oversight() {
	const S = COPY.shared,
		O = S.oversight_page;
	return (
		<Site path="/oversight" footerHeadline={S.footer.headline_home_oversight}>
			<HeroPanel
				photo="bluebells"
				headline={O.hero.headline}
				subhead={O.hero.subhead}
				primary={{ label: O.hero.cta_primary, href: accessFor("network") }}
				note={O.hero.note}
				secondary={O.hero.cta_secondary ? { label: O.hero.cta_secondary, href: "#every-plant" } : undefined}
				band="dashboard"
			>
				<div className="mx-auto max-w-[1200px]">
					<NetworkDash />
				</div>
			</HeroPanel>
			<ProblemSection headline={O.problem.headline} body={O.problem.body} />
			<EveryPlant />
			<PhasesRail id="plants" headline={O.plants.headline} items={O.plants.items} icons={O.plants.icons} />
			<Leaders />
			<SendingPaths p={O.paths} />
			<TrustCards />
			<Faq f={O.faq} />
			<CtaSection c={O.cta} href={{ primary: accessFor("network"), secondary: accessFor("planter") }} />
		</Site>
	);
}
