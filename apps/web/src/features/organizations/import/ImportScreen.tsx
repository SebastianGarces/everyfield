"use client";

import type { PipelineBoard, PipelineColumnChoice } from "@everyfield/contracts/organizations";
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	buttonVariants,
	Card,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	Field,
	IntentLink,
	PageHeader,
	SegmentedControl,
	Select,
} from "@everyfield/ui/controls";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useEffect, useRef, useState } from "react";
import { Problem, Stat, StepHeading, Steps, UploadStep } from "../../people/import-export/ImportSteps";
import { PIPELINE_PATH } from "../board/model";
import {
	CHOICE_LABEL,
	CHOICES,
	plural,
	problemText,
	refusalNotice,
	type Answer,
	type Notice,
	type Preview,
	type Result,
	type Row,
} from "./model";

// Import pipeline people from a CSV or a form's Excel export (T-363): upload, review the columns and rows, import, then
// the result. The chosen bytes stay in memory; the preview and the import each send them, and the server reads them
// itself. A column change asks the server again, so every row's state is the server's. Possible duplicates start with no
// choice: the person picks Skip or Add anyway on each (REQ-MUL-017).

type Stages = PipelineBoard["stages"];
type Staff = PipelineBoard["staff"];
type Decision = "skip" | "add";
type Review = {
	file: File;
	preview: Preview;
	stageId: string;
	seatId: string;
	decisions: Map<number, Decision>;
	checking: boolean;
	problem: Notice | null;
};
type State =
	| { step: "upload"; checking: File | null; error: Notice | null }
	| { step: "review"; review: Review }
	| { step: "import"; review: Review }
	| { step: "done"; review: Review; result: Result };

const NOBODY = "none";

