"use client";

import {
	Alert02Icon,
	ArrowRight02Icon,
	Calendar03Icon,
	Location01Icon,
	Briefcase01Icon,
	CheckListIcon,
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	Edit02Icon,
	FileImportIcon,
	Home01Icon,
	Image01Icon,
	Mail01Icon,
	Notification01Icon,
	ImageNotFound01Icon,
	Mortarboard01Icon,
	StartUp02Icon,
	SquareLock02Icon,
	Tag01Icon,
	Tick02Icon,
	UserAdd01Icon,
	UserGroupIcon,
	UserIcon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	Checkbox,
	Field,
	Input,
	IntentLink,
	Select,
	Skeleton,
	Spinner,
	Textarea,
} from "@everyfield/ui/controls";
import { Avatar, StageChip } from "@everyfield/ui/display";
import { cn, focusOnMount, Icon, useFocusRequest, type IconSvgElement } from "@everyfield/ui/foundations";
import { useRouter } from "next/navigation";
import {
	useCallback,
	useId,
	useRef,
	useState,
	useSyncExternalStore,
	type FormEvent,
	type ReactNode,
	type Ref,
} from "react";
import { STAGE_KEY, type StageValue } from "../../people/model.ts";
import * as api from "./api.ts";
import { MAIL_CONSEQUENCE, MailChanges, MailResult } from "./MailChanges.tsx";
import { NoticeChanges } from "./NoticeChanges.tsx";
import { CurrentState, ImportResult, ImportRows, PeopleResult, ReviewedPeople } from "./PeopleChanges.tsx";
import {
	addsOnly,
	asksReason,
	approvable,
	CHOICES,
	checkable,
	emptyText,
	clock,
	consequence,
	carryOver,
	carryOverText,
	editableChanges,
	fieldKind,
	fieldLabel,
	hasBirthDate,
	isMail,
	isMeetings,
	isNotification,
	isTeams,
	isRequired,
	MAIL_DISMISSED,
	mailHead,
	launchRefusalText,
	mailRefusalText,
	missingRequired,
	operationTitle,
	peopleResult,
	phaseOf,
	photoRef,
	refusalText,
	isLaunch,
	isPipeline,
	isSettings,
	pipelineLink,
	pipelineRefusalText,
	savedPhotoSrc,
	settingsLink,
	settingsRefusalText,
	retryable,
	reviseInput,
	SHARE_CHOICES,
	shownChanges,
	valueText,
	type Change,
	type Phase,
	type Review,
} from "./model.ts";
import { NativeImage } from "@/components/native";
import { useLocalStore } from "@/components/store";
import { createReviewStore, lapsedOf, uploadOf, type Action, type Notice } from "./ReviewCard.store.ts";

type View = Phase | "loading" | "lost" | "unavailable" | "photo_unavailable" | "unknown";

const shownSeeds = new WeakSet<Review>();
const shownUnavailable = new Set<string>();

function firstShow(proposalId: string, seed: Review | null | undefined): Review | null | undefined {
	if (seed === undefined) return undefined;
	const shown = seed ? shownSeeds.has(seed) : shownUnavailable.has(proposalId);
	if (seed) shownSeeds.add(seed);
	else shownUnavailable.add(proposalId);
	return shown ? undefined : seed;
}

function useReview(proposalId: string, seed: Review | null | undefined) {
	const router = useRouter();
	const store = useLocalStore(() =>
		createReviewStore({
			id: proposalId,
			seed: firstShow(proposalId, seed),
			port: { ...api, refresh: () => router.refresh() },
		}),
	);
	const state = useSyncExternalStore(store.getState().actions.follow, store.getState, store.getState);
	const { review, load, photo, outcome, actions } = state;
	const lapsed = lapsedOf(state);
	const view: Exclude<View, "photo_unavailable" | "unknown"> =
		load === "ready" && review ? phaseOf(review, lapsed) : load === "ready" ? "loading" : load;
	const upload = uploadOf(review);
	const mine = photo && photo.upload === upload ? photo : null;
	const staged: StagedPhoto = mine ?? { status: view === "pending" && upload !== null ? "loading" : "idle" };
	return { ...actions, ...outcome, review, view, busy: state.busy, lapsed, staged };
}

const UNKNOWN_TEXT: Record<Action, string> = {
	approve:
		"Evry got no answer to your approval, so it may already be saved. Check again to find out. Checking never saves it twice.",
	revise: "Evry got no answer to your update, so it may already be saved. Check again to find out.",
	cancel: "Evry got no answer to your cancel, so this change may already be cancelled. Check again to find out.",
	retry: "Evry got no answer when it tried again, so the change may already be running. Check again to find out.",
	recheck: "Evry got no answer from the email service. Check again.",
};

type StagedPhoto = { status: "idle" | "loading" | "gone" | "lost" } | { status: "ready"; src: string };

