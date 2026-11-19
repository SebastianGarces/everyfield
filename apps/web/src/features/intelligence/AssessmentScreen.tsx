"use client";

import type {
	Assessment,
	AssessmentView,
	CitationView,
	EvidenceFact,
	LensTile as Lens,
	OwnFeedback,
	PlantFacts,
} from "@everyfield/contracts/intelligence";
import type { Catalog } from "@everyfield/contracts/phases";
import {
	Alert02Icon,
	ArrowRight01Icon,
	Coins01Icon,
	Dumbbell01Icon,
	FavouriteIcon,
	HandPrayerIcon,
	Queue02Icon,
	ThumbsDownIcon,
	ThumbsUpIcon,
	UserGroupIcon,
	UserMultipleIcon,
	ViewIcon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	InsightCard,
	InsightCount,
	InsightFooter,
	InsightPill,
	InsightText,
	InsightTitle,
	InsightTop,
	PageHeader,
	Spinner,
	StatePanel,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon, observeIntersection, type IconSvgElement } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useMemo, useState } from "react";
import { createRead, useRead } from "../../components/read.tsx";
import { markAssessmentSeen, submitAssessmentFeedback } from "./assessment-actions.ts";
import type { ActionOutcome } from "./assessment-model.ts";
import { resolveAssessmentCitation } from "./fetch.ts";
import {
	coldStartTitle,
	CRITERION,
	dayText,
	factText,
	newestText,
	nextSteps,
	QUALITY,
	SEVERITY_LABEL,
	STANDING,
} from "./assessment-model.ts";
import { IntelligenceTabs } from "./IntelligenceTabs.tsx";

type Props = { view: AssessmentView; facts: PlantFacts; catalog: Catalog };
type Point = Assessment["focus"];

const LENS_ICON: Record<Lens["key"], IconSvgElement> = {
	vision: ViewIcon,
	ownership: UserMultipleIcon,
	critical_mass: UserGroupIcon,
	cohesion: Queue02Icon,
	prayer: HandPrayerIcon,
	generosity: Coins01Icon,
	leadership: FavouriteIcon,
	training: Dumbbell01Icon,
};
const phaseName = (catalog: Catalog, n: number) => `Phase ${n} · ${catalog.phases[n]?.name ?? ""}`;

export function AssessmentScreen({ view, facts, catalog }: Props) {
	const current = view.current;
	return (
		<>
			<PageHeader
				size="xl"
				title="Plant Intelligence"
				subtitle={
					current
						? `${phaseName(catalog, current.phase)} assessment, measured ${dayText(current.measuredOn)} against rubric ${current.rubricVersion}.`
						: "Where your church stands on the road to Launch Sunday."
				}
			/>
			<IntelligenceTabs current="overview" />
			{current ? (
				<Current view={view} assessment={current} catalog={catalog} />
			) : (
				<ColdStart view={view} facts={facts} />
			)}
		</>
	);
}

const citations = createRead((runId: string, key: string) => resolveAssessmentCitation(runId, key), {
	failed: (): ActionOutcome<CitationView> => ({ status: "lost" }),
});

