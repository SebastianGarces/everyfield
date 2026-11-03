"use client";

import {
	Alert02Icon,
	Coins01Icon,
	CrownIcon,
	HandPrayerIcon,
	MapsLocation01Icon,
	RefreshIcon,
	StartUp02Icon,
	Tick02Icon,
	UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import {
	CANDIDATE_DAYS,
	SIGNAL_GROUPS,
	TEXT_MAX,
	type AttestationsPage,
	type CandidateEntry,
	type HumanRevision,
	type SignalEntry,
	type SignalKey,
	type SignalWriteResult,
	type SignalValue,
} from "@everyfield/contracts/intelligence";
import {
	Button,
	Card,
	CardActions,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Checkbox,
	Combobox,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	PageHeader,
	Textarea,
	useToast,
} from "@everyfield/ui/controls";
import { StatusBadge } from "@everyfield/ui/display";
import { cn, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import { RadioGroup } from "radix-ui";
import { useRef, useState } from "react";
import { shortDate } from "./model.ts";
import { IntelligenceTabs } from "./IntelligenceTabs.tsx";
import {
	attestCandidate,
	attestSignal,
	correctCandidate,
	correctSignal,
	reaffirmSignal,
	reloadAttestations,
} from "./signals-actions.ts";
import {
	actionLabel,
	agoText,
	answerLabel,
	attentionCount,
	candidateLine,
	definitionOf,
	draftOf,
	draftReasons,
	historyOf,
	historyText,
	intent,
	periodDays,
	periodText,
	reaffirmed,
	REASON_TEXT,
	refusalText,
	renewalLabel,
	renewalStatus,
	retracted,
	signalsIn,
	stated,
	VALUE_LABEL,
	withCandidate,
	withHistory,
	withSignal,
	historyLine,
	type Draft,
	type SignalOutcome,
} from "./signals-model.ts";

/**
 * The Attestations page (prototype #/intelligence/attestations, REQ-PI-014, REQ-PI-015). The seven signals an Owner or
 * Admin answers, by group, each with its answer, author, date, age and renewal state, and the leadership candidates they
 * attest. A save shows at once, then confirms or puts the row back with the reason, keeping what the admin typed. It
 * shows answers only: nothing here scores, ranks or assigns anyone.
 */
export function AttestationsScreen({ initial, viewerName }: { initial: AttestationsPage; viewerName: string }) {
	const [page, setPage] = useState(initial);
	const [dialog, setDialog] = useState<
		{ kind: "answer"; key: SignalKey } | { kind: "renew" } | { kind: "candidate"; personId: string | null } | null
	>(null);
	const toast = useToast();
	const keys = useRef(new Map<string, string>());
	/** One request key per distinct request, so a retry after a lost reply replays the first answer. */
	const keyFor = (payload: string) => {
		if (!keys.current.has(payload)) keys.current.set(payload, crypto.randomUUID());
		return keys.current.get(payload)!;
	};
	const sent = async <T,>(call: () => Promise<SignalOutcome<T>>): Promise<SignalOutcome<T>> => {
		try {
			return await call();
		} catch {
			return { status: "lost" };
		}
	};
	const entryOf = (key: SignalKey) => page.signals.find((s) => s.key === key)!;
	const fail = (result: SignalOutcome<unknown>) => refusalText(result.status === "refused" ? result.error : null);

	/** Show `optimistic` at once, send the write, then confirm with a history line or roll back to `entry`. */
	async function writeSignal(
		entry: SignalEntry,
		optimistic: (today: string) => SignalEntry,
		payload: string,
		send: (requestKey: string) => Promise<SignalOutcome<SignalWriteResult>>,
		line: (confirmed: SignalEntry) => HumanRevision,
	): Promise<string | null> {
		setPage((p) => withSignal(p, optimistic(p.today)));
		const result = await sent(() => send(keyFor(payload)));
		if (result.status !== "ok") {
			setPage((p) => withSignal(p, entry));
			return fail(result);
		}
		keys.current.delete(payload);
		const confirmed = result.value.signal;
		setPage((p) => withHistory(withSignal(p, confirmed), line(confirmed)));
		return null;
	}

	/** Answer a signal for the first time or after a retraction, or correct it to the other value. */
	async function save(entry: SignalEntry, draft: Draft): Promise<string | null> {
		const what = intent(entry, draft);
		if (what === "none" || !draft.value) return null;
		const value = draft.value;
		const input = { key: entry.key, value, asOf: draft.asOf, detail: draft.detail, reference: draft.reference };
		return writeSignal(
			entry,
			(today) => stated(entry, { ...draft, value }, today, viewerName),
			JSON.stringify([what, entry.revision, input]),
			(key) =>
				what === "attest"
					? attestSignal(key, entry.revision, input)
					: correctSignal(key, entry.revision, { action: "correct", ...input }),
			(confirmed) => historyLine(confirmed, what === "attest" ? "answered" : "corrected", value),
		);
	}
	async function retract(entry: SignalEntry): Promise<string | null> {
		const input = { action: "retract", key: entry.key };
		return writeSignal(
			entry,
			() => retracted(entry, viewerName),
			JSON.stringify(["retract", entry.revision, input]),
			(key) => correctSignal(key, entry.revision, input),
			(confirmed) => historyLine(confirmed, "retracted", null),
		);
	}
	async function stillTrue(entry: SignalEntry): Promise<string | null> {
		const input = { key: entry.key, expectedValue: entry.value };
		return writeSignal(
			entry,
			(today) => reaffirmed(entry, today, viewerName),
			JSON.stringify(["reaffirm", entry.revision, input]),
			(key) => reaffirmSignal(key, entry.revision, input),
			(confirmed) => historyLine(confirmed, "reaffirmed", confirmed.value),
		);
	}
	async function reload() {
		const result = await sent(() => reloadAttestations());
		if (result.status === "ok") setPage(result.value);
		else toast({ message: "Everyfield could not be reached. Try again in a moment.", tone: "error" });
	}

	/** Save a candidate attestation, or correct or retract it. */
	async function saveCandidate(
		input: Record<string, unknown> & { personId: string },
		action: "attest" | "correct" | "retract",
		revision: string,
		optimistic: CandidateEntry | null,
	): Promise<string | null> {
		const before = page.candidates.find((c) => c.personId === input.personId) ?? null;
		const payload = JSON.stringify([action, revision, input]);
		if (optimistic) setPage((p) => withCandidate(p, optimistic));
		const result = await sent(() =>
			action === "attest"
				? attestCandidate(keyFor(payload), revision, input)
				: correctCandidate(keyFor(payload), revision, { ...input, action }),
		);
		if (result.status !== "ok") {
			setPage((p) =>
				before
					? withCandidate(p, before)
					: { ...p, candidates: p.candidates.filter((c) => c.personId !== input.personId) },
			);
			return fail(result);
		}
		keys.current.delete(payload);
		const confirmed = result.value.candidate;
		const kind = action === "attest" ? "answered" : action === "correct" ? "corrected" : "retracted";
		setPage((p) => withHistory(withCandidate(p, confirmed), candidateLine(confirmed, kind)));
		return null;
	}

	const reaffirming = page.signals.filter((s) => definitionOf(s.key).reaffirms);
	const open = dialog?.kind === "answer" ? entryOf(dialog.key) : null;

	return (
		<>
			<PageHeader
				size="xl"
				title="Plant Intelligence"
				subtitle="Some evidence only you can give. Each answer is your dated statement. Evry never answers for you."
				actions={
					<Button variant="primary" icon={RefreshIcon} onClick={() => setDialog({ kind: "renew" })}>
						Renew monthly answers
					</Button>
				}
			/>
			<IntelligenceTabs current="attestations" count={attentionCount(page)} />
			<div className="mb-5 grid grid-cols-4 gap-4 max-app-md:grid-cols-2">
				<Stat label="Signals" value={page.signals.length} note="You answer these seven" />
				<Stat label="Current" value={page.counts.current} note="Answered and up to date" />
				<Stat
					label="Needs renewing"
					value={page.counts.needsRenewing}
					tone={page.counts.needsRenewing ? "amber" : undefined}
					note="Monthly answers older than 30 days"
				/>
				<Stat
					label="Not answered"
					value={page.counts.notAnswered}
					tone={page.counts.notAnswered ? "amber" : undefined}
					note="Shown as Unknown, never as no"
				/>
			</div>
			{SIGNAL_GROUPS.map((group) => {
				const rows = signalsIn(page, group.id);
				if (!rows.length) return null;
				return (
					<section key={group.id} aria-labelledby={`att-${group.id}`} className="mb-5">
						<div className="mb-2.5 flex items-center gap-2.5">
							<span className="grid size-[30px] place-items-center rounded-pill bg-surface-2">
								<Icon icon={GROUP_ICON[group.id]} size={16} />
							</span>
							<h2 id={`att-${group.id}`} className="font-title text-title-sm tracking-[-0.02em] text-ink">
								{group.title}
							</h2>
						</div>
						<Card className="!p-0">
							<ul>
								{rows.map((entry, i) => (
									<SignalRow
										key={entry.key}
										entry={entry}
										first={i === 0}
										onOpen={() => setDialog({ kind: "answer", key: entry.key })}
									/>
								))}
							</ul>
						</Card>
					</section>
				);
			})}
			<CandidateSection
				page={page}
				onAdd={() => setDialog({ kind: "candidate", personId: null })}
				onOpen={(personId) => setDialog({ kind: "candidate", personId })}
			/>
			{open ? (
				<AnswerDialog
					key={open.key}
					entry={open}
					page={page}
					onClose={() => setDialog(null)}
					onSave={save}
					onRetract={retract}
					onStillTrue={stillTrue}
					onReload={reload}
					onDone={(message) => {
						setDialog(null);
						toast({ message, tone: "success" });
					}}
				/>
			) : null}
			{dialog?.kind === "renew" ? (
				<RenewDialog
					entries={reaffirming}
					today={page.today}
					onClose={() => setDialog(null)}
					onSave={save}
					onStillTrue={stillTrue}
					onReload={reload}
				/>
			) : null}
			{dialog?.kind === "candidate" ? (
				<CandidateDialog
					page={page}
					personId={dialog.personId}
					viewerName={viewerName}
					onClose={() => setDialog(null)}
					onSave={saveCandidate}
					onReload={reload}
					onDone={(message) => {
						setDialog(null);
						toast({ message, tone: "success" });
					}}
				/>
			) : null}
		</>
	);
}

const GROUP_ICON: Record<(typeof SIGNAL_GROUPS)[number]["id"], IconSvgElement> = {
	prayer: HandPrayerIcon,
	generosity: Coins01Icon,
	launch: StartUp02Icon,
	foundations: MapsLocation01Icon,
};

function Stat({ label, value, note, tone }: { label: string; value: number; note: string; tone?: "amber" }) {
	return (
		<Card size="sm">
			<div className="text-xs font-semibold text-text-3">{label}</div>
			<div
				className={cn("mt-1 font-display text-title-lg leading-none text-ink", tone === "amber" && "text-amber-600")}
			>
				{value}
			</div>
			<div className="mt-2 text-sm text-text-3">{note}</div>
		</Card>
	);
}

const CHIP: Record<string, string> = {
	yes: "bg-green-100 text-green-700",
	not_yet: "bg-amber-100 text-amber-600",
	none: "bg-transparent text-text-2 shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]",
};
function AnswerChip({ entry }: { entry: SignalEntry }) {
	return (
		<span
			className={cn(
				"inline-flex h-7 w-max items-center rounded-pill px-[11px] text-[13px] font-semibold",
				CHIP[entry.value ?? "none"],
			)}
		>
			{answerLabel(entry)}
		</span>
	);
}
function RenewalBadge({ entry }: { entry: SignalEntry }) {
	const status = renewalStatus(entry.renewal);
	return (
		<StatusBadge size="sm" status={status === "plain" ? "unknown" : status} plain={status === "plain"}>
			{renewalLabel(entry.renewal)}
		</StatusBadge>
	);
}

function SignalRow({ entry, first, onOpen }: { entry: SignalEntry; first: boolean; onOpen: () => void }) {
	const def = definitionOf(entry.key);
	const needs = entry.state !== "answered" || entry.renewal.status === "needs_renewing";
	return (
		<li
			className={cn(
				"grid grid-cols-[minmax(0,1.6fr)_120px_minmax(0,1fr)_84px] items-center gap-4 px-[18px] py-4 max-app-md:grid-cols-[minmax(0,1fr)_auto] max-app-md:gap-x-3 max-app-md:gap-y-2",
				!first && "border-t border-line",
			)}
		>
			<div className="max-app-md:col-span-2">
				<div className="font-semibold text-ink">{def.label}</div>
				<div className="mt-[3px] text-sm leading-[1.45] text-text-2">{def.description}</div>
			</div>
			<div className="max-app-md:order-2">
				<AnswerChip entry={entry} />
			</div>
			<div className="text-sm leading-[1.45] text-text-2 max-app-md:order-3 max-app-md:col-span-2">
				{entry.state === "unanswered" ? (
					<span className="text-text-3">No answer yet</span>
				) : (
					<>
						<b className="font-medium text-ink">{entry.authorName ?? "A church admin"}</b>
						<br />
						{shortDate(entry.asOf!)}
						{entry.state === "answered" ? ` · ${agoText(entry.ageDays!)}` : ""}
						{entry.detail ? (
							<>
								<br />
								{entry.detail}
							</>
						) : null}
						{entry.state === "retracted" ? (
							<>
								<br />
								Retracted · reads as Unknown
							</>
						) : null}
						{entry.state === "answered" ? (
							<div className="mt-2">
								<RenewalBadge entry={entry} />
							</div>
						) : null}
					</>
				)}
			</div>
			<div className="max-app-md:order-2 max-app-md:justify-self-end">
				<Button
					variant={needs ? "primary" : "secondary"}
					size="sm"
					onClick={onOpen}
					aria-label={`${actionLabel(entry)}: ${def.label}`}
				>
					{actionLabel(entry)}
				</Button>
			</div>
		</li>
	);
}

/** The Yes and Not yet choice. Neither is chosen until the admin picks one. */
function Choice({
	value,
	onChange,
	label,
	size = "md",
}: {
	value: SignalValue | null;
	onChange: (value: SignalValue) => void;
	label: string;
	size?: "md" | "sm";
}) {
	return (
		<RadioGroup.Root
			aria-label={label}
			orientation="horizontal"
			value={value ?? ""}
			onValueChange={(v) => onChange(v as SignalValue)}
			className={cn("grid grid-cols-2 gap-2", size === "sm" && "w-[200px] max-app-sm:w-full")}
		>
			{(["yes", "not_yet"] as const).map((v) => (
				<RadioGroup.Item
					key={v}
					value={v}
					className={cn(
						"inline-flex cursor-pointer items-center justify-center gap-2 rounded-md bg-surface-2 font-medium text-ink-2 transition-[background-color,box-shadow] duration-150 hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)] data-[state=checked]:bg-surface-raised data-[state=checked]:text-ink data-[state=checked]:shadow-[inset_0_0_0_1.5px_var(--ef-ink),var(--ef-shadow-raised)]",
						size === "sm" ? "h-9 text-sm" : "h-11",
					)}
				>
					{VALUE_LABEL[v]}
				</RadioGroup.Item>
			))}
		</RadioGroup.Root>
	);
}

function Failure({ text, onReload }: { text: string; onReload: () => void }) {
	return (
		<div role="alert" className="flex gap-3 rounded-md bg-amber-100 px-4 py-3 text-sm text-ink">
			<Icon icon={Alert02Icon} size={18} className="mt-0.5 flex-none text-amber-600" />
			<div className="min-w-0 flex-1">
				<p>{text}</p>
				<Button type="button" variant="ghost" size="sm" className="mt-1.5 -ml-2" onClick={onReload}>
					Load the latest answers
				</Button>
			</div>
		</div>
	);
}

function AnswerDialog({
	entry,
	page,
	onClose,
	onSave,
	onRetract,
	onStillTrue,
	onReload,
	onDone,
}: {
	entry: SignalEntry;
	page: AttestationsPage;
	onClose: () => void;
	onSave: (entry: SignalEntry, draft: Draft) => Promise<string | null>;
	onRetract: (entry: SignalEntry) => Promise<string | null>;
	onStillTrue: (entry: SignalEntry) => Promise<string | null>;
	onReload: () => void;
	onDone: (message: string) => void;
}) {
	const def = definitionOf(entry.key);
	const group = SIGNAL_GROUPS.find((g) => g.id === def.group)!;
	// The draft starts from the entry as opened; a later optimistic change to the row never rewrites what is typed.
	const [opened] = useState(entry);
	const [draft, setDraft] = useState<Draft>(() => draftOf(opened, page.today));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const what = intent(opened, draft);
	const history = historyOf(page, entry.key);
	const future = draft.asOf > page.today;

	async function run(task: () => Promise<string | null>, message: string) {
		setBusy(true);
		setError(null);
		const failure = await task();
		setBusy(false);
		if (failure) setError(failure);
		else onDone(message);
	}

	return (
		<Dialog open onOpenChange={(next) => (next || busy ? null : onClose())}>
			<DialogContent size="md">
				<DialogHeader title={def.label} description={`${group.title} · ${def.description}`} />
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						if (what === "none" || future || busy) return;
						void run(() => onSave(opened, draft), opened.state === "answered" ? "Answer corrected." : "Answer saved.");
					}}
				>
					<DialogBody className="flex flex-col gap-4">
						{error ? <Failure text={error} onReload={onReload} /> : null}
						<div>
							<div id={`ans-${entry.key}`} className="mb-2 text-sm font-semibold text-ink">
								Your answer
							</div>
							<Choice label="Your answer" value={draft.value} onChange={(value) => setDraft({ ...draft, value })} />
							{opened.state === "answered" && draft.value === opened.value ? (
								<p className="mt-2 text-sm text-text-3">
									This is the current answer. Choose the other answer to correct it
									{def.reaffirms ? ", or use Still true to renew it" : ""}.
								</p>
							) : null}
						</div>
						<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
							<Field label="True as of" error={future ? "A statement cannot be dated in the future." : undefined}>
								<Input
									type="date"
									value={draft.asOf}
									max={page.today}
									onChange={(event) => setDraft({ ...draft, asOf: event.target.value })}
									invalid={future}
								/>
							</Field>
							<Field label="Detail" optional>
								<Input
									value={draft.detail}
									maxLength={TEXT_MAX}
									placeholder="For example, who or when"
									onChange={(event) => setDraft({ ...draft, detail: event.target.value })}
								/>
							</Field>
						</div>
						<Field label="Reference" optional>
							<Input
								value={draft.reference}
								maxLength={TEXT_MAX}
								placeholder="A document, meeting or note that supports it"
								onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
							/>
						</Field>
						<p className="text-sm text-text-3">
							{def.reaffirms
								? "Renew this answer every 30 days. After that it keeps its value and shows its age."
								: "This answer does not expire. Update it if anything changes."}{" "}
							Recorded as your statement, with the date you choose.
						</p>
						<div>
							<h3 className="mb-2 text-sm font-semibold text-ink">History</h3>
							{history.length ? (
								<ol className="flex flex-col">
									{history.map((line, i) => (
										<li
											key={line.id}
											className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-start gap-3 border-t border-line py-2.5 first:border-t-0"
										>
											<span
												aria-hidden="true"
												className={cn(
													"mt-1.5 size-2.5 rounded-full",
													i === 0 ? "bg-ink" : "bg-transparent shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]",
												)}
											/>
											<div className="min-w-0">
												<div className="font-medium text-ink">{historyText(line)}</div>
												<div className="text-xs text-text-3">
													{line.authorName ?? "A church admin"} · {shortDate(line.asOf)}
												</div>
											</div>
											<span className="text-xs text-text-3">{i === 0 ? "Current" : "Replaced"}</span>
										</li>
									))}
								</ol>
							) : (
								<p className="text-sm text-text-3">No answers yet. Not answered counts as Unknown, never as no.</p>
							)}
						</div>
					</DialogBody>
					<DialogFooter>
						{opened.state === "answered" ? (
							<Button
								type="button"
								variant="ghost"
								disabled={busy}
								className="mr-auto"
								onClick={() => void run(() => onRetract(opened), "Answer retracted. It now reads as Unknown.")}
							>
								Retract answer
							</Button>
						) : null}
						{opened.state === "answered" && def.reaffirms ? (
							<Button
								type="button"
								variant="secondary"
								disabled={busy}
								onClick={() => void run(() => onStillTrue(opened), "Still true. The answer is renewed.")}
							>
								Still true
							</Button>
						) : null}
						<Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" loading={busy} disabled={what === "none" || future}>
							Save answer
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

type RowState = { pick: SignalValue | null; state: "idle" | "saving" | "saved" | "failed"; error: string | null };

/** "Renew your monthly answers": each row the admin picks is its own Still true or answer; one failure never undoes another. */
function RenewDialog({
	entries,
	today,
	onClose,
	onSave,
	onStillTrue,
	onReload,
}: {
	entries: SignalEntry[];
	today: string;
	onClose: () => void;
	onSave: (entry: SignalEntry, draft: Draft) => Promise<string | null>;
	onStillTrue: (entry: SignalEntry) => Promise<string | null>;
	onReload: () => void;
}) {
	const [opened] = useState(entries);
	const [rows, setRows] = useState<Record<string, RowState>>(() =>
		Object.fromEntries(opened.map((e) => [e.key, { pick: null, state: "idle", error: null } as RowState])),
	);
	const patch = (key: string, next: Partial<RowState>) => setRows((r) => ({ ...r, [key]: { ...r[key]!, ...next } }));
	const picked = opened.filter((e) => rows[e.key]!.pick && rows[e.key]!.state !== "saved");
	const busy = opened.some((e) => rows[e.key]!.state === "saving");
	const stale = (e: SignalEntry) => e.state === "answered" && e.renewal.status === "needs_renewing";

	async function submit() {
		await Promise.all(
			picked.map(async (entry) => {
				const row = rows[entry.key]!;
				patch(entry.key, { state: "saving", error: null });
				// The same answer is "Still true"; the other answer, or a first answer, is its own write.
				const failure =
					entry.state === "answered" && row.pick === entry.value
						? await onStillTrue(entry)
						: await onSave(entry, {
								value: row.pick,
								asOf: today,
								detail: entry.detail ?? "",
								reference: entry.reference ?? "",
							});
				patch(entry.key, failure ? { state: "failed", error: failure } : { state: "saved", error: null });
			}),
		);
	}
	const allDone = opened.every((e) => rows[e.key]!.state === "saved" || !rows[e.key]!.pick);

	return (
		<Dialog open onOpenChange={(next) => (next || busy ? null : onClose())}>
			<DialogContent size="sm">
				<DialogHeader
					title="Renew your monthly answers"
					description="These three are renewed every 30 days. An old answer keeps its value and shows its age until you renew it."
				/>
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						if (!busy && picked.length) void submit();
					}}
				>
					<DialogBody className="flex flex-col">
						{opened.map((entry, i) => {
							const row = rows[entry.key]!;
							return (
								<div
									key={entry.key}
									className={cn(
										"grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3.5 max-app-sm:grid-cols-1",
										i > 0 && "border-t border-line",
									)}
								>
									<div className="min-w-0">
										<div className="font-semibold text-ink">{definitionOf(entry.key).label}</div>
										<div className="mt-[3px] text-sm text-text-2">
											{entry.state === "answered" ? (
												<>
													Last: {VALUE_LABEL[entry.value!]} · {agoText(entry.ageDays!)} ·{" "}
													{stale(entry) ? (
														<span className="font-semibold text-amber-600">needs renewing</span>
													) : (
														renewalLabel(entry.renewal).toLowerCase()
													)}
												</>
											) : entry.state === "retracted" ? (
												"Retracted · reads as Unknown"
											) : (
												"Not answered yet"
											)}
										</div>
										{row.state === "failed" ? (
											<div role="alert" className="mt-2 text-sm font-medium text-magenta-600">
												{row.error}{" "}
												<button type="button" className="cursor-pointer underline" onClick={onReload}>
													Load the latest answers
												</button>
											</div>
										) : null}
									</div>
									{row.state === "saved" ? (
										<span className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-700">
											<Icon icon={Tick02Icon} size={16} />
											Saved
										</span>
									) : (
										<Choice
											size="sm"
											label={`${definitionOf(entry.key).label}: your answer`}
											value={row.pick}
											onChange={(pick) => patch(entry.key, { pick, state: "idle", error: null })}
										/>
									)}
								</div>
							);
						})}
						<p className="mt-2 text-sm text-text-3">
							Pick an answer for each one you want to renew. Choosing the answer a row already has marks it as still
							true.
						</p>
					</DialogBody>
					<DialogFooter>
						<span className="mr-auto text-sm text-text-3 max-app-sm:hidden">
							Saved as true as of today, {shortDate(today)}.
						</span>
						<Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
							{allDone && opened.some((e) => rows[e.key]!.state === "saved") ? "Close" : "Cancel"}
						</Button>
						<Button type="submit" variant="primary" loading={busy} disabled={!picked.length}>
							Save answers
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function CandidateSection({
	page,
	onAdd,
	onOpen,
}: {
	page: AttestationsPage;
	onAdd: () => void;
	onOpen: (personId: string) => void;
}) {
	return (
		<section aria-labelledby="att-candidates" className="mb-5">
			<div className="mb-2.5 flex items-center gap-2.5">
				<span className="grid size-[30px] place-items-center rounded-pill bg-surface-2">
					<Icon icon={CrownIcon} size={16} />
				</span>
				<h2 id="att-candidates" className="font-title text-title-sm tracking-[-0.02em] text-ink">
					Leadership candidates
				</h2>
			</div>
			<Card className="!p-0">
				<CardHeader className="flex-wrap px-[18px] pt-4">
					<CardHeading>
						<CardTitle size="sm">Attended and volunteered, {CANDIDATE_DAYS} days unbroken</CardTitle>
						<CardDescription>
							Your dated statement about a named person. It changes no role, title or readiness. You decide who leads.
						</CardDescription>
					</CardHeading>
					<CardActions>
						<Button variant="secondary" size="sm" icon={UserAdd01Icon} onClick={onAdd}>
							Record a candidate
						</Button>
					</CardActions>
				</CardHeader>
				{page.candidates.length ? (
					<ul>
						{page.candidates.map((c) => (
							<li
								key={c.personId}
								className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_104px] items-center gap-4 border-t border-line px-[18px] py-4 max-app-md:grid-cols-[minmax(0,1fr)_auto] max-app-md:gap-y-2"
							>
								<div className="min-w-0 max-app-md:col-span-2">
									<div className="font-semibold text-ink">{c.personName}</div>
									<div className="mt-[3px] text-sm text-text-2">{periodText(c)}</div>
									{c.statement ? <div className="mt-1 text-sm text-text-2">{c.statement}</div> : null}
								</div>
								<div className="text-sm leading-[1.45] text-text-2">
									<StatusBadge size="sm" status={c.established ? "positive" : "unknown"}>
										{c.state === "retracted" ? "Retracted" : c.established ? "Established" : "Not established"}
									</StatusBadge>
									{c.state === "answered" && c.reasons.length ? (
										<div className="mt-1.5 text-text-3">{c.reasons.map((r) => REASON_TEXT[r]).join(". ")}.</div>
									) : null}
									<div className="mt-1.5">
										<b className="font-medium text-ink">{c.authorName ?? "A church admin"}</b> · {shortDate(c.asOf)}
									</div>
								</div>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => onOpen(c.personId)}
									aria-label={`Update: ${c.personName}`}
								>
									{c.state === "retracted" ? "Record again" : "Update"}
								</Button>
							</li>
						))}
					</ul>
				) : (
					<p className="border-t border-line px-[18px] py-5 text-sm text-text-3">
						No one yet. Record a person you have seen attend and volunteer, and the date range you stand behind.
					</p>
				)}
			</Card>
		</section>
	);
}

