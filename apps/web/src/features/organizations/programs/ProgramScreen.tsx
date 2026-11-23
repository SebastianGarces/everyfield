"use client";

import { APPLY_VERSION_LIMIT, type ProgramDetail, type ProgramVersion } from "@everyfield/contracts/organizations";
import { Edit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardBody,
	CardHeader,
	CardHeading,
	CardTitle,
	Checkbox,
	ConfirmDialog,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTrigger,
	Field,
	Input,
	PageHeader,
	SegmentedControl,
	Select,
} from "@everyfield/ui/controls";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition, type ReactNode } from "react";
import { formatPlainDate } from "../../../components/dates.ts";
import { PIPELINE_PATH } from "../board/model";
import { Problem } from "../../../components/Problem.tsx";
import { enroll, publishVersion, savePlan } from "./actions";
import { rereadProgram } from "./fetch.ts";
import { ApplyVersionsDialog, versionReviews } from "./ApplyVersions";
import { enrollmentHref, KIND, monthRange, programProblem, PROGRAMS_PATH, readingHref, RHYTHM } from "./model";
import { draftFrom, PlanEditor, planFrom, type PlanDraft } from "./PlanEditor";

const lost = () => ({ status: "lost" as const });

export function ProgramScreen({ initial, organizationId }: { initial: ProgramDetail; organizationId: string }) {
	const router = useRouter();
	const [local, setLocal] = useState<{ from: ProgramDetail; value: ProgramDetail } | null>(null);
	const program = local?.from === initial ? local.value : initial;
	const [view, setView] = useState<"published" | "draft">(initial.published ? "published" : "draft");
	const [editing, setEditing] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const { viewer, published, draft } = program;
	const shown = view === "draft" ? (draft ?? published) : (published ?? draft);
	const nextNumber = draft?.number ?? (published?.number ?? 0) + 1;

	async function reread() {
		const answer = await rereadProgram(program.id).catch(() => null);
		if (answer?.status === "ok") return (setLocal({ from: initial, value: answer.value }), answer.value);
		router.refresh();
		return null;
	}

	const status = published ? publishedText(published) : `Draft of Version ${nextNumber}`;

	return (
		<div className="flex flex-col gap-5">
			<PageHeader
				breadcrumb={[
					{ label: "Pipeline", href: PIPELINE_PATH },
					{ label: "Programs", href: PROGRAMS_PATH },
					{ label: program.name },
				]}
				title={program.name}
				subtitle={`${KIND[program.kind]} · Directed by ${program.director.name}`}
				actions={
					editing ? null : (
						<>
							{viewer.director ? (
								<Button
									variant="secondary"
									icon={Edit02Icon}
									onClick={() => {
										setProblem(null);
										setEditing(true);
									}}
								>
									{draft ? "Edit draft" : `Start Version ${nextNumber}`}
								</Button>
							) : null}
							{viewer.director && draft ? (
								<ConfirmDialog
									trigger={<Button variant="primary">Publish Version {draft.number}</Button>}
									title={`Publish Version ${draft.number}?`}
									description={
										published
											? `Version ${draft.number} becomes the plan for new enrollments. People already enrolled stay on their version.`
											: "Version 1 becomes the plan, and Owners and Admins can enroll people in it."
									}
									confirmLabel="Publish"
									onConfirm={async () => {
										const answer = await publishVersion({
											programId: program.id,
											expectedRevision: program.revision,
										}).catch(lost);
										if (answer.status !== "ok") return setProblem(programProblem(answer));
										setProblem(null);
										void reread().then(() => setView("published"));
									}}
								/>
							) : null}
							{viewer.administrator && published ? (
								<EnrollDialog
									program={program}
									version={published}
									onEnrolled={(id) => router.push(enrollmentHref(id))}
								/>
							) : null}
						</>
					)
				}
			/>
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<span className="rounded-full bg-surface-2 px-2.5 py-1 font-medium text-ink">{status}</span>
				{published && draft ? (
					<span className="rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-600">
						Draft of Version {draft.number} in progress
					</span>
				) : null}
				{!published ? (
					<span className="text-text-2">Nobody can be enrolled until the director publishes it.</span>
				) : null}
			</div>
			<Problem text={editing ? null : problem} />

			<div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-5 max-app-md:grid-cols-1">
				<Card>
					<CardHeader>
						<CardTitle>{editing ? `Edit the plan · Version ${nextNumber} draft` : "Plan"}</CardTitle>
					</CardHeader>
					<CardBody className="flex flex-col gap-5">
						{editing ? (
							<PlanEditing
								program={program}
								nextNumber={nextNumber}
								onCancel={() => setEditing(false)}
								onSaved={async () => {
									setEditing(false);
									await reread();
									setView("draft");
								}}
							/>
						) : (
							<>
								{published && draft ? (
									<SegmentedControl
										label="Which plan"
										value={view}
										onValueChange={(v) => setView(v as "published" | "draft")}
										options={[
											{ value: "published", label: `Version ${published.number}` },
											{ value: "draft", label: `Version ${draft.number} draft` },
										]}
									/>
								) : null}
								{shown ? <PlanView version={shown} organizationId={organizationId} /> : null}
							</>
						)}
					</CardBody>
				</Card>
				<Enrollments program={program} onApplied={reread} />
			</div>
		</div>
	);
}

