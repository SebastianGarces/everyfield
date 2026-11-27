import { evryAvailable } from "@everyfield/db/provider";
import { File02Icon } from "@hugeicons/core-free-icons";
import type { Metadata } from "next";
import { Icon } from "@/components/Icon";
import { COPY } from "@/marketing/copy";
import { DocumentsScreen, EvryScreen, LockedScreen, TasksScreen, TemplateScreen, WikiScreen } from "./screens";
import { Free, How, Privacy, Ready, Senders } from "./sections";
import { Tour } from "./Tour";
import { HeroPanel } from "@/marketing/hero/HeroPanel";
import { ICONS } from "@/marketing/icons";
import { PAGES, pageMetadata } from "@/marketing/meta";
import { CtaSection } from "@/marketing/sections/CtaSection";
import { Faq } from "@/marketing/sections/Faq";
import { Site } from "@/marketing/Site";
import { serverEnv } from "@/server/config";
import { accessFor } from "@/site";

export const metadata: Metadata = pageMetadata(PAGES.discovery);

const TAB_ICONS = {
	wiki: ICONS.book,
	documents: ICONS.edit,
	templates: File02Icon,
	tasks: ICONS.task,
	evry: ICONS.chat,
	ready: ICONS.flag,
};
const SCREENS = {
	wiki: <WikiScreen />,
	documents: <DocumentsScreen />,
	templates: <TemplateScreen />,
	tasks: <TasksScreen />,
	evry: <EvryScreen />,
	ready: <LockedScreen page="Launch" />,
};

export function DiscoveryPage() {
	const D = COPY.shared.discovery_page;
	const start = accessFor("planter");
	const evry = evryAvailable(serverEnv());
	const shown = D.tour.tabs.filter((t) => evry || t.id !== "evry");
	const tabs = shown.map((t) => ({ ...t, icon: <Icon icon={TAB_ICONS[t.id]} size={20} /> }));
	return (
		<Site path="/discovery">
			<HeroPanel
				photo="blossom"
				band="tour"
				eyebrow={D.hero.eyebrow}
				headline={D.hero.headline}
				subhead={D.hero.subhead}
				primary={{ label: D.hero.cta_primary, href: start }}
				note={D.hero.note}
			>
				<Tour label={D.tour.label} tabs={tabs} panels={shown.map((t) => SCREENS[t.id])} />
			</HeroPanel>
			<Free f={D.free} />
			<Privacy p={D.privacy} />
			<How h={D.how} />
			<Ready r={D.ready} />
			<Senders s={D.senders} />
			<Faq f={D.faq} />
			<CtaSection c={D.cta} href={{ primary: start }} />
		</Site>
	);
}
