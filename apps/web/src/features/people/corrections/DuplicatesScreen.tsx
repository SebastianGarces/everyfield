"use client";

import {
	Alert02Icon,
	ArrowLeftRightIcon,
	GitMergeIcon,
	InformationCircleIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	buttonVariants,
	CalloutLabel,
	CalloutText,
	Card,
	CardHeader,
	CardHeading,
	CardTitle,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	IntentLink,
	PageHeader,
	Radio,
	RadioGroup,
	StatePanel,
} from "@everyfield/ui/controls";
import { Avatar, KeyValue, KeyValueList, StageChip, StatusBadge } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { keyFor, STAGE_KEY, STAGE_LABEL, type KeyedPayload, type Outcome, type StageValue } from "../model.ts";
import { fresh, LocalDay, When } from "../parts.tsx";
import { mergeDestination, mergePair, reviewPair, type Merged } from "./actions.ts";
import {
	blockerText,
	counted,
	defaultChoices,
	FIELD_LABEL,
	fieldText,
	kindTitle,
	listText,
	pairHref,
	referenceGroups,
	sourceChoices,
	type Columns,
	type MergeField,
	type Side,
} from "./model.ts";
import { Problem } from "./parts.tsx";
import type { PairView } from "./server.ts";

type Ready = Extract<PairView, { kind: "ready" }>;
type Review = Ready["review"];
export type PairQuery = { person: string; with: string; keep: string | null };
type Done = { merged: Pick<Merged, "moved" | "survivorId" | "sourceId">; source: string; survivor: string };

const first = (name: string) => name.split(" ")[0] ?? name;
const crumbs = [{ label: "People", href: "/people" }, { label: "Possible duplicate" }];

/**
 * Duplicate review and merge (REQ-PPL-016, 017, 025; prototype #/people/duplicates). The review shows both people side
 * by side: every differing field with both values to choose from, the stage and commitment the survivor keeps, what
 * moves, what stays and anything that blocks the merge. Nothing merges without the confirm dialog, and the result names
 * what moved and the way back (Unmerge in the survivor's Activity).
 */
export function DuplicatesScreen({ initial, query }: { initial: PairView; query: PairQuery }) {
	const [view, setView] = useState<PairView>(initial);
	const [done, setDone] = useState<Done | null>(null);
	/** A problem the page shows after the dialog closed, with a key so a repeat problem takes focus again. */
	const [notice, setNotice] = useState<{ n: number; text: string } | null>(null);
	const [loading, setLoading] = useState(false);
	// Each review request carries a number; an answer to an older request never replaces a newer one.
	const seq = useRef(0);

	async function load(keep: string | null, then?: string) {
		const n = ++seq.current;
		setLoading(true);
		const r: Outcome<PairView> = await reviewPair({ ...query, keep }).catch(() => ({ status: "lost" }) as const);
		if (n !== seq.current) return;
		setLoading(false);
		if (r.status === "ok") {
			setView(r.value);
			if (r.value.kind === "ready")
				window.history.replaceState(null, "", pairHref(query.person, query.with, keep ?? undefined));
			setNotice(then ? { n, text: then } : null);
		} else
			setNotice({
				n,
				text:
					r.status === "lost"
						? "The review did not load again. Nothing was merged by this. Try again in a moment."
						: "You cannot review these people. Your seat may have changed; reload the page.",
			});
	}

	if (done) return <Result done={done} />;
	return (
		<>
			<PageHeader
				title="Possible duplicate"
				breadcrumb={crumbs}
				subtitle="EveryField never merges on its own. You choose which details to keep."
			/>
			{notice ? (
				<div className="mb-5" key={notice.n}>
					<Problem>{notice.text}</Problem>
				</div>
			) : null}
			{view.kind === "ready" ? (
				<PairReview
					key={view.review.reviewDigest}
					view={view}
					loading={loading}
					onKeep={(id, why) => load(id, why)}
					onDone={setDone}
					onStale={(text) => load(view.review.survivor.personId, text)}
				/>
			) : view.kind === "merged" ? (
				<Card>
					<StatePanel
						title={`${view.source.name} was already merged into ${view.survivor.name}`}
						icon={GitMergeIcon}
						actions={
							<IntentLink href={`/people/${view.survivor.id}`} className={buttonVariants({ variant: "primary" })}>
								Open {view.survivor.name}
							</IntentLink>
						}
					>
						Links to {view.source.name} open {view.survivor.name}. If the merge was a mistake, use Review Unmerge on the
						merge in {first(view.survivor.name)}&rsquo;s Activity.
					</StatePanel>
				</Card>
			) : view.kind === "unavailable" ? (
				<Card>
					<StatePanel
						title="There is no pair to review here"
						actions={
							<IntentLink href="/people" className={buttonVariants({ variant: "primary" })}>
								Back to People
							</IntentLink>
						}
					>
						One of these people may be retired or merged, or the link is old. Possible duplicates show on each
						person&rsquo;s page.
					</StatePanel>
				</Card>
			) : (
				<Card>
					<StatePanel
						tone="error"
						title="The review did not load"
						actions={
							<Button variant="primary" loading={loading} onClick={() => load(query.keep)}>
								Try again
							</Button>
						}
					>
						This is a loading problem. Nothing was merged. Try again in a moment.
					</StatePanel>
				</Card>
			)}
		</>
	);
}