function Current({ view, assessment: a, catalog }: { view: AssessmentView; assessment: Assessment; catalog: Catalog }) {
	const [citation, setCitation] = useState<{ key: string; label: string } | null>(null);
	const runId = a.runId;
	const markSeen = useMemo(
		() =>
			view.seen
				? undefined
				: observeIntersection<HTMLDivElement>((entry, stop) => {
						if (!entry.isIntersecting) return;
						stop();
						void markAssessmentSeen(runId).catch(() => {});
					}),
		[runId, view.seen],
	);
	const open = (key: string, label: string) => {
		citations.prefetch(a.runId, key);
		setCitation({ key, label });
	};
	const feedback = new Map(view.feedback.map((f) => [f.ordinal, f]));
	const concerns = new Set(a.concerns.map((c) => c.ordinal));
	const later = newestText(view.newest, true);
	const otherPhase = view.currentPhase !== a.phase ? view.currentPhase : null;
	const point = (p: Point, ordinal: number) => ({
		p,
		ordinal,
		feedback: feedback.get(ordinal) ?? null,
		concern: concerns.has(ordinal),
	});
	return (
		<div ref={markSeen} className="flex flex-col gap-5">
			<Card size="sm" as="section" aria-label="About this assessment" data-phase={a.phase}>
				<div className="flex flex-col gap-3">
					<p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2">
						<StatusBadge status="measured" size="sm">
							{phaseName(catalog, a.phase)} assessment
						</StatusBadge>
						<span>
							As of {dayText(a.measuredOn)}
							{a.ageDays ? ` · ${a.ageDays === 1 ? "1 day" : `${a.ageDays} days`} ago` : " · today"}
							{a.daysToLaunch !== null ? ` · ${a.daysToLaunch} days to the launch date then` : ""}
						</span>
					</p>
					{otherPhase !== null ? (
						<p
							data-current-phase={otherPhase}
							className="flex gap-2.5 rounded-md bg-amber-100 px-3.5 py-2.5 text-sm text-ink"
						>
							<Icon icon={Alert02Icon} size={18} className="mt-0.5 flex-none text-amber-600" />
							<span>
								Your church is now in <b>{phaseName(catalog, otherPhase)}</b>. This assessment was written for Phase{" "}
								{a.phase}, so its criteria and standings are Phase {a.phase}&apos;s, not Phase {otherPhase}&apos;s.
							</span>
						</p>
					) : null}
					{later ? (
						<p role="status" className="text-sm text-text-2" data-newest={view.newest?.state}>
							{later}
						</p>
					) : null}
					<p className="text-sm text-ink-2 text-pretty">{a.summary}</p>
				</div>
			</Card>
			<div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Focus {...point(a.focus, 0)} runId={a.runId} onCite={open} />
				<Card as="section" aria-labelledby="supporting-heading">
					<CardHeader>
						<CardHeading>
							<CardTitle id="supporting-heading">Also worth your attention</CardTitle>
							<CardDescription>Two more points from this assessment.</CardDescription>
						</CardHeading>
					</CardHeader>
					<ol className="flex flex-col">
						{a.supporting.map((p, i) => (
							<PointRow key={i} {...point(p, i + 1)} runId={a.runId} onCite={open} />
						))}
					</ol>
				</Card>
			</div>
			<Card as="section" aria-labelledby="positives-heading">
				<CardHeader>
					<CardHeading>
						<CardTitle id="positives-heading">What&apos;s going well</CardTitle>
						<CardDescription>Strengths this assessment found, kept apart from what needs attention.</CardDescription>
					</CardHeading>
				</CardHeader>
				{a.positives.length ? (
					<ol className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-6 max-app-sm:grid-cols-1">
						{a.positives.map((p, i) => (
							<PointRow key={i} {...point(p, i + 3)} runId={a.runId} onCite={open} />
						))}
					</ol>
				) : (
					<p className="text-sm text-text-3">This assessment didn&apos;t name a strength this time.</p>
				)}
			</Card>
			<Lenses lenses={a.lenses} onCite={open} />
			<Criteria assessment={a} catalog={catalog} onCite={open} />
			{citation ? <CitationDialog runId={a.runId} citation={citation} onClose={() => setCitation(null)} /> : null}
		</div>
	);
}

type PointProps = {
	p: Point;
	ordinal: number;
	runId: string;
	feedback: OwnFeedback | null;
	concern: boolean;
	onCite: (key: string, label: string) => void;
};

function Focus({ p, ordinal, runId, feedback, concern, onCite }: PointProps) {
	return (
		<InsightCard
			tone={p.severity === "high" ? "rose" : "sage"}
			aria-labelledby="focus-heading"
			id="focus"
			data-point={ordinal}
		>
			<InsightTop>
				<InsightPill>Main focus</InsightPill>
				<InsightCount>{SEVERITY_LABEL[p.severity]}</InsightCount>
			</InsightTop>
			<InsightTitle id="focus-heading">{p.title}</InsightTitle>
			<InsightText>{p.body}</InsightText>
			{concern ? <ConcernNote ordinal={ordinal} runId={runId} light /> : null}
			<InsightFooter className="flex-col items-start">
				<Citations citations={p.citations} onCite={onCite} variant="light" />
				<Feedback runId={runId} ordinal={ordinal} initial={feedback} light />
			</InsightFooter>
		</InsightCard>
	);
}

