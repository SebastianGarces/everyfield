"use client";

import {
	ArrowRight01Icon,
	Cancel01Icon,
	Edit02Icon,
	InformationCircleIcon,
	Link01Icon,
	LockKeyIcon,
	Tick02Icon,
	UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import { RadioGroup } from "radix-ui";
import { useId, type ComponentPropsWithRef, type ElementType, type ReactNode } from "react";
import { Button, IconButton } from "../controls";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { Avatar, StatusBadge, type Status } from "./Badges";
import { DataTable } from "./DataTable";
import { SOLID, TINT, type Tone } from "./tone";

/* ---------------------------------------------------------------- Communication */

/**
 * DeliveryBar (components.md): Opened, Delivered and Bounced as one bar. Delivered counts only messages the provider
 * confirmed, never ones it merely accepted; the rest of the bar stays empty. A failed send is a faded empty bar.
 */
export function DeliveryBar({
	opened,
	delivered,
	bounced,
	total,
	failed,
	className,
}: {
	opened: number;
	/** Delivered and not opened. */
	delivered: number;
	bounced: number;
	/** All recipients; the gap after the three counts is not yet confirmed. */
	total: number;
	failed?: boolean;
	className?: string;
}) {
	const parts: [number, string][] = [
		[opened, "bg-green-500"],
		[delivered, "bg-blue-300"],
		[bounced, "bg-magenta-500"],
		[Math.max(0, total - opened - delivered - bounced), "bg-transparent"],
	];
	const text = failed
		? "Not sent"
		: `${opened} opened, ${delivered} delivered and not opened, ${bounced} bounced, of ${total}`;
	return (
		<span
			role="img"
			aria-label={text}
			className={cn(
				"flex h-2 w-[120px] gap-0.5 overflow-hidden rounded-full bg-surface-2",
				failed && "opacity-45",
				className,
			)}
		>
			{failed
				? null
				: parts.map(([n, bg], i) =>
						n > 0 ? <span key={i} className={cn("block h-full", bg)} style={{ flex: n }} /> : null,
					)}
		</span>
	);
}

/** RecipientChip (components.md): a person or a group with its count; removable inside the composer. */
export function RecipientChip({
	label,
	count,
	onRemove,
	className,
}: {
	label: string;
	count?: number;
	onRemove?: () => void;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-[30px] items-center gap-1.5 rounded-full bg-surface-2 pr-1.5 pl-2.5 text-sm font-medium whitespace-nowrap text-ink",
				!onRemove && "pr-2.5",
				className,
			)}
		>
			{label}
			{count === undefined ? null : <b className="font-semibold text-text-3 tabular-nums">{count}</b>}
			{onRemove ? (
				<button
					type="button"
					onClick={onRemove}
					aria-label={`Remove ${label}`}
					className="grid size-5 cursor-pointer place-items-center rounded-full text-text-3 transition-colors hover:bg-surface-3 hover:text-ink"
				>
					<Icon icon={Cancel01Icon} size={16} className="size-[13px]" />
				</button>
			) : null}
		</span>
	);
}

/**
 * MergeField (components.md): a {{field}} token. With onInsert it is a button that inserts the field at the cursor;
 * otherwise it marks a field inside a subject or body.
 */
export function MergeField({ name, onInsert }: { name: string; onInsert?: (name: string) => void }) {
	const look =
		"inline-flex h-[22px] items-center rounded-[6px] bg-blue-100 px-[7px] align-[1px] font-mono text-xs font-semibold text-blue-600";
	return onInsert ? (
		<button
			type="button"
			onClick={() => onInsert(name)}
			aria-label={`Insert ${name}`}
			className={cn(look, "cursor-pointer transition-shadow hover:shadow-[inset_0_0_0_1px_var(--ef-blue-300)]")}
		>
			{`{{${name}}}`}
		</button>
	) : (
		<span className={look}>{`{{${name}}}`}</span>
	);
}

/** EmailPreview (components.md): the message as one recipient will get it, with the next-recipient control. */
export function EmailPreview({
	recipient,
	onNext,
	children,
	className,
}: {
	recipient: { name: string; email: string; tone?: Tone };
	onNext?: () => void;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section
			aria-label={`Preview for ${recipient.name}`}
			className={cn("rounded-[16px] bg-surface-2 p-[18px] text-sm leading-[1.6] text-ink-2", className)}
		>
			<div className="mb-3 flex items-center gap-2.5 border-b border-line pb-3">
				<Avatar name={recipient.name} tone={recipient.tone} size="sm" decorative />
				<div className="min-w-0 flex-1">
					<div className="font-medium text-ink">Preview for {recipient.name}</div>
					<div className="truncate text-xs text-text-3">{recipient.email}</div>
				</div>
				{onNext ? (
					<IconButton icon={ArrowRight01Icon} label="Preview the next recipient" size="sm" onClick={onNext} />
				) : null}
			</div>
			{children}
		</section>
	);
}

/** Composer (components.md): To, Template, Subject, Insert, Preview and Actions rows. Email only. */
export function Composer({ className, ...props }: ComponentPropsWithRef<"div">) {
	return <div className={cn("flex flex-col", className)} {...props} />;
}

