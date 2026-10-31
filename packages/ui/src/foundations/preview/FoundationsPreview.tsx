import {
	Alert02Icon,
	BookOpen01Icon,
	Calendar03Icon,
	ChartLineData01Icon,
	HandPrayerIcon,
	MentorIcon,
	Plant01Icon,
	Rocket01Icon,
	SparklesIcon,
	TaskDone01Icon,
	UserGroupIcon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { cn, EvryBot, Icon, Lockup, LogoMark, revealDelay, type EvryBotSize, type EvryMood, type EvryShape } from "..";
import { InsightCard, InsightPill, InsightTitle, type InsightTone } from "../../controls";
import { PageHead } from "../../shell/preview/ShellPreview";
import { HoverDemo } from "./HoverDemo";

/**
 * The foundations preview at /design/foundations, after the prototype's #/foundations page: logo, color roles, type,
 * muted palette, gradients, shape, elevation, patterns, focus, motion and the Evry character. Every value comes from
 * tokens.css. Brand specimens (ef-brand-fixed) keep their brand values in dark mode; the chrome around them follows it.
 */
export function FoundationsPreview() {
	return (
		<>
			<PageHead crumb="Foundations" title="Foundations" size="xl">
				Brand, color roles, type, shape and patterns. Everything else is built from these tokens. Dark mode uses the
				same token names with dark values: switch it with the sun and moon in the rail.
			</PageHead>

			<Section index={1} title="Logo" code="LogoMark · Wordmark · Lockup">
				<div className="ef-brand-fixed grid gap-5 app-md:grid-cols-3">
					<BrandTile className="bg-ink text-cream" />
					<BrandTile className="bg-green text-ink" />
					<BrandTile className="bg-cream text-ink shadow-card" />
				</div>
				<div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-text-2">
					<p>
						In the app: the ink lockup, no background (top bar). The logo is cream on ink. New-growth is only a tile
						behind an ink symbol. Chips are for avatars, favicons and social images.
					</p>
					<div className="ef-brand-fixed flex gap-2">
						<LogoChip className="bg-ink text-green" />
						<LogoChip className="bg-green text-ink" />
						<LogoChip className="bg-cream text-ink" />
					</div>
				</div>
			</Section>

			<Section index={2} title="Brand colors" code="--ef-ink · --ef-green · --ef-cream">
				<Note>
					The app runs on neutral greys so the data hues and the gradient cards stand out. Ink carries the brand inside
					the app. New-growth is for the logo, the field card and rare brand moments; it is never text. Cream is for
					marketing, print and text on ink or photos, never for app surfaces.
				</Note>
				<div className="ef-brand-fixed grid gap-5 app-md:grid-cols-3">
					<Swatch className="bg-ink" name="Ink" use="--ef-ink · text, active nav, primary button" />
					<Swatch className="bg-green" name="New-growth" use="--ef-green · logo, brand moments, green 500" />
					<Swatch className="bg-cream" name="Cream" use="--ef-cream · brand and marketing only" />
				</div>
			</Section>

			<Section index={3} title="Data hues and roles" code="--ef-{hue}-{600|500|300|100|50}">
				<Note>
					Every hue has one job. Green (new-growth) means healthy or committed. Blue, softened toward the muted sky,
					means measured or actual. Magenta means risk or a gap. Orange means attention or waiting. Two category hues
					only label categories, like pipeline stages; they take the rose and sky ramps of the muted palette. 600 and
					700 are for text and icons. Text on a 500 fill is ink, never white.
				</Note>
				<div className="grid gap-5 app-md:grid-cols-2 app-lg:grid-cols-3">
					<Ramp
						label="Green · healthy, committed, positive"
						steps={[
							["700", "bg-green-700"],
							["500", "bg-green-500"],
							["300", "bg-green-300"],
							["100", "bg-green-100"],
							["50", "bg-green-50"],
						]}
					/>
					<Ramp
						label="Blue · measured, actual, information"
						steps={[
							["600", "bg-blue-600"],
							["500", "bg-blue-500"],
							["300", "bg-blue-300"],
							["100", "bg-blue-100"],
							["50", "bg-blue-50"],
						]}
					/>
					<Ramp
						label="Magenta · risk, gap, overdue"
						steps={[
							["600", "bg-magenta-600"],
							["500", "bg-magenta-500"],
							["300", "bg-magenta-300"],
							["100", "bg-magenta-100"],
							["50", "bg-magenta-50"],
						]}
					/>
					<Ramp
						label="Orange · attention, waiting, draft"
						steps={[
							["600", "bg-amber-600"],
							["500", "bg-amber-500"],
							["300", "bg-amber-300"],
							["100", "bg-amber-100"],
							["50", "bg-amber-50"],
						]}
					/>
					<Ramp
						label="Rose and sky · category only"
						steps={[
							["v600", "bg-violet-600"],
							["v500", "bg-violet-500"],
							["v100", "bg-violet-100"],
							["t600", "bg-teal-600"],
							["t500", "bg-teal-500"],
							["t100", "bg-teal-100"],
						]}
					/>
					<Ramp
						label="Neutrals · app surfaces and text"
						steps={[
							["text-2", "bg-text-2"],
							["text-3", "bg-text-3"],
							["canvas", "bg-canvas"],
							["frame", "bg-frame"],
							["surface", "bg-surface"],
							["raised", "bg-surface-raised"],
						]}
					/>
				</div>
			</Section>

			<Section index={4} title="Muted palette" code="--ef-green · --ef-{sky|sage|rose}-{100|300|500|700}">
				<Note>
					New-growth is the fixed brand color and the field card. The other colors come from the field photos and are
					muted in OKLCH, so they sit next to new-growth without competing with it. They paint the gradient cards and
					the two category hues. They are not status colors. 700 is safe for text on white, cream and the frame; on dark
					surfaces, use 300 for text.
				</Note>
				<div className="ef-brand-fixed grid gap-5 app-md:grid-cols-2">
					<MutedRamp name="Field" note="new-growth, the fixed brand color" hue="green" />
					<MutedRamp name="Sky" note="the open sky over the field" hue="sky" />
					<MutedRamp name="Sage" note="the green hills at dusk" hue="sage" />
					<MutedRamp name="Rose" note="the mauve clouds at sunset" hue="rose" />
				</div>
			</Section>

			<Section index={5} title="Gradients" code="<InsightCard tone>">
				<Note>
					The gradient card is the signature surface. Use at most two per page, and only for one finding the person
					should act on. Field is new-growth, for the default and for growth. Sky is for neutral findings. Sage is for
					the most important summary on a page. Rose is for risk and findings that need attention. All tones carry ink
					text and look the same in both themes.
				</Note>
				<div className="grid gap-5 app-md:grid-cols-2 app-lg:grid-cols-4">
					{GRADIENTS.map(([tone, icon, title]) => (
						<InsightCard key={tone} tone={tone} size="sm" className="min-h-[170px]" aria-labelledby={`g-${tone}`}>
							<span className="self-start">
								<InsightPill icon={icon}>{tone}</InsightPill>
							</span>
							<InsightTitle id={`g-${tone}`} size="sm">
								{title}
							</InsightTitle>
						</InsightCard>
					))}
				</div>
			</Section>

			<Section index={6} title="Type" code="--ef-font-display · --ef-font-title · --ef-font-body">
				<div className="grid gap-5 app-md:grid-cols-2">
					<Specimen label="DM Serif Display 24px and up · DM Serif Text below">
						<div className="num text-[76px] leading-none text-ink max-app-sm:text-display-md">34 of 50</div>
						<div className="mt-3 font-display text-display-sm tracking-[-0.02em] text-ink">Core group</div>
						<div className="mt-2.5 font-title tracking-[-0.02em] text-title-md text-ink">Vision meeting · Oct 12</div>
						<p className="mt-3 text-sm text-text-3">
							display-lg 76 · display-sm 40 · title-lg 28 · title-md 22 · title-sm 18
						</p>
					</Specimen>
					<Specimen label="DM Sans · body, UI and table numbers">
						<p className="text-lg text-ink">
							Gather a core group of committed adults who share the vision before launch.
						</p>
						<p className="mt-3 text-md text-ink">Body 14 is the default for UI text, lists and tables.</p>
						<p className="mt-3 text-sm text-text-2">Small 13 is for captions, table headers and helper text.</p>
						<p className="mt-3 text-xs text-text-3">XS 12 is for labels, chips and counts.</p>
						<p className="mt-4 flex flex-wrap gap-2 text-ink">
							<span className="font-normal">Regular 400</span>·<span className="font-medium">Medium 500</span>·
							<span className="font-semibold">Semibold 600</span>
						</p>
					</Specimen>
				</div>
			</Section>

			<Section index={7} title="Shape, elevation and patterns" code="--corner-* · --ef-shadow-* · .hatch">
				<div className="grid gap-5 app-md:grid-cols-2 app-lg:grid-cols-4">
					<Specimen label="Corners">
						<div className="flex flex-wrap items-end gap-3">
							<div className="h-14 w-[72px] rounded-card bg-surface-2" />
							<div className="h-9 w-[72px] rounded-md bg-surface-2" />
							<div className="h-6 w-14 rounded-pill bg-surface-2" />
							<div className="size-[72px] rounded-card bg-surface-2" />
						</div>
						<p className="mt-3 text-xs text-text-3">
							card · control · pill · media. All square; avatars and dots stay round.
						</p>
					</Specimen>
					<Specimen label="Elevation">
						<div className="flex gap-3">
							<div className="h-16 flex-1 rounded-md bg-surface shadow-card" />
							<div className="h-16 flex-1 rounded-md bg-surface-raised shadow-raised" />
							<div className="h-16 flex-1 rounded-md bg-surface-raised shadow-pop" />
						</div>
						<p className="mt-3 text-xs text-text-3">card · raised · pop</p>
					</Specimen>
					<Specimen label="Hatch = planned or estimated">
						<div className="flex flex-col gap-2">
							<div className="hatch h-4 rounded-pill [--hatch:var(--ef-blue-300)]" />
							<div className="hatch h-4 w-[70%] rounded-pill [--hatch:var(--ef-magenta-500)]" />
							<div className="hatch h-4 w-1/2 rounded-pill [--hatch:var(--ef-green-500)]" />
						</div>
						<p className="mt-3 text-xs text-text-3">Solid fill = actual or recorded</p>
					</Specimen>
					<Specimen label="Icons · Hugeicons stroke rounded">
						<div className="flex flex-wrap gap-3 text-ink-2">
							{[
								UserMultipleIcon,
								Calendar03Icon,
								TaskDone01Icon,
								UserGroupIcon,
								BookOpen01Icon,
								Rocket01Icon,
								HandPrayerIcon,
								MentorIcon,
								Plant01Icon,
							].map((icon, i) => (
								<Icon key={i} icon={icon} size={22} />
							))}
						</div>
						<p className="mt-3 text-xs text-text-3">24 in the rail and top bar · 18 in buttons · 16 inline</p>
					</Specimen>
				</div>
			</Section>

			<Section index={8} title="Focus and motion" code="--ef-focus · --ef-slide-dur · --ef-slide-ease">
				<Note>
					Press Tab to see the focus ring: 2px in --ef-focus with a 2px offset, on keyboard focus only. One shared
					highlight slides to the hovered or focused item and rests on the selected one. Reduced motion turns the slide,
					the page reveal and the Evry animations off.
				</Note>
				<div className="flex flex-wrap items-center gap-5">
					<HoverDemo />
					<a href="#evry" className="font-medium text-ink underline underline-offset-[3px]">
						A focusable link
					</a>
				</div>
			</Section>

			<Section index={9} title="Evry character" code="EvryBot size · mood · follow · shape · hold" id="evry">
				<Note>
					Evry&apos;s character replaces a generic AI icon. It is the brand green with upright ink eyes. Evry has five
					shapes: triangle, circle, square, pill and hexagon. It holds a shape for a few seconds, then morphs into a
					different one at random. When idle it floats, blinks at random, looks to the sides, tilts and sways a little
					between shapes, and sometimes spins once. When it looks toward an edge, its eyes narrow and curve with the body
					and the body leans a little, so the flat shape turns like a solid. With follow, its eyes follow the pointer.
					Thinking squints, looks up and morphs faster. Happy shows ^ ^ eyes and bounces. Reduced motion stops all
					movement and shows one still shape.
				</Note>
				<div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-5">
					{MOODS.map(([mood, title, text]) => (
						<div
							key={mood}
							className="flex flex-col items-center gap-3.5 rounded-lg bg-surface px-5 py-[30px] text-center shadow-card"
						>
							<EvryBot size="xl" mood={mood} follow={mood === "idle"} />
							<div>
								<div className="font-semibold text-text">{title}</div>
								<div className="mt-2 text-sm text-text-3">{text}</div>
							</div>
						</div>
					))}
				</div>
				<p className="mt-6 text-sm text-text-3">Shapes</p>
				<div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(124px,1fr))] gap-5">
					{SHAPES.map((shape) => (
						<div
							key={shape}
							className="flex flex-col items-center gap-3 rounded-lg bg-surface px-3 py-[22px] text-center shadow-card"
						>
							<EvryBot size="xl" shape={shape} hold />
							<div className="flex items-center justify-center gap-3">
								<EvryBot size="sm" shape={shape} hold />
								<span className="font-semibold text-text capitalize">{shape}</span>
							</div>
						</div>
					))}
				</div>
				<div className="mt-4 flex flex-wrap items-center gap-6">
					<span className="text-sm text-text-3">Sizes</span>
					{(["xs", "sm", "md", "lg"] as EvryBotSize[]).map((size, i) => (
						<EvryBot key={size} size={size} blinkOffset={i / 4} />
					))}
					<span className="text-sm text-text-3">18 · 24 · 30 · 40 · 96</span>
				</div>
			</Section>

			<Section index={10} title="Content width" code='--ef-content-max · data-width="wide"'>
				<Note>
					The top bar and the rail span the window. The content column stops at 1536px and centers in the space beside
					the rail. Dense list pages (People, Meetings, Documents) use the wide column, up to 1920px. Below 1024px the
					rail and the top navigation move into Menu.
				</Note>
			</Section>
		</>
	);
}

