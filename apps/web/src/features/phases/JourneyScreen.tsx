"use client";

import {
	checkReason,
	type Catalog,
	type HistoryResult,
	type JourneyEntry,
	type JourneyState,
	type PhaseNumber,
	type Readiness,
} from "@everyfield/contracts/phases";
import { Alert02Icon, ArrowRight01Icon, Flag02Icon, Route02Icon, StartUp02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardActions,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	PageHeader,
	Select,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { StatusBadge, type Status } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useState } from "react";
import type { PlantFacts } from "@everyfield/contracts/intelligence";
import { FactsSection } from "../intelligence/FactsSection.tsx";
import { IntelligenceTabs } from "../intelligence/IntelligenceTabs.tsx";
import { declarePhase, movePhase } from "./actions.ts";
import {
	entryDate,
	entryDetail,
	entryTitle,
	isPending,
	pendingDeclaration,
	pendingMove,
	POST_LAUNCH_MEASURES,
	REASON_MESSAGE,
	refusalMessage,
	requestKeys,
	sent,
	SHORT_NAME,
	withEntry,
	type Journey,
} from "./model.ts";

type Viewer = { accountId: string; name: string };
type Props = { history: HistoryResult; catalog: Catalog; readiness: Readiness[]; facts: PlantFacts; viewer: Viewer };

/** What the change dialog holds: the chosen phase, the typed reason, and why the last attempt did not go through. */
type MoveDraft = { to: PhaseNumber; reason: string; error: string | null; changed: JourneyState | null };

const STATUS: Record<Readiness["criteria"][number]["status"], { status: Status; label: string }> = {
	met: { status: "positive", label: "Met" },
	not_met: { status: "attention", label: "Not met" },
	unknown: { status: "unknown", label: "Unknown" },
	not_tracked: { status: "unknown", label: "Not tracked" },
};

/**
 * Plant Intelligence's phase card, journey and timeline (WP-038, prototype #/intelligence) and the measured facts (WP-040). A move or declaration shows
 * at once and is confirmed or rolled back from the server's answer; nothing reloads the page. Only Owners and Admins
 * reach this screen; the route shows Members a locked panel instead.
 */
