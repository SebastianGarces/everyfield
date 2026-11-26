import { cn } from "@everyfield/ui/foundations";
import type { ReactNode } from "react";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { EvryBot } from "@/components/kit/EvryBot";
import { Reveal } from "@/components/motion/Reveal";
import type { Copy } from "../copy";
import { ICONS } from "../icons";
import { Backdrop } from "../photo/Backdrop";
import { LockedScreen, SenderScreen } from "./screens";

type D = Copy["shared"]["discovery_page"];

const EYEBROW = "inline-block mk-eyebrow type-sm leading-[1.3] font-semibold text-text-2";
const LEAD = "text-mk-lead-sm leading-[1.55] text-pretty text-text-2";

function Wrap({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
	return (
		<section id={id} className="relative py-[clamp(40px,5.556vw,80px)]">
			<div className={cn("mx-auto max-w-mk px-page", className)}>{children}</div>
		</section>
	);
}

export function Free({ f }: { f: D["free"] }) {
	return (
		<Wrap id="free">
			<Reveal className="mx-auto max-w-[940px] text-center">
				<span className={EYEBROW}>{f.eyebrow}</span>
				<Display as="h2" size="h2" className="mx-auto mt-[18px]">
					{f.headline}
				</Display>
				{f.evry.shown ? (
					<p className={cn("mx-auto mt-6 flex max-w-[620px] items-center justify-center gap-4 text-left", LEAD)}>
						<EvryBot size="lg" />
						<span>{f.evry.line}</span>
					</p>
				) : null}
			</Reveal>
		</Wrap>
	);
}

function Stage({ tone, children }: { tone: "g-sky" | "g-field"; children: ReactNode }) {
	return <div className={cn("relative mk-gsurf p-[clamp(16px,4vw,56px)]", tone)}>{children}</div>;
}

export function Privacy({ p }: { p: D["privacy"] }) {
	return (
		<Wrap
			id="private"
			className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-center gap-[clamp(32px,6vw,96px)] max-mk-cx:grid-cols-[minmax(0,1fr)]"
		>
			<Reveal>
				<span className={EYEBROW}>{p.eyebrow}</span>
				<Display as="h2" size="h2" className="mt-[18px]">
					{p.headline}
				</Display>
				<p className={cn("mt-5 max-w-[54ch]", LEAD)}>{p.body}</p>
			</Reveal>
			<Reveal delay={120}>
				<Stage tone="g-sky">
					<SenderScreen />
				</Stage>
			</Reveal>
		</Wrap>
	);
}

export function How({ h }: { h: D["how"] }) {
	return (
		<Wrap id="how">
			<Display as="h2" size="h2" className="text-center">
				{h.headline}
			</Display>
			<ol className="mt-[clamp(28px,4vw,48px)] grid list-none grid-cols-3 gap-4 p-0 max-mk-cx:grid-cols-1">
				{h.steps.map((s, i) => (
					<li
						key={s}
						className="bg-mk-surface-3 p-7 shadow-mk-card max-mk-cx:grid max-mk-cx:grid-cols-[48px_minmax(0,1fr)] max-mk-cx:items-center max-mk-cx:gap-4 max-mk-cx:p-5"
					>
						<span
							aria-hidden="true"
							className="grid size-12 place-items-center bg-mk-mint font-title type-title-md leading-none text-green-600"
						>
							{i + 1}
						</span>
						<Display as="h3" size="h3" className="mt-5 max-w-[20ch] max-mk-cx:mt-0 max-mk-cx:max-w-none">
							{s}
						</Display>
					</li>
				))}
			</ol>
		</Wrap>
	);
}

export function Ready({ r }: { r: D["ready"] }) {
	return (
		<Wrap id="ready">
			<div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-center gap-[clamp(32px,6vw,96px)] max-mk-cx:grid-cols-[minmax(0,1fr)]">
				<Reveal>
					<Display as="h2" size="h2">
						{r.headline}
					</Display>
					<p className={cn("mt-5 max-w-[54ch]", LEAD)}>
						{r.body}
						{r.carry.shown ? ` ${r.carry.line}` : null}
					</p>
				</Reveal>
				<Reveal delay={120}>
					<Stage tone="g-field">
						<LockedScreen page="Tasks" />
					</Stage>
				</Reveal>
			</div>
			<Reveal className="mt-[clamp(32px,4vw,56px)] bg-mk-surface-3 p-[clamp(24px,3vw,44px)]">
				<Display as="h3" size="h3" className="text-balance">
					{r.seat.headline}
				</Display>
				<ul className="mt-[26px] grid list-none grid-cols-2 gap-x-[clamp(24px,4vw,64px)] gap-y-[22px] p-0 max-mk-cx:grid-cols-1">
					{r.seat.items.map((s, i) => (
						<li key={s} className="grid grid-cols-[44px_minmax(0,1fr)] items-start gap-4">
							<span aria-hidden="true" className="grid size-11 place-items-center bg-white text-ink">
								<Icon icon={i ? ICONS.compass : ICONS.heart} size={20} />
							</span>
							<p className="type-lg leading-[1.5] text-pretty text-text-2">{s}</p>
						</li>
					))}
				</ul>
			</Reveal>
		</Wrap>
	);
}

export function Senders({ s }: { s: D["senders"] }) {
	return (
		<Wrap id="senders">
			<Reveal className="relative isolate grid grid-cols-2 items-end gap-x-[clamp(32px,5vw,80px)] gap-y-6 p-[clamp(28px,4.5vw,64px)] text-cream max-mk-cx:grid-cols-1">
				<Backdrop
					bg="plain"
					sizes="(max-width: 1440px) 100vw, 1440px"
					shade={0.5}
					className="absolute inset-0 -z-1 max-mk-sm:[--shade:.68]!"
				/>
				<span className={cn(EYEBROW, "col-span-full -mb-2 text-cream")}>{s.eyebrow}</span>
				<Display as="h2" size="h2" className="max-w-[17ch]">
					{s.headline}
				</Display>
				<div>
					<p className="text-mk-lead-sm leading-[1.55] text-pretty text-cream">{s.body}</p>
					<a
						href="/oversight"
						className="mt-5 inline-flex items-center gap-2 type-lg font-semibold text-cream underline-offset-4 hover:underline focus-visible:outline-cream"
					>
						{s.link}
						<Icon icon={ICONS.arrow} size={17} />
					</a>
				</div>
			</Reveal>
		</Wrap>
	);
}