type Tone = "amber" | "green" | "magenta" | "gray";
const HEAD: Record<Exclude<View, "loading" | "lost">, { icon: IconSvgElement; title: string; tone: Tone }> = {
	pending: { icon: Edit02Icon, title: "Review before saving", tone: "amber" },
	running: { icon: Edit02Icon, title: "Saving…", tone: "amber" },
	completed: { icon: CheckmarkCircle02Icon, title: "Saved", tone: "green" },
	refused: { icon: Alert02Icon, title: "Not saved", tone: "magenta" },
	unconfirmed: { icon: Alert02Icon, title: "Not confirmed", tone: "magenta" },
	expired: { icon: Clock01Icon, title: "Expired", tone: "gray" },
	cancelled: { icon: Cancel01Icon, title: "Cancelled", tone: "gray" },
	withheld: { icon: SquareLock02Icon, title: "No longer available", tone: "gray" },
	unknown: { icon: Alert02Icon, title: "Not confirmed", tone: "amber" },
	photo_unavailable: { icon: ImageNotFound01Icon, title: "Photo not available", tone: "gray" },
	unavailable: { icon: SquareLock02Icon, title: "Not available to you", tone: "gray" },
};
const HEAD_TONE: Record<Tone, string> = {
	amber: "bg-amber-50 text-amber-600 border-b-[color-mix(in_srgb,var(--ef-amber-500)_20%,transparent)]",
	green: "bg-green-50 text-green-700 border-b-[color-mix(in_srgb,var(--ef-green-500)_20%,transparent)]",
	magenta: "bg-magenta-50 text-magenta-600 border-b-[color-mix(in_srgb,var(--ef-magenta-500)_20%,transparent)]",
	gray: "bg-surface-2 text-text-2 border-b-line",
};

function note(view: View, review: Review | null, lapsed: boolean, unknown?: Action): string | null {
	const who = review?.review.target?.label ?? null;
	const mail = !!review && isMail(review.operation);
	if (review && view === "pending" && review.review.refusal) return review.review.refusal;
	if (mail) {
		if (view === "pending" && review.stale)
			return "This message changed since the review. Nothing was changed. Review it again to see it as it is now.";
		if (view === "expired") return "This review expired, so nothing was done. Review required: prepare it again.";
		if (view === "unconfirmed")
			return retryable(review, lapsed)
				? "Evry can't confirm what happened. Try again. A change the email service already holds is not made twice."
				: "Evry can't confirm what happened, and the approval expired, so this card can't try again. Open Messages to see this message.";
		if (view === "running") return "Working in the background. This card shows what the email service confirms.";
		if (view === "cancelled") return MAIL_DISMISSED[review.operation] ?? null;
		if (view === "withheld")
			return review.status === "approved"
				? "The message in this change is no longer available to you, so Evry can't show this change or its result."
				: "The message in this change is no longer available to you. Nothing was changed.";
	}
	switch (view) {
		case "pending":
			if (review?.review.refusal) return review.review.refusal;
			return review && review.revision > 1
				? `You revised this change. Only revision ${review.revision} can be approved.`
				: null;
		case "running":
			return "Saving in the background. You can keep working. This card shows the result.";
		case "refused":
			if (review && isPipeline(review.operation))
				return pipelineRefusalText(review.receipt?.code, review.operation, who);
			if (review && isLaunch(review.operation)) return launchRefusalText(review.receipt?.code);
			if (review?.receipt?.current?.length)
				return `A record in the ${who ?? "change"} changed after Evry prepared this, so it couldn't be applied and nothing was changed for anyone. This is how they are now. Ask Evry to prepare it again.`;
			return mail
				? mailRefusalText(review.receipt?.code)
				: review && isSettings(review.operation)
					? settingsRefusalText(review.receipt?.code)
					: refusalText(review?.receipt?.code, who, !!review && isMeetings(review.operation));
		case "unconfirmed":
			return review && retryable(review, lapsed)
				? "Evry can't confirm that this was saved. Try again. A change that was saved is not saved twice."
				: "Evry can't confirm that this was saved, and the approval expired. Open the person to check.";
		case "unknown":
			return UNKNOWN_TEXT[unknown ?? "approve"];
		case "photo_unavailable":
			return review?.operation === "account.finalizeAvatar"
				? "The attached photo is no longer available, so you can't approve this change. Nothing was changed. Attach it again and ask Evry."
				: `The uploaded photo is no longer available, so you can't approve this change. Nothing was changed. Upload the photo again on ${who ?? "the person"}'s page.`;
		case "expired":
			return review && reviseInput(review) === null
				? "This review expired, so nothing was changed. Ask Evry to prepare it again."
				: "This review expired, so nothing was changed. Prepare it again to check the current values.";
		case "cancelled":
			return "You cancelled this change. Nothing was changed.";
		case "withheld":
			return review?.status === "approved"
				? "The person in this change is no longer available to you, so Evry can't show this change or its result."
				: "The person in this change is no longer available to you. Nothing was changed.";
		case "unavailable":
			return "You can't see this change now, so Evry can't show its result. Changes like this need an Owner or Admin seat in this church.";
		default:
			return null;
	}
}