export function JourneyScreen({ history, catalog, readiness, facts, viewer }: Props) {
	const toast = useToast();
	const [journey, setJourney] = useState<Journey>({ state: history.state, entries: history.entries });
	const [move, setMove] = useState<MoveDraft | null>(null);
	const [declare, setDeclare] = useState<PhaseNumber | null>(null);
	const [receipt, setReceipt] = useState<string | null>(null);
	// A lost move reopens with what was sent, so trying again is the same intent and replays its request key.
	const [lostMove, setLostMove] = useState<MoveDraft | null>(null);
	const [lostDeclare, setLostDeclare] = useState<PhaseNumber | null>(null);
	const [keys] = useState(() => requestKeys(() => crypto.randomUUID()));
	const phase = catalog.phases[journey.state.phase]!;
	const actor = { accountId: viewer.accountId, displayName: viewer.name } as JourneyEntry["actor"];
	const busy = journey.entries.some(isPending);

	async function submitMove(draft: MoveDraft) {
		const checked = checkReason(draft.reason);
		if (!checked.ok) return setMove({ ...draft, error: REASON_MESSAGE[checked.problem] });
		const before = journey;
		setMove(null);
		setReceipt(null);
		setLostMove(null);
		setJourney(pendingMove(before, draft.to, checked.reason, actor, new Date().toISOString()));
		const intent = ["move", before.state.revision, draft.to, draft.reason] as const;
		const r = await sent(() => movePhase(keys.keyFor(intent), before.state.revision, draft.to, draft.reason));
		if (r.status === "lost") setLostMove({ ...draft, error: null, changed: null });
		else keys.settle(intent);
		if (r.status === "ok") {
			if (r.value.outcome === "noop") return setReceipt(`No change: already in Phase ${r.value.state.phase}.`);
			return setJourney(withEntry(before, r.value.state, r.value.entry));
		}
		setJourney(before);
		if (r.status === "refused" && r.error.code === "revision_conflict") {
			// The church changed under the reviewer: show where it is now, keep the reason, and move from the new revision.
			const changed = r.error.details.state;
			setJourney({ ...before, state: changed });
			return setMove({ ...draft, error: null, changed });
		}
		if (r.status === "refused" && r.error.code === "invalid_reason")
			return setMove({ ...draft, error: refusalMessage(r), changed: null });
		toast({ message: refusalMessage(r), tone: "error" });
	}

	async function submitDeclare(to: PhaseNumber) {
		const before = journey;
		setDeclare(null);
		setReceipt(null);
		setLostDeclare(null);
		setJourney(pendingDeclaration(before, to, actor, new Date().toISOString()));
		const intent = ["declare", before.state.revision, to] as const;
		const r = await sent(() => declarePhase(keys.keyFor(intent), before.state.revision, to));
		if (r.status === "lost") setLostDeclare(to);
		else keys.settle(intent);
		if (r.status === "ok") return setJourney(withEntry(before, r.value.state, r.value.entry));
		setJourney(
			r.status === "refused" && r.error.code === "revision_conflict"
				? { ...before, state: r.error.details.state }
				: before,
		);
		toast({ message: refusalMessage(r), tone: "error" });
	}

	return (
		<>
			<PageHeader
				size="xl"
				title="Plant Intelligence"
				subtitle={`Where ${history.plantName} is on the Playbook journey. You decide when to move on.`}
			/>
			<IntelligenceTabs current="overview" />
			<div className="grid grid-cols-[minmax(0,1.9fr)_minmax(0,1.1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Card>
					<CardHeader>
						<CardHeading>
							<CardTitle>Phase {phase.phase}</CardTitle>
							<CardDescription>{phase.name}</CardDescription>
						</CardHeading>
						<CardActions>
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => setMove(lostMove ?? { to: journey.state.phase, reason: "", error: null, changed: null })}
							>
								Change phase
							</Button>
						</CardActions>
					</CardHeader>
					<Track current={journey.state.phase} />
					<p aria-live="polite" className="mt-4 text-sm font-medium text-ink empty:hidden">
						{receipt}
					</p>
					{journey.state.declarable ? (
						<div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface-2 px-4 py-3">
							<p className="text-sm text-ink-2">Already further along? Declare your current phase.</p>
							<Button variant="secondary" size="sm" disabled={busy} onClick={() => setDeclare(lostDeclare ?? 2)}>
								Declare phase
							</Button>
						</div>
					) : null}
					<Signs readiness={readiness[journey.state.phase]!} />
				</Card>
				<Timeline entries={journey.entries} timeZone={history.timeZone} />
			</div>
			<FactsSection facts={facts} />
			<Phases catalog={catalog} current={journey.state.phase} />
			{move ? (
				<MoveDialog
					draft={move}
					current={journey.state.phase}
					catalog={catalog}
					readiness={readiness[journey.state.phase]!}
					onChange={setMove}
					onSubmit={submitMove}
				/>
			) : null}
			{declare !== null ? (
				<DeclareDialog to={declare} catalog={catalog} onChange={setDeclare} onSubmit={submitDeclare} />
			) : null}
		</>
	);
}

/** The seven-step track: done phases filled, the current one hatched (prototype .phase-track). */
function Track({ current }: { current: PhaseNumber }) {
	return (
		<div>
			<ol aria-label="Journey" className="grid grid-cols-7 gap-1.5">
				{SHORT_NAME.map((name, i) => (
					<li key={name} aria-current={i === current ? "step" : undefined}>
						<span className="sr-only">
							Phase {i} {name}
							{i < current ? ", earlier" : i === current ? ", current" : ""}
						</span>
						<span
							aria-hidden="true"
							style={i === current ? ({ "--hatch": "var(--ef-green-600)" } as React.CSSProperties) : undefined}
							className={cn(
								"block h-2.5 rounded-pill",
								i < current ? "bg-ink" : i === current ? "hatch bg-green-100" : "bg-surface-2",
							)}
						/>
					</li>
				))}
			</ol>
			<div aria-hidden="true" className="mt-2.5 grid grid-cols-7 gap-1.5 text-xs text-text-3">
				{SHORT_NAME.map((name, i) => (
					<span key={name} className={cn(i === current ? "font-semibold text-ink" : "max-app-sm:invisible")}>
						{name}
					</span>
				))}
			</div>
		</div>
	);
}