type Version = NonNullable<ProgramDetail["draft"] | ProgramDetail["published"]>;

function baseOf({ draft, published }: ProgramDetail): { kind: "draft" | "published"; version: Version } {
	if (draft) return { kind: "draft", version: draft };
	if (published) return { kind: "published", version: published };
	throw new Error("The program has neither a draft nor a published version");
}

function publishedText(version: Version) {
	if (version.publishedOn === null) throw new Error(`Version ${version.number} is published without a date`);
	return `Version ${version.number} published ${formatPlainDate(version.publishedOn)}`;
}

function PlanEditing({
	program,
	nextNumber,
	onCancel,
	onSaved,
}: {
	program: ProgramDetail;
	nextNumber: number;
	onCancel: () => void;
	onSaved: () => Promise<void>;
}) {
	const [editing, setEditing] = useState<PlanDraft>(() => draftFrom(baseOf(program).version));
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, startSaving] = useTransition();
	const base = baseOf(program);

	const save = () => {
		const built = planFrom(editing);
		if ("problem" in built) return setProblem(built.problem);
		startSaving(async () => {
			setProblem(null);
			const answer = await savePlan({
				programId: program.id,
				expectedRevision: program.revision,
				plan: built.plan,
			}).catch(lost);
			if (answer.status !== "ok") return setProblem(programProblem(answer));
			await onSaved();
		});
	};

	return (
		<>
			{base.kind === "published" ? (
				<p className="text-sm text-text-2">
					Version {base.version.number} stays as it is. Saving starts the draft of Version {nextNumber}, and people
					already enrolled keep Version {base.version.number}.
				</p>
			) : null}
			<PlanEditor value={editing} onChange={setEditing} />
			<Problem text={problem} />
			<div className="flex flex-wrap justify-end gap-2">
				<Button variant="ghost" onClick={onCancel} disabled={saving}>
					Cancel
				</Button>
				<Button variant="primary" onClick={save} loading={saving}>
					Save draft
				</Button>
			</div>
		</>
	);
}

function PlanView({ version, organizationId }: { version: ProgramVersion; organizationId: string }) {
	return (
		<>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
				<Detail term="Version">
					{version.publishedOn
						? `Version ${version.number}, published ${formatPlainDate(version.publishedOn)}`
						: `Version ${version.number}, draft`}
				</Detail>
				<Detail term="Meeting rhythm">{RHYTHM[version.rhythm]}</Detail>
				<Detail term="Expected length">{`${version.expectedMonths} months`}</Detail>
			</dl>
			<Part title="Stages" empty="No stages yet." count={version.stages.length}>
				<ol className="flex flex-col gap-1.5">
					{version.stages.map((s, i) => (
						<li
							key={s.id}
							className="flex items-baseline justify-between gap-3 rounded-md bg-surface-2 px-3 py-2 text-sm"
						>
							<span className="min-w-0 [overflow-wrap:anywhere] text-ink">
								<span className="text-text-3">{i + 1}. </span>
								{s.label}
							</span>
							<span className="flex-none text-text-2">{monthRange(s.minMonths, s.maxMonths)}</span>
						</li>
					))}
				</ol>
			</Part>
			<Part title="Milestones" empty="No milestones yet." count={version.milestones.length}>
				<ol className="flex flex-col gap-2">
					{version.milestones.map((m) => (
						<li key={m.id} className="flex flex-col gap-0.5 text-sm">
							<span className="font-medium [overflow-wrap:anywhere] text-ink">{m.title}</span>
							{m.handsOn ? <span className="text-xs font-medium text-blue-600">Hands-on assignment</span> : null}
							{m.description ? <span className="[overflow-wrap:anywhere] text-text-2">{m.description}</span> : null}
						</li>
					))}
				</ol>
			</Part>
			<Part title="Reading list" empty="No readings yet." count={version.readings.length}>
				<ul className="flex flex-col gap-1.5">
					{version.readings.map((r) => (
						<li key={r.id} className="text-sm">
							{r.slug ? (
								<Link
									href={readingHref(r.slug, r.source, organizationId)}
									className="font-medium [overflow-wrap:anywhere] text-ink underline decoration-line-2 underline-offset-2 hover:decoration-ink"
								>
									{r.title}
								</Link>
							) : (
								<span className="[overflow-wrap:anywhere] text-text-2">{r.title}</span>
							)}
							<span className="text-text-3">
								{r.slug
									? r.source === "organization"
										? " · Your version"
										: ""
									: " · Unavailable: no longer published"}
							</span>
						</li>
					))}
				</ul>
			</Part>
		</>
	);
}

