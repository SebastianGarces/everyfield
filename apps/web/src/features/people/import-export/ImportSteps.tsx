"use client";

import {
	Alert02Icon,
	ArrowDown01Icon,
	Download04Icon,
	FileImportIcon,
	InformationCircleIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
	Button,
	buttonVariants,
	CalloutLabel,
	CalloutText,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	IntentLink,
	Menu,
	MenuContent,
	MenuItem,
	MenuTrigger,
	SegmentedControl,
} from "@everyfield/ui/controls";
import { Pagination } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	addCount,
	canReview,
	firstGroup,
	plural,
	problemText,
	progressOf,
	ROWS_PER_PAGE,
	rowsIn,
	SOURCE_VALUES,
	type Choice,
	type Group,
	type ImportReceipt,
	type Preview,
	type PreviewRow,
	type ValidRow,
	withReviewTargets,
} from "./model.ts";

import { RECONNECTING, type FailedRow, type Notice, type Review } from "./model.ts";

// The four steps of the People CSV import screen. ImportScreen owns the state; these only draw it.

export type StepKey = "upload" | "review" | "import" | "done";
// ---------------------------------------------------------------------------------------------------------------

const STEPS = [
	{ key: "upload", label: "Upload" },
	{ key: "review", label: "Review" },
	{ key: "import", label: "Import" },
	{ key: "done", label: "Done" },
] as const;

/** The step pills from the prototype's import page. They show progress only; the page's buttons move between steps. */
export function Steps({ current }: { current: StepKey }) {
	const at = STEPS.findIndex((s) => s.key === current);
	return (
		<ol
			aria-label="Import steps"
			className="mb-6 flex w-fit max-w-full gap-1.5 rounded-pill bg-surface-raised p-[5px] shadow-nav"
		>
			{STEPS.map((s, i) => {
				const state = i === at ? "current" : i < at || current === "done" ? "done" : "todo";
				return (
					<li
						key={s.key}
						aria-current={state === "current" ? "step" : undefined}
						className={cn(
							"inline-flex h-9 items-center gap-2 rounded-pill pr-3.5 pl-1.5 text-sm font-medium whitespace-nowrap max-app-sm:pr-1.5",
							state === "current"
								? "bg-ink text-on-ink max-app-sm:pr-3.5"
								: state === "done"
									? "text-text-2"
									: "text-text-3",
						)}
					>
						<span
							aria-hidden="true"
							className={cn(
								"grid size-6 flex-none place-items-center rounded-full text-xs font-semibold",
								state === "current" && "bg-on-ink-soft text-on-ink",
								state === "done" && "bg-green-100 text-green-700",
								state === "todo" && "bg-surface-2",
							)}
						>
							{state === "done" || (s.key === "done" && current === "done") ? (
								<Icon icon={Tick02Icon} size={16} />
							) : (
								i + 1
							)}
						</span>
						<span className={cn(state !== "current" && "max-app-sm:sr-only")}>{s.label}</span>
						{state === "done" ? <span className="sr-only"> (done)</span> : null}
					</li>
				);
			})}
		</ol>
	);
}

function StepHeading({
	heading,
	children,
}: {
	heading: React.RefObject<HTMLHeadingElement | null>;
	children: ReactNode;
}) {
	return (
		<h2 ref={heading} tabIndex={-1} className="font-title text-title-md tracking-[-0.02em] text-ink outline-none">
			{children}
		</h2>
	);
}