/** One labelled composer row. `label` names the control inside when `htmlFor` is given. */
export function ComposerRow({
	label,
	htmlFor,
	top,
	children,
}: {
	label: string;
	htmlFor?: string;
	top?: boolean;
	children: ReactNode;
}) {
	const Label: ElementType = htmlFor ? "label" : "span";
	return (
		<div
			className={cn(
				"grid grid-cols-[70px_minmax(0,1fr)] gap-3 border-t border-line py-3 first:border-t-0",
				top ? "items-start" : "items-center",
			)}
		>
			<Label htmlFor={htmlFor} className={cn("text-sm text-text-3", top && "pt-0.5")}>
				{label}
			</Label>
			<div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
		</div>
	);
}
Composer.Row = ComposerRow;

/* ---------------------------------------------------------------- Documents */

export type DocFormat = "pdf" | "docx" | "xlsx";
const FORMAT: Record<DocFormat, string> = {
	pdf: "bg-magenta-100 text-magenta-600",
	docx: "bg-blue-100 text-blue-600",
	xlsx: "bg-green-100 text-green-700",
};

/** FormatChip (components.md): PDF, DOCX or XLSX. */
export function FormatChip({ format }: { format: DocFormat }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center rounded-[5px] px-1.5 text-[11px] font-bold tracking-[0.02em]",
				FORMAT[format],
			)}
		>
			{format.toUpperCase()}
		</span>
	);
}

export type ThumbKind = "page" | "quarter" | "sheet" | "grid-sheet";
const INK: Record<Tone, string> = {
	green: "bg-green-600",
	blue: "bg-blue-600",
	amber: "bg-amber-600",
	magenta: "bg-magenta-600",
	violet: "bg-violet-600",
	teal: "bg-teal-600",
	ink: "bg-ink",
};
const BODY: Record<ThumbKind, string> = {
	page: "bg-[repeating-linear-gradient(var(--ef-surface-2)_0_3px,transparent_3px_7px)]",
	quarter: "bg-[repeating-linear-gradient(var(--ef-surface-2)_0_3px,transparent_3px_7px)]",
	sheet:
		"bg-[linear-gradient(90deg,transparent_32%,var(--ef-line)_32%_33%,transparent_33%_66%,var(--ef-line)_66%_67%,transparent_67%),repeating-linear-gradient(var(--ef-surface-2)_0_1px,transparent_1px_8px)]",
	"grid-sheet":
		"bg-[repeating-linear-gradient(90deg,var(--ef-line)_0_1px,transparent_1px_14px),repeating-linear-gradient(var(--ef-line)_0_1px,transparent_1px_8px)]",
};

function Paper({ kind, tone, back }: { kind: ThumbKind; tone: Tone; back?: boolean }) {
	return (
		<span
			className={cn(
				"flex flex-col gap-1 rounded-[4px] bg-surface-raised px-2 py-[9px] shadow-raised",
				kind === "quarter" ? "aspect-[5/3.2] w-[104px]" : "aspect-[8.5/11] w-[92px]",
				back
					? "absolute translate-x-6 translate-y-[18px] rotate-[5deg] opacity-90"
					: kind === "quarter"
						? "translate-y-1 -rotate-3"
						: "translate-y-2.5 -rotate-2",
			)}
		>
			<span className={cn("h-[5px] w-3/5 rounded-[2px]", INK[tone])} />
			<span className="h-[3px] rounded-[2px] bg-line" />
			{back ? null : <span className="h-[3px] w-[70%] rounded-[2px] bg-line" />}
			<span className={cn("flex-1 rounded-[3px]", BODY[kind])} />
		</span>
	);
}

/**
 * DocThumb (components.md): a drawn page in the shape of the template: page, quarter (cards, two to a sheet),
 * sheet or grid-sheet. Paper stays light in dark mode (the light-token island), as printed paper does.
 */
export function DocThumb({
	kind = "page",
	tone = "blue",
	className,
}: {
	kind?: ThumbKind;
	tone?: Tone;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"ef-light-island relative grid h-[150px] place-items-center overflow-hidden rounded-[14px] bg-surface-2",
				className,
			)}
		>
			{kind === "quarter" ? <Paper kind={kind} tone={tone} back /> : null}
			<Paper kind={kind} tone={tone} />
		</span>
	);
}

export type DocTemplate = {
	id: string;
	name: string;
	description: string;
	/** "Vision meetings · Phase 1". */
	stage: string;
	formats: DocFormat[];
	thumb: ThumbKind;
	tone: Tone;
};

/**
 * DocCard (components.md, Document card): Stage, Thumb, Use, Formats, Name and Description; selected. Cards sit in a
 * DocCardGroup, a radio group: arrows move between cards and the chosen card opens in the side panel.
 */