/** The current phase's exit criteria with their advisory status. */
function Signs({ readiness }: { readiness: Readiness }) {
	if (readiness.verdict === "terminal")
		return (
			<section className="mt-7" aria-labelledby="signs-heading">
				<h3 id="signs-heading" className="mb-3 text-sm text-text-3">
					Phase 6 is the last phase. It has no exit criteria.
				</h3>
				<PostLaunchMeasures />
			</section>
		);
	return (
		<section className="mt-7" aria-labelledby="signs-heading">
			<h3 id="signs-heading" className="mb-3 text-sm text-text-3">
				Signs that Phase {readiness.phase} is wrapping up
			</h3>
			<ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 max-app-sm:grid-cols-1">
				{readiness.criteria.map((x) => (
					<li
						key={x.key}
						className="flex flex-col items-start gap-2 rounded-md bg-surface-2 px-3.5 py-3 max-app-sm:flex-row max-app-sm:items-center max-app-sm:justify-between"
					>
						<span className="min-w-0 text-sm text-ink-2">{x.label}</span>
						<StatusBadge size="sm" status={STATUS[x.status].status} className="shrink-0">
							{STATUS[x.status].label}
						</StatusBadge>
					</li>
				))}
			</ul>
			{readiness.measured ? null : (
				<p className="mt-3 text-xs text-text-3">
					Everyfield does not measure these signs yet, so each one reads Unknown. Unknown is not the same as not met.
				</p>
			)}
		</section>
	);
}

/** Post-launch measures with no approved source yet: each reads Not measured, never met. */
function PostLaunchMeasures() {
	return (
		<ul className="flex flex-col gap-2.5">
			{POST_LAUNCH_MEASURES.map((m) => (
				<li
					key={m.key}
					className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-3.5 py-3 max-app-sm:flex-col max-app-sm:items-start"
				>
					<span className="min-w-0">
						<span className="block text-sm text-ink-2">{m.label}</span>
						<span className="mt-0.5 block text-xs text-text-3">{m.note}</span>
					</span>
					<StatusBadge size="sm" status="unknown" className="shrink-0">
						Not measured
					</StatusBadge>
				</li>
			))}
		</ul>
	);
}

/** Every recorded step, newest first. Entries are never edited; a correction is a new entry. */
function Timeline({ entries, timeZone }: { entries: JourneyEntry[]; timeZone: string }) {
	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>Journey</CardTitle>
					<CardDescription>Each change stays here as it happened.</CardDescription>
				</CardHeading>
			</CardHeader>
			<ol className="flex flex-col">
				{entries.toReversed().map((e) => (
					<li
						key={e.id}
						aria-busy={isPending(e) || undefined}
						className={cn(
							"flex gap-3 border-t border-line py-3.5 first:border-t-0 first:pt-0",
							isPending(e) && "opacity-60",
						)}
					>
						<span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-full bg-surface-2 text-ink-2">
							<Icon
								icon={
									e.kind === "movement"
										? Route02Icon
										: e.kind === "creation"
											? Flag02Icon
											: e.kind === "launch_sunday"
												? StartUp02Icon
												: ArrowRight01Icon
								}
								size={16}
							/>
						</span>
						<div className="min-w-0 flex-1">
							<p className="font-semibold text-ink">{entryTitle(e)}</p>
							<p className="text-sm text-ink-2">{entryDetail(e)}</p>
							{e.kind === "movement" ? (
								<p className="mt-1 text-sm break-words whitespace-pre-line text-text-2">{e.reason}</p>
							) : null}
							<p className="mt-1 text-xs text-text-3">
								{[e.actor?.displayName, isPending(e) ? "Saving" : entryDate(e.occurredAt, timeZone)]
									.filter(Boolean)
									.join(" · ")}
							</p>
						</div>
					</li>
				))}
			</ol>
		</Card>
	);
}

/** All seven phases with their Playbook exit criteria (PHASE-008). */
function Phases({ catalog, current }: { catalog: Catalog; current: PhaseNumber }) {
	return (
		<Card className="mt-5">
			<CardHeader>
				<CardHeading>
					<CardTitle>The seven phases</CardTitle>
					<CardDescription>The Playbook&apos;s exit criteria for each phase.</CardDescription>
				</CardHeading>
			</CardHeader>
			<ol className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
				{catalog.phases.map((p) => (
					<li
						key={p.phase}
						aria-current={p.phase === current ? "step" : undefined}
						className={cn(
							"rounded-md px-4 py-3.5",
							p.phase === current ? "bg-green-100 shadow-[inset_0_0_0_1px_var(--ef-green-600)]" : "bg-surface-2",
						)}
					>
						<p className="flex items-baseline justify-between gap-2">
							<span className="font-semibold text-ink">
								{p.phase} · {p.name}
							</span>
							{p.phase === current ? <span className="text-xs font-semibold text-green-700">Current</span> : null}
						</p>
						{p.terminal ? (
							<>
								<p className="mt-2 text-sm text-text-3">The last phase. No exit criteria.</p>
								<ul className="mt-2 flex flex-col gap-1 text-sm text-ink-2">
									{POST_LAUNCH_MEASURES.map((m) => (
										<li key={m.key} className="flex gap-2">
											<span aria-hidden="true" className="mt-2 size-1 flex-none rounded-full bg-text-3" />
											<span>
												{m.label}
												<span className="text-text-3"> · Not measured</span>
											</span>
										</li>
									))}
								</ul>
							</>
						) : (
							<ul className="mt-2 flex flex-col gap-1 text-sm text-ink-2">
								{p.criteria.map((x) => (
									<li key={x.key} className="flex gap-2">
										<span aria-hidden="true" className="mt-2 size-1 flex-none rounded-full bg-text-3" />
										<span>
											{x.label}
											{x.softwareOnly ? <span className="text-text-3"> · Everyfield checklist</span> : null}
										</span>
									</li>
								))}
							</ul>
						)}
					</li>
				))}
			</ol>
		</Card>
	);
}