function Section({
	index,
	title,
	code,
	id,
	children,
}: {
	index: number;
	title: string;
	code: string;
	id?: string;
	children: ReactNode;
}) {
	return (
		<section id={id} className="reveal mb-11 scroll-mt-28" style={revealDelay(index)} aria-labelledby={`f-${index}`}>
			<div className="mb-4 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
				<h2 id={`f-${index}`} className="text-[26px] text-ink">
					{title}
				</h2>
				<code className="rounded-xs bg-surface-2 px-[7px] py-[3px] font-mono text-xs text-text-2">{code}</code>
			</div>
			{children}
		</section>
	);
}

function Note({ className, children }: { className?: string; children: ReactNode }) {
	return <p className={cn("mb-[18px] max-w-[760px] text-text-2", className)}>{children}</p>;
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="rounded-lg bg-surface p-[22px] shadow-card">
			<p className="mb-3 text-xs text-text-3">{label}</p>
			{children}
		</div>
	);
}

function BrandTile({ className }: { className: string }) {
	return (
		<div className={cn("grid h-[210px] place-items-center rounded-card max-app-sm:h-40", className)}>
			<Lockup className="h-auto w-[260px] max-app-sm:w-48" />
		</div>
	);
}

function LogoChip({ className }: { className: string }) {
	return (
		<span className={cn("grid size-[34px] place-items-center rounded-card", className)}>
			<LogoMark className="h-auto w-5" />
		</span>
	);
}