function PointRow({ p, ordinal, runId, feedback, concern, onCite }: PointProps) {
	return (
		<li className="flex flex-col gap-2 border-t border-line py-4 first:border-t-0 first:pt-0" data-point={ordinal}>
			<p className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-semibold text-ink">{p.title}</span>
				<StatusBadge
					size="sm"
					status={p.severity === "info" ? "positive" : p.severity === "low" ? "measured" : "attention"}
				>
					{SEVERITY_LABEL[p.severity]}
				</StatusBadge>
			</p>
			<p className="text-sm text-ink-2 text-pretty">{p.body}</p>
			{concern ? <ConcernNote ordinal={ordinal} runId={runId} /> : null}
			<Citations citations={p.citations} onCite={onCite} />
			<Feedback runId={runId} ordinal={ordinal} initial={feedback} />
		</li>
	);
}

function ConcernNote({ ordinal, runId, light }: { ordinal: number; runId: string; light?: boolean }) {
	return (
		<p
			data-concern={`${runId}:${ordinal}`}
			className={cn("mt-3 text-xs", light ? "text-[var(--on-3)]" : "text-text-3")}
		>
			A concern: an organization you share Plant Intelligence findings with sees it too, as counts only.
		</p>
	);
}

function Citations({
	citations,
	onCite,
	variant = "secondary",
}: {
	citations: Point["citations"];
	onCite: (key: string, label: string) => void;
	variant?: "secondary" | "light";
}) {
	return (
		<ul aria-label="Evidence" className="flex flex-wrap gap-2">
			{citations.map((c) => (
				<li key={c.key}>
					<Button
						type="button"
						size="sm"
						variant={variant}
						data-citation={c.key}
						onClick={() => onCite(c.key, c.label)}
					>
						{c.label}
					</Button>
				</li>
			))}
		</ul>
	);
}

function Feedback({
	runId,
	ordinal,
	initial,
	light,
}: {
	runId: string;
	ordinal: number;
	initial: OwnFeedback | null;
	light?: boolean;
}) {
	const toast = useToast();
	const [saved, setSaved] = useState(initial);
	const [writing, setWriting] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	async function save(rating: OwnFeedback["rating"], comment: string, close: boolean) {
		const before = saved;
		setBusy(true);
		setSaved({
			ordinal,
			rating,
			comment: comment.trim() || null,
			recordedAt: before?.recordedAt ?? (new Date().toISOString() as OwnFeedback["recordedAt"]),
		});
		const r: ActionOutcome<{ feedback: OwnFeedback | null }> = await submitAssessmentFeedback({
			runId,
			ordinal,
			rating,
			comment,
		}).catch(() => ({ status: "lost" as const }));
		setBusy(false);
		if (r.status === "ok" && r.value.feedback) {
			setSaved(r.value.feedback);
			if (close) setWriting(null);
			return;
		}
		setSaved(before);
		toast({ message: "Your feedback wasn't saved. Try again in a moment.", tone: "error" });
	}
	const muted = light ? "text-[var(--on-3)]" : "text-text-3";
	const rate = (rating: OwnFeedback["rating"]) => {
		if (rating === "not_useful" && writing === null) setWriting(saved?.comment ?? "");
		void save(rating, saved?.comment ?? "", false);
	};
	return (
		<div className="flex w-full flex-col gap-2" data-feedback={saved?.rating ?? "none"}>
			<div className="flex flex-wrap items-center gap-2">
				<span className={cn("text-xs", muted)}>Was this useful?</span>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					aria-pressed={saved?.rating === "useful"}
					disabled={busy}
					onClick={() => rate("useful")}
					className={cn(saved?.rating === "useful" && "font-semibold")}
				>
					<Icon icon={ThumbsUpIcon} size={16} />
					Useful
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					aria-pressed={saved?.rating === "not_useful"}
					disabled={busy}
					onClick={() => rate("not_useful")}
					className={cn(saved?.rating === "not_useful" && "font-semibold")}
				>
					<Icon icon={ThumbsDownIcon} size={16} />
					Not useful
				</Button>
				{saved && writing === null ? (
					<Button type="button" size="sm" variant="ghost" onClick={() => setWriting(saved.comment ?? "")}>
						{saved.comment ? "Edit comment" : "Add a comment"}
					</Button>
				) : null}
			</div>
			{saved?.comment && writing === null ? (
				<p className={cn("text-sm whitespace-pre-line", light ? "text-[var(--on-2)]" : "text-ink-2")} data-comment>
					Your comment: {saved.comment}
				</p>
			) : null}
			{writing !== null && saved ? (
				<form
					className="flex w-full flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void save(saved.rating, writing, true);
					}}
				>
					<label className="sr-only" htmlFor={`comment-${ordinal}`}>
						Comment
					</label>
					<Textarea
						id={`comment-${ordinal}`}
						rows={2}
						maxLength={1000}
						value={writing}
						placeholder="What would have made this more useful? Only you can see this."
						onChange={(event) => setWriting(event.target.value)}
					/>
					<div className="flex gap-2">
						<Button type="submit" size="sm" variant="primary" disabled={busy}>
							Save comment
						</Button>
						<Button type="button" size="sm" variant="secondary" onClick={() => setWriting(null)}>
							Cancel
						</Button>
					</div>
				</form>
			) : null}
		</div>
	);
}