export function DocCardGroup({
	templates,
	value,
	onValueChange,
	label,
	className,
}: {
	templates: DocTemplate[];
	value: string | null;
	onValueChange: (id: string) => void;
	label: string;
	className?: string;
}) {
	return (
		<RadioGroup.Root
			aria-label={label}
			value={value ?? undefined}
			onValueChange={onValueChange}
			className={cn("grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4", className)}
		>
			{templates.map((t) => (
				<RadioGroup.Item
					key={t.id}
					value={t.id}
					aria-label={`${t.name}, ${t.stage}, ${t.formats.map((f) => f.toUpperCase()).join(" and ")}`}
					className="flex cursor-pointer flex-col gap-3 rounded-lg border border-[var(--ef-card-edge)] bg-surface p-3.5 text-left shadow-card transition-shadow hover:shadow-raised data-[state=checked]:shadow-[0_0_0_2px_var(--ef-ink),var(--ef-shadow-card)]"
				>
					<DocThumb kind={t.thumb} tone={t.tone} />
					<span className="block">
						<span className="flex items-center justify-between gap-2">
							<span className="text-xs text-text-3">{t.stage}</span>
							<span className="flex gap-1">
								{t.formats.map((f) => (
									<FormatChip key={f} format={f} />
								))}
							</span>
						</span>
						<span className="mt-1.5 block font-semibold text-ink">{t.name}</span>
						<span className="mt-2 block text-sm leading-[1.45] text-text-2">{t.description}</span>
					</span>
				</RadioGroup.Item>
			))}
		</RadioGroup.Root>
	);
}

/* ---------------------------------------------------------------- Attestations */

/** An attestation answer. "none" is not answered: it counts as unknown, never as no. */
export type AttestAnswer = "yes" | "no" | "unsure" | "none";
export const ATTEST_LABEL: Record<AttestAnswer, string> = {
	yes: "Yes",
	no: "Not yet",
	unsure: "Not sure",
	none: "Not answered",
};
const ANSWER_FILL: Record<AttestAnswer, string> = {
	yes: "bg-green-100 text-green-700",
	no: "bg-amber-100 text-amber-600",
	unsure: "bg-blue-100 text-blue-600",
	none: "bg-transparent text-text-2 shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]",
};

/** The answer pill of an attestation. */
export function AttestAnswerPill({ answer }: { answer: AttestAnswer }) {
	return (
		<span
			data-answer={answer}
			className={cn(
				"inline-flex h-7 w-max items-center rounded-full px-[11px] text-[13px] font-semibold",
				ANSWER_FILL[answer],
			)}
		>
			{ATTEST_LABEL[answer]}
		</span>
	);
}

/** How fresh an answer is. The feature computes it from the answer date and the renewal period. */
export type Renewal =
	{ kind: "unanswered" } | { kind: "permanent" } | { kind: "due" } | { kind: "current"; daysLeft: number };

function RenewalBadge({ renewal }: { renewal: Renewal }) {
	switch (renewal.kind) {
		case "unanswered":
			return null;
		case "permanent":
			return (
				<StatusBadge plain size="sm">
					Does not expire
				</StatusBadge>
			);
		case "due":
			return (
				<StatusBadge status="attention" size="sm">
					Needs renewing
				</StatusBadge>
			);
		case "current":
			return (
				<StatusBadge status="positive" size="sm">
					Current for {renewal.daysLeft} more {renewal.daysLeft === 1 ? "day" : "days"}
				</StatusBadge>
			);
	}
}

/**
 * AttestationRow (components.md): Question, description, answer, attestor and date, renewal badge, also-on link and
 * action. The action reads Answer, Renew or Update and is primary when the answer is missing or due.
 */