function CandidateDialog({
	page,
	personId,
	viewerName,
	onClose,
	onSave,
	onReload,
	onDone,
}: {
	page: AttestationsPage;
	personId: string | null;
	viewerName: string;
	onClose: () => void;
	onSave: (
		input: Record<string, unknown> & { personId: string },
		action: "attest" | "correct" | "retract",
		revision: string,
		optimistic: CandidateEntry | null,
	) => Promise<string | null>;
	onReload: () => void;
	onDone: (message: string) => void;
}) {
	// The form starts from the candidate as opened; a later optimistic change never rewrites what is typed.
	const [opened] = useState(() => page.candidates.find((c) => c.personId === personId) ?? null);
	const [chosen, setChosen] = useState<string>(personId ?? "");
	const [start, setStart] = useState<string>(opened?.periodStart ?? "");
	const [end, setEnd] = useState<string>(opened?.periodEnd ?? page.today);
	const [attended, setAttended] = useState(opened?.attended ?? true);
	const [volunteered, setVolunteered] = useState(opened?.volunteered ?? true);
	const [asOf, setAsOf] = useState<string>(page.today);
	const [statement, setStatement] = useState(opened?.statement ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const person = page.people.find((p) => p.id === chosen);
	const current = page.candidates.find((c) => c.personId === chosen) ?? null;
	// A Person with a retracted statement is recorded again; one with a current statement is corrected.
	const action = !current || current.state === "retracted" ? "attest" : "correct";
	const revision = person?.candidateRevision ?? "0";
	const days = periodDays(start, end);
	const reasons = draftReasons({ start, end, attended, volunteered });
	const orderWrong = Boolean(start && end && start > end);
	const afterAsOf = Boolean(end && end > asOf);
	const future = asOf > page.today;
	const valid = Boolean(person && start && end && !orderWrong && !afterAsOf && !future);
	const history = page.history.filter((h) => h.key === "leadership_candidate" && h.personId === chosen);

	async function run(what: "attest" | "correct" | "retract", message: string) {
		if (!person) return;
		setBusy(true);
		setError(null);
		const input =
			what === "retract"
				? { personId: person.id }
				: { personId: person.id, periodStart: start, periodEnd: end, attended, volunteered, asOf, statement };
		const stateNow = what === "retract" ? ("retracted" as const) : ("answered" as const);
		const optimistic: CandidateEntry =
			what === "retract" && current
				? { ...current, state: stateNow, established: false, reasons: [], authorName: viewerName }
				: {
						personId: person.id as CandidateEntry["personId"],
						personName: person.displayName,
						state: stateNow,
						attended,
						volunteered,
						periodStart: start as CandidateEntry["periodStart"],
						periodEnd: end as CandidateEntry["periodEnd"],
						days: Math.max(days, 1),
						established: reasons.length === 0,
						reasons,
						asOf: asOf as CandidateEntry["asOf"],
						statement: statement.trim() || null,
						authorName: viewerName,
						recordedAt: new Date().toISOString() as CandidateEntry["recordedAt"],
						revision: String(BigInt(revision) + 1n) as CandidateEntry["revision"],
					};
		const failure = await onSave(input, what, revision, optimistic);
		setBusy(false);
		if (failure) setError(failure);
		else onDone(message);
	}

	return (
		<Dialog open onOpenChange={(next) => (next || busy ? null : onClose())}>
			<DialogContent size="sm">
				<DialogHeader
					title={opened ? opened.personName : "Record a leadership candidate"}
					description={`You attest this person attended and volunteered ${CANDIDATE_DAYS} days unbroken. It changes no role, title or readiness.`}
				/>
				<form
					className="contents"
					onSubmit={(event) => {
						event.preventDefault();
						if (valid && !busy) void run(action, action === "attest" ? "Candidate recorded." : "Candidate updated.");
					}}
				>
					<DialogBody className="flex flex-col gap-4">
						{error ? <Failure text={error} onReload={onReload} /> : null}
						{opened ? null : (
							<Field label="Person" hint="Choose someone in your church's People list.">
								<Combobox
									value={chosen ? [chosen] : []}
									onValueChange={(next) => setChosen(next[0] ?? "")}
									options={page.people.map((p) => ({ value: p.id, label: p.displayName }))}
									placeholder="Choose a person"
									searchLabel="Search people"
								/>
							</Field>
						)}
						<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
							<Field label="Period starts" error={orderWrong ? "The start must be on or before the end." : undefined}>
								<Input
									type="date"
									value={start}
									max={end || page.today}
									onChange={(e) => setStart(e.target.value)}
									invalid={orderWrong}
								/>
							</Field>
							<Field label="Period ends" error={afterAsOf ? "The period cannot end after the as-of date." : undefined}>
								<Input
									type="date"
									value={end}
									max={asOf}
									onChange={(e) => setEnd(e.target.value)}
									invalid={afterAsOf}
								/>
							</Field>
						</div>
						<div className="flex flex-col gap-2.5">
							<Checkbox
								checked={attended}
								onCheckedChange={(v) => setAttended(v === true)}
								label="Attended every week, unbroken"
							/>
							<Checkbox
								checked={volunteered}
								onCheckedChange={(v) => setVolunteered(v === true)}
								label="Volunteered every week, unbroken"
							/>
						</div>
						<div
							className={cn(
								"rounded-md px-4 py-3 text-sm",
								reasons.length ? "bg-surface-2 text-ink-2" : "bg-green-100 text-green-700",
							)}
							aria-live="polite"
						>
							<b className="font-semibold">{days ? `${days} days` : "No period yet"}</b> ·{" "}
							{reasons.length
								? "Not established: " + reasons.map((r) => REASON_TEXT[r].toLowerCase()).join("; ") + "."
								: "Established."}
						</div>
						<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
							<Field label="True as of" error={future ? "A statement cannot be dated in the future." : undefined}>
								<Input
									type="date"
									value={asOf}
									max={page.today}
									onChange={(e) => setAsOf(e.target.value)}
									invalid={future}
								/>
							</Field>
						</div>
						<Field label="Statement" optional>
							<Textarea
								value={statement}
								maxLength={TEXT_MAX}
								rows={2}
								placeholder="What you saw, in your words"
								onChange={(event) => setStatement(event.target.value)}
							/>
						</Field>
						{chosen ? (
							<div>
								<h3 className="mb-2 text-sm font-semibold text-ink">History</h3>
								{history.length ? (
									<ol>
										{history.map((line, i) => (
											<li
												key={line.id}
												className="flex items-start justify-between gap-3 border-t border-line py-2.5 first:border-t-0"
											>
												<div className="min-w-0">
													<div className="font-medium text-ink">{historyText(line)}</div>
													<div className="text-xs text-text-3">
														{line.authorName ?? "A church admin"} · {shortDate(line.asOf)}
													</div>
												</div>
												<span className="text-xs text-text-3">{i === 0 ? "Current" : "Replaced"}</span>
											</li>
										))}
									</ol>
								) : (
									<p className="text-sm text-text-3">No statements about this person yet.</p>
								)}
							</div>
						) : null}
					</DialogBody>
					<DialogFooter>
						{current && current.state === "answered" ? (
							<Button
								type="button"
								variant="ghost"
								disabled={busy}
								className="mr-auto"
								onClick={() => void run("retract", "Candidate retracted.")}
							>
								Retract
							</Button>
						) : null}
						<Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" variant="primary" loading={busy} disabled={!valid}>
							{action === "attest" ? "Record candidate" : "Save changes"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
