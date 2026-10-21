"use client";

import {
	Add01Icon,
	Alert02Icon,
	ArrowRight01Icon,
	Calendar03Icon,
	Cancel01Icon,
	Call02Icon,
	Copy01Icon,
	Delete02Icon,
	Download01Icon,
	Edit02Icon,
	FilterHorizontalIcon,
	GridViewIcon,
	HelpCircleIcon,
	ListViewIcon,
	Mail01Icon,
	MoreHorizontalIcon,
	Plant01Icon,
	Refresh01Icon,
	Share08Icon,
	SidebarLeftIcon,
	SparklesIcon,
	Task01Icon,
	UserAdd01Icon,
	UserCheck01Icon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import { useEffect, useState, type ReactNode } from "react";
import { cn, EvryBot, Icon, revealDelay } from "../../foundations";
import {
	Button,
	CalloutLabel,
	CalloutText,
	CalloutTitle,
	Card,
	CardActions,
	CardBody,
	CardClose,
	CardDescription,
	CardFooter,
	CardHeader,
	CardHeading,
	CardInset,
	CardScrollArea,
	CardTitle,
	Checkbox,
	Combobox,
	CommandPalette,
	ConfirmDialog,
	DateRangePicker,
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTrigger,
	EmptyState,
	Field,
	FilterChip,
	IconButton,
	Input,
	InsightCard,
	InsightCount,
	InsightFooter,
	InsightMetric,
	InsightPill,
	InsightSpark,
	InsightText,
	InsightTitle,
	InsightTop,
	Kbd,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	MenuTrigger,
	PageHeader,
	Popover,
	PopoverContent,
	PopoverTrigger,
	Radio,
	RadioGroup,
	SearchInput,
	SegmentedControl,
	Select,
	Sheet,
	Skeleton,
	StatePanel,
	Switch,
	Tab,
	Tabs,
	TabsList,
	TabsPanel,
	Textarea,
	ToastProvider,
	Tooltip,
	TooltipSep,
	useToast,
	type DateRange,
} from "..";
import { ACTIVITY, COMMANDS, PRESETS, STAGES, TAGS, TONES_PREVIEW } from "./fixtures";

type Group = "all" | "surfaces" | "actions" | "inputs" | "overlays" | "feedback";

const GROUPS = [
	{ value: "all", label: "All" },
	{ value: "surfaces", label: "Surfaces" },
	{ value: "actions", label: "Actions" },
	{ value: "inputs", label: "Inputs" },
	{ value: "overlays", label: "Overlays" },
	{ value: "feedback", label: "Feedback" },
] as const satisfies readonly { value: Group; label: string }[];

/**
 * The controls preview at /design/controls, after the prototype's #/components page: every WP-089 inventory row in
 * its drawn states, with invented sample data. Every control works, so keyboard, focus and the overlay states can
 * be checked in place. Compositions that belong to feature packages are listed at the end with their parts.
 */
export function ControlsPreview() {
	const [group, setGroup] = useState<Group>("all");
	const show = (g: Group) => group === "all" || group === g;
	return (
		<ToastProvider>
			<PageHeader
				size="xl"
				breadcrumb={[{ label: "Design system", href: "/design/foundations" }, { label: "Controls" }]}
				title="Controls"
				subtitle="Shared controls, surfaces and overlays. Feature pages compose their screens from these parts. Every control here works with the keyboard; the sample data is invented."
				actions={<SegmentedControl label="Show group" options={[...GROUPS]} value={group} onValueChange={setGroup} />}
				className="reveal"
			/>
			<div className="flex flex-col gap-12">
				{show("surfaces") ? <CardsSection /> : null}
				{show("surfaces") ? <InsightSection /> : null}
				{show("actions") ? <ButtonsSection /> : null}
				{show("inputs") ? <InputsSection /> : null}
				{show("inputs") ? <SelectionSection /> : null}
				{show("overlays") ? <OverlaysSection /> : null}
				{show("feedback") ? <FeedbackSection /> : null}
				{group === "all" ? <CompositionMap /> : null}
			</div>
		</ToastProvider>
	);
}

function Section({
	title,
	code,
	index,
	note,
	children,
}: {
	title: string;
	code: string;
	index: number;
	note?: ReactNode;
	children: ReactNode;
}) {
	const id = `section-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
	return (
		<section aria-labelledby={id} className="reveal" style={revealDelay(index)}>
			<div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
				<h2 id={id} className="text-title-lg text-ink">
					{title}
				</h2>
				<code className="text-sm text-text-3">{code}</code>
			</div>
			{note ? <p className="mb-4 max-w-[760px] text-text-2">{note}</p> : null}
			{children}
		</section>
	);
}

function Specimen({ label, className, children }: { label?: string; className?: string; children: ReactNode }) {
	return (
		<div className={cn("rounded-lg bg-surface p-6 shadow-card max-app-sm:p-4", className)}>
			{label ? <h3 className="mb-4 text-sm font-medium text-text-3">{label}</h3> : null}
			{children}
		</div>
	);
}

function Avatar({ initials, tone }: { initials: string; tone: keyof typeof TONES_PREVIEW }) {
	return (
		<span
			aria-hidden="true"
			className={cn("grid size-8 flex-none place-items-center rounded-full text-xs font-semibold", TONES_PREVIEW[tone])}
		>
			{initials}
		</span>
	);
}

function CardsSection() {
	const [dismissed, setDismissed] = useState(false);
	return (
		<Section
			index={1}
			title="Card"
			code={'<Card variant="default|raised|flat|callout" size="md|sm">'}
			note="A card is a frame with optional slots. The header holds the title, description, actions and close button. The body can become a scroll area. The footer holds buttons."
		>
			<div className="grid items-start gap-5 app-md:grid-cols-2 app-lg:grid-cols-4">
				<Card as="section" aria-labelledby="card-core">
					<CardHeader>
						<CardHeading>
							<CardTitle id="card-core">Core group</CardTitle>
							<CardDescription>Committed adults</CardDescription>
						</CardHeading>
						<CardActions>
							<RowMenu name="Core group" />
						</CardActions>
					</CardHeader>
					<CardBody>
						<p className="num text-[56px] leading-none text-ink">34</p>
						<p className="mt-2 text-text-3">16 to reach 50</p>
					</CardBody>
					<CardFooter>
						<Button size="sm">View people</Button>
					</CardFooter>
				</Card>

				{dismissed ? (
					<Card variant="flat" size="sm">
						<p className="text-text-2">Reminder dismissed.</p>
						<Button size="sm" variant="ghost" className="mt-2 self-start" onClick={() => setDismissed(false)}>
							Show it again
						</Button>
					</Card>
				) : (
					<Card as="section" aria-labelledby="card-close">
						<CardHeader>
							<CardHeading>
								<CardTitle id="card-close" size="sm">
									Header and close
								</CardTitle>
								<CardDescription>Dismissible prompt</CardDescription>
							</CardHeading>
							<CardClose label="Dismiss the meeting reminder" onClick={() => setDismissed(true)} />
						</CardHeader>
						<CardBody className="text-text-2">
							Your last vision meeting was 16 days ago. The Playbook rhythm is every 14 days.
						</CardBody>
						<CardFooter plain>
							<Button size="sm" variant="primary">
								Schedule meeting
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
								Later
							</Button>
						</CardFooter>
					</Card>
				)}

				<Card as="section" aria-labelledby="card-scroll">
					<CardHeader className="mb-2.5">
						<CardHeading>
							<CardTitle id="card-scroll" size="sm">
								Header and scroll area
							</CardTitle>
							<CardDescription>Recent activity</CardDescription>
						</CardHeading>
						<span className="num rounded-pill bg-surface-2 px-2 py-0.5 font-title text-xs text-text-2">12</span>
					</CardHeader>
					<CardScrollArea label="Recent activity" maxHeight={190}>
						<ul className="flex flex-col">
							{ACTIVITY.map((a) => (
								<li key={a.title} className="flex items-center gap-3 py-2.5">
									<Avatar initials={a.initials} tone={a.tone} />
									<div className="min-w-0">
										<p className="truncate text-sm font-medium text-ink">{a.title}</p>
										<p className="truncate text-xs text-text-3">{a.sub}</p>
									</div>
								</li>
							))}
						</ul>
					</CardScrollArea>
				</Card>

				<div className="flex flex-col gap-4">
					<Card variant="callout" tone="green" as="section" aria-label="Evry noticed">
						<CalloutLabel tone="green" art={<EvryBot size="sm" mood="idle" />}>
							Evry noticed
						</CalloutLabel>
						<CalloutText>Three first-time guests from Sunday have no follow-up owner yet.</CalloutText>
						<div className="mt-3">
							<Button size="sm">Assign follow-ups</Button>
						</div>
					</Card>
					<Card variant="flat" size="sm">
						<p className="flex items-center gap-3 text-text-2">
							<Icon icon={Add01Icon} size={18} className="text-text-3" />
							Flat card · drop zone or placeholder
						</p>
					</Card>
					<Card variant="raised" size="sm">
						<p className="text-text-2">Raised card · on a tinted area</p>
					</Card>
				</div>
			</div>
		</Section>
	);
}

function InsightSection() {
	return (
		<Section
			index={2}
			title="Insight card"
			code="<InsightCard tone size> Pill · Metric · Title · Text · Spark · Footer"
			note="The gradient card. At most two per page, for one finding to act on. All four tones carry ink text and look the same in light and dark mode."
		>
			<div className="grid gap-5 app-md:grid-cols-2 app-lg:grid-cols-[1.1fr_1fr_1fr]">
				<InsightCard tone="field" aria-labelledby="ins-field">
					<InsightTop>
						<InsightPill icon={Plant01Icon}>Momentum</InsightPill>
						<InsightCount>Last 28 days</InsightCount>
					</InsightTop>
					<InsightMetric value="+9" unit="committed adults, up from +4 the 28 days before" />
					<InsightTitle id="ins-field">The core group is growing faster than in any month so far</InsightTitle>
					<InsightSpark values={[2, 3, 2, 4, 3, 5, 9]} label="Committed adults per four weeks, rising from 2 to 9" />
					<InsightFooter>
						<Button variant="light">
							See who joined <Icon icon={ArrowRight01Icon} size={18} />
						</Button>
					</InsightFooter>
				</InsightCard>
				<InsightCard tone="sky" aria-labelledby="ins-sky">
					<InsightTop>
						<InsightPill icon={SparklesIcon}>Pattern found</InsightPill>
						<InsightCount>1 of 3</InsightCount>
					</InsightTop>
					<InsightMetric value="62%" unit="of guests return when called within 48 h" />
					<InsightTitle id="ins-sky">Quick follow-up doubles return visits</InsightTitle>
					<InsightFooter>
						<Button variant="light">
							Review 7 guests <Icon icon={ArrowRight01Icon} size={18} />
						</Button>
					</InsightFooter>
				</InsightCard>
				<InsightCard tone="rose" aria-labelledby="ins-rose">
					<InsightTop>
						<InsightPill icon={Alert02Icon}>Needs attention</InsightPill>
						<InsightCount>Before launch</InsightCount>
					</InsightTop>
					<InsightMetric value="4" unit="leader roles still open" />
					<InsightTitle id="ins-rose">Children&apos;s ministry has no leader yet</InsightTitle>
					<InsightFooter>
						<Button variant="light">
							Find candidates <Icon icon={ArrowRight01Icon} size={18} />
						</Button>
						<Button variant="glass">Later</Button>
					</InsightFooter>
				</InsightCard>
				<InsightCard tone="sage" size="sm" aria-labelledby="ins-sage" className="app-lg:col-span-2">
					<InsightTop>
						<InsightPill icon={SparklesIcon}>This week</InsightPill>
						<InsightCount>Size sm</InsightCount>
					</InsightTop>
					<InsightMetric size="sm" value="3" unit="steps left in Phase 1" />
					<InsightTitle id="ins-sage" size="sm">
						Your next step is the first vision meeting
					</InsightTitle>
					<InsightText>
						Lilac is for the most important summary on a page. Nested text and buttons keep their light colors in dark
						mode.
					</InsightText>
					<InsightFooter>
						<Button variant="light" size="sm">
							Plan it
						</Button>
					</InsightFooter>
				</InsightCard>
			</div>
		</Section>
	);
}

function ButtonsSection() {
	const [range, setRange] = useState<DateRange>(PRESETS[1]!.range);
	const [saving, setSaving] = useState(false);
	const save = () => {
		setSaving(true);
		setTimeout(() => setSaving(false), 1600);
	};
	return (
		<Section index={3} title="Buttons" code="<Button variant size icon loading> · <IconButton variant size label>">
			<Specimen>
				<div className="flex flex-wrap items-center gap-3">
					<Button variant="primary" icon={Add01Icon}>
						Add person
					</Button>
					<Button variant="brand">Commit to core group</Button>
					<Button variant="secondary" icon={Share08Icon}>
						Share
					</Button>
					<Button variant="outline" icon={Download01Icon}>
						Export
					</Button>
					<Button variant="ghost">Cancel</Button>
					<Button variant="danger" icon={Delete02Icon}>
						Retire
					</Button>
					<Button variant="primary" disabled>
						Disabled
					</Button>
					<Button variant="primary" loading={saving} onClick={save}>
						{saving ? "Saving" : "Save changes"}
					</Button>
					<Button variant="light">
						Review 7 guests <Icon icon={ArrowRight01Icon} size={18} />
					</Button>
				</div>
				<div className="mt-4 flex flex-wrap items-center gap-3">
					<Button variant="primary" size="sm">
						Small primary
					</Button>
					<Button variant="secondary" size="sm">
						Small secondary
					</Button>
					<Button variant="outline" size="sm" icon={FilterHorizontalIcon}>
						Filters
					</Button>
					<Button variant="secondary" size="sm" asChild>
						<a href="#section-buttons">Link as a button</a>
					</Button>
					<span className="w-4" aria-hidden="true" />
					<Tooltip content="More actions">
						<IconButton icon={MoreHorizontalIcon} label="More actions" />
					</Tooltip>
					<Tooltip content="Edit">
						<IconButton icon={Edit02Icon} label="Edit" variant="soft" />
					</Tooltip>
					<Tooltip content="Close">
						<IconButton icon={Cancel01Icon} label="Close" size="sm" />
					</Tooltip>
					<Tooltip content="Collapse sidebar">
						<IconButton icon={SidebarLeftIcon} label="Collapse sidebar" variant="square" />
					</Tooltip>
				</div>
				<div className="mt-6 flex flex-wrap items-center gap-3">
					<DateRangePicker value={range} onValueChange={setRange} presets={PRESETS} compareLabel="vs prior 28 days" />
				</div>
				<div className="mt-6 rounded-md bg-ink-fixed p-4">
					<p className="mb-3 text-sm text-white/80">Glass on a dark surface</p>
					<Button variant="glass" size="sm">
						Not now
					</Button>
				</div>
			</Specimen>
		</Section>
	);
}

function InputsSection() {
	const [phone, setPhone] = useState("512-555-01");
	const [stage, setStage] = useState("interviewed");
	const [tags, setTags] = useState<string[]>(["hyde-park"]);
	const [owner, setOwner] = useState<string[]>([]);
	const phoneError =
		phone.replace(/\D/g, "").length < 10 ? "Enter a full phone number, with the area code." : undefined;
	return (
		<Section index={4} title="Inputs" code="<Field> <Input> <SearchInput> <Textarea> <Select> <Combobox> <FilterChip>">
			<div className="grid items-start gap-5 app-md:grid-cols-2 app-lg:grid-cols-3">
				<Specimen className="flex flex-col gap-4">
					<Field label="Full name">
						<Input defaultValue="Maria Santos" autoComplete="off" />
					</Field>
					<Field label="Email" hint="Used for invitations and RSVP links.">
						<Input type="email" icon={Mail01Icon} defaultValue="maria@harvestpoint.org" autoComplete="off" />
					</Field>
					<Field label="Phone" error={phoneError}>
						<Input
							type="tel"
							icon={Call02Icon}
							value={phone}
							onChange={(e) => setPhone(e.target.value)}
							autoComplete="off"
						/>
					</Field>
					<Field label="Nickname" optional>
						<Input placeholder="What people call her" disabled />
					</Field>
				</Specimen>
				<Specimen className="flex flex-col gap-4">
					<Field label="Search">
						<SearchInput placeholder="Search people, meetings, articles" shortcut="⌘K" />
					</Field>
					<Field label="Stage">
						<Select value={stage} onValueChange={setStage} options={STAGES} />
					</Field>
					<Field label="Note" hint="Visible to Owners and Admins.">
						<Textarea placeholder="What did you talk about?" />
					</Field>
				</Specimen>
				<Specimen className="flex flex-col gap-4">
					<Field label="Follow-up owner">
						<Combobox
							searchLabel="Search people"
							options={TAGS.owners}
							value={owner}
							onValueChange={setOwner}
							placeholder="Choose a person"
						/>
					</Field>
					<div>
						<h3 className="mb-2 text-sm font-medium text-ink-2">Filter chips</h3>
						<div className="flex flex-wrap items-center gap-2">
							<FilterChip
								label="Stage"
								icon={FilterHorizontalIcon}
								searchLabel="Search stages"
								options={STAGES}
								value={[]}
								onValueChange={() => {}}
							/>
							<FilterChip
								label="Tag"
								searchLabel="Search tags"
								options={TAGS.tags}
								value={tags}
								onValueChange={setTags}
							/>
							<FilterChip
								label="Source"
								searchLabel="Search sources"
								options={[]}
								value={[]}
								onValueChange={() => {}}
								loading
							/>
						</div>
						<p className="mt-2 text-xs text-text-3">
							Stage and Tag are searchable lists. Source shows the loading state.
						</p>
					</div>
				</Specimen>
			</div>
		</Section>
	);
}

function SelectionSection() {
	const [view, setView] = useState("list");
	const [digest, setDigest] = useState(true);
	return (
		<Section index={5} title="Selection" code="<Checkbox> <RadioGroup> <Radio> <Switch> <SegmentedControl> <Tabs>">
			<div className="grid items-start gap-5 app-md:grid-cols-2 app-lg:grid-cols-3">
				<Specimen label="Checkbox and radio">
					<Checkbox label="Send RSVP reminder" defaultChecked />
					<Checkbox label="All core group members" description="Mixed: some are selected" checked="indeterminate" />
					<Checkbox label="Round shape" shape="round" />
					<div className="mt-2 flex items-center gap-3 text-sm text-text-3">
						<Checkbox aria-label="Select Maria Santos" /> A row checkbox without a visible label
					</div>
					<fieldset className="mt-4">
						<legend className="text-sm font-medium text-ink-2">Vision meeting rhythm</legend>
						<RadioGroup defaultValue="14" orientation="horizontal" className="flex-wrap">
							<Radio value="14" label="Every 14 days" />
							<Radio value="7" label="Weekly" />
							<Radio value="30" label="Monthly" disabled />
						</RadioGroup>
					</fieldset>
				</Specimen>
				<Specimen label="Switch">
					<Switch
						label="Daily digest"
						description="Open items at 7:00 am"
						checked={digest}
						onCheckedChange={setDigest}
					/>
					<Switch label="Calendar sync" description="Blue tone variant" tone="blue" defaultChecked />
					<Switch label="Weekly summary" description="Off" />
					<Switch label="SMS reminders" description="Disabled until a number is verified" disabled />
				</Specimen>
				<Specimen label="Segmented control and tabs" className="min-w-0">
					<SegmentedControl
						label="View"
						value={view}
						onValueChange={setView}
						options={[
							{ value: "list", label: "List", icon: ListViewIcon },
							{ value: "cards", label: "Cards", icon: GridViewIcon },
							{ value: "pipeline", label: "Pipeline" },
						]}
					/>
					<Tabs defaultValue="overview" className="mt-6">
						<TabsList aria-label="Ministry">
							<Tab value="overview" count={4}>
								Overview
							</Tab>
							<Tab value="roles">Roles</Tab>
							<Tab value="training">Training</Tab>
							<Tab value="meetings">Meetings</Tab>
						</TabsList>
						<TabsPanel value="overview">Four open items for Worship.</TabsPanel>
						<TabsPanel value="roles">Six roles, two open.</TabsPanel>
						<TabsPanel value="training">Two people finished training this month.</TabsPanel>
						<TabsPanel value="meetings">Next rehearsal is Thursday.</TabsPanel>
					</Tabs>
				</Specimen>
			</div>
		</Section>
	);
}

function RowMenu({ name }: { name: string }) {
	const toast = useToast();
	return (
		<Menu>
			<Tooltip content="More actions">
				<MenuTrigger asChild>
					<IconButton icon={MoreHorizontalIcon} label={`More actions for ${name}`} />
				</MenuTrigger>
			</Tooltip>
			<MenuContent align="end">
				<MenuLabel>{name}</MenuLabel>
				<MenuItem
					icon={Edit02Icon}
					shortcut="E"
					onSelect={() => toast({ message: "Edit opens the profile.", tone: "info" })}
				>
					Edit profile
				</MenuItem>
				<MenuItem icon={Calendar03Icon} onSelect={() => toast({ message: "Invited to the vision meeting on Oct 26." })}>
					Invite to meeting
				</MenuItem>
				<MenuItem
					icon={Task01Icon}
					onSelect={() =>
						toast({
							message: "Follow-up created for Tom.",
							action: { label: "View task", altText: "Open Tasks to view the follow-up", onSelect: () => {} },
						})
					}
				>
					Create follow-up
				</MenuItem>
				<MenuItem icon={Copy01Icon} disabled>
					Merge duplicate
				</MenuItem>
				<MenuSeparator />
				<MenuItem
					icon={Delete02Icon}
					danger
					onSelect={() => toast({ message: "Retire needs a confirmation in the real page.", tone: "info" })}
				>
					Retire person
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}

function OverlaysSection() {
	const toast = useToast();
	const [palette, setPalette] = useState(false);
	const [guide, setGuide] = useState(false);
	const [attempts, setAttempts] = useState(0);
	const [offer, setOffer] = useState(true);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPalette((o) => !o);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<Section
			index={6}
			title="Overlays"
			code="<Dialog> <ConfirmDialog> <Sheet> <Menu> <Popover> <Tooltip> <Toast> <CommandPalette>"
			note="Each overlay closes with Esc and returns focus to the control that opened it. Dialogs make the page behind them inert."
		>
			<div className="grid items-start gap-5 app-md:grid-cols-2">
				<Specimen label="Dialogs and panels">
					<div className="flex flex-wrap gap-3">
						<Dialog>
							<DialogTrigger asChild>
								<Button variant="primary" icon={UserCheck01Icon}>
									Move Maria to core group
								</Button>
							</DialogTrigger>
							<DialogContent>
								<DialogHeader
									icon={UserCheck01Icon}
									tone="green"
									title="Move Maria to core group"
									description="Interviewed · Sep 30"
								/>
								<DialogBody>
									<p>
										Maria signed a commitment card on Oct 6. Moving her to core group adds her to the 50-person
										benchmark count.
									</p>
									<CardInset className="mt-4 bg-surface">
										<div className="flex flex-wrap items-center gap-4">
											<div>
												<p className="text-sm text-text-3">Now</p>
												<p className="mt-1.5 font-medium text-ink">Interviewed</p>
											</div>
											<Icon icon={ArrowRight01Icon} size={16} className="text-text-3" />
											<div>
												<p className="text-sm text-text-3">New</p>
												<p className="mt-1.5 font-medium text-ink">Core group</p>
											</div>
										</div>
										<div className="mt-4 border-t border-line pt-2">
											<Switch
												label="Offer ministry roles"
												description="Suggest open roles that match her skills"
												checked={offer}
												onCheckedChange={setOffer}
											/>
										</div>
									</CardInset>
								</DialogBody>
								<DialogFooter>
									<DialogClose asChild>
										<Button>Cancel</Button>
									</DialogClose>
									<DialogClose asChild>
										<Button
											variant="primary"
											onClick={() =>
												toast({
													message: "Maria moved to core group.",
													action: { label: "View Maria", altText: "Open People to view Maria", onSelect: () => {} },
												})
											}
										>
											Move to core group
										</Button>
									</DialogClose>
								</DialogFooter>
							</DialogContent>
						</Dialog>
						<ConfirmDialog
							trigger={
								<Button variant="danger" icon={Delete02Icon}>
									Hide article
								</Button>
							}
							tone="danger"
							title="Hide “Cast the vision”?"
							description="Readers in your church stop seeing this article. You can show it again later."
							consequences={[
								"It leaves the Wiki tree and search for everyone in Harvest Point.",
								"Reading progress already recorded stays in history.",
								"Links to it show that it is hidden.",
							]}
							confirmLabel="Hide article"
							onConfirm={async () => {
								await new Promise((r) => setTimeout(r, 900));
								setAttempts((n) => n + 1);
								if (attempts === 0)
									throw new Error(
										"The article did not hide because the connection dropped. Nothing changed. Try again.",
									);
								toast({ message: "Article hidden." });
							}}
						/>
						<Button icon={HelpCircleIcon} onClick={() => setGuide(true)}>
							Open the guide
						</Button>
						<Sheet
							open={guide}
							onOpenChange={setGuide}
							modal={false}
							title="Run your first vision meeting"
							description="Guide · 8 min read"
							footer={
								<Button size="sm" variant="ghost" onClick={() => setGuide(false)}>
									Done
								</Button>
							}
						>
							<p>
								A vision meeting is where a core group starts. Invite people you already know, share why the church is
								starting, and ask each person to take one next step.
							</p>
							<p className="mt-3">The page stays usable while this panel is open. Esc closes it.</p>
						</Sheet>
					</div>
					<p className="mt-4 text-sm text-text-3">
						The first try of Hide article fails on purpose to show the error state; the second succeeds.
					</p>
				</Specimen>

				<Specimen label="Menus, pop-overs, tooltips and toasts">
					<div className="flex flex-wrap items-center gap-3">
						<RowMenu name="Maria Santos" />
						<Popover>
							<PopoverTrigger asChild>
								<Button icon={UserMultipleIcon}>Who is coming</Button>
							</PopoverTrigger>
							<PopoverContent arrow label="RSVPs for the vision meeting" className="w-[280px] p-4">
								<p className="font-medium text-ink">Vision meeting · Oct 26</p>
								<p className="mt-1 text-sm text-text-2">18 yes · 4 maybe · 9 not answered</p>
								<Button size="sm" className="mt-3">
									Send a reminder
								</Button>
							</PopoverContent>
						</Popover>
						<Tooltip
							tone="light"
							content={
								<>
									<b className="font-semibold">Oct 12</b>
									<TooltipSep />
									47 attended
									<TooltipSep />
									<span className="font-semibold text-green-600">9 new</span>
								</>
							}
						>
							<button
								type="button"
								className="h-11 cursor-pointer rounded-md px-3 font-medium text-ink underline decoration-dotted underline-offset-4"
							>
								Oct 12 bar
							</button>
						</Tooltip>
					</div>
					<div className="mt-4 flex flex-wrap gap-3">
						<Button
							size="sm"
							onClick={() =>
								toast({
									message: "Maria moved to core group.",
									action: { label: "View Maria", altText: "Open People to view Maria", onSelect: () => {} },
								})
							}
						>
							Success toast
						</Button>
						<Button size="sm" onClick={() => toast({ message: "Reminders go out at 7:00 am.", tone: "info" })}>
							Info toast
						</Button>
						<Button
							size="sm"
							onClick={() =>
								toast({ message: "The reminder did not send. Check the email address and try again.", tone: "error" })
							}
						>
							Error toast
						</Button>
						<Button size="sm" variant="outline" icon={SparklesIcon} onClick={() => setPalette(true)}>
							Command palette <Kbd className="ml-1">⌘K</Kbd>
						</Button>
					</div>
					<CommandPalette
						open={palette}
						onOpenChange={setPalette}
						hints={["↑↓ move", "↵ open", "⌘J ask Evry"]}
						groups={COMMANDS.map((g) => ({
							heading: g.heading,
							items: g.items.map((i) => ({
								...i,
								art: i.evry ? (
									<EvryBot size="xs" mood="idle" />
								) : (
									<Avatar initials={i.initials ?? ""} tone={i.tone ?? "blue"} />
								),
								onSelect: () => toast({ message: `Opened ${i.label}.`, tone: "info" }),
							})),
						}))}
					/>
				</Specimen>
			</div>
		</Section>
	);
}

function FeedbackSection() {
	return (
		<Section
			index={7}
			title="Feedback"
			code="<EmptyState> <Skeleton> <StatePanel tone> <Card variant=callout tone>"
			note="A failed load never looks like an empty list: it says what failed, keeps the last known time and offers Try again."
		>
			<div className="grid items-start gap-5 app-md:grid-cols-2 app-lg:grid-cols-3">
				<Card>
					<EmptyState
						icon={Calendar03Icon}
						title="No vision meetings yet"
						action={
							<Button size="sm" variant="primary" icon={Add01Icon}>
								Plan the first one
							</Button>
						}
					>
						Vision meetings are how a core group starts. The Playbook suggests one every 14 days.
					</EmptyState>
				</Card>
				<Card aria-busy="true" className="gap-3">
					<p className="sr-only">Loading recent activity</p>
					<div className="flex items-center gap-3">
						<Skeleton shape="circle" width={44} height={44} />
						<div className="flex flex-1 flex-col gap-2">
							<Skeleton width="60%" />
							<Skeleton width="40%" height={12} />
						</div>
					</div>
					<Skeleton shape="block" height={64} />
					<Skeleton width="80%" />
					<Skeleton width="50%" />
					<p className="text-center text-xs text-text-3">Loading recent activity…</p>
				</Card>
				<div className="flex flex-col gap-4">
					<Card variant="callout" tone="amber">
						<CalloutLabel tone="amber" icon={Alert02Icon}>
							Needs attention
						</CalloutLabel>
						<CalloutTitle>Two follow-ups are overdue</CalloutTitle>
						<CalloutText>Kim Wu and Sara Nunez have waited more than three days.</CalloutText>
					</Card>
					<Card variant="callout" tone="blue">
						<CalloutLabel tone="blue" icon={GridViewIcon}>
							Components
						</CalloutLabel>
						<CalloutTitle>Class names become components.</CalloutTitle>
					</Card>
					<Card variant="callout" tone="violet">
						<CalloutLabel tone="violet" icon={SparklesIcon}>
							Top finding
						</CalloutLabel>
						<CalloutText>Guests called within 48 hours return twice as often.</CalloutText>
					</Card>
				</div>
				<Card className="app-lg:col-span-3">
					<StatePanel
						tone="error"
						title="We could not load your people"
						meta="Last loaded today at 8:40 am · Error reference EF-3MDA"
						actions={
							<>
								<Button variant="primary" icon={Refresh01Icon}>
									Try again
								</Button>
								<Button variant="ghost">Report a problem</Button>
							</>
						}
					>
						This is a loading problem, not an empty list. Your 214 people are safe. Try again in a moment.
					</StatePanel>
				</Card>
				<Card className="app-lg:col-span-2">
					<StatePanel
						tone="lock"
						title="People is not shared with your seat"
						actions={
							<>
								<Button variant="primary">Ask for access</Button>
								<Button variant="ghost">Back to overview</Button>
							</>
						}
					>
						Your seat can see meetings and tasks you are part of, but not the full list of people. An Owner can change
						this in Seats and invitations.
					</StatePanel>
				</Card>
				<Card>
					<StatePanel
						icon={UserMultipleIcon}
						title="No people yet"
						meta="Tip: export contacts from your phone or Google as a CSV file."
						actions={
							<>
								<Button variant="primary" icon={Download01Icon}>
									Import a spreadsheet
								</Button>
								<Button icon={UserAdd01Icon}>Add a person</Button>
							</>
						}
					>
						Start with the people you already know. Everyone starts as a prospect.
					</StatePanel>
				</Card>
			</div>
		</Section>
	);
}

const COMPOSITIONS: [string, string, string][] = [
	["Network tabs", "Tabs, Tab count", "WP-047"],
	["Plant Intelligence tabs", "Tabs, Tab count", "WP-038, WP-044"],
	["Scope bar", "SegmentedControl", "WP-047"],
	["Publish review", "Dialog, CardInset", "WP-034, WP-035"],
	["Hide dialog", "ConfirmDialog tone=danger (shown above)", "WP-034, WP-035"],
	["Lens plants dialog", "Dialog size=lg", "WP-044, WP-047"],
	["Attestation dialog, Renewal pass", "Dialog, RadioGroup, Field, Textarea", "WP-039, WP-040"],
	["Feedback dialog", "Dialog, RadioGroup, Textarea", "WP-049"],
	["Guide panel", "Sheet modal=false (shown above)", "WP-034"],
	["Settings dialog", "Dialog size=lg, Tabs, Switch, Field", "WP-010"],
	["Notification pop-over", "Popover, CardIcon", "WP-030"],
	["User menu", "Menu, MenuRadioGroup", "WP-010, WP-047"],
	["Private check-in reminder", "Card variant=callout, CardClose", "WP-039"],
];

/** Inventory rows in these groups whose content belongs to one feature: the feature composes them from these parts. */
function CompositionMap() {
	return (
		<Section
			index={8}
			title="Feature compositions"
			code="components.md rows composed by feature packages"
			note="These rows carry one feature's data and behavior, so their owners build them from the parts above instead of a second component system."
		>
			<Card
				role="region"
				aria-label="Feature compositions table"
				tabIndex={0}
				data-focus-inset=""
				className="overflow-x-auto p-0"
			>
				<table className="w-full min-w-[620px] text-left text-md">
					<thead className="text-sm text-text-3">
						<tr className="border-b border-line">
							<th scope="col" className="px-6 py-3 font-medium">
								Inventory row
							</th>
							<th scope="col" className="px-6 py-3 font-medium">
								Built from
							</th>
							<th scope="col" className="px-6 py-3 font-medium">
								Owner
							</th>
						</tr>
					</thead>
					<tbody>
						{COMPOSITIONS.map(([row, parts, owner]) => (
							<tr key={row} className="border-b border-line last:border-0">
								<th scope="row" className="px-6 py-3 font-medium text-ink">
									{row}
								</th>
								<td className="px-6 py-3 text-text-2">{parts}</td>
								<td className="px-6 py-3 text-text-2">{owner}</td>
							</tr>
						))}
					</tbody>
				</table>
			</Card>
		</Section>
	);
}
