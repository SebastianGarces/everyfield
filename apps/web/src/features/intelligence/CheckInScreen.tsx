"use client";

import { ArrowLeft01Icon, ArrowRight01Icon, Edit02Icon, LockKeyIcon } from "@hugeicons/core-free-icons";
import {
	CARE_AREAS,
	careLevel,
	NOTE_MAX,
	type CareArea,
	type CareError,
	type CareLevel,
	type CarePage,
	type CareWeek,
	type CareWriteResult,
} from "@everyfield/contracts/intelligence";
import {
	Button,
	CalloutLabel,
	CalloutText,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Field,
	IconButton,
	Textarea,
} from "@everyfield/ui/controls";
import { cn, Icon } from "@everyfield/ui/foundations";
import { RadioGroup } from "radix-ui";
import { useRef, useState } from "react";
import { correctCheckIn, readCheckInHistory, saveCheckIn } from "./actions.ts";
import {
	AREA,
	complete,
	draftOf,
	LEVEL_LABEL,
	missingAreas,
	mondayDate,
	refusalText,
	savedAt,
	shortDate,
	weekNote,
	withAnswer,
	withResult,
	type Draft,
	type Outcome,
} from "./model.ts";
import { CheckInHeader } from "./Header.tsx";

/**
 * The private weekly check-in (prototype #/me/check-in, REQ-PI-038 to REQ-PI-041). The form answers this week or
 * corrects an earlier one; the strip shows the latest twelve weeks, with older pages behind it. A save shows at once
 * in the strip, then confirms or puts the strip back with the reason, keeping what the author typed. It only shows the
 * author's own answers back: no prompt, alert or score.
 */
