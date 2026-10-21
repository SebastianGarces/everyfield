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
	PageHeader,
	SegmentedControl,
} from "@everyfield/ui/controls";
import { Pagination } from "@everyfield/ui/display";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
	addCount,
	choicesPayload,
	fileRefusal,
	firstGroup,
	isDuplicate,
	MAX_BYTES,
	plural,
	problemText,
	progressOf,
	ROWS_PER_PAGE,
	rowsIn,
	SOURCE_VALUES,
	suggestedChoices,
	type Choice,
	type Group,
	type ImportReceipt,
	type Preview,
	type PreviewRow,
	type ValidRow,
} from "./model.ts";

// People CSV import (REQ-PPL-018): upload, review every row, import as one background job, then the receipt. The
// file never leaves this page as parsed rows: the server reads the bytes itself, at preview and again at import.
// One import has one request key, made when the person presses Import. It lives in the address (?import=), so a
// lost reply or a reload reads the same import's receipt instead of starting a second one.

type FailedRow = Extract<ImportReceipt["rows"][number], { status: "failed" }>;
type Review = { file: File; preview: Preview; choices: Map<number, Choice> };
type Notice = { title: string; text: string };
type State =
	| { step: "upload"; checking: File | null; error: Notice | null }
	| { step: "review"; review: Review; refusal: Notice | null }
	| { step: "import"; review: Review | null; key: string; receipt: ImportReceipt | null; trouble: Notice | null }
	| { step: "done"; review: Review | null; key: string; receipt: ImportReceipt };

/** What the page found for ?import= when it loaded. */
export type Initial =
	| { kind: "none" }
	| { kind: "receipt"; key: string; receipt: ImportReceipt }
	| { kind: "missing"; key: string }
	| { kind: "lost"; key: string };

