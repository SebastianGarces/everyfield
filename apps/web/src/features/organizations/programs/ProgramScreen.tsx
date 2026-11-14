"use client";

import type { ProgramDetail, ProgramVersion } from "@everyfield/contracts/organizations";
import { Edit02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Card,
	CardBody,
	CardHeader,
	CardTitle,
	ConfirmDialog,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	PageHeader,
	SegmentedControl,
	Select,
} from "@everyfield/ui/controls";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { formatDay, PIPELINE_PATH } from "../board/model";
import { Problem } from "../board/Problem";
import { enroll, publishVersion, rereadProgram, savePlan } from "./actions";
import { enrollmentHref, KIND, monthRange, programProblem, PROGRAMS_PATH, readingHref, RHYTHM } from "./model";
import { draftFrom, PlanEditor, planFrom, type PlanDraft } from "./PlanEditor";

const lost = () => ({ status: "lost" as const });

/**
 * One program (REQ-MUL-010, -011). Everyone in the organization reads its plan and who is enrolled. The director edits
 * the draft and publishes it as the next version; an Owner or Admin enrolls people in the published version.
 */
export function ProgramScreen({ initial, organizationId }: { initial: ProgramDetail; organizationId: string }) {
	const router = useRouter();
	const [program, setProgram] = useState(initial);
	const [view, setView] = useState<"published" | "draft">(initial.published ? "published" : "draft");
	const [editing, setEditing] = useState<PlanDraft | null>(null);
	const [dialog, setDialog] = useState<"publish" | "enroll" | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const { viewer, published, draft } = program;
	const shown = view === "draft" ? (draft ?? published) : (published ?? draft);
	const nextNumber = draft?.number ?? (published?.number ?? 0) + 1;

	async function reread() {
		const answer = await rereadProgram(program.id).catch(() => null);
		if (answer?.status === "ok") return (setProgram(answer.value), answer.value);
		router.refresh();
		return null;
	}

	async function save() {
		if (!editing) return;
		const built = planFrom(editing);
		if ("problem" in built) return setProblem(built.problem);
		setSaving(true);
		setProblem(null);
		const answer = await savePlan({
			programId: program.id,
			expectedRevision: program.revision,
			plan: built.plan,
		}).catch(lost);
		setSaving(false);
		if (answer.status !== "ok") return setProblem(programProblem(answer));
		setEditing(null);
		await reread();
		setView("draft");
	}

	const status = published
		? `Version ${published.number} published ${formatDay(published.publishedOn!)}`
		: `Draft of Version ${nextNumber}`;

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
										setEditing(draftFrom((draft ?? published)!));
									}}
								>
									{draft ? "Edit draft" : `Start Version ${nextNumber}`}
								</Button>
							) : null}
							{viewer.director && draft ? (
								<Button variant="primary" onClick={() => setDialog("publish")}>
									Publish Version {draft.number}
								</Button>
							) : null}
							{viewer.administrator && published ? (
								<Button variant="primary" icon={PlusSignIcon} onClick={() => setDialog("enroll")}>
									Enroll
								</Button>
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
							<>
								{!draft ? (
									<p className="text-sm text-text-2">
										Version {published!.number} stays as it is. Saving starts the draft of Version {nextNumber}, and
										people already enrolled keep Version {published!.number}.
									</p>
								) : null}
								<PlanEditor value={editing} onChange={setEditing} />
								<Problem text={problem} />
								<div className="flex flex-wrap justify-end gap-2">
									<Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
										Cancel
									</Button>
									<Button variant="primary" onClick={save} loading={saving}>
										Save draft
									</Button>
								</div>
							</>
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
				<Enrollments program={program} />
			</div>

			{viewer.director && draft ? (
				<ConfirmDialog
					open={dialog === "publish"}
					onOpenChange={(open) => setDialog(open ? "publish" : null)}
					title={`Publish Version ${draft.number}?`}
					description={
						published
							? `Version ${draft.number} becomes the plan for new enrollments. People already enrolled stay on their version.`
							: "Version 1 becomes the plan, and Owners and Admins can enroll people in it."
					}
					confirmLabel="Publish"
					onConfirm={async () => {
						const answer = await publishVersion({ programId: program.id, expectedRevision: program.revision }).catch(
							lost,
						);
						setDialog(null);
						if (answer.status !== "ok") return setProblem(programProblem(answer));
						setProblem(null);
						await reread();
						setView("published");
					}}
				/>
			) : null}
			{viewer.administrator && published ? (
				<EnrollDialog
					open={dialog === "enroll"}
					onOpenChange={(open) => setDialog(open ? "enroll" : null)}
					program={program}
					version={published}
					onEnrolled={(id) => router.push(enrollmentHref(id))}
				/>
			) : null}
		</div>
	);
}