async function send<T>(path: string, file: File, request: object): Promise<Answer<T>> {
	const form = new FormData();
	form.set("file", file);
	form.set("request", JSON.stringify(request));
	try {
		const res = await fetch(`${PIPELINE_PATH}/import/${path}`, { method: "POST", body: form, cache: "no-store" });
		const body = (await res.json().catch(() => null)) as Answer<T> | null;
		return body && (body.status === "ok" || body.status === "refused") ? body : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}
const previewOf = (file: File, columns: PipelineColumnChoice[] | null) => send<Preview>("preview", file, { columns });

export function PipelineImportScreen({ stages, staff }: { stages: Stages; staff: Staff }) {
	const [state, setState] = useState<State>({ step: "upload", checking: null, error: null });
	const heading = useRef<HTMLHeadingElement>(null);
	const first = useRef(true);
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		(document.querySelector<HTMLElement>("[data-import-problem]") ?? heading.current)?.focus();
	}, [state.step]);

	const check = async (picked: File) => {
		setState({ step: "upload", checking: picked, error: null });
		// The bytes are read once, so the import sends the file that was checked even if the one on disk changes.
		const file = new File([await picked.arrayBuffer()], picked.name, { type: picked.type });
		const got = await previewOf(file, null);
		if (got.status !== "ok") return setState({ step: "upload", checking: null, error: refusalNotice(got) });
		setState({
			step: "review",
			review: {
				file,
				preview: got.value,
				stageId: stages[0]!.id,
				seatId: NOBODY,
				decisions: new Map(),
				checking: false,
				problem: null,
			},
		});
	};

	const update = (review: Review) => setState({ step: "review", review });
	/** A column's new choice: the server reads the rows again with it. Decisions stay on rows still flagged. */
	const choose = async (review: Review, index: number, choice: PipelineColumnChoice) => {
		const columns = review.preview.columns.map((c, i) => (i === index ? choice : c.choice));
		update({ ...review, checking: true, problem: null });
		const got = await previewOf(review.file, columns);
		if (got.status !== "ok") return update({ ...review, checking: false, problem: refusalNotice(got) });
		const flagged = new Set(got.value.rows.filter((r) => r.status === "duplicate").map((r) => r.row));
		update({
			...review,
			preview: got.value,
			checking: false,
			decisions: new Map([...review.decisions].filter(([row]) => flagged.has(row))),
		});
	};
	const recheck = async (review: Review) => {
		update({ ...review, checking: true, problem: null });
		const got = await previewOf(
			review.file,
			review.preview.columns.map((c) => c.choice),
		);
		if (got.status !== "ok") return update({ ...review, checking: false, problem: refusalNotice(got) });
		update({ ...review, preview: got.value, decisions: new Map(), checking: false });
	};

	/** One import id per press: a lost reply retried with the same id adds no one twice. */
	const run = async (review: Review, importId: string) => {
		setState({ step: "import", review });
		const { preview } = review;
		const got = await send<Result>("save", review.file, {
			importId,
			fileDigest: preview.fileDigest,
			reviewDigest: preview.reviewDigest,
			columns: preview.columns.map((c) => c.choice),
			stageId: review.stageId,
			responsibleSeatId: review.seatId === NOBODY ? null : review.seatId,
			duplicates: [...review.decisions].map(([row, choice]) => ({ row, choice })),
		});
		if (got.status === "ok") return setState({ step: "done", review, result: got.value });
		setState({ step: "review", review: { ...review, problem: refusalNotice(got) } });
	};

	const review = state.step === "upload" ? null : state.review;
	const duplicates = review ? review.preview.rows.filter((r) => r.status === "duplicate") : [];
	const undecided = review ? duplicates.filter((r) => !review.decisions.has(r.row)).length : 0;
	const adding = review
		? review.preview.counts.ready + duplicates.filter((r) => review.decisions.get(r.row) === "add").length
		: 0;
	const startOver = () => setState({ step: "upload", checking: null, error: null });

	return (
		<>
			<PageHeader
				size="xl"
				title="Import people"
				breadcrumb={[{ label: "Pipeline", href: PIPELINE_PATH }, { label: "Import" }]}
				subtitle={
					review
						? `${review.file.name} · ${plural(review.preview.counts.rows, "row")}`
						: "Bring in the people you already track, from a spreadsheet or your application form’s export."
				}
				actions={
					state.step === "review" ? (
						<>
							<Button variant="ghost" onClick={startOver}>
								Choose another file
							</Button>
							<Button
								variant="primary"
								disabled={adding === 0 || undecided > 0 || state.review.checking}
								onClick={() => void run(state.review, crypto.randomUUID())}
							>
								{undecided > 0
									? `Choose for ${plural(undecided, "duplicate")}`
									: adding === 0
										? "Nobody to import"
										: `Import ${plural(adding, "person", "people")}`}
							</Button>
						</>
					) : state.step === "upload" ? (
						<IntentLink href={PIPELINE_PATH} className={buttonVariants({ variant: "ghost" })}>
							Cancel
						</IntentLink>
					) : null
				}
			/>
			<Steps current={state.step} />
			{state.step === "upload" ? (
				<UploadStep
					heading={heading}
					checking={state.checking}
					error={state.error}
					onFile={check}
					kind={{
						title: "Choose a file",
						accept: ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
						prompt: "Drop a CSV or Excel file here, or choose one",
						limits: "CSV or Excel (.xlsx), up to 5 MB and 2,000 rows",
						inputLabel: "Choose a CSV or Excel file",
					}}
					aside={<FormsCard />}
				/>
			) : state.step === "review" ? (
				<ReviewStep
					heading={heading}
					review={state.review}
					stages={stages}
					staff={staff}
					onChange={update}
					onChoose={(i, c) => void choose(state.review, i, c)}
					onRecheck={() => void recheck(state.review)}
				/>
			) : state.step === "import" ? (
				<Card className="gap-3" aria-busy="true">
					<StepHeading heading={heading}>Importing people</StepHeading>
					<p className="text-text-2">Adding {plural(adding, "person", "people")} to your pipeline…</p>
				</Card>
			) : (
				<DoneStep heading={heading} review={state.review} result={state.result} onStartOver={startOver} />
			)}
		</>
	);
}

function FormsCard() {
	return (
		<Card size="sm" className="gap-3">
			<h3 className="font-semibold text-ink">Using an application form?</h3>
			<p className="text-sm text-text-2 text-pretty">
				Export the responses to Excel, such as Microsoft Forms’ “Open results in Excel”, and choose that file.
				Everyfield matches columns by their title, so Full name becomes Name and Email address becomes Email.
			</p>
			<p className="text-sm text-text-2 text-pretty">
				Other questions are kept as answers in one note on each person, which only Owners, Admins and their responsible
				staff can read. Background-check questions are never imported.
			</p>
		</Card>
	);
}

