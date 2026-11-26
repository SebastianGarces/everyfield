import { cn } from "@everyfield/ui/foundations";
import {
	ArrowDown01Icon,
	ArrowRight01Icon,
	ArrowUp01Icon,
	Bookmark01Icon,
	ChurchIcon,
	Delete02Icon,
	Download04Icon,
	File02Icon,
	FileImportIcon,
	FloppyDiskIcon,
	Link01Icon,
	MoreHorizontalIcon,
	PlusSignIcon,
	PrinterIcon,
	QuoteDownIcon,
	RedoIcon,
	Search01Icon,
	SeparatorHorizontalIcon,
	TextBoldIcon,
	TextItalicIcon,
	TextUnderlineIcon,
	UndoIcon,
	UnfoldMoreIcon,
	LeftToRightListBulletIcon,
	LeftToRightListNumberIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { LockedNote, PageHead, Shell } from "./Shell";

const SQ = "grid size-[46px] place-items-center text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]";
const CARD = "bg-surface shadow-card";

function Sq({ icon }: { icon: IconSvgElement }) {
	return (
		<span className={SQ}>
			<Icon icon={icon} size={20} stroke={1.5} />
		</span>
	);
}

const PHASES = [
	"Discovery",
	"Core Group Development",
	"Launch Team Formation",
	"Training & Preparation",
	"Pre-Launch",
	"Launch Sunday",
	"Post-Launch",
];
const PHASE_ONE = [
	["What is a Core Group?", "read"],
	["What is a Vision Meeting?", "on"],
	["Planning Your Vision Meeting", ""],
	["Your First Vision Meeting", ""],
] as const;

export function WikiScreen() {
	return (
		<Shell
			nav="Wiki"
			label="The Everyfield wiki in Discovery: every stage from Discovery to Post-Launch, with the article What is a Vision Meeting? open."
		>
			<PageHead
				title="What is a Vision Meeting?"
				crumb={["Wiki", "Core Group Development", "What is a Vision Meeting?"]}
				sub="46% read"
				actions={
					<>
						<span className="flex h-[46px] w-[234px] items-center gap-2.5 bg-white px-3.5 shadow-[inset_0_0_0_1px_var(--color-line-2)] @max-[639px]:hidden">
							<Icon icon={Search01Icon} size={18} stroke={1.5} />
							<span className="flex-1 type-md text-text-3">Search the wiki</span>
							<span className="bg-surface-2 px-1.5 type-xs text-text-2 shadow-[inset_0_0_0_1px_var(--color-line)]">
								/
							</span>
						</span>
						<span className="hidden @max-[639px]:contents">
							<Sq icon={Search01Icon} />
						</span>
						<Sq icon={Bookmark01Icon} />
						<Sq icon={Download04Icon} />
						<Sq icon={PrinterIcon} />
					</>
				}
			/>
			<div className={cn("-mt-2 mb-4 flex items-center gap-3 p-2.5 type-sm text-text-2 @max-[639px]:hidden", CARD)}>
				<span className="flex h-10 items-center gap-2 bg-surface-2 pr-3 pl-2">
					<span className="grid size-[26px] place-items-center bg-green-100 type-mk-pic-xs font-semibold text-green-700">
						GL
					</span>
					Source <b className="font-semibold text-ink">Global</b>
					<Icon icon={ArrowDown01Icon} size={16} />
				</span>
				Published · your preferred source
			</div>
			<div className="grid flex-1 grid-cols-[250px_minmax(0,1fr)_220px] items-start @max-[1000px]:grid-cols-[230px_minmax(0,1fr)] @max-[639px]:grid-cols-[minmax(0,1fr)] @max-[639px]:gap-3.5">
				<div className="pr-3 @max-[639px]:pr-0">
					{PHASES.map((p, i) => (
						<div key={p}>
							<div className="flex items-center gap-2.5 px-2.5 py-[9px] font-medium text-ink @max-[639px]:px-0 @max-[639px]:py-[5px]">
								<span
									className={cn(
										"grid size-6 flex-none place-items-center font-title type-xs",
										i === 1 ? "bg-ink text-on-ink" : "bg-surface-2 text-text-2",
									)}
								>
									{i}
								</span>
								{p}
							</div>
							{i === 1 ? (
								<div className="@max-[639px]:hidden">
									{PHASE_ONE.map(([t, s]) => (
										<div
											key={t}
											className={cn(
												"flex items-center gap-2 py-[7px] pr-2.5 pl-11",
												s === "on" ? "font-medium text-ink" : "text-text-2",
											)}
										>
											{t}
											{s === "read" ? <i className="ml-auto size-1.5 flex-none rounded-full bg-green-500" /> : null}
										</div>
									))}
								</div>
							) : null}
						</div>
					))}
					<div className="mt-4 bg-surface-2 p-3.5 type-sm text-text-2 @max-[639px]:hidden">
						<div className="flex justify-between">
							<span>Phase 1 read</span>
							<b className="font-medium text-ink">1 of 4</b>
						</div>
						<span className="mt-2 block h-1.5 bg-surface">
							<i className="block h-full w-1/4 bg-ink" />
						</span>
					</div>
				</div>
				<div
					className={cn(
						"mx-4 px-11 py-8 type-lg leading-[1.65] text-ink-2 @max-[1000px]:mx-0 @max-[1000px]:px-[30px] @max-[1000px]:py-7 @max-[639px]:px-4 @max-[639px]:py-[22px] @max-[639px]:type-lg @max-[639px]:leading-[1.55]",
						CARD,
					)}
				>
					<p>
						The Vision Meeting sits at the top of the funnel that transforms interested individuals into committed Core
						Group members who will help you plant a thriving church.
					</p>
					<WikiHeading>The Heart of the Launch Process</WikiHeading>
					<p>
						A Vision Meeting is any gathering, large or small, formal or informal, where you and your key leaders cast a
						clear, compelling, and challenging vision.
					</p>
					<div className="mt-[18px] bg-surface-2 px-[18px] py-4 type-lg leading-[1.6]">
						<b className="mb-1 block font-medium">Insight</b>
						Vision Meetings aren&rsquo;t about selling people on your church. They&rsquo;re about clearly articulating
						where God is leading and inviting the right people to join the journey.
					</div>
					<div className="@max-[639px]:hidden">
						<WikiHeading>Seven Essential Elements</WikiHeading>
						<p>Every effective Vision Meeting includes these seven elements, regardless of size or format.</p>
						<p className="mt-3">
							<b className="font-semibold text-ink">1. Connect.</b> Connect authentically with the people attending.
							People don&rsquo;t join visions. They join people with visions.
						</p>
					</div>
				</div>
				<div className="pl-6 @max-[1000px]:hidden">
					<p className="mb-2.5 type-sm text-text-3">On this page</p>
					<div className="border-l-[1.5px] border-line">
						{["The Heart of the Launch Process", "Seven Essential Elements", "What a Vision Meeting Is NOT"].map(
							(h, i) => (
								<span
									key={h}
									className={cn(
										"-ml-[1.5px] block border-l-[1.5px] px-3.5 py-1.5",
										i ? "border-transparent text-text-3" : "border-ink font-medium text-ink",
									)}
								>
									{h}
								</span>
							),
						)}
					</div>
				</div>
			</div>
		</Shell>
	);
}

function WikiHeading({ children }: { children: ReactNode }) {
	return (
		<div className="mt-[26px] mb-2 font-display type-title-lg leading-[1.2] tracking-[-0.02em] text-ink @max-[639px]:mt-5 @max-[639px]:type-title-md">
			{children}
		</div>
	);
}

const MY_DOCUMENTS = [
	"Why I keep coming back to this",
	"Prayer list for the east side",
	"What I'm learning about our city",
];
const TEMPLATES = [
	[
		"Expectations of a Core Group Member",
		"What the church plant asks of each core group member, with a place to sign.",
	],
	["Launch Team Commitment", "The commitment of a launch team member, with a place to sign."],
	["Vision Meeting Follow-up Letter", "A thank-you letter to a guest of a vision meeting."],
	["Prayer Letter", "A letter from the pastor that tells supporters how to pray for the church plant."],
] as const;

function SectionTitle({ title, sub }: { title: string; sub: string }) {
	return (
		<div className="min-w-0">
			<div className="font-title type-title-sm leading-[1.2] tracking-[-0.02em] text-ink">{title}</div>
			<p className="mt-1 type-md text-text-2">{sub}</p>
		</div>
	);
}

export function DocumentsScreen() {
	return (
		<Shell
			nav="Documents"
			label="Documents in Discovery: Your documents, with the line Only you can see these documents, three private documents, and templates to start from."
		>
			<PageHead title="Documents" sub="Write your own documents, or start from a template." xl />
			<div className="flex items-end justify-between gap-4 @max-[639px]:flex-col @max-[639px]:items-start @max-[639px]:gap-3">
				<SectionTitle title="Your documents" sub="Only you can see these documents." />
				<span className="inline-flex h-11 flex-none items-center gap-2 bg-surface-2 px-[18px] font-medium text-ink">
					<Icon icon={PlusSignIcon} size={18} stroke={1.5} />
					New document
				</span>
			</div>
			<div className="mt-4 flex flex-col gap-2">
				{MY_DOCUMENTS.map((d) => (
					<div
						key={d}
						className="flex items-center justify-between gap-3 bg-surface px-4 py-3.5 text-ink shadow-[0_0_0_1px_var(--color-line)]"
					>
						<span className="truncate">{d}</span>
						<Icon icon={ArrowRight01Icon} size={18} stroke={1.5} className="text-text-2" />
					</div>
				))}
			</div>
			<div className="mt-10 @max-[639px]:mt-8">
				<SectionTitle
					title="Start from a template"
					sub="Each one makes a private document you can edit. Your name is filled in. Church details stay blank for you to fill in."
				/>
			</div>
			<div className="mt-4 grid grid-cols-2 gap-2.5 @max-[639px]:grid-cols-1">
				{TEMPLATES.map(([t, d], i) => (
					<div
						key={t}
						className={cn(
							"flex flex-col items-start gap-4 bg-surface p-4 shadow-[0_0_0_1px_var(--color-line)]",
							i > 1 && "@max-[639px]:hidden",
						)}
					>
						<div className="flex gap-3">
							<span className="grid size-9 flex-none place-items-center bg-blue-100 text-blue-600">
								<Icon icon={File02Icon} size={18} stroke={1.5} />
							</span>
							<div className="min-w-0">
								<div className="font-semibold text-ink">{t}</div>
								<p className="mt-0.5 type-md text-text-2">{d}</p>
							</div>
						</div>
						<span className="inline-flex h-11 items-center bg-surface-2 px-[18px] text-ink">Use this template</span>
					</div>
				))}
			</div>
		</Shell>
	);
}

const TOOLBAR: (readonly IconSvgElement[] | "style")[] = [
	[UndoIcon, RedoIcon],
	"style",
	[TextBoldIcon, TextItalicIcon, TextUnderlineIcon, Link01Icon],
	[LeftToRightListBulletIcon, LeftToRightListNumberIcon, QuoteDownIcon],
	[SeparatorHorizontalIcon],
];

const BLANK = "bg-amber-100 px-0.5 text-ink";

export function TemplateScreen() {
	return (
		<Shell
			nav="Documents"
			label="A template opened as a private document: the Vision Meeting Follow-up Letter, signed Caleb Turner, with the church name left blank to fill in."
		>
			<PageHead title="Vision Meeting Follow-up Letter" crumb={["Documents"]} sub="Your documents" />
			<div className="mx-auto flex w-full max-w-[816px] flex-1 flex-col gap-4 @max-[639px]:gap-3">
				<div className="grid gap-1.5">
					<span className="type-sm font-medium text-ink">Title</span>
					<span className="flex min-h-[46px] items-center bg-white px-3.5 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]">
						Vision Meeting Follow-up Letter
					</span>
				</div>
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<span className="type-sm text-text-2">Saved · Revision 1</span>
					<span className="flex gap-2 type-sm">
						<span className="inline-flex h-9 items-center gap-1.5 bg-surface-2 px-3 font-medium text-ink @max-[639px]:hidden">
							<Icon icon={FileImportIcon} size={16} stroke={1.5} />
							Import a text or Word file
						</span>
						<span className="grid size-9 place-items-center text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]">
							<Icon icon={MoreHorizontalIcon} size={18} stroke={1.5} />
						</span>
						<span className="inline-flex h-9 items-center gap-1.5 bg-ink px-3 font-medium text-on-ink opacity-45">
							<Icon icon={FloppyDiskIcon} size={16} stroke={1.5} />
							Save
						</span>
					</span>
				</div>
				<div className="flex items-center gap-1.5 overflow-hidden bg-white p-1.5 text-ink-2 shadow-[0_0_0_1px_var(--color-line)]">
					{TOOLBAR.map((g, i) => (
						<span
							key={i}
							className={cn(
								"flex items-center gap-0.5",
								i > 0 && "border-l border-line pl-1.5",
								i !== 1 && i !== 2 && "@max-[639px]:hidden",
								i === 1 && "@max-[639px]:border-0 @max-[639px]:pl-0",
							)}
						>
							{g === "style" ? (
								<span className="flex min-w-[100px] items-center justify-between gap-2 px-2 font-medium whitespace-nowrap @max-[330px]:min-w-0">
									Heading 1
									<Icon icon={UnfoldMoreIcon} size={16} stroke={1.5} />
								</span>
							) : (
								g.map((ic, j) => (
									<span key={j} className="grid size-9 place-items-center @max-[639px]:w-8 @max-[330px]:w-7">
										<Icon icon={ic} size={18} stroke={1.5} />
									</span>
								))
							)}
						</span>
					))}
					<span className="flex items-center gap-0.5 border-l border-line pl-1.5 @max-[1000px]:hidden">
						<span className="flex items-center gap-1.5 px-2">
							<Icon icon={PlusSignIcon} size={18} stroke={1.5} />
							Insert
						</span>
						{[ArrowUp01Icon, ArrowDown01Icon, Delete02Icon].map((ic, j) => (
							<span key={j} className="grid size-9 place-items-center">
								<Icon icon={ic} size={18} stroke={1.5} />
							</span>
						))}
					</span>
				</div>
				<div className="flex-1 bg-white px-[88px] py-11 type-lg leading-[1.55] text-ink shadow-raised @max-[1000px]:px-14 @max-[639px]:px-[18px] @max-[639px]:py-[22px]">
					<div className="mb-2 font-display type-display-sm leading-[1.1] tracking-[-0.02em] text-green-700 @max-[639px]:type-title-lg">
						Thank You for Coming
					</div>
					<p>Dear friend,</p>
					<p className="mt-2.5">
						Thank you for coming to our vision meeting. It meant a great deal to us that you gave an evening to hear
						about <span className={BLANK}>[church name]</span>, a new church plant.
					</p>
					<p className="mt-2.5 @max-[639px]:hidden">
						We shared why we believe this church is needed, who we hope to reach and what a Sunday could look like. We
						would love to hear what you thought.
					</p>
					<p className="mt-2.5">With gratitude,</p>
					<p className="mt-2.5">Caleb Turner</p>
					<p className="mt-2.5">
						<span className={BLANK}>[church name]</span>
					</p>
				</div>
			</div>
		</Shell>
	);
}

export function LockedScreen({ page }: { page: "Tasks" | "Launch" }) {
	const body =
		page === "Tasks"
			? "This is where your church team shares its work and follow-ups."
			: "This is where your church plans its launch.";
	return (
		<Shell
			rail={page.toLowerCase()}
			label={`${page} in Discovery: ${page} opens when you start your church, with a Start a church action.`}
		>
			<PageHead title={page} xl />
			<LockedNote
				title={`${page} opens when you start your church`}
				body={`${body} You can keep exploring in Discovery for as long as you need.`}
			/>
		</Shell>
	);
}

export function SenderScreen() {
	return (
		<Shell
			who="director"
			rail="sharing"
			label="What a linked sending church sees when Caleb Turner has turned sharing on: his name, when he connected, and foundations, 4 of 6 completed. Documents are never shared."
		>
			<PageHead
				title="Sharing and privacy"
				sub="Churches connected with you, the networks you work with, and what you share with each."
			/>
			<div className={cn("p-7 @max-[639px]:p-4", CARD)}>
				<SectionTitle
					title="Connected churches"
					sub="Churches that chose to connect with you. You see only what each one shares."
				/>
				<div className="mt-5 flex items-start gap-3">
					<span className="grid size-9 flex-none place-items-center bg-blue-100 text-blue-600">
						<Icon icon={ChurchIcon} size={18} stroke={1.5} />
					</span>
					<div className="min-w-0 flex-1">
						<p className="font-semibold text-ink">Caleb Turner</p>
						<p className="type-md text-text-3">Exploring planting · connected Sep 14, 2026</p>
						<p className="mt-2 type-md text-text-2">Foundations: 4 of 6 completed</p>
						<p className="mt-3 border-t border-line pt-3 type-sm text-text-3">Documents are never shared.</p>
					</div>
					<span className="flex-none px-3 type-md text-ink @max-[639px]:hidden">End connection</span>
				</div>
			</div>
		</Shell>
	);
}