function Lenses({ lenses, onCite }: { lenses: Lens[]; onCite: (key: string, label: string) => void }) {
	return (
		<section aria-labelledby="lenses-heading">
			<div className="mb-3.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h2 id="lenses-heading" className="font-title text-title-sm tracking-[-0.02em] text-ink">
					Eight critical success factors
				</h2>
				<p className="text-sm text-text-3">Measured, attested or Unknown. Unknown is not the same as weak.</p>
			</div>
			<ul className="grid grid-cols-4 gap-4 max-app-lg:grid-cols-2 max-app-sm:grid-cols-1">
				{lenses.map((l) => (
					<LensTile key={l.key} lens={l} onCite={onCite} />
				))}
			</ul>
		</section>
	);
}

function LensTile({ lens, onCite }: { lens: Lens; onCite: (key: string, label: string) => void }) {
	const standing = STANDING[lens.standing];
	const unknown = lens.quality === "unknown";
	return (
		<li
			id={`lens-${lens.key}`}
			data-lens={lens.key}
			data-quality={lens.quality}
			data-standing={lens.standing}
			className={cn(
				"flex min-h-[176px] scroll-mt-24 flex-col gap-3 rounded-card p-[18px]",
				unknown
					? "border-[1.5px] border-dashed border-line-2"
					: "border border-line bg-surface-raised shadow-[var(--ef-shadow-card)]",
			)}
		>
			<div className="flex items-center gap-2.5">
				<span
					className={cn(
						"grid size-[34px] flex-none place-items-center rounded-pill",
						standing.status === "positive"
							? "bg-green-100 text-green-700"
							: standing.status === "attention"
								? "bg-amber-100 text-amber-600"
								: standing.status === "risk"
									? "bg-magenta-100 text-magenta-600"
									: "bg-surface-2 text-ink-2",
					)}
				>
					<Icon icon={LENS_ICON[lens.key]} size={18} />
				</span>
				<h3 className="min-w-0 flex-1 text-[15px] font-semibold text-ink">{lens.label}</h3>
				<StatusBadge size="sm" status={standing.status} className="shrink-0">
					{standing.label}
				</StatusBadge>
			</div>
			<LensNote lens={lens} onCite={onCite} />
			<p className="mt-auto flex items-center justify-between gap-2 text-xs text-text-3">
				<span className="font-medium text-ink-2">{QUALITY[lens.quality].label}</span>
				{lens.points.length ? (
					<a href="#focus" className="hover:text-ink">
						{lens.points.length === 1 ? "1 point cites this" : `${lens.points.length} points cite this`}
					</a>
				) : null}
			</p>
		</li>
	);
}