const phaseOptions = (catalog: Catalog, current?: PhaseNumber) =>
	catalog.phases.map((p) => ({
		value: String(p.phase),
		label: `Phase ${p.phase} · ${p.name}${p.phase === current ? " (current)" : ""}`,
	}));

function MoveDialog({
	draft,
	current,
	catalog,
	readiness,
	onChange,
	onSubmit,
}: {
	draft: MoveDraft;
	current: PhaseNumber;
	catalog: Catalog;
	readiness: Readiness;
	onChange: (draft: MoveDraft | null) => void;
	onSubmit: (draft: MoveDraft) => void;
}) {
	return (
		<Dialog open onOpenChange={(next) => (next ? null : onChange(null))}>
			<DialogContent>
				<DialogHeader
					title="Change phase"
					description="Move forward, back or to any phase. Your reason stays on the journey."
				/>
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit(draft);
					}}
				>
					<DialogBody className="flex flex-col gap-5">
						{draft.changed ? (
							<div role="alert" className="flex gap-3 rounded-md bg-amber-100 px-4 py-3 text-sm text-ink">
								<Icon icon={Alert02Icon} size={18} className="mt-0.5 flex-none text-amber-600" />
								<p>
									Someone changed this church while you were reviewing. It is now in Phase {draft.changed.phase} ·{" "}
									{catalog.phases[draft.changed.phase]!.name}. Your reason is kept. Check the move and try again.
								</p>
							</div>
						) : null}
						<Field label="Move to">
							<Select
								value={String(draft.to)}
								onValueChange={(v) => onChange({ ...draft, to: Number(v) as PhaseNumber })}
								options={phaseOptions(catalog, current)}
							/>
						</Field>
						{readiness.verdict !== "terminal" && !readiness.ready ? (
							<div className="rounded-md bg-surface-2 px-4 py-3 text-sm">
								<p className="font-semibold text-ink">
									Advisory: Phase {current} is {readiness.measured ? "not ready yet" : "not measured yet"}
								</p>
								<ul className="mt-2 flex flex-col gap-1.5">
									{readiness.criteria.map((x) => (
										<li key={x.key} className="flex items-center justify-between gap-3 text-ink-2">
											<span>{x.label}</span>
											<StatusBadge size="sm" status={STATUS[x.status].status}>
												{STATUS[x.status].label}
											</StatusBadge>
										</li>
									))}
								</ul>
								<p className="mt-2 text-text-3">You can still move. Nothing moves on its own.</p>
							</div>
						) : null}
						<Field
							label="Reason"
							hint="Up to 2,000 characters. Owners and Admins see it on the journey."
							error={draft.error}
						>
							<Textarea
								value={draft.reason}
								onChange={(event) => onChange({ ...draft, reason: event.target.value, error: null })}
								rows={3}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onChange(null)}>
							Cancel
						</Button>
						<Button type="submit" variant="primary">
							Move to Phase {draft.to}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function DeclareDialog({
	to,
	catalog,
	onChange,
	onSubmit,
}: {
	to: PhaseNumber;
	catalog: Catalog;
	onChange: (to: PhaseNumber | null) => void;
	onSubmit: (to: PhaseNumber) => void;
}) {
	return (
		<Dialog open onOpenChange={(next) => (next ? null : onChange(null))}>
			<DialogContent size="sm">
				<DialogHeader
					title="Declare your current phase"
					description="For a church that was already on its journey when it joined Everyfield. You can do this once."
				/>
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmit(to);
					}}
				>
					<DialogBody className="flex flex-col gap-4">
						<Field label="Current phase" hint="Earlier phases are not filled in. The journey starts here.">
							<Select
								value={String(to)}
								onValueChange={(v) => onChange(Number(v) as PhaseNumber)}
								options={phaseOptions(catalog)}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => onChange(null)}>
							Cancel
						</Button>
						<Button type="submit" variant="primary">
							Declare Phase {to}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