const MOODS: [EvryMood, string, string][] = [
	["idle", "Idle", "Waiting. Floats, blinks, looks around, tilts and sometimes spins."],
	["thinking", "Thinking", "Reading records or drafting."],
	["happy", "Happy", "A change was approved and saved."],
];
const SHAPES: EvryShape[] = ["triangle", "circle", "square", "pill", "hexagon"];

const GRADIENTS: [InsightTone, typeof Plant01Icon, string][] = [
	["field", Plant01Icon, "Default and growth"],
	["sky", SparklesIcon, "Neutral finding"],
	["sage", ChartLineData01Icon, "Key summary"],
	["rose", Alert02Icon, "Risk or gap"],
];

/** A muted ramp, 700 to 100: cream text on 700, brand ink on the lighter steps, in both themes. */
function MutedRamp({ name, note, hue }: { name: string; note: string; hue: "green" | "sky" | "sage" | "rose" }) {
	const steps = ["700", "500", "300", "100"] as const;
	const fill = {
		green: ["bg-green-700", "bg-green-500", "bg-green-300", "bg-green-100"],
		sky: ["bg-sky-700", "bg-sky-500", "bg-sky-300", "bg-sky-100"],
		sage: ["bg-sage-700", "bg-sage-500", "bg-sage-300", "bg-sage-100"],
		rose: ["bg-rose-700", "bg-rose-500", "bg-rose-300", "bg-rose-100"],
	}[hue];
	return (
		<div className="rounded-lg bg-surface p-[22px] shadow-card">
			<p className="mb-3 text-xs text-text-3">
				<b className="mr-1.5 font-semibold text-text">{name}</b>
				{note}
			</p>
			<div className="grid h-[72px] grid-cols-4 overflow-hidden rounded-md">
				{steps.map((step, i) => (
					<div
						key={step}
						className={cn(
							"flex items-end px-2.5 py-2 font-mono text-[11px]",
							fill[i],
							i === 0 ? "text-cream" : "text-ink",
						)}
					>
						{step}
					</div>
				))}
			</div>
		</div>
	);
}

function Swatch({ className, name, use }: { className: string; name: string; use: string }) {
	return (
		<div className="overflow-hidden rounded-card bg-surface shadow-card">
			<div className={cn("h-[92px]", className)} />
			<div className="px-3.5 py-3">
				<b className="block font-semibold text-text">{name}</b>
				<span className="font-mono text-xs text-text-3">{use}</span>
			</div>
		</div>
	);
}

/** Text on 600/700 and on the text greys is on-ink; text on a 500 fill is brand ink in both themes; tints use ink. */
function stepText(step: string): string {
	if (/^(v|t)?(600|700)$/.test(step) || step.startsWith("text-")) return "text-on-ink";
	if (/500$/.test(step)) return "text-ink-fixed";
	return "text-ink";
}

function Ramp({ label, steps }: { label: string; steps: [string, string][] }) {
	return (
		<Specimen label={label}>
			<div
				className="grid h-[54px] overflow-hidden rounded-md"
				style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
			>
				{steps.map(([step, bg]) => (
					<div key={step} className={cn("flex items-end px-2 py-1.5 font-mono text-[11px]", bg, stepText(step))}>
						{step}
					</div>
				))}
			</div>
		</Specimen>
	);
}