function announcement(view: View, review: Review | null, lapsed: boolean, unknown?: Action) {
	const head =
		view === "loading" || view === "lost"
			? ""
			: ((review && mailHead(review, view)?.title) ?? HEAD[view].title).replace("…", "");
	if (view === "pending" && !(review && review.revision > 1)) return "";
	if (view === "running") return "Approved. Saving in the background.";
	if (view === "completed" && review && isMail(review.operation)) return mailHead(review, "completed")!.title;
	if (view === "completed" && review && peopleResult(review)) return `${peopleResult(review)}.`;
	if (view === "completed" && review?.receipt?.import) return "Import saved.";
	if (view === "completed")
		return review?.review.target ? `Saved. ${review.review.target.label} is updated.` : "Saved.";
	return [head, note(view, review, lapsed, unknown)].filter(Boolean).join(". ");
}

export function ReviewCard({
	proposalId,
	target,
	seed,
}: {
	proposalId: string;
	target: string | null;
	seed?: Review | null;
}) {
	const r = useReview(proposalId, seed);
	const [reason, setReason] = useState("");
	const [editing, setEditing] = useState<number | null>(null);
	const [closes, setCloses] = useState(0);
	const headId = useId();
	const focusInside = useRef(false);
	const { review, notice, staged } = r;
	const photoGone =
		staged.status === "gone" || (r.refused?.code === "photo_unavailable" && r.refused.revision === review?.revision);
	const unknown = r.unknown && r.unknown.revision === review?.revision ? r.unknown.action : undefined;
	const view: View = unknown ? "unknown" : r.view === "pending" && photoGone ? "photo_unavailable" : r.view;

	const mailTitle = review ? mailHead(review, view) : null;
	const key = `${view}:${review?.revision ?? 0}:${mailTitle?.title ?? ""}`;
	const [said, setSaid] = useState({ key, text: "" });
	if (said.key !== key)
		setSaid({ key, text: said.key.startsWith("loading") ? "" : announcement(view, review, r.lapsed, unknown) });
	const keepFocus = useCallback((node: HTMLHeadingElement) => {
		const active = node.ownerDocument.activeElement;
		const card = node.closest("section");
		return focusInside.current && (!active || active === node.ownerDocument.body || !card?.contains(active))
			? node
			: null;
	}, []);
	const headRef = useFocusRequest(key, keepFocus);
	const reviseRef = useFocusRequest<HTMLButtonElement>(closes);

	const why = note(view, review, r.lapsed, unknown);
	const base = view === "loading" || view === "lost" ? HEAD.pending : HEAD[view];
	const icon =
		mailTitle &&
		((view === "completed" && mailTitle.tone !== "green") || (view === "pending" && review?.review.refusal))
			? Alert02Icon
			: base.icon;
	const people = view === "completed" && review ? peopleResult(review) : null;
	const imported = view === "completed" && review?.receipt?.import ? "Import saved" : null;
	const h = mailTitle
		? { ...base, ...mailTitle, icon }
		: people || imported
			? {
					...base,
					title: people ?? imported!,
					...(people && !people.startsWith("Saved") && { icon: Alert02Icon, tone: "amber" as const }),
				}
			: base;
	const title = view === "loading" || view === "lost" ? (target ? `Change for ${target}` : "Prepared change") : h.title;
	const meta =
		view === "completed" && review?.approvedAt
			? clock(review.approvedAt)
			: view === "pending" && review && review.revision > 1
				? `Revision ${review.revision}`
				: null;

	return (
		<section
			data-proposal={proposalId}
			data-state={view}
			aria-labelledby={headId}
			aria-busy={view === "loading" || undefined}
			onFocus={() => (focusInside.current = true)}
			onBlur={(e) => {
				if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) focusInside.current = false;
			}}
			className="overflow-hidden rounded-card bg-surface-raised shadow-[inset_0_0_0_1px_var(--ef-line),var(--ef-shadow-raised)]"
		>
			<CardHead id={headId} ref={headRef} icon={h.icon} tone={h.tone} title={title} spinning={view === "running"}>
				{meta}
			</CardHead>
			{why ? <p className="bg-surface-2 px-4 py-2.5 text-sm text-text-2">{why}</p> : null}

			{view === "loading" ? (
				<p className="flex items-center gap-2 px-4 py-3.5 text-sm text-text-2">
					<Spinner size={16} /> Loading the review…
				</p>
			) : view === "lost" ? (
				<div className="flex flex-col items-start gap-3 px-4 py-3.5 text-sm text-text-2">
					<p>The review did not load. Check your connection, then try again.</p>
					<Button size="sm" variant="outline" onClick={r.reload}>
						Try again
					</Button>
				</div>
			) : view === "unavailable" || view === "withheld" || !review ? null : (view === "pending" ||
					unknown === "revise") &&
			  editing === review.revision ? (
				<ReviseForm
					review={review}
					busy={r.busy === "revise"}
					unknown={unknown === "revise"}
					checking={r.busy === "check"}
					onCheck={() => void r.check()}
					notice={notice}
					onSubmit={(edits) => void r.revise(edits)}
					onClose={() => {
						setEditing(null);
						r.clearNotice();
						setCloses((n) => n + 1);
					}}
				/>
			) : (
				<>
					<div className="flex flex-col gap-3 px-4 py-3.5">
						<Affects review={review} />
						{isMail(review.operation) ? (
							<>
								<MailChanges review={review} />
								{view === "completed" ? <MailResult review={review} /> : null}
								{view === "pending" && !review.review.refusal && !review.stale ? (
									<p className="text-sm text-text-2">{MAIL_CONSEQUENCE[review.operation]}</p>
								) : null}
							</>
						) : isNotification(review.operation) ? (
							<>
								<NoticeChanges review={review} />
								{consequence(review) ? <p className="text-sm text-text-2">{consequence(review)}</p> : null}
							</>
						) : (
							<>
								<Changes review={review} staged={photoGone ? { status: "gone" } : staged} onRetry={r.retryPhoto} />
								{view === "completed" && review.receipt?.people ? (
									<PeopleResult review={review} />
								) : (
									<ReviewedPeople review={review} />
								)}
								{view === "completed" && review.receipt?.import ? (
									<ImportResult review={review} />
								) : (
									<ImportRows review={review} />
								)}
								{view === "refused" ? <CurrentState review={review} /> : null}
								{consequence(review) && (view === "pending" || view === "running") ? (
									<p className="text-sm text-text-2">{consequence(review)}</p>
								) : null}
								{review.review.notes?.length ? <Notes notes={review.review.notes} /> : null}
								{view === "pending" && asksReason(review.operation) && !review.review.refusal ? (
									<Field
										label="Reason for this move"
										hint={`Only you write this. It's saved in ${review.review.target?.label ?? "the person"}'s pipeline history, not in Evry.`}
									>
										<Textarea
											value={reason}
											onChange={(e) => setReason(e.target.value)}
											rows={3}
											maxLength={1000}
											disabled={r.busy !== null}
										/>
									</Field>
								) : null}
							</>
						)}
						{view === "pending" && !review.review.refusal && !review.stale ? (
							<p className="text-xs text-text-3">
								Nothing changes until you approve. Approve by {clock(review.expiresAt)}.
							</p>
						) : null}
					</div>
					{notice ? <NoticeLine notice={notice} /> : null}
					<Footer
						view={view}
						review={review}
						canApprove={approvable(review, staged.status === "ready")}
						reason={asksReason(review.operation) ? reason.trim() : null}
						r={r}
						reviseButton={reviseRef}
						onRevise={() => {
							r.clearNotice();
							setEditing(review.revision);
						}}
					/>
				</>
			)}
			<p role="status" className="sr-only">
				{said.text}
			</p>
		</section>
	);
}