function ReviewStep({
	heading,
	review,
	stages,
	staff,
	onChange,
	onChoose,
	onRecheck,
}: {
	heading: React.RefObject<HTMLHeadingElement | null>;
	review: Review;
	stages: Stages;
	staff: Staff;
	onChange: (review: Review) => void;
	onChoose: (index: number, choice: PipelineColumnChoice) => void;
	onRecheck: () => void;
}) {
	const { preview } = review;
	const { counts } = preview;
	const stageColumn = preview.columns.some((c) => c.choice === "stage");
	const stageLabel = (id: string | null) => stages.find((s) => s.id === id)?.label;
	const kept = preview.columns.filter((c) => c.choice === "answer").length;
	return (
		<div className="flex flex-col gap-5" aria-busy={review.checking || undefined}>
			{review.problem ? (
				<Problem
					notice={review.problem}
					actions={
						<Button variant="primary" size="sm" onClick={onRecheck}>
							Check the file again
						</Button>
					}
				/>
			) : null}
			<div className="grid grid-cols-4 gap-4 max-app-lg:grid-cols-2">
				<Stat label="Ready" value={counts.ready} note="New people" tone="text-green-700" />
				<Stat label="Possible duplicates" value={counts.duplicates} note="Choose for each one" tone="text-amber-600" />
				<Stat label="Need a fix" value={counts.invalid} note="Not imported" tone="text-magenta-600" />
				<Stat label="Rows in file" value={counts.rows} note={plural(kept, "answer") + " kept per person"} />
			</div>
			<Card className="gap-4">
				<CardHeader>
					<CardHeading>
						<StepHeading heading={heading}>Columns</StepHeading>
						<CardDescription>
							Matched by title. Change any column before you import; the next file with the same titles uses your
							choices.
						</CardDescription>
					</CardHeading>
				</CardHeader>
				<ul aria-label="Columns" className="flex flex-col">
					{preview.columns.map((c, i) => (
						<li
							key={i}
							className="grid grid-cols-[minmax(0,1fr)_240px] items-center gap-4 border-b border-line py-3 last:border-b-0 max-app-sm:grid-cols-1 max-app-sm:gap-2"
						>
							<div className="min-w-0">
								<p className="font-medium break-words text-ink">{c.title || `Column ${i + 1} (no title)`}</p>
								{c.locked ? <p className="text-sm text-text-2">Background-check answers are never imported.</p> : null}
							</div>
							<Select
								aria-label={`What column ${i + 1}, ${c.title || "no title"}, becomes`}
								value={c.choice}
								disabled={review.checking}
								onValueChange={(v) => onChoose(i, v as PipelineColumnChoice)}
								options={CHOICES.map((choice) => ({
									value: choice,
									label: CHOICE_LABEL[choice],
									disabled: c.locked && choice !== "skip",
								}))}
							/>
						</li>
					))}
				</ul>
			</Card>
			<Card className="gap-4">
				<CardHeader>
					<CardHeading>
						<CardTitle as="h3">Where they go</CardTitle>
						<CardDescription>
							{stageColumn
								? "The Stage column places each row by its label. Rows with no stage go to the stage below."
								: "Everyone in this file starts in one stage."}
						</CardDescription>
					</CardHeading>
				</CardHeader>
				<div className="grid grid-cols-2 gap-4 max-app-sm:grid-cols-1">
					<Field label={stageColumn ? "Rows with no stage" : "Stage"}>
						<Select
							value={review.stageId}
							onValueChange={(stageId) => onChange({ ...review, stageId })}
							options={stages.map((s) => ({ value: s.id, label: s.label }))}
						/>
					</Field>
					<Field label="Responsible staff" hint="They can read these people’s records and notes, and add notes.">
						<Select
							value={review.seatId}
							onValueChange={(seatId) => onChange({ ...review, seatId })}
							options={[{ value: NOBODY, label: "No one" }, ...staff.map((s) => ({ value: s.seatId, label: s.name }))]}
						/>
					</Field>
				</div>
			</Card>
			<Card className="gap-4">
				<CardHeader>
					<CardHeading>
						<CardTitle as="h3">Rows</CardTitle>
						<CardDescription>
							Nothing is merged and no one already in your pipeline changes. Choose Skip or Add anyway for each possible
							duplicate.
						</CardDescription>
					</CardHeading>
				</CardHeader>
				<ul aria-label="Rows" className="flex flex-col">
					{preview.rows.map((r) => (
						<RowItem
							key={r.row}
							row={r}
							stage={r.stageId ? stageLabel(r.stageId) : undefined}
							decision={review.decisions.get(r.row) ?? null}
							onDecide={(d) => onChange({ ...review, decisions: new Map(review.decisions).set(r.row, d) })}
						/>
					))}
				</ul>
			</Card>
		</div>
	);
}