/** A version's plan as everyone reads it. A reading whose source no longer publishes it shows as unavailable. */
function PlanView({ version, organizationId }: { version: ProgramVersion; organizationId: string }) {
	return (
		<>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
				<Detail term="Version">
					{version.publishedOn
						? `Version ${version.number}, published ${formatDay(version.publishedOn)}`
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
									className="cursor-pointer font-medium [overflow-wrap:anywhere] text-ink underline decoration-line-2 underline-offset-2 hover:decoration-ink"
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

function Enrollments({ program }: { program: ProgramDetail }) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Enrolled</CardTitle>
			</CardHeader>
			<CardBody>
				{program.enrollments.length ? (
					<ul className="flex flex-col gap-2">
						{program.enrollments.map((e) => (
							<li key={e.id} className="relative rounded-md bg-surface-2 px-3 py-2.5 text-sm">
								<Link
									href={enrollmentHref(e.id)}
									className="cursor-pointer font-semibold text-ink after:absolute after:inset-0 after:rounded-md hover:underline"
								>
									{e.name}
								</Link>
								<p className="text-text-2">
									{[e.cohort, e.stage, `Version ${e.versionNumber}`, e.status === "active" ? null : e.status]
										.filter(Boolean)
										.join(" · ")}
								</p>
							</li>
						))}
					</ul>
				) : (
					<p className="text-sm text-text-3">
						{program.published ? "Nobody is enrolled yet." : "Enrollment opens when the director publishes the plan."}
					</p>
				)}
			</CardBody>
		</Card>
	);
}

/** Enroll a live pipeline person in the published version, at one of its stages (REQ-MUL-011). */
function EnrollDialog({
	open,
	onOpenChange,
	...form
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	program: ProgramDetail;
	version: ProgramVersion;
	onEnrolled: (enrollmentId: string) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm">{open ? <EnrollForm {...form} /> : null}</DialogContent>
		</Dialog>
	);
}

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
	const [personId, setPersonId] = useState("");
	const [cohort, setCohort] = useState("");
	const [startedOn, setStartedOn] = useState<string>(program.today);
	const [expectedEndOn, setExpectedEndOn] = useState("");
	const [stageId, setStageId] = useState(version.stages[0]?.id ?? "");
	const [meetingDay, setMeetingDay] = useState("");
	const [meetingTime, setMeetingTime] = useState("");
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	async function submit(event: FormEvent) {
		event.preventDefault();
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
		if (missing) return setProblem(missing);
		setSaving(true);
		setProblem(null);
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
		setSaving(false);
		if (answer.status === "refused" && answer.refusal.code === "already_enrolled") {
			const name = program.people.find((p) => p.personId === personId)?.name ?? "This person";
			return setProblem(
				`${name} is already enrolled in ${program.name}. Each person can have one active enrollment per program.`,
			);
		}
		if (answer.status !== "ok") return setProblem(programProblem(answer));
		onEnrolled(enrollmentId);
	}

	return (
		<form onSubmit={submit} noValidate className="contents">
			<DialogHeader
				title={`Enroll in ${program.name}`}
				description={`On Version ${version.number}. Their pipeline stage doesn’t change.`}
			/>
			<DialogBody className="flex flex-col gap-4">
				<Field label="Person" hint={program.people.length ? undefined : "Add people to the pipeline first."}>
					<Select
						value={personId}
						onValueChange={setPersonId}
						placeholder="Choose a pipeline person"
						options={program.people.map((p) => ({ value: p.personId, label: p.name }))}
					/>
				</Field>
				<Field label="Cohort">
					<Input value={cohort} onChange={(e) => setCohort(e.target.value)} maxLength={80} placeholder="Fall 2026" />
				</Field>
				<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
					<Field label="Start">
						<Input type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
					</Field>
					<Field label="Expected end">
						<Input
							type="date"
							value={expectedEndOn}
							min={startedOn}
							onChange={(e) => setExpectedEndOn(e.target.value)}
						/>
					</Field>
				</div>
				<Field label="Program stage" hint="Separate from their pipeline stage.">
					<Select
						value={stageId}
						onValueChange={setStageId}
						options={version.stages.map((s) => ({ value: s.id, label: s.label }))}
					/>
				</Field>
				<div className="grid grid-cols-2 gap-3 max-app-sm:grid-cols-1">
					<Field label="Next meeting" optional hint={`Time in ${program.timezone}.`}>
						<Input type="date" value={meetingDay} onChange={(e) => setMeetingDay(e.target.value)} />
					</Field>
					<Field label="Time" optional>
						<Input type="time" value={meetingTime} onChange={(e) => setMeetingTime(e.target.value)} />
					</Field>
				</div>
				<Problem text={problem} />
			</DialogBody>
			<DialogFooter>
				<Button type="submit" variant="primary" loading={saving}>
					Enroll
				</Button>
			</DialogFooter>
		</form>
	);
}