function Footer({
	view,
	review,
	canApprove,
	reason,
	r,
	reviseButton,
	onRevise,
}: {
	view: Phase | "photo_unavailable" | "unknown";
	review: Review;
	canApprove: boolean;
	reason: string | null;
	r: ReturnType<typeof useReview>;
	reviseButton: Ref<HTMLButtonElement>;
	onRevise: () => void;
}) {
	const who = review.review.target;
	const other = (action: string) => r.busy !== null && r.busy !== action;
	const cancel = (
		<Button
			size="sm"
			variant="ghost"
			loading={r.busy === "cancel"}
			disabled={other("cancel")}
			onClick={() => void r.cancel()}
		>
			{isMail(review.operation) ? "Close review" : "Cancel"}
		</Button>
	);
	let body: ReactNode = null;
	if (view === "pending")
		body = (
			<>
				{review.review.refusal ? null : (
					<Button
						size="sm"
						variant="primary"
						icon={Tick02Icon}
						loading={r.busy === "approve"}
						disabled={other("approve") || !canApprove || review.stale || reason === ""}
						onClick={() => void r.approve(reason ?? undefined)}
					>
						Approve
					</Button>
				)}
				{review.stale ? (
					<Button size="sm" variant="secondary" loading={r.busy === "revise"} onClick={() => void r.revise()}>
						Review again
					</Button>
				) : null}
				{editableChanges(review).length ? (
					<Button ref={reviseButton} size="sm" variant="secondary" disabled={r.busy !== null} onClick={onRevise}>
						Revise
					</Button>
				) : null}
				<span className="flex-1" />
				{cancel}
				{r.busy ? (
					<Hint>One change at a time. Wait for this one to finish.</Hint>
				) : reason === "" && !review.review.refusal ? (
					<Hint>Type the reason for this move to approve it.</Hint>
				) : null}
			</>
		);
	else if (view === "unknown")
		body = (
			<>
				<Button
					size="sm"
					variant="primary"
					loading={r.busy === "approve" || r.busy === "check"}
					onClick={() => void r.check()}
				>
					Check again
				</Button>
				{editableChanges(review).length ? (
					<Button size="sm" variant="secondary" disabled>
						Revise
					</Button>
				) : null}
				<span className="flex-1" />
				<Button size="sm" variant="ghost" disabled>
					Cancel
				</Button>
				<Hint>Check again before you change or cancel this.</Hint>
			</>
		);
	else if (view === "photo_unavailable")
		body = (
			<>
				{isSettings(review.operation) ? (
					<Button size="sm" variant="secondary" asChild>
						<IntentLink href={settingsLink(review.operation).href}>{settingsLink(review.operation).label}</IntentLink>
					</Button>
				) : who ? (
					<Button size="sm" variant="secondary" asChild>
						<IntentLink href={`/people/${who.id}`}>Open {who.label}</IntentLink>
					</Button>
				) : null}
				<span className="flex-1" />
				{cancel}
			</>
		);
	else if (view === "running")
		body = (
			<>
				<span className="flex-1 text-xs whitespace-nowrap text-text-3">Approved by you</span>
				{cancel}
			</>
		);
	else if (view === "completed")
		body = (
			<>
				<span className="flex-1 text-xs whitespace-nowrap text-text-3">Approved by you</span>
				{isMail(review.operation) ? (
					<>
						{checkable(review) ? (
							<Button size="sm" variant="secondary" loading={r.busy === "recheck"} onClick={() => void r.recheck()}>
								Check again
							</Button>
						) : null}
						<Button size="sm" variant="ghost" asChild>
							<IntentLink href="/communication">
								Open Messages
								<Icon icon={ArrowRight02Icon} size={16} />
							</IntentLink>
						</Button>
					</>
				) : isNotification(review.operation) ? (
					<Button size="sm" variant="ghost" asChild>
						<IntentLink
							href={review.operation.startsWith("notifications.mark") ? "/notifications" : "/settings/notifications"}
						>
							{review.operation.startsWith("notifications.mark") ? "Open notifications" : "Open settings"}
							<Icon icon={ArrowRight02Icon} size={16} />
						</IntentLink>
					</Button>
				) : isSettings(review.operation) ? (
					<Button size="sm" variant="ghost" asChild>
						<IntentLink href={settingsLink(review.operation).href}>
							{settingsLink(review.operation).label}
							<Icon icon={ArrowRight02Icon} size={16} />
						</IntentLink>
					</Button>
				) : isLaunch(review.operation) ? (
					<Button size="sm" variant="ghost" asChild>
						<IntentLink href="/launch">
							Open Launch
							<Icon icon={ArrowRight02Icon} size={16} />
						</IntentLink>
					</Button>
				) : isPipeline(review.operation) ? (
					<Button size="sm" variant="ghost" asChild>
						<IntentLink href={pipelineLink(review).href}>
							{pipelineLink(review).label}
							<Icon icon={ArrowRight02Icon} size={16} />
						</IntentLink>
					</Button>
				) : who?.kind === "person" && review.operation !== "people.deletePerson" && !review.review.withheld ? (
					<Button size="sm" variant="ghost" asChild>
						<IntentLink href={`/people/${who.id}`}>
							Open {who.label}
							<Icon icon={ArrowRight02Icon} size={16} />
						</IntentLink>
					</Button>
				) : null}
			</>
		);
	else if (view === "unconfirmed" && retryable(review, r.lapsed))
		body = (
			<Button size="sm" variant="secondary" loading={r.busy === "retry"} onClick={() => void r.retry()}>
				Try again
			</Button>
		);
	else if (view === "expired" && review.outcome === null && reviseInput(review) !== null)
		body = (
			<Button size="sm" variant="secondary" loading={r.busy === "revise"} onClick={() => void r.revise()}>
				Prepare again
			</Button>
		);
	return body ? (
		<div key={view} className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
			{body}
		</div>
	) : null;
}