function LensNote({ lens, onCite }: { lens: Lens; onCite: (key: string, label: string) => void }) {
	if (lens.quality === "unknown")
		return (
			<p className="text-sm text-text-2">
				We don&apos;t have enough information to assess {lens.label.toLowerCase()} yet.
				{lens.attestations.length ? (
					<>
						{" "}
						<Link href="/intelligence/attestations" className="font-medium text-ink underline">
							Answer {lens.attestations.length === 1 ? "the question" : `${lens.attestations.length} questions`}
						</Link>
					</>
				) : null}
			</p>
		);
	return (
		<ul className="flex flex-col gap-1 text-sm text-text-2">
			{lens.evidence.map((e) => (
				<li key={e.key}>
					<FactButton fact={e} onCite={onCite} />
				</li>
			))}
			{lens.attestations.map((s) => (
				<li key={s.key}>
					{s.label}:{" "}
					<b className="font-semibold text-ink">
						{s.answered && s.asOf ? `answered ${dayText(s.asOf)}` : "not answered"}
					</b>
					{s.needsRenewing ? <span className="text-amber-600"> · needs renewing</span> : null}
				</li>
			))}
		</ul>
	);
}

function FactButton({ fact: e, onCite }: { fact: EvidenceFact; onCite: (key: string, label: string) => void }) {
	return (
		<button
			type="button"
			className="text-left hover:text-ink"
			data-citation={e.key}
			onClick={() => onCite(e.key, e.label)}
		>
			{e.label}: <b className="font-semibold text-ink">{factText(e.value)}</b>
		</button>
	);
}