type Answer<T> = { status: "ok"; value: T } | { status: "refused"; code: string; line?: number } | { status: "lost" };
async function call<T>(input: string, init?: RequestInit): Promise<Answer<T>> {
	try {
		const res = await fetch(input, { ...init, cache: "no-store" });
		const body = (await res.json().catch(() => null)) as Answer<T> | null;
		return body && (body.status === "ok" || body.status === "refused") ? body : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}
const readReceipt = (key: string) => call<ImportReceipt>(`/api/people/import?key=${encodeURIComponent(key)}`);
const address = (key: string | null) =>
	window.history.replaceState(null, "", key ? `/people/import?import=${key}` : "/people/import");

const finished = (r: ImportReceipt) => r.status !== "in_progress";

export function ImportScreen({ initial }: { initial: Initial }) {
	const [state, setState] = useState<State>(() => {
		if (initial.kind === "receipt")
			return finished(initial.receipt)
				? { step: "done", review: null, key: initial.key, receipt: initial.receipt }
				: { step: "import", review: null, key: initial.key, receipt: initial.receipt, trouble: null };
		if (initial.kind === "lost")
			return { step: "import", review: null, key: initial.key, receipt: null, trouble: LOST_CHECK };
		return {
			step: "upload",
			checking: null,
			error: initial.kind === "missing" ? NOT_FOUND : null,
		};
	});
	const heading = useRef<HTMLHeadingElement>(null);
	const step = state.step;
	// A new step moves focus to its heading, so keyboard and screen reader users start there.
	const first = useRef(true);
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		heading.current?.focus();
	}, [step]);

	const check = async (picked: File) => {
		if (picked.size > MAX_BYTES) {
			setState({ step: "upload", checking: null, error: fileRefusal("file_too_large") });
			return;
		}
		setState({ step: "upload", checking: picked, error: null });
		// The reviewed bytes stay in memory, so the import sends exactly what was previewed even if the file on disk
		// changes or moves afterwards.
		const file = new File([await picked.arrayBuffer()], picked.name, { type: "text/csv" });
		const got = await call<Preview>("/api/people/import/preview", {
			method: "POST",
			headers: { "Content-Type": "text/csv" },
			body: file,
		});
		if (got.status === "ok")
			setState({
				step: "review",
				review: { file, preview: got.value, choices: suggestedChoices(got.value) },
				refusal: null,
			});
		else
			setState({
				step: "upload",
				checking: null,
				error: fileRefusal(got.status === "lost" ? "lost" : got.code, got.status === "refused" ? got.line : undefined),
			});
	};

	/** Sends the reviewed import under its key. The same key repeats it safely after a lost reply or a partial import. */
	const send = async (review: Review, key: string) => {
		setState({ step: "import", review, key, receipt: null, trouble: null });
		const form = new FormData();
		form.set("file", review.file);
		form.set(
			"review",
			JSON.stringify({
				requestKey: key,
				fileDigest: review.preview.fileDigest,
				reviewDigest: review.preview.reviewDigest,
				choices: choicesPayload(review.choices),
			}),
		);
		const got = await call<ImportReceipt>("/api/people/import", { method: "POST", body: form });
		if (got.status === "ok") return settle(review, key, got.value);
		if (got.status === "lost") return confirm(review, key);
		address(null);
		setState({ step: "review", review, refusal: importRefusal(got.code) });
	};

	/** After a lost reply: the receipt says whether the import started. Nothing is sent again without a press. */
	const confirm = async (review: Review | null, key: string) => {
		setState({ step: "import", review, key, receipt: null, trouble: null });
		const got = await readReceipt(key);
		if (got.status === "ok") return settle(review, key, got.value);
		setState({ step: "import", review, key, receipt: null, trouble: got.status === "lost" ? LOST_CHECK : NOT_STARTED });
	};

	const settle = (review: Review | null, key: string, receipt: ImportReceipt) =>
		setState(
			finished(receipt)
				? { step: "done", review, key, receipt }
				: { step: "import", review, key, receipt, trouble: null },
		);

	// While the job runs, read its receipt about once a second. A failed read waits longer, then tries again.
	const running = state.step === "import" && state.receipt !== null ? state : null;
	const runningKey = running?.key;
	useEffect(() => {
		if (!runningKey) return;
		let wait = 1000;
		let timer: ReturnType<typeof setTimeout>;
		let stopped = false;
		const tick = async () => {
			const got = await readReceipt(runningKey);
			if (stopped) return;
			if (got.status === "ok") {
				wait = 1000;
				setState((s) => (s.step === "import" && s.key === runningKey ? next(s, got.value) : s));
				if (finished(got.value)) return;
			} else {
				wait = Math.min(wait * 2, 8000);
				setState((s) => (s.step === "import" && s.key === runningKey ? { ...s, trouble: RECONNECTING } : s));
			}
			timer = setTimeout(tick, wait);
		};
		timer = setTimeout(tick, wait);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [runningKey]);

	const startOver = () => {
		address(null);
		setState({ step: "upload", checking: null, error: null });
	};

	const review = state.step === "review" ? state.review : null;
	const adding = review ? addCount(review.choices) : 0;
	const fileName = state.step === "upload" ? null : (state.review?.file.name ?? null);

	return (
		<>
			<PageHeader
				size="xl"
				title="Import people"
				breadcrumb={[{ label: "People", href: "/people" }, { label: "Import" }]}
				subtitle={
					review
						? `${review.file.name} · ${plural(review.preview.counts.rows, "row")}`
						: fileName
							? fileName
							: "Add the people you already know from a spreadsheet."
				}
				actions={
					review ? (
						<>
							<Button variant="ghost" onClick={startOver}>
								Choose another file
							</Button>
							<Button
								variant="primary"
								disabled={adding === 0}
								onClick={() => {
									const key = crypto.randomUUID();
									address(key);
									void send(review, key);
								}}
							>
								{adding === 0 ? "Nobody to import" : `Import ${plural(adding, "person", "people")}`}
							</Button>
						</>
					) : state.step === "upload" ? (
						<IntentLink href="/people" className={buttonVariants({ variant: "ghost" })}>
							Cancel
						</IntentLink>
					) : null
				}
			/>
			<Steps current={state.step} />
			{state.step === "upload" ? (
				<UploadStep heading={heading} checking={state.checking} error={state.error} onFile={check} />
			) : state.step === "review" ? (
				<ReviewStep
					heading={heading}
					review={state.review}
					refusal={state.refusal}
					onChoices={(choices) => setState({ ...state, review: { ...state.review, choices }, refusal: null })}
					onCheckAgain={() => check(state.review.file)}
				/>
			) : state.step === "import" ? (
				<ImportStep
					heading={heading}
					receipt={state.receipt}
					trouble={state.trouble}
					onRetry={
						state.trouble === NOT_STARTED && state.review
							? () => send(state.review!, state.key)
							: state.trouble === LOST_CHECK
								? () => confirm(state.review, state.key)
								: null
					}
					onStartOver={startOver}
				/>
			) : (
				<DoneStep
					heading={heading}
					receipt={state.receipt}
					review={state.review}
					onRetry={state.review ? () => send(state.review!, state.key) : null}
					onStartOver={startOver}
				/>
			)}
		</>
	);
}

function next(s: Extract<State, { step: "import" }>, receipt: ImportReceipt): State {
	return finished(receipt) ? { step: "done", review: s.review, key: s.key, receipt } : { ...s, receipt, trouble: null };
}

const NOT_FOUND: Notice = {
	title: "We found no import for this link",
	text: "It may belong to another church, or it never started. Choose the file to import it.",
};
const LOST_CHECK: Notice = {
	title: "We could not confirm the import",
	text: "The connection dropped before the answer arrived. The import may be running. Check again to see where it stands.",
};
const NOT_STARTED: Notice = {
	title: "The import did not start",
	text: "Nothing was saved. Send it again with the same choices.",
};
const RECONNECTING: Notice = {
	title: "Reconnecting",
	text: "The import keeps running on the server. This page tries again in a few seconds.",
};

function importRefusal(code: string): Notice {
	switch (code) {
		case "review_stale":
			return {
				title: "People changed since you checked this file",
				text: "Someone added or changed people, so some duplicates may be different now. Check the file again, then review the rows.",
			};
		case "file_changed":
			return {
				title: "The file changed since you checked it",
				text: "Check the file again, then review the rows.",
			};
		case "access_denied":
		case "unavailable":
			return {
				title: "You cannot import people now",
				text: "Only Owners and Admins of this church can import. Your seat may have changed. Nothing was saved.",
			};
		default:
			return { title: "The import did not start", text: "Nothing was saved. Check the file again, then import." };
	}
}