function Hint({ children }: { children: ReactNode }) {
	return <p className="w-full text-xs text-text-3">{children}</p>;
}

function NoticeLine({ notice }: { notice: Notice }) {
	return (
		<p
			ref={notice.tone === "error" ? focusOnMount : undefined}
			tabIndex={-1}
			className={cn(
				"mx-4 mb-3 rounded-md px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus",
				notice.tone === "error" ? "bg-magenta-50 text-magenta-600" : "bg-surface-2 text-text-2",
			)}
		>
			{notice.text}
		</p>
	);
}

function CardHead({
	id,
	ref,
	icon,
	title,
	tone,
	spinning,
	children,
}: {
	id: string;
	ref: Ref<HTMLHeadingElement>;
	icon: IconSvgElement;
	title: string;
	tone: Tone;
	spinning?: boolean;
	children?: ReactNode;
}) {
	return (
		<h3
			id={id}
			ref={ref}
			tabIndex={-1}
			className={cn(
				"flex items-center gap-2.5 border-b px-4 py-3 font-sans text-sm font-semibold tracking-normal outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset",
				HEAD_TONE[tone],
			)}
		>
			{spinning ? <Spinner size={16} /> : <Icon icon={icon} size={16} />}
			<span className="min-w-0 flex-1">{title}</span>
			{children ? <span className="font-medium tabular-nums">{children}</span> : null}
		</h3>
	);
}

const NOTIFICATION_SUBJECT: Partial<Record<string, string>> = {
	"notifications.markSelectedRead": "Your notifications",
	"notifications.markAllVisibleRead": "Your notifications",
	"notifications.setPreferences": "Your notification settings",
	"notifications.digestCadence.set": "Your church digest",
	"notifications.oversightDigestCadence.set": "Your oversight digest",
};

const RECORD_GLYPH: Partial<Record<NonNullable<Review["review"]["target"]>["kind"], IconSvgElement>> = {
	person: UserIcon,
	message: Mail01Icon,
	team: UserGroupIcon,
	role: Briefcase01Icon,
	training: Mortarboard01Icon,
	responsibility: CheckListIcon,
	household: Home01Icon,
	tag: Tag01Icon,
	meeting: Calendar03Icon,
	venue: Location01Icon,
};