function RowItem({
	row,
	stage,
	decision,
	onDecide,
}: {
	row: Row;
	stage: string | undefined;
	decision: Decision | null;
	onDecide: (d: Decision) => void;
}) {
	const name = row.name ?? `Row ${row.row}`;
	return (
		<li className="grid grid-cols-[48px_minmax(0,1fr)_minmax(0,auto)] items-center gap-4 border-b border-line py-3.5 last:border-b-0 max-app-md:grid-cols-[40px_minmax(0,1fr)] max-app-md:gap-x-3 max-app-md:gap-y-2">
			<span className="text-sm text-text-3 tabular-nums">
				<span className="sr-only">Row </span>
				{row.row}
			</span>
			<div className="min-w-0">
				<p className="truncate font-medium text-ink">{name}</p>
				<p className="truncate text-sm text-text-2">{[row.email ?? "No email", stage].filter(Boolean).join(" · ")}</p>
				{row.status === "invalid" ? (
					<p className="mt-0.5 flex items-start gap-1.5 text-sm text-magenta-600">
						<Icon icon={Alert02Icon} size={16} className="mt-0.5 flex-none" />
						Not imported: {problemText(row.problems)}
					</p>
				) : row.status === "duplicate" ? (
					<p className="mt-0.5 text-sm text-amber-600">
						Possible duplicate:{" "}
						{[
							...row.existing.map((p) => `same email as ${p.name} in your pipeline`),
							...row.sameAs.map((n) => `same email as row ${n}`),
						].join(", ")}
					</p>
				) : null}
			</div>
			<div className={cn("min-w-0", "max-app-md:col-start-2")}>
				{row.status === "duplicate" ? (
					<SegmentedControl<Decision>
						label={`What to do with row ${row.row}, ${name}`}
						size="sm"
						value={(decision ?? "") as Decision}
						onValueChange={onDecide}
						options={[
							{ value: "skip", label: "Skip" },
							{ value: "add", label: "Add anyway" },
						]}
					/>
				) : row.status === "ready" ? (
					<span className="text-sm text-green-700">Ready</span>
				) : null}
			</div>
		</li>
	);
}

function DoneStep({
	heading,
	review,
	result,
	onStartOver,
}: {
	heading: React.RefObject<HTMLHeadingElement | null>;
	review: Review;
	result: Result;
	onStartOver: () => void;
}) {
	const nameOf = (row: number) => review.preview.rows[row - 1]?.name ?? `Row ${row}`;
	return (
		<div className="flex flex-col gap-5">
			<Card className="gap-4">
				<div className="flex items-start gap-4">
					<span
						aria-hidden="true"
						className="grid size-11 flex-none place-items-center rounded-pill bg-green-100 text-green-700"
					>
						<Icon icon={Tick02Icon} size={20} />
					</span>
					<div className="min-w-0">
						<StepHeading heading={heading}>{plural(result.added.length, "person", "people")} added</StepHeading>
						<p className="mt-1.5 text-text-2 text-pretty">
							{result.added.length
								? `${result.added.map((a) => nameOf(a.row)).join(", ")} ${result.added.length === 1 ? "is" : "are"} in your pipeline now.`
								: "No one was added."}
						</p>
					</div>
				</div>
				<div className="flex flex-wrap gap-2">
					<IntentLink href={PIPELINE_PATH} className={buttonVariants({ variant: "primary" })}>
						Go to Pipeline
					</IntentLink>
					<Button variant="ghost" onClick={onStartOver}>
						Import another file
					</Button>
				</div>
			</Card>
			<div className="grid grid-cols-3 gap-4 max-app-md:grid-cols-1">
				<Stat label="Added" value={result.added.length} note="New people" tone="text-green-700" />
				<Stat label="Skipped" value={result.skipped.length} note="Possible duplicates you skipped" />
				<Stat
					label="Refused"
					value={result.refused.length}
					note={result.refused.length ? "Need a fix in the file" : "None"}
					tone={result.refused.length ? "text-magenta-600" : undefined}
				/>
			</div>
			{result.refused.length || result.skipped.length ? (
				<Card className="gap-4">
					<CardHeader>
						<CardHeading>
							<CardTitle as="h3">Rows not imported</CardTitle>
							<CardDescription>Each row with the reason.</CardDescription>
						</CardHeading>
					</CardHeader>
					<ul aria-label="Rows not imported" className="flex flex-col">
						{[
							...result.refused.map((r) => ({ row: r.row, why: problemText(r.problems), refused: true })),
							...result.skipped.map((row) => ({ row, why: "Skipped as a possible duplicate", refused: false })),
						]
							.sort((a, b) => a.row - b.row)
							.map((r) => (
								<li
									key={r.row}
									className="grid grid-cols-[48px_minmax(0,1fr)] gap-4 border-b border-line py-3 last:border-b-0 max-app-sm:grid-cols-[40px_minmax(0,1fr)] max-app-sm:gap-3"
								>
									<span className="text-sm text-text-3 tabular-nums">
										<span className="sr-only">Row </span>
										{r.row}
									</span>
									<div className="min-w-0">
										<p className="truncate font-medium text-ink">{nameOf(r.row)}</p>
										<p className={cn("text-sm", r.refused ? "text-magenta-600" : "text-text-2")}>{r.why}</p>
									</div>
								</li>
							))}
					</ul>
				</Card>
			) : null}
		</div>
	);
}