export function CheckInScreen({ initial, name }: { initial: CarePage; name: string }) {
	const [strip, setStrip] = useState(initial);
	const [older, setOlder] = useState<CarePage | null>(null);
	// The past week being corrected, kept whole so paging the strip never changes which week the form saves.
	const [target, setTarget] = useState<CareWeek | null>(null);
	const thisWeek = strip.weeks[0]!;
	const shown = older ?? strip;
	const editing = target ?? thisWeek;
	const correcting = target !== null;
	const [draft, setDraft] = useState<Draft>(() => draftOf(thisWeek));
	const [pending, setPending] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [failure, setFailure] = useState<{ error: CareError | null } | null>(null);
	const [incomplete, setIncomplete] = useState(false);
	const [paging, setPaging] = useState(false);
	const formRef = useRef<HTMLHeadingElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	// A retry of the same answers after a lost reply reuses its request key, so the server answers from its record.
	const sent = useRef<{ payload: string; key: string } | null>(null);
	const keyFor = (payload: string) => {
		if (sent.current?.payload !== payload) sent.current = { payload, key: crypto.randomUUID() };
		return sent.current.key;
	};

	const choose = (week: CareWeek | null) => {
		setTarget(week && week.ordinal !== thisWeek.ordinal ? week : null);
		setDraft(draftOf(week ?? thisWeek));
		setFailure(null);
		setIncomplete(false);
		setStatus(null);
		// The form comes into view below the sticky top bar, its heading takes focus for keyboard and screen reader users.
		formRef.current?.focus({ preventScroll: true });
		cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	async function submit() {
		if (!complete(draft)) {
			setIncomplete(true);
			return;
		}
		setIncomplete(false);
		setFailure(null);
		setStatus("Saving…");
		setPending(true);
		const week = editing,
			answers = draft.answers,
			note = draft.note;
		const before = { strip, older };
		// Optimistic: the strip shows the new answer at once, on whichever page holds the week.
		setStrip(withAnswer(strip, week, answers, note));
		if (older) setOlder(withAnswer(older, week, answers, note));
		const revision = strip.revision;
		const payload = JSON.stringify({ id: week.id, revision, answers, note });
		const key = keyFor(payload);
		let result: Outcome<CareWriteResult>;
		try {
			result = correcting
				? await correctCheckIn(key, revision, week.id, answers, note)
				: await saveCheckIn(key, revision, answers, note);
		} catch {
			result = { status: "lost" };
		}
		setPending(false);
		if (result.status !== "ok") {
			// Roll back: the strip as it was; the form keeps what the author typed.
			setStrip(before.strip);
			setOlder(before.older);
			setStatus(null);
			setFailure({ error: result.status === "refused" ? result.error : null });
			return;
		}
		sent.current = null;
		const confirmed = result.value;
		setStrip((s) => withResult({ ...s, revision: confirmed.revision }, confirmed));
		setOlder((o) => (o ? withResult({ ...o, revision: confirmed.revision }, confirmed) : o));
		setDraft(draftOf(confirmed.week));
		if (correcting) setTarget(confirmed.week);
		setStatus(
			confirmed.outcome === "unchanged"
				? "Nothing changed, so nothing new was saved."
				: correcting
					? `Correction saved. Your earlier answer stays in your history.`
					: "Check-in saved.",
		);
	}

	async function load(page: number) {
		setPaging(true);
		const result = await readCheckInHistory(page).catch((): Outcome<CarePage> => ({ status: "lost" }));
		setPaging(false);
		if (result.status !== "ok") {
			setFailure({ error: result.status === "refused" ? result.error : null });
			return;
		}
		if (page === 1) {
			setStrip(result.value);
			setOlder(null);
		} else {
			// One calendar revision for every page: the newest read wins.
			setOlder(result.value);
			setStrip((s) => ({ ...s, revision: result.value.revision }));
		}
	}

	const missing = incomplete ? missingAreas(draft) : [];
	const conflict = failure?.error?.code === "revision_conflict";

	return (
		<>
			<CheckInHeader
				name={name}
				subtitle={`A short check-in for you, not for the church. Week of ${mondayDate(thisWeek.startsOn)}.`}
			/>
			<div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] items-start gap-5 max-app-md:grid-cols-1">
				<Card ref={cardRef} className="scroll-mt-28 scroll-mb-6">
					{correcting ? (
						<div className="mb-3 flex flex-wrap items-center gap-3 rounded-md bg-amber-50 px-4 py-3 shadow-[inset_0_0_0_1px_var(--ef-amber-100)]">
							<Icon icon={Edit02Icon} size={18} className="text-amber-600" />
							<span className="min-w-0 flex-1 text-sm text-ink-2">
								Correcting the week of <b className="font-semibold text-ink">{shortDate(editing.startsOn)}</b>. Your
								earlier answers stay in your history.
							</span>
							<Button variant="ghost" size="sm" onClick={() => choose(null)}>
								Back to this week
							</Button>
						</div>
					) : null}
					<CardHeader>
						<CardHeading>
							<CardTitle ref={formRef} tabIndex={-1} className="outline-none">
								{correcting ? `Week of ${shortDate(editing.startsOn)}` : "This week"}
							</CardTitle>
							<CardDescription>Pick the word that fits. There is no score.</CardDescription>
						</CardHeading>
						{editing.answer?.answeredAt ? (
							<span className="flex-none pt-1 text-sm text-text-3">
								Saved {savedAt(editing.answer.answeredAt, shown.zone)}
							</span>
						) : null}
					</CardHeader>
					<div>
						{CARE_AREAS.map((area, i) => (
							<Question
								key={area}
								area={area}
								first={i === 0}
								value={draft.answers[area]}
								missing={missing.includes(area)}
								onChange={(level) => {
									setDraft((d) => ({ ...d, answers: { ...d.answers, [area]: level } }));
									setStatus(null);
								}}
							/>
						))}
					</div>
					<Field
						label="A note for yourself"
						optional
						className="mt-3"
						hint={`Up to ${NOTE_MAX.toLocaleString("en-US")} characters. ${draft.note.length.toLocaleString("en-US")} / ${NOTE_MAX.toLocaleString("en-US")}`}
					>
						<Textarea
							value={draft.note}
							maxLength={NOTE_MAX}
							placeholder="What is on your mind this week?"
							className="min-h-[90px]"
							onChange={(e) => {
								const note = e.target.value;
								setDraft((d) => ({ ...d, note }));
								setStatus(null);
							}}
						/>
					</Field>
					{missing.length ? (
						<p role="alert" className="mt-3 text-sm text-magenta-600">
							Choose an answer for {missing.map((a) => AREA[a].title).join(", ")}.
						</p>
					) : null}
					{failure ? (
						<div
							role="alert"
							className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-magenta-50 px-4 py-3 text-sm text-ink-2"
						>
							<span className="min-w-0 flex-1">
								{failure.error
									? correcting
										? "Your correction was not saved. "
										: "Your check-in was not saved. "
									: null}
								{refusalText(failure.error)}
							</span>
							{conflict ? (
								<Button size="sm" variant="secondary" loading={paging} onClick={() => void load(1)}>
									Load the latest
								</Button>
							) : null}
						</div>
					) : null}
					<div className="mt-4 flex items-center justify-between gap-3 max-app-sm:flex-col-reverse max-app-sm:items-stretch">
						<span className="min-w-0 flex-1 text-sm text-text-3">
							{correcting
								? "A correction becomes the current answer. The earlier one stays in this week's history."
								: "You can change this week until Sunday. After that, a correction keeps the earlier answer."}
						</span>
						<Button variant="primary" loading={pending} onClick={() => void submit()}>
							{correcting ? "Save correction" : "Save check-in"}
						</Button>
					</div>
					<p role="status" className="mt-2 min-h-5 text-right text-sm text-text-3">
						{status}
					</p>
				</Card>
				<div className="flex flex-col gap-5">
					<Card variant="callout" tone="violet">
						<CalloutLabel tone="violet" icon={LockKeyIcon}>
							Private to you
						</CalloutLabel>
						<CalloutText className="text-sm">
							Only you can read your check-ins. They are never shown to your team, other Admins, your network or sending
							church, and never sent to Evry. They do not affect Plant Intelligence or any score. Evry is off while this
							page is open.
						</CalloutText>
					</Card>
					<Card>
						<CardHeader>
							<CardHeading>
								<CardTitle size="sm">{older ? `Earlier weeks, page ${older.page}` : "Your last 12 weeks"}</CardTitle>
								<CardDescription className="text-sm">Select the pencil to correct a past week</CardDescription>
							</CardHeading>
						</CardHeader>
						<Strip page={shown} editing={editing.ordinal} onCorrect={choose} />
						<Legend />
						{shown.pageCount > 1 ? (
							<div className="mt-4 flex items-center justify-between gap-3">
								<Button
									size="sm"
									variant="secondary"
									icon={ArrowLeft01Icon}
									disabled={shown.page >= shown.pageCount || paging}
									onClick={() => void load(shown.page + 1)}
								>
									Older weeks
								</Button>
								<span className="text-xs whitespace-nowrap text-text-3 max-app-sm:sr-only">
									Page {shown.page} of {shown.pageCount}
								</span>
								<Button
									size="sm"
									variant="secondary"
									disabled={shown.page === 1 || paging}
									onClick={() => (shown.page === 2 ? setOlder(null) : void load(shown.page - 1))}
								>
									Newer weeks
									<Icon icon={ArrowRight01Icon} size={16} />
								</Button>
							</div>
						) : null}
					</Card>
				</div>
			</div>
		</>
	);
}