function Criteria({
	assessment: a,
	catalog,
	onCite,
}: {
	assessment: Assessment;
	catalog: Catalog;
	onCite: (key: string, label: string) => void;
}) {
	return (
		<Card as="section" aria-labelledby="criteria-heading">
			<CardHeader>
				<CardHeading>
					<CardTitle id="criteria-heading">Phase {a.phase} exit criteria</CardTitle>
					<CardDescription>
						{catalog.phases[a.phase]?.name}, as this assessment measured them on {dayText(a.measuredOn)}. Unknown is not
						the same as not met.
					</CardDescription>
				</CardHeading>
			</CardHeader>
			{a.criteria.length ? (
				<ul className="flex flex-col">
					{a.criteria.map((x) => (
						<li
							key={x.key}
							data-criterion={x.key}
							data-status={x.status}
							className="flex items-start justify-between gap-4 border-t border-line py-3.5 first:border-t-0 first:pt-0 max-app-sm:flex-col max-app-sm:gap-2"
						>
							<div className="min-w-0">
								<p className="font-medium text-ink">{x.label}</p>
								{x.evidence.length ? (
									<ul aria-label="Evidence" className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-2">
										{x.evidence.map((e) => (
											<li key={e.key}>
												<FactButton fact={e} onCite={onCite} />
											</li>
										))}
									</ul>
								) : (
									<p className="mt-1 text-sm text-text-3">Everyfield doesn&apos;t measure this one yet.</p>
								)}
							</div>
							<StatusBadge size="sm" status={CRITERION[x.status].status} className="shrink-0">
								{CRITERION[x.status].label}
							</StatusBadge>
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-text-3">Phase 6 is the last phase. It has no exit criteria.</p>
			)}
		</Card>
	);
}

function CitationDialog({
	runId,
	citation,
	onClose,
}: {
	runId: string;
	citation: { key: string; label: string };
	onClose: () => void;
}) {
	const result = useRead(citations, runId, citation.key).value;
	return (
		<Dialog open onOpenChange={(next) => (next ? null : onClose())}>
			<DialogContent size="sm">
				<DialogHeader title={citation.label} description="From this assessment's own saved evidence." />
				<DialogBody className="flex flex-col gap-3" data-citation-view={citation.key}>
					{!result ? (
						<p className="flex items-center gap-2 text-sm text-text-2" role="status">
							<Spinner size={16} /> Opening the evidence
						</p>
					) : result.status !== "ok" ? (
						<StatePanel tone="error" title="We couldn't open this evidence" headingLevel="h3">
							Nothing was changed. Close this and try again in a moment.
						</StatePanel>
					) : (
						<CitationBody view={result.value} />
					)}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function CitationBody({ view }: { view: CitationView }) {
	if (view.status === "unverifiable")
		return (
			<p className="text-sm text-ink-2">
				This evidence no longer matches what the assessment saved, so it isn&apos;t shown.
			</p>
		);
	if (view.status === "unavailable")
		return <p className="text-sm text-ink-2">You can no longer open this passage&apos;s source.</p>;
	if (view.kind === "fact")
		return (
			<>
				<p className="num text-[40px] leading-none text-ink" data-fact-value>
					{factText(view.value)}
				</p>
				<p className="text-sm text-text-2">
					{view.label}, as of {dayText(view.measuredOn)}. Measured with {view.formulaVersion}.
				</p>
				{view.people.shown.length || view.people.hidden ? (
					<div>
						<p className="text-sm font-medium text-ink">People counted</p>
						<ul className="mt-1.5 flex flex-col gap-1 text-sm">
							{view.people.shown.map((p) => (
								<li key={p.personId}>
									<Link href={`/people/${p.personId}`} className="inline-flex items-center gap-1 text-ink underline">
										{p.name}
										<Icon icon={ArrowRight01Icon} size={16} />
									</Link>
								</li>
							))}
						</ul>
						{view.people.hidden ? (
							<p className="mt-1.5 text-xs text-text-3" data-hidden-people={view.people.hidden}>
								{view.people.hidden === 1
									? "1 more person was counted who is no longer in your records."
									: `${view.people.hidden} more people were counted who are no longer in your records.`}
							</p>
						) : null}
					</div>
				) : null}
			</>
		);
	return (
		<>
			<p className="text-sm font-medium text-ink">
				{view.title}
				{view.section ? ` · ${view.section}` : ""}
			</p>
			<blockquote className="border-l-2 border-line-2 pl-3 text-sm whitespace-pre-line text-ink-2" data-passage>
				{view.text}
			</blockquote>
			<p className="text-xs text-text-3">
				{view.sourceKind === "global" ? "Everyfield methodology" : "Your network's Wiki"} · release{" "}
				{view.version.release}, revision {view.version.revision}
				{view.currentVersion ? "" : " · a newer version has been published since"}
			</p>
			<Link href={`/wiki/${view.slug}`} className="text-sm font-medium text-ink underline">
				Open the article
			</Link>
		</>
	);
}

function ColdStart({ view, facts }: { view: AssessmentView; facts: PlantFacts }) {
	const { title, body } = coldStartTitle(view.newest);
	const steps = nextSteps(facts);
	return (
		<div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
			<Card as="section" data-cold-start={view.newest?.state ?? "not_generated"}>
				<StatePanel tone="neutral" title={title} headingLevel="h2">
					{body} Until then there are no results to show, so nothing here is met or unmet.
				</StatePanel>
			</Card>
			<Card as="section" aria-labelledby="next-heading">
				<CardHeader>
					<CardHeading>
						<CardTitle id="next-heading">Next steps from your records</CardTitle>
						<CardDescription>What Everyfield has measured so far points here. You choose what to do.</CardDescription>
					</CardHeading>
				</CardHeader>
				{steps.length ? (
					<ul className="flex flex-col">
						{steps.map((s) => (
							<li key={s.title} className="border-t border-line first:border-t-0">
								<Link href={s.href} className="flex items-center gap-3 py-3 hover:text-ink">
									<span className="min-w-0 flex-1">
										<span className="block font-medium text-ink">{s.title}</span>
										<span className="block text-sm text-text-2">{s.detail}</span>
									</span>
									<Icon icon={ArrowRight01Icon} size={16} className="flex-none text-text-3" />
								</Link>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-text-3">Your records show no gap to act on yet.</p>
				)}
			</Card>
		</div>
	);
}