function Affects({ review }: { review: Review }) {
	const mail = isMail(review.operation);
	const own = isNotification(review.operation);
	const create = review.operation === "people.createPerson";
	if (isMeetings(review.operation)) {
		const after = (field: string) => review.review.changes.find((c) => c.field === field)?.after;
		const venue = review.operation.startsWith("venues.") || review.review.target?.kind === "venue";
		const name =
			review.review.target?.label ?? String(after("title") ?? after("name") ?? (venue ? "New venue" : "New meeting"));
		return (
			<div className="flex items-center gap-3">
				<span className="grid size-8 flex-none place-items-center rounded-full bg-surface-2 text-text-2">
					<Icon icon={venue ? Location01Icon : Calendar03Icon} size={16} />
				</span>
				<span className="min-w-0">
					<span className="block truncate font-medium text-ink">{name}</span>
					<span className="block text-xs text-text-3">{operationTitle(review.operation)}</span>
				</span>
			</div>
		);
	}
	const target = review.review.target;
	const kind = target?.kind;
	const tag = !kind && review.review.changes.find((c) => c.field === "tag" || c.field === "createTag")?.after;
	const imported = review.operation === "people.executeBulkImport";
	const program = review.operation === "development.saveProgram" || review.operation === "development.draftNextVersion";
	const record = isTeams(review.operation) ? ((target && RECORD_GLYPH[target.kind]) ?? UserGroupIcon) : null;
	const glyph = own
		? Notification01Icon
		: (record ??
			(program
				? Mortarboard01Icon
				: isLaunch(review.operation)
					? StartUp02Icon
					: imported
						? FileImportIcon
						: kind === "household"
							? Home01Icon
							: kind === "tag" || tag
								? Tag01Icon
								: mail
									? Mail01Icon
									: create
										? UserAdd01Icon
										: null));
	const name = own
		? (NOTIFICATION_SUBJECT[review.operation] ?? "Your notifications")
		: imported
			? "People import"
			: tag
				? String(tag)
				: mail
					? String(review.review.changes.find((c) => c.field === "subject")?.after ?? target?.label ?? "Email")
					: create
						? String(review.review.changes.find((c) => c.field === "displayName")?.after ?? "New person")
						: record && !target
							? String(review.review.changes.find((c) => c.field === "name")?.after ?? "New ministries")
							: (target?.label ?? "Not available");
	return (
		<div className="flex items-center gap-3">
			{glyph ? (
				<span className="grid size-8 flex-none place-items-center rounded-full bg-surface-2 text-text-2">
					<Icon icon={glyph} size={16} />
				</span>
			) : (
				<Avatar name={name} size="sm" decorative />
			)}
			<span className="min-w-0">
				<span className="block truncate font-medium text-ink">{name}</span>
				<span className="block text-xs text-text-3">{operationTitle(review.operation)}</span>
			</span>
		</div>
	);
}

function Value({ field, value, before }: { field: string; value: unknown; before?: boolean }) {
	if (Array.isArray(value) && value.length)
		return (
			<ul className={cn("flex min-w-0 flex-col gap-0.5", before ? "text-text-2" : "font-medium text-ink")}>
				{value.map((v, i) => (
					<li key={i} className="break-words">
						{String(v)}
					</li>
				))}
			</ul>
		);
	const text = valueText(field, value);
	if (text === null) return <span className="text-text-3 italic">{emptyText(field, !before)}</span>;
	if (field === "stage" && typeof value === "string" && value in STAGE_KEY)
		return <StageChip stage={STAGE_KEY[value as StageValue]}>{text}</StageChip>;
	return (
		<span className={cn("min-w-0 [overflow-wrap:anywhere]", before ? "text-text-2" : "font-medium text-ink")}>
			{text}
		</span>
	);
}

type TileState = "image" | "none" | "loading" | "gone" | "lost" | "hidden";
const TILE_TEXT: Partial<Record<TileState, string>> = {
	none: "No photo",
	gone: "Not available",
	lost: "Didn't load",
};

function PhotoTile({
	caption,
	value,
	src,
	alt,
	state,
	onRetry,
}: {
	caption: string;
	value: unknown;
	src?: string;
	alt: string;
	state: TileState;
	onRetry?: () => void;
}) {
	const [failed, setFailed] = useState<string | null>(null);
	const shown = state === "image" && src && failed !== src ? "image" : state === "image" ? "gone" : state;
	return (
		<figure className="flex min-w-20 flex-none flex-col gap-1.5" aria-busy={shown === "loading" || undefined}>
			<span className="grid size-20 place-items-center overflow-hidden rounded-md bg-surface-raised text-text-3 shadow-[inset_0_0_0_1px_var(--ef-line)]">
				{shown === "image" ? (
					<NativeImage
						src={src}
						alt={alt}
						width={80}
						height={80}
						onError={() => setFailed(src ?? null)}
						className="size-20 object-cover outline-1 -outline-offset-1 outline-line"
					/>
				) : shown === "loading" ? (
					<>
						<Skeleton shape="block" width={80} height={80} />
						<span className="sr-only">Loading the photo…</span>
					</>
				) : (
					<span className="flex flex-col items-center gap-1 px-1 text-center text-xs leading-tight">
						<Icon icon={shown === "gone" || shown === "lost" ? ImageNotFound01Icon : Image01Icon} size={20} />
						{TILE_TEXT[shown] ?? null}
					</span>
				)}
			</span>
			<figcaption className="flex flex-col text-xs leading-tight">
				<span className="font-medium text-ink">{caption}</span>
				{value ? <span className="whitespace-nowrap text-text-3 tabular-nums">Ref {photoRef(value)}</span> : null}
			</figcaption>
			{shown === "lost" && onRetry ? (
				<Button size="sm" variant="ghost" className="-ml-2 self-start" onClick={onRetry}>
					Try again
				</Button>
			) : null}
		</figure>
	);
}