function Question({
	area,
	first,
	value,
	missing,
	onChange,
}: {
	area: CareArea;
	first: boolean;
	value: CareLevel | undefined;
	missing: boolean;
	onChange: (level: CareLevel) => void;
}) {
	const { title, question } = AREA[area];
	return (
		<div
			className={cn(
				"grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-[18px] max-app-sm:grid-cols-1 max-app-sm:gap-3",
				!first && "border-t border-line",
			)}
		>
			<div>
				<div id={`care-${area}`} className="text-[16px] font-semibold text-ink">
					{title}
				</div>
				<div className="mt-[3px] text-sm text-text-2">{question}</div>
			</div>
			<RadioGroup.Root
				aria-labelledby={`care-${area}`}
				aria-invalid={missing || undefined}
				orientation="horizontal"
				value={value ?? ""}
				onValueChange={(v) => onChange(v as CareLevel)}
				className={cn("flex gap-1.5", missing && "rounded-md shadow-[0_0_0_2px_var(--ef-magenta-500)]")}
			>
				{careLevel.options.map((level) => (
					<RadioGroup.Item
						key={level}
						value={level}
						className="inline-flex h-10 flex-1 cursor-pointer items-center justify-center gap-[7px] rounded-md bg-surface-2 px-3.5 text-[14px] font-medium text-ink-2 transition-[background-color,box-shadow] duration-150 hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ef-focus)] data-[state=checked]:bg-surface-raised data-[state=checked]:text-ink data-[state=checked]:shadow-[inset_0_0_0_1.5px_var(--ef-ink),var(--ef-shadow-raised)] max-app-sm:px-2"
					>
						<Dot level={level} className="size-[9px] flex-none rounded-full" />
						{LEVEL_LABEL[level]}
					</RadioGroup.Item>
				))}
			</RadioGroup.Root>
		</div>
	);
}