function PairReview({
	view,
	loading,
	onKeep,
	onDone,
	onStale,
}: {
	view: Ready;
	loading: boolean;
	/** Review the pair again with `personId` as the person who stays; `why` is shown when it is a refusal's answer. */
	onKeep: (personId: string, why?: string) => void;
	onDone: (done: Done) => void;
	/** The reviewed state is out of date: read it again and say why. */
	onStale: (why: string) => void;
}) {
	const { review } = view;
	const source = review.source,
		survivor = review.survivor;
	const names = { source: source.displayName, survivor: survivor.displayName };
	const [choices, setChoices] = useState(() => defaultChoices(review.fields as Field[]));
	const [confirming, setConfirming] = useState(false);
	const intent = useRef<Intent>({ payload: null, lost: false });
	const groups = referenceGroups(review.references);
	const blocked = review.blockers.causes.length > 0;
	const fromSource = (review.fields as Field[]).filter((f) => choices[f.field] === "source").map((f) => f.field);
	const stageMoves = review.stage && review.stage.result !== review.stage.survivor;
	// Two records with one name: name the swap by record, not by a name that fits both.
	const swapLabel =
		source.displayName === survivor.displayName
			? "Keep the other record instead"
			: `Keep ${source.displayName} instead`;

	return (
		<div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-5 max-app-lg:grid-cols-1">
			<Card as="section" aria-labelledby="pair-title">
				<h2 id="pair-title" className="sr-only">
					{survivor.displayName} and {source.displayName}
				</h2>
				<div className="grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-line pb-3.5 max-app-sm:grid-cols-2">
					<span className="max-app-sm:hidden" />
					<PersonHead
						person={survivor}
						added={view.added[survivor.personId]}
						stage={review.stage?.survivor}
						role="Stays"
					/>
					<PersonHead
						person={source}
						added={view.added[source.personId]}
						stage={review.stage?.source}
						role="Merges in"
					/>
				</div>
				<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
					<p className="text-sm text-text-3">
						{review.fields.length
							? `Choose which details ${first(survivor.displayName)} keeps.`
							: "Both records have the same details."}
					</p>
					<Button
						variant="ghost"
						size="sm"
						icon={ArrowLeftRightIcon}
						loading={loading}
						onClick={() => onKeep(source.personId)}
					>
						{swapLabel}
					</Button>
				</div>
				<div className="mt-2 flex flex-col">
					{(review.fields as Field[]).map((f) => (
						<FieldRow
							key={f.field}
							field={f}
							view={view}
							value={choices[f.field] ?? "survivor"}
							onChange={(side) => setChoices((c) => ({ ...c, [f.field]: side }))}
						/>
					))}
				</div>
				{review.stage || review.commitment ? (
					<KeyValueList className="mt-3 border-t border-line pt-1">
						{review.stage ? (
							<KeyValue
								size="sm"
								k="Stage"
								value={
									<span className="flex flex-wrap items-center justify-end gap-2">
										<StageChip stage={STAGE_KEY[review.stage.result]}>{STAGE_LABEL[review.stage.result]}</StageChip>
										<span className="font-normal text-text-3">the later of the two</span>
									</span>
								}
							/>
						) : null}
						{review.commitment && review.commitment.result !== "unknown" ? (
							<KeyValue
								size="sm"
								k="Commitment"
								value={
									<span className="flex flex-wrap items-center justify-end gap-2">
										<StatusBadge status={review.commitment.result === "active" ? "positive" : "unknown"} size="sm">
											{review.commitment.result === "active" ? "Committed" : "Withdrawn"}
										</StatusBadge>
										{review.commitment.effectiveOn ? (
											<span className="font-normal text-text-3">
												since <LocalDay day={review.commitment.effectiveOn} />
											</span>
										) : null}
									</span>
								}
							/>
						) : null}
					</KeyValueList>
				) : null}
				<Card variant="callout" tone="blue" className="mt-5">
					<CalloutLabel tone="blue" icon={InformationCircleIcon}>
						You can unmerge later
					</CalloutLabel>
					<CalloutText className="text-sm">
						After merging, links to {source.displayName} open {survivor.displayName}. If this was a mistake, Review
						Unmerge in {first(survivor.displayName)}&rsquo;s Activity brings {first(source.displayName)} back.
						EveryField shows what goes back first, and stops if a later change depends on the merge.
					</CalloutText>
				</Card>
			</Card>

			<div className="flex min-w-0 flex-col gap-5">
				<Card size="sm" as="section" aria-labelledby="moves-title">
					<CardHeader className="mb-1">
						<CardHeading>
							<CardTitle size="sm" id="moves-title">
								What moves to {first(survivor.displayName)}
							</CardTitle>
						</CardHeading>
					</CardHeader>
					{groups.moves.length || groups.blocked.length ? (
						<ul className="flex flex-col">
							{[...groups.moves, ...groups.blocked].map((r) => (
								<li
									key={r.kind}
									className="flex items-center justify-between gap-3 border-t border-line py-2.5 text-sm first:border-t-0"
								>
									<span className="text-text-2">
										{kindTitle(r.kind)}
										{r.treatment === "block" ? <span className="text-magenta-600"> · cannot move yet</span> : null}
									</span>
									<span className="font-semibold text-ink tabular-nums">{r.count}</span>
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-text-3">{source.displayName} has no records to move.</p>
					)}
					{groups.moves.some((r) => r.treatment === "deduplicate") ? (
						<p className="mt-2 text-xs text-text-3">Tags they both have are kept once.</p>
					) : null}
					{groups.stays.length ? (
						<p className="mt-3 text-xs text-text-3">
							Stays in {first(source.displayName)}&rsquo;s history:{" "}
							{listText(groups.stays.map((r) => counted(r.kind, r.count)))}.
						</p>
					) : null}
				</Card>
				<Card size="sm" as="section" aria-labelledby="blockers-title">
					{blocked ? (
						<>
							<div id="blockers-title">
								<CalloutLabel tone="magenta" icon={Alert02Icon}>
									This merge cannot run
								</CalloutLabel>
							</div>
							<ul className="mt-2 flex flex-col gap-2 text-sm text-ink-2">
								{review.blockers.causes.map((cause) => (
									<li key={cause} className="text-pretty">
										{blockerText(cause, names, review.blockers.references)}
										{cause === "linked_source" ? (
											<Button
												variant="secondary"
												size="sm"
												className="mt-2"
												icon={ArrowLeftRightIcon}
												loading={loading}
												onClick={() => onKeep(source.personId)}
											>
												{swapLabel}
											</Button>
										) : null}
									</li>
								))}
							</ul>
						</>
					) : (
						<>
							<div id="blockers-title">
								<CalloutLabel tone="green" icon={Tick02Icon}>
									Nothing blocks this merge
								</CalloutLabel>
							</div>
							<p className="mt-2 text-sm text-text-2">
								Account links, note authorship and history never move. A merge stops if both people have an account or
								if a record cannot move yet.
							</p>
						</>
					)}
				</Card>
				<div className="flex gap-2 max-app-sm:flex-col-reverse">
					<IntentLink
						href={`/people/${survivor.personId}`}
						className={cn(buttonVariants({ variant: "secondary" }), "flex-1")}
					>
						Keep both
					</IntentLink>
					<Button
						variant="primary"
						className="flex-1"
						icon={GitMergeIcon}
						disabled={blocked || loading}
						onClick={() => setConfirming(true)}
					>
						Merge
					</Button>
				</div>
			</div>

			{confirming ? (
				<ConfirmMerge
					review={review}
					fromSource={fromSource}
					fieldChoices={sourceChoices(choices)}
					stageTo={stageMoves && review.stage ? review.stage.result : null}
					intentRef={intent}
					onClose={() => setConfirming(false)}
					onDone={onDone}
					onStale={(why) => {
						setConfirming(false);
						onStale(why);
					}}
				/>
			) : null}
		</div>
	);
}

type Field = { field: MergeField; source: Columns; survivor: Columns };
type Intent = { payload: KeyedPayload | null; lost: boolean };

function PersonHead({
	person,
	added,
	stage,
	role,
}: {
	person: Review["source"];
	added: string | undefined;
	stage: StageValue | undefined;
	role: "Stays" | "Merges in";
}) {
	return (
		<div className="flex min-w-0 items-start gap-3">
			<Avatar name={person.displayName} decorative tone={role === "Stays" ? "amber" : "ink"} />
			<div className="min-w-0 flex-1">
				<IntentLink
					href={`/people/${person.personId}`}
					className="block truncate font-semibold text-ink underline-offset-2 hover:underline"
				>
					{person.displayName}
				</IntentLink>
				<p className="text-xs text-text-3">
					{added ? (
						<>
							Added <When at={added} />
						</>
					) : null}
					{stage ? ` · ${STAGE_LABEL[stage]}` : null}
				</p>
				<span className="mt-1.5 inline-flex items-center gap-1.5">
					<StatusBadge status={role === "Stays" ? "positive" : "unknown"} size="sm">
						{role}
					</StatusBadge>
					{person.linkedAccount ? (
						<StatusBadge status="measured" size="sm">
							Has an account
						</StatusBadge>
					) : null}
				</span>
			</div>
		</div>
	);
}

/** One differing field: a labelled radio group with both values. Arrow keys move the choice. */
function FieldRow({
	field,
	view,
	value,
	onChange,
}: {
	field: Field;
	view: Ready;
	value: Side;
	onChange: (side: Side) => void;
}) {
	const id = `field-${field.field}`;
	const option = (side: Side) => {
		const shown = fieldText(field.field, field[side], view.households);
		const photo = field.field === "photo" ? view.photos[side] : undefined;
		const name = view.review[side].displayName;
		return (
			<Radio
				value={side}
				aria-label={`${FIELD_LABEL[field.field]} from ${name}: ${shown ?? "none"}`}
				className="min-h-[46px] items-center rounded-card bg-surface-raised px-3.5 py-2.5 shadow-[inset_0_0_0_1px_var(--ef-line)] has-[[data-state=checked]]:shadow-[0_0_0_2px_var(--ef-ink)]"
				label={
					<span className="flex min-w-0 items-center gap-2.5">
						{photo ? <Avatar name={name} src={photo} size="sm" decorative /> : null}
						<span
							className={cn(
								"line-clamp-3 min-w-0 [overflow-wrap:anywhere]",
								shown === null ? "text-text-3" : "text-ink",
							)}
						>
							{shown === null ? "None" : field.field === "birthDate" ? <LocalDay day={shown} /> : shown}
						</span>
					</span>
				}
			/>
		);
	};
	return (
		<div className="grid grid-cols-[110px_minmax(0,2fr)] items-center gap-3 py-2 max-app-sm:grid-cols-1 max-app-sm:gap-1.5">
			<span id={id} className="text-sm text-text-3">
				{FIELD_LABEL[field.field]}
			</span>
			<RadioGroup
				aria-labelledby={id}
				orientation="horizontal"
				value={value}
				onValueChange={(v) => onChange(v as Side)}
				className="grid grid-cols-2 gap-3 max-app-sm:gap-2"
			>
				{option("survivor")}
				{option("source")}
			</RadioGroup>
		</div>
	);
}

/**
 * The merge confirmation. One request key per reviewed merge: a retry after a lost answer sends the same key, so the
 * server replays a merge that did happen. A refusal after a lost answer first asks where the source's links lead, so
 * the screen never says a merge failed when it went through.
 */
function ConfirmMerge({
	review,
	fromSource,
	fieldChoices,
	stageTo,
	intentRef,
	onClose,
	onDone,
	onStale,
}: {
	review: Review;
	fromSource: MergeField[];
	fieldChoices: ReturnType<typeof sourceChoices>;
	stageTo: StageValue | null;
	/** This review's merge intent: its request key and whether an answer was lost. It outlives the dialog. */
	intentRef: { current: Intent };
	onClose: () => void;
	onDone: (done: Done) => void;
	onStale: (why: string) => void;
}) {
	const source = review.source.displayName,
		survivor = review.survivor.displayName;
	const [pending, setPending] = useState(false);
	const [problem, setProblem] = useState<{ n: number; text: string; retry?: boolean } | null>(null);
	/** Shows a problem; each one gets a new number, so a repeat of the same words still takes focus. */
	const say = (p: { text: string; retry?: boolean }) => setProblem((old) => ({ ...p, n: (old?.n ?? 0) + 1 }));
	const moves = referenceGroups(review.references).moves;
	const done = (moved: Merged["moved"]) =>
		onDone({
			merged: { moved, sourceId: review.source.personId, survivorId: review.survivor.personId },
			source,
			survivor,
		});

	async function merge() {
		const input = {
			sourceId: review.source.personId,
			survivorId: review.survivor.personId,
			reviewDigest: review.reviewDigest,
			fieldChoices,
		};
		const sent = keyFor(intentRef.current.payload, input, fresh);
		intentRef.current.payload = sent;
		const key = intentRef.current;
		setPending(true);
		setProblem(null);
		const r: Outcome<Merged> = await mergePair(sent.key, input).catch(() => ({ status: "lost" }) as const);
		if (r.status === "ok") return done(r.value.moved);
		if (r.status === "lost") {
			key.lost = true;
			setPending(false);
			return say({
				retry: true,
				text: "We did not hear back from the server, so the merge may have happened. Try again; it will not merge twice.",
			});
		}
		key.payload = null;
		if (key.lost) {
			// An earlier attempt's answer was lost. It may have merged them: check before saying anything.
			const d = await mergeDestination(review.source.personId).catch(() => ({ status: "lost" }) as const);
			if (d.status === "ok" && d.value.status === "merged" && d.value.destinationId === review.survivor.personId)
				return done(moves.map(({ kind, count }) => ({ kind, count })));
		}
		setPending(false);
		if (r.code === "conflict")
			return onStale(
				"One of these people changed while you reviewed them. The review now shows their current details. Check it, then merge again.",
			);
		if (r.code === "merge_blocked") return onStale("This merge cannot run now. The review below says what blocks it.");
		if (r.code === "unavailable")
			return onStale("One of these people is no longer available to merge. The page now shows where they stand.");
		say({ text: "You cannot merge these people. Your seat may have changed; reload the page." });
	}

	return (
		<Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
			<DialogContent size="sm" aria-busy={pending || undefined}>
				<DialogHeader icon={GitMergeIcon} tone="blue" title={`Merge ${source} into ${survivor}?`} />
				<DialogBody className="flex flex-col gap-4">
					<ul className="flex flex-col gap-2 rounded-md bg-surface px-5 py-4 text-text-2">
						<Point>
							{survivor} stays. Links to {source} will open {survivor}.
						</Point>
						{fromSource.length ? (
							<Point>
								From {source}: {listText(fromSource.map((f) => FIELD_LABEL[f].toLowerCase()))}.
							</Point>
						) : null}
						<Point>
							{moves.length
								? `Moves to ${first(survivor)}: ${listText(moves.map((m) => counted(m.kind, m.count)))}.`
								: `${source} has no records to move.`}
						</Point>
						{stageTo ? (
							<Point>
								{first(survivor)}&rsquo;s stage becomes {STAGE_LABEL[stageTo].toLowerCase()}.
							</Point>
						) : null}
					</ul>
					<p className="text-sm">
						You can undo this with Review Unmerge in {first(survivor)}&rsquo;s Activity, while nothing that depends on
						the merge has changed.
					</p>
					{problem ? <Problem key={problem.n}>{problem.text}</Problem> : null}
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" disabled={pending} onClick={onClose}>
						Cancel
					</Button>
					<Button variant="primary" loading={pending} onClick={merge}>
						{problem?.retry ? "Try again" : "Merge"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function Point({ children }: { children: ReactNode }) {
	return (
		<li className="flex gap-2.5">
			<span aria-hidden="true" className="mt-[9px] size-1.5 flex-none rounded-full bg-text-3" />
			<span className="text-pretty">{children}</span>
		</li>
	);
}

/** The merge result: what moved, a link to the survivor and the way back. Focus moves to its heading. */
function Result({ done }: { done: Done }) {
	const ref = useRef<HTMLHeadingElement>(null);
	useEffect(() => ref.current?.focus(), []);
	const { merged } = done;
	return (
		<>
			<PageHeader title="Merged" breadcrumb={[{ label: "People", href: "/people" }, { label: "Merged" }]} />
			<Card variant="callout" tone="green" role="status" className="max-w-[640px]">
				<CalloutLabel tone="green" icon={Tick02Icon}>
					Merged
				</CalloutLabel>
				<h2 ref={ref} tabIndex={-1} className="mt-3 font-title text-title-md text-ink outline-none">
					{done.source} is now part of {done.survivor}
				</h2>
				<CalloutText className="text-sm">
					Links to {done.source} open {done.survivor}.{" "}
					{merged.moved.length
						? `${listText(merged.moved.map((m) => counted(m.kind, m.count)))} moved to ${first(done.survivor)}.`
						: "No records needed to move."}
				</CalloutText>
				<p className="mt-3 text-sm text-text-3">
					To undo it, open {first(done.survivor)}&rsquo;s Activity and choose Review Unmerge on this merge.
				</p>
				<div className="mt-5 flex flex-wrap gap-2.5 max-app-sm:*:flex-1">
					<IntentLink href={`/people/${merged.survivorId}`} className={buttonVariants({ variant: "primary" })}>
						Open {done.survivor}
					</IntentLink>
					<IntentLink href="/people" className={buttonVariants({ variant: "secondary" })}>
						Back to People
					</IntentLink>
				</div>
			</Card>
		</>
	);
}