function PhotoChange({
	review,
	change,
	staged,
	onRetry,
}: {
	review: Review;
	change: Change;
	staged: StagedPhoto;
	onRetry: () => void;
}) {
	const target = review.review.target!;
	const saved = review.outcome === "completed";
	const after: { state: TileState; src?: string } =
		change.after === null || change.after === undefined
			? { state: "none" }
			: staged.status === "ready"
				? { state: "image", src: staged.src }
				: saved
					? { state: "image", src: savedPhotoSrc(target, String(change.after)) }
					: { state: staged.status === "idle" ? "hidden" : staged.status };
	return (
		<div className="flex flex-col gap-2">
			<dt className="text-text-2">{fieldLabel(change.field)}</dt>
			<dd className="flex items-start gap-3">
				<span className="sr-only">from </span>
				<PhotoTile
					caption={saved ? "Before" : "Current"}
					value={change.before}
					src={change.before ? savedPhotoSrc(target, String(change.before)) : undefined}
					alt={`${saved ? "Previous" : "Current"} photo of ${target.label}`}
					state={change.before ? "image" : "none"}
				/>
				<Icon icon={ArrowRight02Icon} size={16} className="mt-8 flex-none text-text-3" />
				<span className="sr-only"> to </span>
				<PhotoTile
					caption={saved ? "New" : "Uploaded"}
					value={change.after}
					src={after.src}
					alt={`${saved ? "New" : "Uploaded"} photo for ${target.label}`}
					state={after.state}
					onRetry={onRetry}
				/>
			</dd>
		</div>
	);
}

function Notes({ notes }: { notes: string[] }) {
	const [first, ...rest] = notes;
	const list = first?.endsWith(":") ? rest : [];
	const lines = list.length ? [] : notes;
	return (
		<div className="flex flex-col gap-1.5 text-sm text-text-2">
			{lines.map((n) => (
				<p key={n}>{n}</p>
			))}
			{list.length ? (
				<>
					<p>{first}</p>
					<ul className="flex flex-col gap-1 rounded-md bg-surface-2 px-3 py-2.5 text-ink-2">
						{list.slice(0, -1).map((n) => (
							<li key={n} className="tabular-nums">
								{n}
							</li>
						))}
					</ul>
					<p>{list.at(-1)}</p>
				</>
			) : null}
		</div>
	);
}

function Changes({ review, staged, onRetry }: { review: Review; staged: StagedPhoto; onRetry: () => void }) {
	const changes = shownChanges(review);
	if (!changes.length) return null;
	const create = addsOnly(review.operation);
	const fresh = (c: Change) =>
		(isMeetings(review.operation) ||
			isLaunch(review.operation) ||
			review.operation === "development.draftNextVersion") &&
		(c.before === null || c.before === undefined);
	return (
		<dl className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-2.5 text-sm">
			{changes.map((c: Change) =>
				c.field === "photo" && review.review.target ? (
					<PhotoChange key={c.field} review={review} change={c} staged={staged} onRetry={onRetry} />
				) : carryOver(c) ? (
					<LinkChange key={c.field} change={c} />
				) : (
					<div key={c.field} className="grid grid-cols-[minmax(88px,auto)_minmax(0,1fr)] items-baseline gap-x-3">
						<dt className="text-text-2">{fieldLabel(c.field, review.operation)}</dt>
						<dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
							{create || c.field === "reason" || fresh(c) ? null : (
								<>
									<span className="sr-only">from </span>
									<Value field={c.field} value={c.before} before />
									<Icon icon={ArrowRight02Icon} size={16} className="text-text-3" />
									<span className="sr-only"> to </span>
								</>
							)}
							<Value field={c.field} value={c.after} />
						</dd>
					</div>
				),
			)}
		</dl>
	);
}

function LinkChange({ change }: { change: Change }) {
	const link = carryOver(change)!;
	return (
		<div className="grid grid-cols-[minmax(88px,auto)_minmax(0,1fr)] items-baseline gap-x-3">
			<dt className="text-text-2">
				{link.organization}
				{link.kind ? <span className="block text-xs text-text-3">{link.kind}</span> : null}
			</dt>
			<dd className={cn("min-w-0 [overflow-wrap:anywhere]", link.carries ? "font-medium text-ink" : "text-text-2")}>
				{carryOverText(link)}
			</dd>
		</div>
	);
}