function Part({ title, empty, count, children }: { title: string; empty: string; count: number; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<h3 className="font-body text-sm font-semibold tracking-normal text-ink">{title}</h3>
			{count ? children : <p className="text-sm text-text-3">{empty}</p>}
		</section>
	);
}

export function Detail({ term, children }: { term: string; children: ReactNode }) {
	return (
		<>
			<dt className="text-text-2">{term}</dt>
			<dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{children}</dd>
		</>
	);
}

function Enrollments({ program, onApplied }: { program: ProgramDetail; onApplied: () => Promise<unknown> }) {
	const [selected, onSelectedChange] = useState<string[]>([]);
	const [applying, setApplying] = useState(false);
	const onApply = () => {
		versionReviews.prefetch(program.id, selected);
		setApplying(true);
	};
	const current = program.published?.number ?? null;
	const movable = (e: ProgramDetail["enrollments"][number]) =>
		program.viewer.director && current !== null && e.status === "active" && e.versionNumber < current;
	const selecting = program.enrollments.some(movable);
	const chosen = selected.filter((id) => program.enrollments.some((e) => e.id === id && movable(e)));
	const tooMany = chosen.length > APPLY_VERSION_LIMIT;
	return (
		<Card>
			<CardHeader className={selecting ? "flex-wrap" : undefined}>
				<CardHeading>
					<CardTitle>Enrolled</CardTitle>
				</CardHeading>
				{selecting ? (
					<Button
						variant="primary"
						size="sm"
						className="flex-none"
						disabled={!chosen.length || tooMany}
						onClick={onApply}
					>
						{chosen.length
							? `Apply Version ${current} to ${chosen.length === 1 ? "1 person" : `${chosen.length} people`}`
							: `Apply Version ${current}`}
					</Button>
				) : null}
			</CardHeader>
			<CardBody className="flex flex-col gap-3">
				{selecting ? (
					<p className="text-sm text-text-2" aria-live="polite">
						{tooMany
							? `Select up to ${APPLY_VERSION_LIMIT} people at a time.`
							: chosen.length
								? "You’ll review what changes for each person before anything is saved."
								: `Select people on an earlier version to move them to Version ${current}.`}
					</p>
				) : null}
				{program.enrollments.length ? (
					<ul className="flex flex-col gap-2">
						{program.enrollments.map((e) => (
							<li key={e.id} className="relative flex items-start gap-3 rounded-md bg-surface-2 px-3 py-2.5 text-sm">
								{selecting ? (
									movable(e) ? (
										<Checkbox
											className="relative z-10 mt-0.5"
											aria-label={`Select ${e.name} to apply Version ${current}`}
											checked={chosen.includes(e.id)}
											onCheckedChange={(on) =>
												onSelectedChange(on === true ? [...chosen, e.id] : chosen.filter((id) => id !== e.id))
											}
										/>
									) : (
										<span className="size-5 flex-none" aria-hidden />
									)
								) : null}
								<div className="min-w-0 flex-1">
									<Link
										href={enrollmentHref(e.id)}
										className="font-semibold [overflow-wrap:anywhere] text-ink after:absolute after:inset-0 after:rounded-md hover:underline"
									>
										{e.name}
									</Link>
									<p className="text-text-2">
										{[e.cohort, e.stage, `Version ${e.versionNumber}`, e.status === "active" ? null : e.status]
											.filter(Boolean)
											.join(" · ")}
									</p>
								</div>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-text-3">
						{!program.published
							? "Enrollment opens when the director publishes the plan."
							: program.viewer.administrator || program.viewer.director
								? "Nobody is enrolled yet."
								: "You see only the people you’re responsible for, and none of them is enrolled."}
					</p>
				)}
			</CardBody>
			{program.viewer.director && program.published ? (
				<ApplyVersionsDialog
					open={applying}
					programId={program.id}
					toNumber={program.published.number}
					enrollmentIds={selected}
					onClose={() => setApplying(false)}
					onApplied={async () => {
						setApplying(false);
						onSelectedChange([]);
						await onApplied();
					}}
				/>
			) : null}
		</Card>
	);
}

function EnrollDialog(form: {
	program: ProgramDetail;
	version: ProgramVersion;
	onEnrolled: (enrollmentId: string) => void;
}) {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button variant="primary" icon={PlusSignIcon}>
					Enroll
				</Button>
			</DialogTrigger>
			<DialogContent size="sm">
				<EnrollForm {...form} />
			</DialogContent>
		</Dialog>
	);
}

type EnrollState = {
	values: {
		personId: string;
		cohort: string;
		expectedEndOn: string;
		stageId: string;
		meetingDay: string;
		meetingTime: string;
	};
	problem: string | null;
};

function EnrollForm({
	program,
	version,
	onEnrolled,
}: {
	program: ProgramDetail;
	version: ProgramVersion;
	onEnrolled: (enrollmentId: string) => void;
}) {
	const [enrollmentId] = useState(() => crypto.randomUUID());
	const [startedOn, setStartedOn] = useState<string>(program.today);
	const [state, submit, saving] = useActionState(
		async (_: EnrollState, form: FormData): Promise<EnrollState> => {
			const values = {
				personId: String(form.get("personId") ?? ""),
				cohort: String(form.get("cohort") ?? ""),
				expectedEndOn: String(form.get("expectedEndOn") ?? ""),
				stageId: String(form.get("stageId") ?? ""),
				meetingDay: String(form.get("meetingDay") ?? ""),
				meetingTime: String(form.get("meetingTime") ?? ""),
			};
			const { personId, cohort, expectedEndOn, stageId, meetingDay, meetingTime } = values;
			const missing = !personId
				? "Choose who to enroll."
				: !cohort.trim()
					? "Name the cohort."
					: !startedOn || !expectedEndOn
						? "Enter the start and the expected end."
						: expectedEndOn < startedOn
							? "The expected end can’t be before the start."
							: Boolean(meetingDay) !== Boolean(meetingTime)
								? "Enter both the day and the time of the next meeting, or neither."
								: null;
			if (missing) return { values, problem: missing };
			const answer = await enroll({
				enrollmentId,
				programId: program.id,
				personId,
				cohort: cohort.trim(),
				startedOn,
				expectedEndOn,
				stageId,
				nextMeetingAt: meetingDay && meetingTime ? `${meetingDay}T${meetingTime}:00` : null,
			}).catch(lost);
			if (answer.status === "refused" && answer.refusal.code === "already_enrolled") {
				const name = program.people.find((p) => p.personId === personId)?.name ?? "This person";
				return {
					values,
					problem: `${name} is already enrolled in ${program.name}. Each person can have one active enrollment per program.`,
				};
			}
			if (answer.status !== "ok") return { values, problem: programProblem(answer) };
			onEnrolled(enrollmentId);
			return { values, problem: null };
		},
		{
			values: {
				personId: "",
				cohort: "",
				expectedEndOn: "",
				stageId: version.stages[0]?.id ?? "",
				meetingDay: "",
				meetingTime: "",
			},
			problem: null,
		},
	);
	const { values } = state;

	return (
		<form action={submit} noValidate className="contents">
			<DialogHeader
				title={`Enroll in ${program.name}`}
				description={`On Version ${version.number}. Their pipeline stage doesn’t change.`}
			/>
			<DialogBody className="flex flex-col gap-4">
				<Field label="Person" hint={program.people.length ? undefined : "Add people to the pipeline first."}>
					<Select
						name="personId"
						defaultValue={values.personId}
						placeholder="Choose a pipeline person"
						options={program.people.map((p) => ({ value: p.personId, label: p.name }))}
					/>
				</Field>
				<Field label="Cohort">
					<Input name="cohort" defaultValue={values.cohort} maxLength={80} placeholder="Fall 2026" />
				</Field>
				<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
					<Field label="Start">
						<Input type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
					</Field>
					<Field label="Expected end">
						<Input type="date" name="expectedEndOn" defaultValue={values.expectedEndOn} min={startedOn} />
					</Field>
				</div>
				<Field label="Program stage" hint="Separate from their pipeline stage.">
					<Select
						name="stageId"
						defaultValue={values.stageId}
						options={version.stages.map((s) => ({ value: s.id, label: s.label }))}
					/>
				</Field>
				<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
					<Field label="Next meeting" optional hint={`Time in ${program.timezone}.`}>
						<Input type="date" name="meetingDay" defaultValue={values.meetingDay} />
					</Field>
					<Field label="Time" optional>
						<Input type="time" name="meetingTime" defaultValue={values.meetingTime} />
					</Field>
				</div>
				<Problem text={saving ? null : state.problem} />
			</DialogBody>
			<DialogFooter>
				<Button type="submit" variant="primary" loading={saving}>
					Enroll
				</Button>
			</DialogFooter>
		</form>
	);
}
