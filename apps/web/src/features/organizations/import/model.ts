import type {
	PipelineColumnChoice,
	PipelineImportPreview,
	PipelineImportRefusal,
	PipelineImportResult,
} from "@everyfield/contracts/organizations";

export type Preview = PipelineImportPreview;
export type Result = PipelineImportResult;
export type Row = Preview["rows"][number];
export type Answer<T> =
	{ status: "ok"; value: T } | { status: "refused"; refusal: PipelineImportRefusal } | { status: "lost" };
export type Notice = { title: string; text: string };
export type Decision = "skip" | "add";
export const NOBODY = "none";
export type Review = {
	file: File;
	preview: Preview;
	stageId: string;
	seatId: string;
	decisions: Map<number, Decision>;
	importId: string;
	checking: boolean;
	problem: Notice | null;
};

export const revised = (review: Review, change: Partial<Omit<Review, "importId">>): Review => ({
	...review,
	...change,
	importId: crypto.randomUUID(),
});

export const importRequest = (review: Review) => ({
	importId: review.importId,
	fileDigest: review.preview.fileDigest,
	reviewDigest: review.preview.reviewDigest,
	columns: review.preview.columns.map((c) => c.choice),
	stageId: review.stageId,
	responsibleSeatId: review.seatId === NOBODY ? null : review.seatId,
	duplicates: [...review.decisions].map(([row, choice]) => ({ row, choice })),
});

export const afterImport = (review: Review, got: Answer<Result>) =>
	got.status === "ok"
		? { step: "done" as const, review, result: got.value }
		: { step: "review" as const, review: { ...review, checking: false, problem: refusalNotice(got) } };

export const CHOICE_LABEL: Record<PipelineColumnChoice, string> = {
	name: "Name",
	email: "Email",
	stage: "Stage",
	answer: "Keep as answer",
	skip: "Skip",
};
export const CHOICES = Object.keys(CHOICE_LABEL) as PipelineColumnChoice[];

const ROW_PROBLEM: Record<Row["problems"][number], string> = {
	name_required: "No name",
	name_too_long: "The name is longer than 255 characters",
	invalid_email: "The email isn’t a valid address",
	unknown_stage: "The stage isn’t one of your stages",
	answers_too_long: "The kept answers are longer than 5,000 characters. Skip a long column to import this row.",
	column_count: "The row has more cells than the file has column titles",
};
export const problemText = (problems: Row["problems"]) => problems.map((p) => ROW_PROBLEM[p]).join(". ");

const FILE_PROBLEM: Record<Extract<PipelineImportRefusal, { code: "file_refused" }>["problem"], Notice> = {
	file_type: {
		title: "Choose a .csv or .xlsx file",
		text: "Everyfield reads a CSV file or an Excel workbook. Export your form’s responses to Excel, or save the sheet as CSV.",
	},
	file_empty: { title: "The file is empty", text: "Choose the file that holds your responses." },
	file_too_large: { title: "The file is over 5 MB", text: "Split it into smaller files and import each one." },
	file_unreadable: {
		title: "Everyfield couldn’t read this file",
		text: "It may be damaged, protected with a password, or not a CSV or Excel file. Export it again and try once more.",
	},
	no_header: {
		title: "The first row has no column titles",
		text: "Each column needs a title in the first row, such as Full name or Email address.",
	},
	no_rows: { title: "The file has no people in it", text: "It has column titles but no rows below them." },
	row_limit: { title: "The file has more than 2,000 rows", text: "Split it into smaller files and import each one." },
	column_limit: {
		title: "The file has more than 200 columns",
		text: "Remove the columns you don’t need and try again.",
	},
};

export function refusalNotice(answer: Exclude<Answer<unknown>, { status: "ok" }>): Notice {
	if (answer.status === "lost")
		return {
			title: "We couldn’t reach Everyfield",
			text: "Nothing was imported. Check your connection and try again.",
		};
	const r = answer.refusal;
	switch (r.code) {
		case "file_refused":
			return FILE_PROBLEM[r.problem];
		case "file_changed":
			return { title: "The file changed", text: "It isn’t the file you checked. Choose it again to check it." };
		case "review_stale":
			return {
				title: "Your pipeline changed",
				text: "Someone added or changed people since you checked the file. Check it again before you import.",
			};
		case "conflict":
			return { title: "This import was already sent", text: "Reload the page to see your pipeline." };
		case "invalid_input":
			return r.field === "stageId" || r.field === "responsibleSeatId"
				? { title: "Choose the stage and staff again", text: "That stage or staff member is no longer available." }
				: r.field === "duplicates"
					? { title: "Choose for every possible duplicate", text: "Pick Skip or Add anyway on each one." }
					: {
							title: "Check the columns",
							text: "Each field can take one column, and a background check is always skipped.",
						};
		default:
			return { title: "You can’t import people here", text: "Only Owners and Admins import people into the pipeline." };
	}
}

export const plural = (n: number, one: string, many = one + "s") =>
	`${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