function LinkPicker({
	change,
	value,
	onChange,
	disabled,
}: {
	change: Change;
	value: string;
	onChange: (value: string) => void;
	disabled: boolean;
}) {
	const link = carryOver(change)!;
	const pick = JSON.parse(value) as { carries: boolean; share: string[] };
	const set = (next: typeof pick) => onChange(JSON.stringify(next));
	return (
		<fieldset className="flex flex-col gap-1 rounded-md border border-line px-3 py-2.5">
			<legend className="px-1 text-sm font-medium text-ink">{link.organization}</legend>
			<Checkbox
				label={`Keep the link to ${link.organization}`}
				description={link.kind ? `${link.kind} relationship. If you leave it out, the link ends.` : undefined}
				checked={pick.carries}
				disabled={disabled}
				onCheckedChange={(on) => set({ carries: on === true, share: on === true ? pick.share : [] })}
			/>
			{pick.carries ? (
				<div className="flex flex-col gap-1 pl-7">
					<p className="text-xs text-text-3">What your church shares with {link.organization}</p>
					{SHARE_CHOICES.map((choice) => (
						<Checkbox
							key={choice.value}
							label={choice.label}
							checked={pick.share.includes(choice.value)}
							disabled={disabled}
							onCheckedChange={(on) =>
								set({
									carries: true,
									share: on === true ? [...pick.share, choice.value] : pick.share.filter((k) => k !== choice.value),
								})
							}
						/>
					))}
				</div>
			) : null}
		</fieldset>
	);
}

function focusControl(form: HTMLFormElement, field?: string) {
	form
		.querySelector<HTMLElement>(
			field
				? `[data-field="${field}"] :is(input,textarea,button)`
				: ":is(input,textarea,button[role=combobox],button[role=checkbox])",
		)
		?.focus();
}

function focusFirstControl(form: HTMLFormElement | null) {
	if (form) focusControl(form);
}

function ReviseForm({
	review,
	busy,
	unknown,
	checking,
	onCheck,
	notice,
	onSubmit,
	onClose,
}: {
	review: Review;
	busy: boolean;
	unknown: boolean;
	checking: boolean;
	onCheck: () => void;
	notice: Notice | null;
	onSubmit: (edits: Record<string, string>) => void;
	onClose: () => void;
}) {
	const fields = editableChanges(review);
	const [edits, setEdits] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			fields.map((c) => {
				const link = carryOver(c);
				if (link) return [c.field, JSON.stringify({ carries: link.carries, share: link.share })];
				return [c.field, c.after === null || c.after === undefined ? "" : String(c.after)];
			}),
		),
	);
	const [missing, setMissing] = useState<string | null>(null);
	const locked = busy || unknown || checking;
	const dated = hasBirthDate(review, edits);
	const submit = (e: FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		if (locked) return;
		const empty = missingRequired(review, edits);
		setMissing(empty?.field ?? null);
		if (empty) return focusControl(e.currentTarget, empty.field);
		onSubmit(edits);
	};
	return (
		<form ref={focusFirstControl} onSubmit={submit} noValidate aria-label="Revise this change">
			<div className="flex flex-col gap-3 px-4 py-3.5">
				<Affects review={review} />
				{fields.map((c) => {
					const kind = fieldKind(c.field);
					const set = (value: string) => setEdits((all) => ({ ...all, [c.field]: value }));
					if (carryOver(c))
						return (
							<div key={c.field} data-field={c.field}>
								<LinkPicker change={c} value={edits[c.field]!} onChange={set} disabled={locked} />
							</div>
						);
					const now =
						review.operation === "people.createPerson" || c.field === "reason"
							? undefined
							: c.field === "adultClassification" && dated
								? "Not needed: it comes from the birth date."
								: `Now: ${valueText(c.field, c.before) ?? "empty"}`;
					return (
						<div key={c.field} data-field={c.field}>
							<Field
								label={fieldLabel(c.field)}
								hint={now}
								error={missing === c.field ? `Enter ${fieldLabel(c.field).toLowerCase()}.` : undefined}
								optional={!isRequired(c.field, dated)}
							>
								{kind === "choice" ? (
									<Select options={CHOICES[c.field]!} value={edits[c.field]} onValueChange={set} disabled={locked} />
								) : kind === "long" ? (
									<Textarea value={edits[c.field]} onChange={(e) => set(e.target.value)} rows={3} disabled={locked} />
								) : (
									<Input
										type={kind === "date" ? "date" : kind === "email" ? "email" : "text"}
										value={edits[c.field]}
										onChange={(e) => set(e.target.value)}
										disabled={locked}
									/>
								)}
							</Field>
						</div>
					);
				})}
				<p className="text-xs text-text-3">Updating makes a new revision. You check it, then approve it.</p>
			</div>
			{notice ? <NoticeLine notice={notice} /> : null}
			<div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
				{unknown || checking ? (
					<Button size="sm" variant="primary" type="button" loading={checking} onClick={onCheck}>
						Check again
					</Button>
				) : null}
				<Button
					size="sm"
					variant={unknown || checking ? "secondary" : "primary"}
					type="submit"
					loading={busy}
					disabled={unknown || checking}
				>
					Update review
				</Button>
				<Button size="sm" variant="ghost" type="button" disabled={locked} onClick={onClose}>
					Keep as it is
				</Button>
				{unknown || checking ? <Hint>Check again before you update or close this.</Hint> : null}
			</div>
		</form>
	);
}
