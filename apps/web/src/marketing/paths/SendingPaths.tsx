import type { ReactNode } from "react";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { Badge, CardIcon, UiButton, type Tone } from "@/components/kit/kit";
import { Reveal } from "@/components/motion/Reveal";
import type { Copy } from "../copy";
import { ICONS, type IconName } from "../icons";
import { PathsCycle } from "./PathsCycle";

type Paths = Copy["shared"]["oversight_page"]["paths"];
const TONES = ["g-sky", "g-rose", "g-sun"];

/**
 * /oversight, Revision 28: the sending paths. One display sentence over one large card; PathsCycle moves both. The panes
 * and the three product cards are rendered here. The block rises in as one (Revision 16: it follows the phases rail).
 */
export function SendingPaths({ p }: { p: Paths }) {
	const S = p.states;
	const sentence =
		p.lead +
		" " +
		S.slice(0, -1)
			.map((x) => x.phrase)
			.join(", ") +
		" or " +
		S[S.length - 1]!.phrase +
		". " +
		p.tail;
	const panes = S.map((x) => (
		<div key={x.title}>
			<Display as="h3" size="h3">
				{x.title}
			</Display>
			<p className="mt-3.5 max-w-[38ch] text-mk-lead-sm leading-[1.55] text-pretty text-text-2">{x.body}</p>
		</div>
	));
	return (
		<section id="sending-paths" className="relative scroll-mt-[88px] py-section max-mk-sm:scroll-mt-[76px]">
			<Reveal up className="mx-auto max-w-mk px-page">
				<PathsCycle
					sentence={sentence}
					lead={p.lead}
					tail={p.tail}
					phrases={S.map((x) => x.phrase)}
					panes={panes}
					apps={APPS}
					tones={TONES}
				/>
				<p className="mx-auto mt-[clamp(24px,3vw,36px)] max-w-[720px] text-center text-mk-lead-sm leading-[1.55] text-pretty text-text-2">
					{p.line}
				</p>
			</Reveal>
		</section>
	);
}

function App({ children }: { children: ReactNode }) {
	return (
		<div className="w-[min(400px,100%)] rounded-[20px] bg-white px-[18px] pt-4 pb-[18px] type-sm leading-[1.4] text-text shadow-mk-panel-flat">
			{children}
		</div>
	);
}
function Head({ icon, tone, title, sub }: { icon: IconName; tone: Tone; title: string; sub: string }) {
	return (
		<div className="mb-2 flex items-center gap-3">
			<CardIcon tone={tone} icon={ICONS[icon]} size={36} glyph={17} />
			<div className="min-w-0 flex-1">
				<div className="font-title type-title-sm leading-[1.2] tracking-[-0.02em]">{title}</div>
				<div className="mt-0.5 type-sm text-text-3">{sub}</div>
			</div>
		</div>
	);
}
const PILL =
	"inline-flex h-[22px] items-center gap-1.5 rounded-full bg-surface-2 pr-[9px] pl-2 type-xs font-medium whitespace-nowrap text-ink-2";
const KV = "flex items-center justify-between gap-2.5 border-t border-line py-2.5 type-sm text-text-2";

const APPS = [
	<App key="church">
		<Head icon="heart" tone="blue" title="Grace Church" sub="Your plants · in launch order" />
		{[
			["Harvest Point Church", "Hyde Park, Austin", "1 · Core group", "Mar 14, 2027"],
			["Eastside Commons", "East Austin · with Austin Sending Network", "3 · Training", "May 2, 2027"],
		].map((r) => (
			<div key={r[0]} className="flex items-center gap-3 border-t border-line py-[9px]">
				<CardIcon tone="green" icon={ICONS.pin} />
				<div className="min-w-0 flex-1">
					<div className="type-md font-semibold">{r[0]}</div>
					<div className="mt-0.5 truncate type-sm text-text-3">{r[1]}</div>
				</div>
				<div className="flex flex-col items-end gap-0.5 type-sm whitespace-nowrap">
					<b>{r[3]}</b>
					<span className="type-xs text-text-3 max-mk-sm:hidden">{r[2]}</span>
				</div>
			</div>
		))}
	</App>,
	<App key="network">
		<Head icon="network" tone="teal" title="Austin Sending Network" sub="Plants by sending church" />
		{(
			[
				[
					"Grace Church",
					[
						["Harvest Point Church", 1],
						["Eastside Commons", 3],
					],
				],
				[
					"Redeemer Dallas",
					[
						["Deep Ellum Collective", 4],
						["Oak Cliff Church", 2],
					],
				],
			] as const
		).map((g) => (
			<div key={g[0]} className="border-t border-line py-2">
				<div className="flex items-center justify-between gap-2">
					<span className="type-md font-semibold">{g[0]}</span>
					<span className="type-xs text-text-2">
						{g[1].length} plant{g[1].length > 1 ? "s" : ""}
					</span>
				</div>
				<div className="mt-1.5 flex flex-wrap gap-1">
					{g[1].map((x) => (
						<span key={x[0]} className={PILL}>
							<i className={x[1] < 2 ? "size-1.5 rounded-full bg-blue-500" : "size-1.5 rounded-full bg-green-500"} />
							{x[0]}
						</span>
					))}
				</div>
			</div>
		))}
	</App>,
	<App key="direct">
		<Head icon="pin" tone="green" title="Mueller Hope Church" sub="Mueller, Austin · 0 · Discovery" />
		<div className={KV}>
			<span>Sent by</span>
			<span className="inline-flex min-h-7 items-center gap-1.5 rounded-full bg-green-50 py-1 pr-[11px] pl-2 type-xs leading-[1.3] font-medium text-green-700 shadow-mk-chip-on">
				<Icon icon={ICONS.network} />
				<span>
					Sent by <b className="font-semibold text-ink">Austin Sending Network</b>
				</span>
			</span>
		</div>
		<div className={KV}>
			<span>Sending church</span>
			<Badge status="unknown" size="sm">
				No sending church yet
			</Badge>
		</div>
		<div className="mt-3">
			<UiButton variant="primary" size="action">
				<Icon icon={ICONS.plus} size={14} />
				Assign a sending church
			</UiButton>
		</div>
	</App>,
];
