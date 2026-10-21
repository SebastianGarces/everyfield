import type { ReactNode } from "react";
import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { COPY } from "../copy";
import type { Backdrop } from "../photo/photos";
import { isPanelKind, type PanelKind } from "../scene-data";
import { AutoList, type AutoStep } from "./AutoList";

type Id = "intelligence" | "every-plant" | "leaders" | "network-intelligence";
type Def = {
	title: string;
	lead?: string;
	mirror?: boolean;
	steps: { kind: PanelKind; bg: Backdrop; title: string; body: string }[];
};

/* Panel backgrounds (photo rules): a step whose card is a colorful InsightCard gets a muted gradient; the other steps of a
   chapter share one landscape, so no photo repeats on the page. */
const NETWORK = ["scope", "pipe", "lens", "top"] as const;
const NETWORK_BGS: Backdrop[] = ["plain", "plain", "plain", "mesh:sage"];
const LEADERS = ["stages", "goals", "talks", "program"] as const;
const LEADER_BGS: Backdrop[] = ["wheat", "wheat", "wheat", "wheat"];

/** Steps whose panel kind the copy file names. */
function named(chapter: string, steps: { panel: string; title: string; body: string }[], bgs: Backdrop[]) {
	return steps.map((s, i) => {
		if (!isPanelKind(s.panel)) throw new Error(`${chapter} step ${i}: unknown panel "${s.panel}"`);
		return { kind: s.panel, bg: bgs[i]!, title: s.title, body: s.body };
	});
}

function defs(id: Id): Def {
	const S = COPY.shared,
		O = S.oversight_page;
	switch (id) {
		case "intelligence":
			return {
				title: S.intelligence.title,
				lead: S.intelligence.lead,
				steps: named(id, S.intelligence.steps, ["mesh:sky", "plain", "plain", "plain"]),
			};
		case "every-plant":
			return { title: O.chapter.title, steps: named(id, O.chapter.steps, ["field", "field", "field", "mesh:sky"]) };
		// The /oversight chapters alternate sides: plants, leaders (mirrored), then Network Intelligence.
		case "leaders":
			return {
				title: O.leaders.headline,
				lead: O.leaders.lead,
				mirror: true,
				steps: LEADERS.map((k, i) => ({ kind: k, bg: LEADER_BGS[i]!, ...O.leaders.steps[i]! })),
			};
		case "network-intelligence":
			return {
				title: O.intelligence.title,
				steps: NETWORK.map((k, i) => ({ kind: k, bg: NETWORK_BGS[i]!, ...O.intelligence.steps[i]! })),
			};
	}
}

/**
 * An auto-advancing chapter: Plant Intelligence on home; "All your plants, in one place", the leader pipeline and
 * Network Intelligence on /oversight. The heading and the tab text are rendered here; AutoList runs the tabs and panels.
 * The page passes its panel elements by kind (it imports only its own panels, so each page ships only those).
 */
export function AutoChapter({ id, panels }: { id: Id; panels: Partial<Record<PanelKind, ReactNode>> }) {
	const d = defs(id);
	const head = (
		<div className={cn("max-w-[640px]", d.mirror ? "mb-[clamp(14px,1.6vw,22px)]" : "mb-[clamp(28px,3vw,44px)]")}>
			<Display as="h2" size="h2" id={id + "-title"}>
				{d.title}
			</Display>
			{d.lead ? <p className="mt-4 text-mk-lead-sm leading-[1.55] text-pretty text-text-2">{d.lead}</p> : null}
		</div>
	);
	const steps: AutoStep[] = d.steps.map((s) => {
		if (!panels[s.kind]) throw new Error(`${id}: the page passes no "${s.kind}" panel`);
		return { ...s, panel: panels[s.kind] };
	});
	return <AutoList id={id} head={head} mirror={d.mirror} steps={steps} />;
}