export function AttestationRow({
	question,
	description,
	answer,
	attestor,
	renewal,
	alsoOn,
	onAction,
	readOnly,
	className,
}: {
	question: string;
	description: string;
	answer: AttestAnswer;
	/** Who answered, when and the detail: { name: "Daniel Reyes", when: "Sep 2 · 39 days ago", detail: "Grace Kim" }. */
	attestor?: { name: string; when: string; detail?: string };
	renewal: Renewal;
	alsoOn?: { label: string; href: string };
	onAction?: () => void;
	readOnly?: boolean;
	className?: string;
}) {
	const due = answer === "none" || renewal.kind === "due";
	const verb = answer === "none" ? "Answer" : renewal.kind === "due" ? "Renew" : "Update";
	return (
		<div
			className={cn(
				"grid grid-cols-[minmax(0,1.6fr)_110px_minmax(0,1fr)_auto] items-center gap-4 border-t border-line px-[18px] py-4 first:border-t-0",
				"max-app-md:grid-cols-[minmax(0,1fr)_auto] max-app-md:gap-y-2.5",
				className,
			)}
		>
			<div className="max-app-md:col-span-2">
				<div className="font-semibold text-ink">{question}</div>
				<div className="mt-[3px] text-sm leading-[1.45] text-text-2">{description}</div>
				{alsoOn ? (
					<div className="mt-2 inline-flex items-center gap-[5px] text-xs text-text-2">
						<Icon icon={Link01Icon} size={16} className="size-3.5" />
						Also on{" "}
						<a href={alsoOn.href} className="text-ink-2 underline underline-offset-2">
							{alsoOn.label}
						</a>
					</div>
				) : null}
			</div>
			<div>
				<AttestAnswerPill answer={answer} />
			</div>
			<div className="text-sm leading-[1.45] text-text-2 max-app-md:col-span-2 max-app-md:row-start-3">
				{answer === "none" || !attestor ? (
					<span className="text-text-3">No answer yet</span>
				) : (
					<>
						<b className="font-medium text-ink">{attestor.name}</b>
						<br />
						{attestor.when}
						{attestor.detail ? (
							<>
								<br />
								{attestor.detail}
							</>
						) : null}
						<div className="mt-2">
							<RenewalBadge renewal={renewal} />
						</div>
					</>
				)}
			</div>
			{readOnly || !onAction ? null : (
				<div className="max-app-md:col-start-2 max-app-md:row-start-2 max-app-md:justify-self-end">
					<Button
						variant={due ? "primary" : "secondary"}
						size="sm"
						onClick={onAction}
						aria-label={`${verb}: ${question}`}
					>
						{verb}
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * AttestChip (components.md, Attestation chip): Icon, label and short state, in context on another page. It opens the
 * answer dialog, which the feature owns.
 */
export function AttestChip({
	label,
	answer,
	when,
	onOpen,
	icon = UserCheck01Icon,
}: {
	label: string;
	answer: AttestAnswer;
	/** "Aug 30". */
	when?: string;
	onOpen: () => void;
	icon?: IconSvgElement;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			data-answer={answer}
			className="inline-flex cursor-pointer items-center gap-2 rounded-[10px] bg-surface-2 py-1.5 pr-2.5 pl-2 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-surface-3"
		>
			<Icon
				icon={icon}
				size={16}
				className={cn(
					"size-[15px]",
					answer === "yes" ? "text-green-600" : answer === "unsure" ? "text-blue-600" : "text-amber-600",
				)}
			/>
			<span>
				<b className="font-semibold text-ink">{label}</b>
				{" · "}
				{answer === "yes" && when ? when : ATTEST_LABEL[answer]}
			</span>
		</button>
	);
}

/* ---------------------------------------------------------------- Check-ins */

/** A weekly check-in answer. Null is a skipped question, shown hollow and never as "steady". */
export type Wellbeing = "steady" | "strained" | "struggling";
const WELL_DOT: Record<Wellbeing, string> = {
	steady: "bg-green-500",
	strained: "bg-amber-500",
	struggling: "bg-magenta-500",
};
const WELL_LABEL: Record<Wellbeing, string> = { steady: "Steady", strained: "Strained", struggling: "Struggling" };

export type CheckinQuestion = { id: string; title: string; prompt: string };

/**
 * CheckinForm (components.md, Check-in form): four questions (steady, strained, struggling), a note and the
 * correction banner. Each question is a radio group; a question left empty stays unanswered. mode="correcting" shows
 * the banner for the past week being corrected.
 */
export function CheckinForm({
	questions,
	values,
	onChange,
	note,
	onNoteChange,
	noteMax = 2000,
	mode = "current",
	correctingWeek,
	onBackToCurrent,
	footer,
}: {
	questions: CheckinQuestion[];
	values: Record<string, Wellbeing | null>;
	onChange: (id: string, value: Wellbeing) => void;
	note: string;
	onNoteChange: (note: string) => void;
	noteMax?: number;
	mode?: "current" | "correcting";
	correctingWeek?: string;
	onBackToCurrent?: () => void;
	/** The save row: deadline text and the Save button. */
	footer?: ReactNode;
}) {
	const noteId = useId();
	const countId = useId();
	return (
		<div>
			{mode === "correcting" ? (
				<div className="mb-3 flex flex-wrap items-center gap-3 rounded-[18px] bg-amber-50 px-[18px] py-3.5 shadow-[inset_0_0_0_1px_var(--ef-amber-100)]">
					<Icon icon={Edit02Icon} size={18} className="text-amber-600" />
					<span className="min-w-0 flex-1 text-sm text-ink">
						Correcting the week of <b className="font-semibold">{correctingWeek}</b>. Your earlier answers stay in your
						history.
					</span>
					{onBackToCurrent ? (
						<Button variant="ghost" size="sm" onClick={onBackToCurrent}>
							Back to this week
						</Button>
					) : null}
				</div>
			) : null}
			{questions.map((q) => (
				<CheckinQuestionRow key={q.id} question={q} value={values[q.id] ?? null} onChange={(v) => onChange(q.id, v)} />
			))}
			<div className="mt-3 flex flex-col gap-1.5">
				<label htmlFor={noteId} className="text-sm font-medium text-ink">
					A note for yourself (optional)
				</label>
				<textarea
					id={noteId}
					value={note}
					maxLength={noteMax}
					aria-describedby={countId}
					onChange={(e) => onNoteChange(e.target.value)}
					placeholder="What is on your mind this week?"
					className="min-h-[90px] rounded-md bg-surface-raised px-3.5 py-3 text-ink shadow-[inset_0_0_0_1px_var(--ef-line-2)] outline-none placeholder:text-text-3 focus-visible:shadow-[inset_0_0_0_1.5px_var(--ef-ink-2)]"
				/>
				<div className="flex justify-between text-xs text-text-3">
					<span>Up to {noteMax} characters.</span>
					<span id={countId}>
						{note.length} / {noteMax}
					</span>
				</div>
			</div>
			{footer ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3">{footer}</div> : null}
		</div>
	);
}

function CheckinQuestionRow({
	question,
	value,
	onChange,
}: {
	question: CheckinQuestion;
	value: Wellbeing | null;
	onChange: (v: Wellbeing) => void;
}) {
	const titleId = useId();
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-line py-[18px] first-of-type:border-t-0 max-app-sm:grid-cols-1 max-app-sm:gap-2.5">
			<div>
				<div id={titleId} className="text-base font-semibold text-ink">
					{question.title}
				</div>
				<div className="mt-[3px] text-sm text-text-2">{question.prompt}</div>
			</div>
			<RadioGroup.Root
				aria-labelledby={titleId}
				orientation="horizontal"
				value={value ?? ""}
				onValueChange={(v) => onChange(v as Wellbeing)}
				className="flex gap-1.5"
			>
				{(Object.keys(WELL_LABEL) as Wellbeing[]).map((w) => (
					<RadioGroup.Item
						key={w}
						value={w}
						className="inline-flex h-10 cursor-pointer items-center gap-[7px] rounded-[12px] bg-surface-2 px-3.5 text-sm font-medium text-ink-2 transition-[background-color,box-shadow] hover:bg-surface-3 data-[state=checked]:bg-surface-raised data-[state=checked]:text-ink data-[state=checked]:shadow-[inset_0_0_0_1.5px_var(--ef-ink),var(--ef-shadow-raised)] max-app-sm:flex-1 max-app-sm:justify-center max-app-sm:px-2"
					>
						<span aria-hidden="true" className={cn("size-[9px] rounded-full", WELL_DOT[w])} />
						{WELL_LABEL[w]}
					</RadioGroup.Item>
				))}
			</RadioGroup.Root>
		</div>
	);
}

export type CheckinWeek = {
	week: string;
	/** "this week" or "Corrected Sep 24 · Pace was Strained". */
	note?: string;
	corrected?: boolean;
	values: (Wellbeing | null)[];
	onCorrect?: () => void;
};

/**
 * CheckinHistory (components.md, Check-in history): Week, four dots, correction note and the correct action; skipped.
 * It is a table: the column headers name each dot, and each dot's word is in the cell for screen readers.
 */
export function CheckinHistory({
	columns,
	weeks,
	label = "Your last 12 weeks",
	className,
}: {
	columns: string[];
	weeks: CheckinWeek[];
	label?: string;
	className?: string;
}) {
	return (
		<div className={className}>
			<table className="w-full table-fixed border-separate border-spacing-x-2.5 border-spacing-y-1.5 text-sm">
				<caption className="sr-only">{label}</caption>
				<thead>
					<tr>
						<th scope="col" className="w-[110px] text-left text-xs font-semibold text-text-3">
							Week of
						</th>
						{columns.map((c) => (
							<th key={c} scope="col" className="text-left text-xs font-semibold text-text-3">
								{c}
							</th>
						))}
						<th scope="col" className="w-7">
							<span className="sr-only">Correct</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{weeks.map((w) => (
						<tr key={w.week}>
							<th scope="row" className="text-left font-medium text-ink">
								{w.week}
								{w.note ? (
									<small
										className={cn("block text-[11.5px] font-normal", w.corrected ? "text-amber-600" : "text-text-3")}
									>
										{w.note}
									</small>
								) : null}
							</th>
							{w.values.map((v, i) => (
								<td key={i}>
									<span
										aria-hidden="true"
										className={cn(
											"block h-2.5 w-full rounded-full",
											v ? WELL_DOT[v] : "shadow-[inset_0_0_0_1px_var(--ef-line-2)]",
										)}
									/>
									<span className="sr-only">{v ? WELL_LABEL[v] : "Skipped"}</span>
								</td>
							))}
							<td>
								{w.onCorrect ? (
									<button
										type="button"
										onClick={w.onCorrect}
										aria-label={`Correct the week of ${w.week}`}
										className="grid size-7 cursor-pointer place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-surface-2 hover:text-ink"
									>
										<Icon icon={Edit02Icon} size={16} />
									</button>
								) : null}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<ul aria-hidden="true" className="mt-4 flex flex-wrap gap-4 text-xs text-text-3">
				{(Object.keys(WELL_LABEL) as Wellbeing[]).map((w) => (
					<li key={w} className="flex items-center gap-2">
						<span className={cn("h-2.5 w-4 rounded-full", WELL_DOT[w])} />
						{WELL_LABEL[w]}
					</li>
				))}
				<li className="flex items-center gap-2">
					<span className="h-2.5 w-4 rounded-full shadow-[inset_0_0_0_1px_var(--ef-line-2)]" />
					Skipped
				</li>
			</ul>
		</div>
	);
}

/** The "Only you" tag of private pages. */
export function PrivateTag({ children = "Only you" }: { children?: ReactNode }) {
	return (
		<span className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-violet-100 px-3 text-[13px] font-semibold text-violet-600">
			<Icon icon={LockKeyIcon} size={16} />
			{children}
		</span>
	);
}

/* ---------------------------------------------------------------- Merge */

export type MergeSide = "keep" | "remove";
export type MergeFieldRow = {
	id: string;
	label: string;
	keep: ReactNode | null;
	remove: ReactNode | null;
	/** Plain text of each value, for the radio names. */
	keepText: string;
	removeText: string;
};

/**
 * MergeReview (components.md): Header pair and Field rows, with MergeOption choices; selected and empty. Each field
 * is a radio group of the two values; an empty value says "None" and cannot be chosen over a real one.
 */
export function MergeReview({
	keep,
	remove,
	fields,
	choices,
	onChoose,
	className,
}: {
	keep: { name: string; meta: string; tone?: Tone };
	remove: { name: string; meta: string; tone?: Tone };
	fields: MergeFieldRow[];
	choices: Record<string, MergeSide>;
	onChoose: (fieldId: string, side: MergeSide) => void;
	className?: string;
}) {
	const grid =
		"grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 max-app-sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]";
	return (
		<div className={className}>
			<div className={cn(grid, "mb-1.5 border-b border-line pb-3.5")}>
				<span className="max-app-sm:hidden" />
				{[
					[keep, "Keep"],
					[remove, "Remove"],
				].map(([p, word]) => {
					const person = p as typeof keep;
					return (
						<div key={word as string} className="flex min-w-0 items-center gap-3">
							<Avatar name={person.name} tone={person.tone} decorative />
							<div className="min-w-0">
								<div className="truncate font-semibold text-ink">{person.name}</div>
								<div className="truncate text-xs text-text-3">{person.meta}</div>
							</div>
							<StatusBadge plain size="sm" className="ml-auto max-app-sm:hidden">
								{word as string}
							</StatusBadge>
						</div>
					);
				})}
			</div>
			{fields.map((f) => (
				<RadioGroup.Root
					key={f.id}
					aria-label={f.label}
					orientation="horizontal"
					value={choices[f.id]}
					onValueChange={(v) => onChoose(f.id, v as MergeSide)}
					className={cn(grid, "py-2")}
				>
					<span aria-hidden="true" className="text-sm text-text-3 max-app-sm:col-span-2">
						{f.label}
					</span>
					<MergeOption value="keep" label={`${f.label}: ${f.keepText}`} empty={f.keep === null}>
						{f.keep}
					</MergeOption>
					<MergeOption value="remove" label={`${f.label}: ${f.removeText}`} empty={f.remove === null}>
						{f.remove}
					</MergeOption>
				</RadioGroup.Root>
			))}
		</div>
	);
}

/** MergeOption: one value as a radio card. An empty value is shown as "None" and disabled. */
export function MergeOption({
	value,
	label,
	empty,
	children,
}: {
	value: MergeSide;
	label: string;
	empty?: boolean;
	children: ReactNode;
}) {
	return (
		<RadioGroup.Item
			value={value}
			disabled={empty}
			aria-label={empty ? `${label.split(":")[0]}: none` : label}
			className="group/opt flex min-h-[46px] min-w-0 cursor-pointer items-center gap-2.5 rounded-[14px] bg-surface-raised px-3.5 text-left text-ink shadow-[inset_0_0_0_1px_var(--ef-line)] transition-shadow data-[disabled]:cursor-default data-[disabled]:text-text-3 data-[state=checked]:shadow-[0_0_0_2px_var(--ef-ink)]"
		>
			<span
				aria-hidden="true"
				className="size-[18px] flex-none rounded-full shadow-[inset_0_0_0_1.5px_var(--ef-text-3)] group-data-[disabled]/opt:shadow-[inset_0_0_0_1.5px_var(--ef-line-2)] group-data-[state=checked]/opt:shadow-[inset_0_0_0_5px_var(--ef-ink)]"
			/>
			<span className="min-w-0 truncate">{empty ? "None" : children}</span>
		</RadioGroup.Item>
	);
}

/**
 * The merge blockers card: "Nothing blocks this merge" with the rule, or the list of what stops it (the refused
 * state). A refused merge keeps the Merge action disabled; the feature decides the blockers.
 */
export function MergeBlockers({ blockers, rule }: { blockers: string[]; rule: ReactNode }) {
	const clear = blockers.length === 0;
	return (
		<div role={clear ? undefined : "alert"}>
			<div
				className={cn("flex items-center gap-2 text-sm font-semibold", clear ? "text-green-700" : "text-magenta-600")}
			>
				<span
					aria-hidden="true"
					className={cn("grid size-6 place-items-center rounded-full", clear ? "bg-green-100" : "bg-magenta-100")}
				>
					<Icon icon={clear ? Tick02Icon : InformationCircleIcon} size={16} className="size-3.5" />
				</span>
				{clear
					? "Nothing blocks this merge"
					: blockers.length === 1
						? "One thing blocks this merge"
						: `${blockers.length} things block this merge`}
			</div>
			{clear ? null : (
				<ul className="mt-2 list-disc pl-5 text-sm text-ink-2">
					{blockers.map((b) => (
						<li key={b}>{b}</li>
					))}
				</ul>
			)}
			<p className="mt-2 text-sm text-text-2">{rule}</p>
		</div>
	);
}

/* ---------------------------------------------------------------- Choices */

/**
 * PhaseOption (components.md): Number, Name, Description and Check; selected. Options sit in a PhaseOptions radio
 * group, so arrows move between phases and the chosen one is announced.
 */
export function PhaseOptions({
	phases,
	value,
	onValueChange,
	label,
	className,
}: {
	phases: { number: number; name: string; description: string }[];
	value: number | null;
	onValueChange: (phase: number) => void;
	label: string;
	className?: string;
}) {
	return (
		<RadioGroup.Root
			aria-label={label}
			value={value === null ? "" : String(value)}
			onValueChange={(v) => onValueChange(Number(v))}
			className={cn(
				"grid grid-cols-2 gap-3 max-app-sm:grid-cols-1 [&>*:last-child:nth-child(odd)]:col-span-full",
				className,
			)}
		>
			{phases.map((p) => (
				<RadioGroup.Item
					key={p.number}
					value={String(p.number)}
					className="group/po relative flex cursor-pointer items-center gap-3.5 rounded-[18px] border border-line bg-surface-raised px-[18px] py-4 text-left shadow-card transition-shadow data-[state=checked]:shadow-[0_0_0_2px_var(--ef-ink),var(--ef-shadow-card)]"
				>
					<span
						aria-hidden="true"
						className="grid size-[34px] flex-none place-items-center rounded-[11px] bg-surface-2 font-display font-semibold text-ink group-data-[state=checked]/po:bg-ink group-data-[state=checked]/po:text-on-ink"
					>
						{p.number}
					</span>
					<span className="flex min-w-0 flex-1 flex-col gap-[3px]">
						<b className="font-semibold text-ink">{p.name}</b>
						<span className="text-sm text-text-3">{p.description}</span>
					</span>
					<RadioGroup.Indicator>
						<Icon icon={Tick02Icon} size={18} className="text-ink" />
					</RadioGroup.Indicator>
				</RadioGroup.Item>
			))}
		</RadioGroup.Root>
	);
}

/**
 * CheckInRow (components.md, Check-in row): Avatar, Name, Note and Check; here. A toggle button 58px tall for a thumb
 * at the door: pressing it marks the person here, pressing again undoes a wrong tap.
 */
export function CheckInRow({
	name,
	note,
	tone,
	here,
	onHereChange,
	className,
}: {
	name: string;
	note?: string;
	tone?: Tone;
	here: boolean;
	onHereChange: (here: boolean) => void;
	className?: string;
}) {
	return (
		<button
			type="button"
			aria-pressed={here}
			onClick={() => onHereChange(!here)}
			data-focus-inset=""
			className={cn(
				"flex min-h-[58px] w-full cursor-pointer items-center gap-3 rounded-[16px] px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--ef-line)] transition-colors",
				here ? "bg-green-50" : "bg-surface-raised hover:bg-surface-2",
				className,
			)}
		>
			<Avatar name={name} tone={tone} size="sm" decorative />
			<span className="min-w-0 flex-1">
				<span className="block font-medium text-ink">{name}</span>
				{note ? <span className="block text-xs text-text-3">{note}</span> : null}
			</span>
			<span
				aria-hidden="true"
				className={cn(
					"grid size-8 place-items-center rounded-full transition-colors",
					here ? "bg-green-500 text-ink-fixed" : "text-transparent shadow-[inset_0_0_0_1.5px_var(--ef-line-2)]",
				)}
			>
				<Icon icon={Tick02Icon} size={16} />
			</span>
		</button>
	);
}

/**
 * OutcomeOption (components.md): one outcome of a follow-up as a large radio card (We talked, No answer, No longer
 * needed). Options sit in an OutcomeOptions radio group.
 */
export function OutcomeOptions({
	options,
	value,
	onValueChange,
	label,
	className,
}: {
	options: { id: string; title: string; description: string; icon: IconSvgElement }[];
	value: string | null;
	onValueChange: (id: string) => void;
	label: string;
	className?: string;
}) {
	return (
		<RadioGroup.Root
			aria-label={label}
			value={value ?? ""}
			onValueChange={onValueChange}
			className={cn("flex flex-col gap-2", className)}
		>
			{options.map((o) => (
				<RadioGroup.Item
					key={o.id}
					value={o.id}
					className="group/oo flex min-h-[58px] w-full cursor-pointer items-center gap-3 rounded-[14px] bg-surface-raised px-3.5 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--ef-line)] transition-shadow data-[state=checked]:shadow-[0_0_0_2px_var(--ef-ink)]"
				>
					<Icon icon={o.icon} size={20} className="text-text-3 group-data-[state=checked]/oo:text-green-600" />
					<span className="flex flex-col">
						<b className="font-semibold text-ink">{o.title}</b>
						<span className="text-xs text-text-3">{o.description}</span>
					</span>
				</RadioGroup.Item>
			))}
		</RadioGroup.Root>
	);
}

/* ---------------------------------------------------------------- Network */

export type Share = "shared" | "empty" | "withheld";

/**
 * CategoryCard (components.md, Sharing category card): Header, share tag, metric and chart; shared, empty or
 * withheld. Withheld is a dashed card that says it is a choice, not a zero; empty is shared with nothing yet.
 */
export function CategoryCard({
	title,
	icon,
	tone = "blue",
	share,
	children,
	className,
}: {
	title: string;
	icon: IconSvgElement;
	tone?: Tone;
	share: Share;
	/** The metric and chart for shared; the explanation sentence for empty and withheld. */
	children: ReactNode;
	className?: string;
}) {
	return (
		<article
			aria-label={title}
			data-share={share}
			className={cn(
				"flex flex-col rounded-card px-7 py-[26px] max-app-sm:px-5 max-app-sm:py-5",
				share === "withheld"
					? "border-[1.5px] border-dashed border-line-2 bg-transparent"
					: "border border-[var(--ef-card-edge)] bg-surface shadow-card",
				className,
			)}
		>
			<div className="mb-3.5 flex items-center gap-2.5">
				<span aria-hidden="true" className={cn("grid size-[34px] place-items-center rounded-full", TINT[tone])}>
					<Icon icon={icon} size={16} className="size-[17px]" />
				</span>
				<h3 className="font-body text-base font-semibold tracking-normal text-ink">{title}</h3>
				<span
					className={cn(
						"ml-auto inline-flex items-center gap-[5px] rounded-full px-[9px] py-[3px] text-xs font-semibold",
						share === "shared" ? "bg-green-100 text-green-700" : "bg-surface-2 text-text-2",
					)}
				>
					{share === "shared" ? <Icon icon={Tick02Icon} size={16} className="size-3" /> : null}
					{share === "withheld" ? <Icon icon={LockKeyIcon} size={16} className="size-3" /> : null}
					{share === "shared" ? "Shared" : share === "empty" ? "Shared · nothing yet" : "Not shared"}
				</span>
			</div>
			{share === "shared" ? children : <p className="text-sm text-text-2">{children}</p>}
		</article>
	);
}

/** A proportional strip of counts, such as people per stage. The counts are listed for screen readers. */
export function StageStrip({
	label,
	segments,
	className,
}: {
	label: string;
	segments: { label: string; count: number; tone: Tone | "muted" }[];
	className?: string;
}) {
	return (
		<div className={className}>
			<div aria-hidden="true" className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
				{segments.map((s) =>
					s.count > 0 ? (
						<span
							key={s.label}
							className={s.tone === "muted" ? "bg-surface-3" : SOLID[s.tone]}
							style={{ flex: s.count }}
						/>
					) : null,
				)}
			</div>
			<p className="sr-only">
				{label}: {segments.map((s) => `${s.label} ${s.count}`).join(", ")}
			</p>
		</div>
	);
}

export type AreaStanding = { status: Status; label: string } | "few";
export type AreaRow = {
	area: string;
	plants: number;
	sharing: number;
	lenses: AreaStanding[];
	gap: string | null;
};

/**
 * AreaTable (components.md): Area, plants, sharing, lens badges and gap, listed by size, not score. An area with fewer
 * than two plants shows "Needs 2 plants" instead of a standing, so no single plant can be singled out.
 */
export function AreaTable({
	rows,
	lensNames,
	caption = "By area",
}: {
	rows: AreaRow[];
	lensNames: string[];
	caption?: string;
}) {
	const standing = (s: AreaStanding) =>
		s === "few" ? (
			<span className="inline-flex items-center gap-1.5 text-[12.5px] whitespace-nowrap text-text-2">
				<Icon icon={InformationCircleIcon} size={16} className="size-3.5" />
				Needs 2 plants
			</span>
		) : (
			<StatusBadge status={s.status} size="sm">
				{s.label}
			</StatusBadge>
		);
	return (
		<DataTable
			caption={caption}
			minWidth={680}
			state={{ status: "ready", data: rows }}
			rowId={(r) => r.area}
			rowLabel={(r) => r.area}
			empty={{ title: "No areas yet", text: "Areas appear when plants share their location." }}
			columns={[
				{ key: "area", header: "Area", cell: (r) => <span className="font-medium">{r.area}</span> },
				{ key: "plants", header: "Plants", cell: (r) => r.plants, numeric: true },
				{ key: "sharing", header: "Share findings", cell: (r) => r.sharing, numeric: true },
				...lensNames.map((name, i) => ({
					key: `lens${i}`,
					header: name,
					cell: (r: AreaRow) => (r.lenses[i] ? standing(r.lenses[i]) : null),
				})),
				{
					key: "gap",
					header: "Most common gap",
					cell: (r) =>
						r.gap ? (
							<span className="text-sm text-text-2">{r.gap}</span>
						) : (
							<span className="text-sm text-text-3">Not shown</span>
						),
				},
			]}
		/>
	);
}