// ---------------------------------------------------------------------------------------------------------------

const STEPS = [
	{ key: "upload", label: "Upload" },
	{ key: "review", label: "Review" },
	{ key: "import", label: "Import" },
	{ key: "done", label: "Done" },
] as const;

/** The step pills from the prototype's import page. They show progress only; the page's buttons move between steps. */
function Steps({ current }: { current: State["step"] }) {
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

function UploadStep({
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
					"mt-2.5 font-title text-display-sm leading-none tracking-[-0.02em] tabular-nums",
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

function ReviewStep({
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
	const setAll = (choice: Choice) => {
		const next = new Map(choices);
		for (const r of rowsIn(preview.rows, "check")) next.set(r.row, choice);
		onChoices(next);
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
					<CardHeading>
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
									onChoice={(c) => onChoices(new Map(choices).set(r.row, c))}
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
	onChoice,
	nameOf,
}: {
	row: PreviewRow;
	choice: Choice | null;
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
						options={(isDuplicate(row)
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

function ImportStep({
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
							<Button variant="primary" onClick={onRetry}>
								{trouble === LOST_CHECK ? "Check again" : "Import again"}
							</Button>
						) : null}
						<Button variant="ghost" onClick={onStartOver}>
							Start over
						</Button>
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

function DoneStep({
	heading,
	receipt,
	review,
	onRetry,
	onStartOver,
}: {
	heading: React.RefObject<HTMLHeadingElement | null>;
	receipt: ImportReceipt;
	review: Review | null;
	onRetry: (() => void) | null;
	onStartOver: () => void;
}) {
	const { counts } = receipt;
	const failed = receipt.rows.filter((r): r is FailedRow => r.status === "failed");
	const unsaved = failed.filter((r) => r.reason === "row_write_failed");
	const invalid = failed.filter((r) => r.reason === "invalid");
	const partial = receipt.status === "partial";
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
								? `${plural(counts.created, "person", "people")} added. ${plural(unsaved.length, "row")} did not save.`
								: `${plural(counts.created, "person", "people")} added`}
						</StepHeading>
						<p className="mt-1.5 text-text-2 text-pretty">
							{partial
								? "The other rows are saved. Try the rows that did not save again; nobody is added twice."
								: flagged
									? `${plural(flagged, "person", "people")} added with a note to review against a possible duplicate.`
									: "Everyone you chose is in People now."}
						</p>
					</div>
				</div>
				<div className="flex flex-wrap gap-2">
					{partial && onRetry ? (
						<Button variant="primary" onClick={onRetry}>
							Try {plural(unsaved.length, "row")} again
						</Button>
					) : null}
					<IntentLink
						href="/people"
						className={buttonVariants({ variant: partial && onRetry ? "secondary" : "primary" })}
					>
						Go to People
					</IntentLink>
					<Button variant="ghost" onClick={onStartOver}>
						Import another file
					</Button>
				</div>
				{partial && !onRetry ? (
					<p className="text-sm text-text-2 text-pretty">
						To try them again, import the same file. People already added show as duplicates, so skip them.
					</p>
				) : null}
			</Card>
			<div className="grid grid-cols-4 gap-4 max-app-lg:grid-cols-2">
				<Stat label="Added" value={counts.created} note="New people" tone="text-green-700" />
				<Stat label="Skipped" value={counts.skipped} note="By your choice" />
				<Stat
					label="Did not save"
					value={unsaved.length}
					note={unsaved.length ? "Can try again" : "None"}
					tone={unsaved.length ? "text-magenta-600" : undefined}
				/>
				<Stat label="Needed a fix" value={invalid.length} note="Not imported" />
			</div>
			{unsaved.length || invalid.length ? (
				<Card className="gap-4">
					<CardHeader>
						<CardHeading>
							<CardTitle as="h3">Rows not imported</CardTitle>
							<CardDescription>Each row with the reason.</CardDescription>
						</CardHeading>
					</CardHeader>
					<FailedRows rows={failed} name={name} />
				</Card>
			) : null}
		</div>
	);
}

function FailedRows({ rows, name }: { rows: FailedRow[]; name: (row: number) => string | null }) {
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
								{r.reason === "invalid" ? "Needs a fix" : (name(r.row) ?? "Not saved")}
							</p>
							<p className="flex items-start gap-1.5 text-sm text-magenta-600">
								<Icon icon={Alert02Icon} size={16} className="mt-0.5 flex-none" />
								{r.reason === "row_write_failed"
									? "Could not be saved. Try it again."
									: r.problems.length
										? r.problems.map(problemText).join(". ")
										: "Needs a fix in the file"}
							</p>
						</div>
					</li>
				))}
			</ul>
			<Pagination page={page} pageCount={pages} onPageChange={setPage} label="Pages of rows not imported" />
		</>
	);
}