const DOT: Record<CareLevel | "none", string> = {
	steady: "bg-green-500",
	strained: "bg-amber-500",
	struggling: "bg-magenta-500",
	none: "bg-transparent shadow-[inset_0_0_0_1px_var(--ef-line-2)]",
};
function Dot({ level, className, title }: { level: CareLevel | "none"; className: string; title?: string }) {
	return <span aria-hidden={title ? undefined : true} title={title} className={cn(DOT[level], className)} />;
}

function Strip({ page, editing, onCorrect }: { page: CarePage; editing: number; onCorrect: (week: CareWeek) => void }) {
	return (
		<table className="w-full border-separate border-spacing-x-2.5 border-spacing-y-1.5 text-sm max-app-sm:border-spacing-x-1.5">
			<caption className="sr-only">Your answers by week, newest first</caption>
			<thead>
				<tr>
					<th scope="col" className="w-[110px] text-left text-xs font-semibold text-text-3 max-app-sm:w-[92px]">
						Week of
					</th>
					{CARE_AREAS.map((a) => (
						<th key={a} scope="col" className="text-left text-xs font-semibold text-text-3">
							{AREA[a].short}
						</th>
					))}
					<th scope="col" className="w-7">
						<span className="sr-only">Correct</span>
					</th>
				</tr>
			</thead>
			<tbody>
				{page.weeks.map((week) => {
					const note = weekNote(week, page.zone);
					return (
						<tr key={week.ordinal} aria-current={week.ordinal === editing ? "true" : undefined}>
							<th scope="row" className="text-left align-middle font-medium text-ink">
								{shortDate(week.startsOn)}
								{note ? (
									<small
										className={cn(
											"block text-[11.5px] font-normal",
											note.tone === "amber" ? "text-amber-600" : "text-text-3",
										)}
									>
										{note.text}
									</small>
								) : null}
							</th>
							{CARE_AREAS.map((a) => {
								const level = week.answer?.answers[a];
								return (
									<td key={a} className="align-middle">
										<Dot
											level={level ?? "none"}
											className="block h-2.5 w-full rounded-pill"
											title={`${AREA[a].title}: ${level ? LEVEL_LABEL[level] : "No answer"}`}
										/>
									</td>
								);
							})}
							<td className="align-middle">
								{week.answer && week.id ? (
									<IconButton
										icon={Edit02Icon}
										size="sm"
										label={`Correct the week of ${shortDate(week.startsOn)}`}
										title="Correct this week"
										onClick={() => onCorrect(week)}
										className="size-7 text-text-3 shadow-none hover:bg-surface-2 hover:text-ink"
									/>
								) : null}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

function Legend() {
	return (
		<div className="mt-4 flex flex-wrap gap-4 text-xs text-text-3">
			{(["steady", "strained", "struggling", "none"] as const).map((level) => (
				<span key={level} className="inline-flex items-center gap-2">
					<Dot level={level} className="block h-2.5 w-4 rounded-pill" />
					{level === "none" ? "Skipped" : LEVEL_LABEL[level]}
				</span>
			))}
		</div>
	);
}