function Problem({ notice, actions }: { notice: Notice; actions?: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	// An error takes focus when it appears, so the person hears what went wrong and what to do.
	useEffect(() => ref.current?.focus(), [notice]);
	return (
		<Card
			ref={ref}
			tabIndex={-1}
			variant="callout"
			tone="magenta"
			role="alert"
			data-import-problem=""
			className="outline-none focus-visible:outline-2 focus-visible:outline-focus"
		>
			<CalloutLabel tone="magenta" icon={Alert02Icon}>
				{notice.title}
			</CalloutLabel>
			<CalloutText>{notice.text}</CalloutText>
			{actions ? <div className="mt-4 flex flex-wrap gap-2">{actions}</div> : null}
		</Card>
	);
}

// ---------------------------------------------------------------------------------------------------------------

export function UploadStep({
	heading,
	checking,
	error,
	onFile,
}: {
	heading: React.RefObject<HTMLHeadingElement | null>;
	checking: File | null;
	error: Notice | null;
	onFile: (file: File) => void;
}) {
	const [over, setOver] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	return (
		<div className="grid items-start gap-5 app-lg:grid-cols-[minmax(0,1fr)_340px]">
			<Card className="gap-5">
				<StepHeading heading={heading}>Choose a CSV file</StepHeading>
				{error ? <Problem notice={error} /> : null}
				<label
					onDragOver={(e) => {
						e.preventDefault();
						setOver(true);
					}}
					onDragLeave={() => setOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setOver(false);
						const file = e.dataTransfer.files[0];
						if (file && !checking) onFile(file);
					}}
					aria-busy={checking ? true : undefined}
					className={cn(
						"flex cursor-pointer flex-col items-center gap-3 rounded-card border border-dashed border-line-2 px-6 py-12 text-center transition-[background-color,border-color] duration-150 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus hover:bg-hover max-app-sm:py-8",
						over && "border-ink bg-hover",
						checking && "cursor-progress",
					)}
				>
					<span aria-hidden="true" className="grid size-14 place-items-center rounded-card bg-surface-2 text-text-2">
						<Icon icon={FileImportIcon} size={24} />
					</span>
					<span className="font-medium text-ink">
						{checking ? `Checking ${checking.name}…` : "Drop a CSV file here, or choose one"}
					</span>
					<span className="text-sm text-text-2">CSV UTF-8, up to 10 MB and 10,000 rows</span>
					<span className={cn(buttonVariants({ variant: "primary" }), "mt-2 pointer-events-none")} aria-hidden="true">
						{checking ? "Checking…" : "Choose file"}
					</span>
					<input
						ref={input}
						type="file"
						accept=".csv,text/csv"
						className="sr-only"
						aria-label="Choose a CSV file"
						disabled={checking !== null}
						onChange={(e) => {
							const file = e.currentTarget.files?.[0];
							e.currentTarget.value = "";
							if (file) onFile(file);
						}}
					/>
				</label>
				<p role="status" className="sr-only">
					{checking ? `Checking ${checking.name}` : ""}
				</p>
			</Card>
			<Card size="sm" className="gap-3">
				<h3 className="font-semibold text-ink">Start from the template</h3>
				<p className="text-sm text-text-2 text-pretty">
					The first row names the columns. Everyfield reads first_name, last_name, email, phone, street, city, state,
					postal_code, country, source, source_details and notes. Each person needs a first or last name. Other columns
					are listed and ignored.
				</p>
				<p className="text-sm text-text-2 text-pretty">
					source is one of: {SOURCE_VALUES.join(", ")}. Leave it empty for other.
				</p>
				<a
					href="/api/people/import/template"
					download
					className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
				>
					<Icon icon={Download04Icon} size={16} />
					Download template
				</a>
			</Card>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------------------------

function Stat({ label, value, note, tone }: { label: string; value: number; note: string; tone?: string }) {
	return (
		<Card size="sm">
			<p className="text-md text-text-3">{label}</p>
			<p
				className={cn(
					"mt-2.5 font-display text-display-sm leading-none tracking-[-0.02em] tabular-nums",
					tone ?? "text-ink",
				)}
			>
				{value.toLocaleString("en-US")}
			</p>
			<p className="mt-2 text-sm text-text-3">{note}</p>
		</Card>
	);
}

const CHOICE_LABEL: Record<Choice, string> = {
	create: "Add new",
	create_and_review: "Add, review later",
	skip: "Skip",
};

export function ReviewStep({
	heading,
	review,
	refusal,
	onChoices,
	onCheckAgain,
}: {
	heading: React.RefObject<HTMLHeadingElement | null>;
	review: Review;
	refusal: Notice | null;
	onChoices: (choices: Map<number, Choice>) => void;
	onCheckAgain: () => void;
}) {
	const { preview, choices } = review;
	const { counts } = preview;
	const [group, setGroup] = useState<Group>(() => firstGroup(preview));
	const [page, setPage] = useState(1);
	const shown = rowsIn(preview.rows, group);
	const pages = Math.max(1, Math.ceil(shown.length / ROWS_PER_PAGE));
	const at = Math.min(page, pages);
	const slice = shown.slice((at - 1) * ROWS_PER_PAGE, at * ROWS_PER_PAGE);
	const duplicates = counts.existingDuplicates + counts.withinFileDuplicates;
	// Rows can match both ways; the group counts each row once.
	const toCheck = rowsIn(preview.rows, "check").length;
	const ready = counts.valid - toCheck;
	// A row skipped under its repeat takes away that repeat's review target, so every change rechecks the targets.
	const choose = (next: Map<number, Choice>) => onChoices(withReviewTargets(preview, next));
	const setAll = (choice: Choice) => {
		const next = new Map(choices);
		for (const r of rowsIn(preview.rows, "check")) next.set(r.row, choice);
		choose(next);
	};
	const list = useRef<HTMLDivElement>(null);
	const turn = (p: number) => {
		setPage(p);
		list.current?.scrollIntoView({ block: "start" });
	};

	return (
		<div className="flex flex-col gap-5">
			{refusal ? (
				<Problem
					notice={refusal}
					actions={
						<Button variant="primary" size="sm" onClick={onCheckAgain}>
							Check the file again
						</Button>
					}
				/>
			) : null}
			<div className="grid grid-cols-4 gap-4 max-app-lg:grid-cols-2">
				<Stat label="Ready" value={ready} note="New people" tone="text-green-700" />
				<Stat label="Possible duplicates" value={toCheck} note="Choose for each one" tone="text-amber-600" />
				<Stat label="Need a fix" value={counts.invalid} note="Not imported" tone="text-magenta-600" />
				<Stat
					label="Rows in file"
					value={counts.rows}
					note={plural(addCount(choices), "person", "people") + " to add"}
				/>
			</div>
			{preview.columns.ignored.length ? (
				<Card variant="callout" tone="blue">
					<CalloutLabel tone="blue" icon={InformationCircleIcon}>
						{plural(preview.columns.ignored.length, "column")} not imported
					</CalloutLabel>
					<CalloutText>
						{preview.columns.ignored.join(", ")}. Everyfield reads only the template’s columns, so these stay out.
					</CalloutText>
				</Card>
			) : null}
			<Card className="gap-5">
				<CardHeader className="flex-wrap">
					<CardHeading className="basis-80">
						<StepHeading heading={heading}>Rows to check</StepHeading>
						<CardDescription>
							{duplicates || counts.invalid
								? "Everything else imports as it is. Rows that need a fix are not imported; fix them in the file and import it again."
								: "No duplicates or problems found. Every row imports as it is."}
						</CardDescription>
					</CardHeading>
					<SegmentedControl
						label="Show rows"
						size="sm"
						value={group}
						onValueChange={(g) => {
							setGroup(g);
							setPage(1);
						}}
						options={[
							{ value: "check", label: "Duplicates", count: toCheck },
							{ value: "fix", label: "Need a fix", count: counts.invalid },
							{ value: "all", label: "All", count: counts.rows },
						]}
					/>
				</CardHeader>
				{group === "check" && toCheck > 1 ? (
					<div className="flex flex-wrap items-center gap-2 text-sm text-text-2">
						<Menu>
							<MenuTrigger asChild>
								<Button variant="outline" size="sm">
									Choose for all {toCheck.toLocaleString("en-US")}
									<Icon icon={ArrowDown01Icon} size={16} />
								</Button>
							</MenuTrigger>
							<MenuContent align="start">
								{(["skip", "create_and_review", "create"] as const).map((c) => (
									<MenuItem key={c} onSelect={() => setAll(c)}>
										{CHOICE_LABEL[c]}
									</MenuItem>
								))}
							</MenuContent>
						</Menu>
					</div>
				) : null}
				<div ref={list} className="scroll-mt-24">
					{slice.length === 0 ? (
						<p className="py-10 text-center text-text-2">
							{group === "fix" ? "No rows need a fix." : "No possible duplicates in this file."}
						</p>
					) : (
						<ul aria-label="Rows" className="flex flex-col">
							<li
								aria-hidden="true"
								className="grid grid-cols-[56px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,auto)] gap-4 border-b border-line px-1 pb-3 text-sm text-text-3 max-app-md:hidden"
							>
								<span>Row</span>
								<span>In your file</span>
								<span>Already in Everyfield</span>
								<span className="w-[300px]">What to do</span>
							</li>
							{slice.map((r) => (
								<RowItem
									key={r.row}
									row={r}
									choice={r.status === "valid" ? choices.get(r.row)! : null}
									reviewable={r.status === "valid" && canReview(r, choices)}
									onChoice={(c) => choose(new Map(choices).set(r.row, c))}
									nameOf={(n) => nameOf(preview, n)}
								/>
							))}
						</ul>
					)}
				</div>
				{pages > 1 ? (
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-sm text-text-2 tabular-nums">
							Rows {((at - 1) * ROWS_PER_PAGE + 1).toLocaleString("en-US")}–
							{Math.min(at * ROWS_PER_PAGE, shown.length).toLocaleString("en-US")} of{" "}
							{shown.length.toLocaleString("en-US")}
						</p>
						<Pagination page={at} pageCount={pages} onPageChange={turn} label="Row pages" />
					</div>
				) : null}
			</Card>
		</div>
	);
}

function nameOf(p: Preview, row: number): string {
	const r = p.rows[row - 1];
	return r?.status === "valid" ? r.values.displayName : `Row ${row}`;
}

function contact(r: ValidRow): string {
	return [r.values.email, r.values.phone].filter(Boolean).join(" · ") || "No email or phone";
}

function RowItem({
	row,
	choice,
	reviewable,
	onChoice,
	nameOf,
}: {
	row: PreviewRow;
	choice: Choice | null;
	reviewable: boolean;
	onChoice: (c: Choice) => void;
	nameOf: (row: number) => string;
}) {
	const name = row.status === "valid" ? row.values.displayName : `Row ${row.row}`;
	return (
		<li className="grid grid-cols-[56px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,auto)] items-center gap-4 border-b border-line px-1 py-3.5 last:border-b-0 max-app-md:grid-cols-[40px_minmax(0,1fr)] max-app-md:gap-x-3 max-app-md:gap-y-2">
			<span className="text-sm text-text-3 tabular-nums">
				<span className="sr-only">Row </span>
				{row.row}
			</span>
			<div className="min-w-0">
				{row.status === "valid" ? (
					<>
						<p className="truncate font-medium text-ink">{name}</p>
						<p className="truncate text-sm text-text-2">{contact(row)}</p>
					</>
				) : (
					<>
						<p className="font-medium text-ink">Not imported</p>
						<ul className="mt-0.5 flex flex-col gap-0.5">
							{row.problems.map((p, i) => (
								<li key={i} className="flex items-start gap-1.5 text-sm text-magenta-600">
									<Icon icon={Alert02Icon} size={16} className="mt-0.5 flex-none" />
									{problemText(p)}
								</li>
							))}
						</ul>
					</>
				)}
			</div>
			<div className="min-w-0 max-app-md:col-start-2">
				{row.status === "invalid" ? (
					<p className="text-sm text-text-2">Fix it in the file and import it again</p>
				) : row.existingDuplicates.length ? (
					<>
						<p className="sr-only max-app-md:not-sr-only max-app-md:text-xs max-app-md:text-text-3">
							Already in Everyfield
						</p>
						<p className="truncate font-medium text-ink">
							{row.existingDuplicates.map((d) => d.displayName).join(", ")}
						</p>
						<p className="text-sm text-text-2">Same email or phone</p>
					</>
				) : row.withinFileDuplicateOf !== null ? (
					<>
						<p className="truncate font-medium text-ink">{nameOf(row.withinFileDuplicateOf)}</p>
						<p className="text-sm text-text-2">Same as row {row.withinFileDuplicateOf} in this file</p>
					</>
				) : (
					<p className="text-sm text-text-3 max-app-md:hidden">No match</p>
				)}
			</div>
			<div className="min-w-0 max-app-md:col-span-2">
				{choice !== null && row.status === "valid" ? (
					<SegmentedControl
						label={`What to do with row ${row.row}, ${name}`}
						size="sm"
						value={choice}
						onValueChange={onChoice}
						options={(reviewable
							? (["create", "create_and_review", "skip"] as const)
							: (["create", "skip"] as const)
						).map((c) => ({ value: c, label: CHOICE_LABEL[c] }))}
					/>
				) : null}
			</div>
		</li>
	);
}

// ---------------------------------------------------------------------------------------------------------------

export function ImportStep({
	heading,
	receipt,
	trouble,
	onRetry,
	onStartOver,
}: {
	heading: React.RefObject<HTMLHeadingElement | null>;
	receipt: ImportReceipt | null;
	trouble: Notice | null;
	onRetry: (() => void) | null;
	onStartOver: () => void;
}) {
	const progress = receipt ? progressOf(receipt) : null;
	const blocked = trouble && trouble !== RECONNECTING;
	return (
		<Card className="gap-5">
			<StepHeading heading={heading}>{blocked ? trouble.title : "Importing people"}</StepHeading>
			{blocked ? (
				<>
					<p className="text-text-2 text-pretty">{trouble.text}</p>
					<div className="flex flex-wrap gap-2">
						{onRetry ? (
							<>
								<Button variant="primary" onClick={onRetry}>
									Check again
								</Button>
								<Button variant="ghost" onClick={onStartOver}>
									Start over
								</Button>
							</>
						) : (
							// The outcome is unknown (UNCONFIRMED): People shows what was saved; nothing here sends the import again.
							<IntentLink href="/people" className={buttonVariants({ variant: "primary" })}>
								Go to People
							</IntentLink>
						)}
					</div>
				</>
			) : (
				<>
					<p className="text-text-2 text-pretty">
						Everyfield saves the rows on the server. You can leave this page; the import keeps going, and this link
						shows where it stands.
					</p>
					<div>
						<div
							role="progressbar"
							aria-label="Import progress"
							aria-valuemin={0}
							aria-valuemax={progress?.total ?? 100}
							aria-valuenow={progress?.done}
							aria-valuetext={progress ? `${progress.done} of ${progress.total} rows` : "Starting"}
							className="h-2.5 overflow-hidden rounded-pill bg-surface-2"
						>
							<div
								className={cn(
									"h-full rounded-pill bg-green-600 transition-[width] duration-500 motion-reduce:transition-none",
									!progress && "w-1/12 animate-pulse motion-reduce:animate-none",
								)}
								style={
									progress
										? { width: `${Math.max(4, (progress.done / Math.max(1, progress.total)) * 100)}%` }
										: undefined
								}
							/>
						</div>
						<p className="mt-2.5 text-sm text-text-2 tabular-nums" aria-live="polite">
							{progress
								? `${progress.done.toLocaleString("en-US")} of ${plural(progress.total, "row")} done`
								: "Starting the import…"}
						</p>
					</div>
					{trouble === RECONNECTING ? (
						<p role="status" className="text-sm text-text-2">
							{trouble.text}
						</p>
					) : null}
				</>
			)}
		</Card>
	);
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * The receipt. A partial import offers "Try N rows again" while the server keeps its file; once the file is deleted
 * (7 days after the import stopped), the person uploads the same file again instead (`onRetry` with it).
 */
export function DoneStep({
	heading,
	receipt,
	review,
	working,
	problem,
	onRetry,
	onStartOver,
}: {
	heading: React.RefObject<HTMLHeadingElement | null>;
	receipt: ImportReceipt;
	review: Review | null;
	/** A retry is on its way: the chosen file while it uploads, or true for the kept copy. */
	working: File | boolean;
	problem: Notice | null;
	onRetry: (file?: File) => void;
	onStartOver: () => void;
}) {
	const { counts } = receipt;
	const failed = receipt.rows.filter((r): r is FailedRow => r.status === "failed");
	const invalid = failed.filter((r) => r.reason === "invalid");
	// Every row the import did not add, each with its reason: the ones that need a fix, the ones the job could not
	// write and the ones it never reached.
	const notImported = receipt.rows.filter(
		(r): r is NotImportedRow => r.status === "failed" || r.status === "remaining",
	);
	// Every row still to write: the ones the job tried and could not write, and the ones it never reached.
	const notSaved = counts.remaining;
	const partial = receipt.status === "partial";
	const retry = partial && receipt.fileKept;
	const reupload = partial && !receipt.fileKept;
	const name = (row: number) => (review ? nameOf(review.preview, row) : null);
	const flagged = receipt.rows.filter((r) => r.status === "created" && r.reviewWith !== null).length;

	return (
		<div className="flex flex-col gap-5">
			<Card className="gap-4">
				<div className="flex items-start gap-4">
					<span
						aria-hidden="true"
						className={cn(
							"grid size-11 flex-none place-items-center rounded-pill",
							partial ? "bg-amber-100 text-amber-600" : "bg-green-100 text-green-700",
						)}
					>
						<Icon icon={partial ? Alert02Icon : Tick02Icon} size={20} />
					</span>
					<div className="min-w-0">
						<StepHeading heading={heading}>
							{partial
								? `${plural(counts.created, "person", "people")} added. ${plural(notSaved, "row")} did not save.`
								: `${plural(counts.created, "person", "people")} added`}
						</StepHeading>
						<p className="mt-1.5 text-text-2 text-pretty">
							{retry ? (
								"The other rows are saved. Try the rows that did not save again; nobody is added twice."
							) : reupload ? (
								`Upload the file again to finish the remaining ${plural(notSaved, "row")}.`
							) : flagged ? (
								<>
									{flagged} to review in{" "}
									<IntentLink href="/people/duplicates" className="font-medium text-ink underline underline-offset-2">
										Duplicates
									</IntentLink>
									.
								</>
							) : (
								"Everyone you chose is in People now."
							)}
						</p>
					</div>
				</div>
				{problem ? <Problem notice={problem} /> : null}
				<div className="flex flex-wrap gap-2">
					{retry ? (
						<Button variant="primary" loading={working !== false} onClick={() => onRetry()}>
							Try {plural(notSaved, "row")} again
						</Button>
					) : reupload ? (
						<ChooseAgain working={working} onFile={onRetry} />
					) : null}
					<IntentLink href="/people" className={buttonVariants({ variant: partial ? "secondary" : "primary" })}>
						Go to People
					</IntentLink>
					<Button variant="ghost" onClick={onStartOver}>
						Import another file
					</Button>
				</div>
				{reupload ? (
					<p className="text-sm text-text-2 text-pretty">
						Choose the same file you imported. Rows already added are never added twice.
					</p>
				) : null}
			</Card>
			<div className="grid grid-cols-4 gap-4 max-app-lg:grid-cols-2">
				<Stat label="Added" value={counts.created} note="New people" tone="text-green-700" />
				<Stat label="Skipped" value={counts.skipped} note="By your choice" />
				<Stat
					label="Did not save"
					value={notSaved}
					note={notSaved ? "Can try again" : "None"}
					tone={notSaved ? "text-magenta-600" : undefined}
				/>
				<Stat label="Needed a fix" value={invalid.length} note="Not imported" />
			</div>
			{notImported.length ? (
				<Card className="gap-4">
					<CardHeader>
						<CardHeading>
							<CardTitle as="h3">Rows not imported</CardTitle>
							<CardDescription>Each row with the reason.</CardDescription>
						</CardHeading>
					</CardHeader>
					<NotImportedRows rows={notImported} name={name} />
				</Card>
			) : null}
		</div>
	);
}

/** The file button of an expired partial import: the same file, uploaded again to finish its remaining rows. */
function ChooseAgain({ working, onFile }: { working: File | boolean; onFile: (file: File) => void }) {
	const busy = working !== false;
	return (
		<label
			aria-busy={busy || undefined}
			className={cn(
				buttonVariants({ variant: "primary" }),
				"focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
				busy && "cursor-progress",
			)}
		>
			<Icon icon={FileImportIcon} size={18} />
			{working instanceof File ? `Checking ${working.name}…` : "Choose the file"}
			<input
				type="file"
				accept=".csv,text/csv"
				className="sr-only"
				aria-label="Choose the file this import used"
				disabled={busy}
				onChange={(e) => {
					const file = e.currentTarget.files?.[0];
					e.currentTarget.value = "";
					if (file) onFile(file);
				}}
			/>
		</label>
	);
}

type NotImportedRow = FailedRow | Extract<ImportReceipt["rows"][number], { status: "remaining" }>;

function reasonOf(r: NotImportedRow): string {
	if (r.status === "remaining") return "Not reached. Try it again.";
	if (r.reason === "row_write_failed") return "Could not be saved. Try it again.";
	return r.problems.length ? r.problems.map(problemText).join(". ") : "Needs a fix in the file";
}

function NotImportedRows({ rows, name }: { rows: NotImportedRow[]; name: (row: number) => string | null }) {
	const [page, setPage] = useState(1);
	const pages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
	const slice = rows.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);
	return (
		<>
			<ul aria-label="Rows not imported" className="flex flex-col">
				{slice.map((r) => (
					<li
						key={r.row}
						className="grid grid-cols-[56px_minmax(0,1fr)] gap-4 border-b border-line px-1 py-3 last:border-b-0 max-app-sm:grid-cols-[40px_minmax(0,1fr)] max-app-sm:gap-3"
					>
						<span className="text-sm text-text-3 tabular-nums">
							<span className="sr-only">Row </span>
							{r.row}
						</span>
						<div className="min-w-0">
							<p className="truncate font-medium text-ink">
								{r.status === "failed" && r.reason === "invalid" ? "Needs a fix" : (name(r.row) ?? "Not saved")}
							</p>
							<p className="flex items-start gap-1.5 text-sm text-magenta-600">
								<Icon icon={Alert02Icon} size={16} className="mt-0.5 flex-none" />
								{reasonOf(r)}
							</p>
						</div>
					</li>
				))}
			</ul>
			<Pagination page={page} pageCount={pages} onPageChange={setPage} label="Pages of rows not imported" />
		</>
	);
}
