import type { Metadata } from "next";
import { COPY } from "@/marketing/copy";
import { HeroAnimation } from "@/marketing/hero/HeroAnimation";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { HERO, MONDAY } from "@/marketing/home/demo";
import { JourneySection } from "@/marketing/home/Journey";
import { EvryCards, SendingSection } from "@/marketing/home/sections";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { PhasesRail } from "@/marketing/rail/PhasesRail";
import { CtaSection } from "@/marketing/sections/CtaSection";
import { ProblemSection } from "@/marketing/sections/SectionHead";
import { VisionSection } from "@/marketing/sections/VisionSection";
import { Site } from "@/marketing/Site";
import { MondayOverview } from "@/marketing/visuals/MondayOverview";
import { ACCESS_PATH, accessFor } from "@/site";

export const metadata: Metadata = pageMetadata(PAGES.home);

/** The home page (OPS-82 prototype): hero, problem, the vision down to Monday, the six phases, the journey, Evry, the
 *  sending church, then the call to action. Below the vision it shows no app UI. */
export default function Home() {
	const J = COPY.journey,
		S = COPY.shared;
	return (
		<Site path="/" footerHeadline={S.footer.headline_home_oversight}>
			<HeroPanel
				photo="wildflowers"
				eyebrow={S.ops82.hero_eyebrow}
				headline={J.hero.headline}
				subhead={J.hero.subhead}
				primary={{ label: J.hero.cta_primary, href: ACCESS_PATH }}
				secondary={J.hero.cta_secondary ? { label: J.hero.cta_secondary, href: "#vision" } : undefined}
			>
				<HeroAnimation demo={HERO} />
			</HeroPanel>
			<ProblemSection headline={J.problem.headline} body={J.problem.body} />
			<VisionSection
				headline={J.vision.headline}
				body={J.vision.body}
				bridge={J.vision.bridge}
				overview={<MondayOverview demo={MONDAY} />}
			/>
			<PhasesRail
				id="features"
				headline={S.ops82.features_headline}
				items={J.features.items}
				vignettes="phases"
				icons={J.features.icons}
			/>
			<JourneySection />
			<EvryCards />
			<SendingSection />
			<CtaSection c={J.cta} href={{ secondary: accessFor("network") }} size="h1" />
		</Site>
	);
}
